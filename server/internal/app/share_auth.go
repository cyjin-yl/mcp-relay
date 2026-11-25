package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var errShareAuthorization = errors.New("temporary share has expired or been revoked")

type shareInvocation struct {
	cancel context.CancelFunc
}

type deviceDispatchGuardKey struct{}

func (token *VerifiedToken) allowsDevice(deviceID string) bool {
	return token.ShareID == "" || token.AllowedDeviceIDs[deviceID]
}

func tokenAllowsTool(token *VerifiedToken, tool Tool) bool {
	if tool.readOnly() {
		return hasScope(token.Scopes, scopeRead)
	}
	return hasScope(token.Scopes, scopeWrite)
}

func (a *App) toolsForToken(token *VerifiedToken) []Tool {
	if token.ShareID == "" {
		return a.registry.ToolsForUser(token.UserID)
	}
	out := []Tool{}
	for _, device := range a.registry.ListForUser(token.UserID) {
		if !token.allowsDevice(device.ID) {
			continue
		}
		for _, tool := range device.Tools {
			if !tokenAllowsTool(token, tool) {
				continue
			}
			copy := tool
			copy.Name = deviceToolName(device.Slug, tool.Name)
			copy.Description = "[" + device.Name + "] " + tool.Description
			out = append(out, copy)
		}
	}
	return out
}

func instructionsForToken(token *VerifiedToken) string {
	if token.ShareID == "" {
		return mcpInstructions
	}
	return mcpInstructions + fmt.Sprintf(
		" This connection uses a temporary device share (%s), limited to the explicitly shared devices and scopes %s. It expires at %s and may be revoked earlier. The share does not grant account management, device pairing, OAuth refresh, or permission to create further shares.",
		token.ShareID, strings.Join(token.Scopes, " "), time.Unix(token.ExpiresAt, 0).UTC().Format(time.RFC3339))
}

// Registration precedes the database recheck. Otherwise a revoke between
// verifyBearer and registration could miss a newly admitted invocation.
func (a *App) shareCallContext(parent context.Context, token *VerifiedToken, deviceID string) (context.Context, func(), error) {
	if !token.allowsDevice(deviceID) || token.ExpiresAt <= nowUnix() {
		return nil, nil, errShareAuthorization
	}
	ctx, cancel := context.WithDeadline(parent, time.Unix(token.ExpiresAt, 0))
	call := &shareInvocation{cancel: cancel}
	a.shareCallsMu.Lock()
	if a.shareCalls == nil {
		a.shareCalls = make(map[string]map[*shareInvocation]struct{})
	}
	if a.shareCalls[token.ShareID] == nil {
		a.shareCalls[token.ShareID] = make(map[*shareInvocation]struct{})
	}
	a.shareCalls[token.ShareID][call] = struct{}{}
	a.shareCallsMu.Unlock()
	release := func() {
		cancel()
		a.shareCallsMu.Lock()
		delete(a.shareCalls[token.ShareID], call)
		if len(a.shareCalls[token.ShareID]) == 0 {
			delete(a.shareCalls, token.ShareID)
		}
		a.shareCallsMu.Unlock()
	}
	authorize := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		active, err := a.store.ShareAllowsDevice(ctx, token.ShareID, token.UserID, token.Audience, deviceID)
		if err != nil || !active {
			return errShareAuthorization
		}
		return ctx.Err()
	}
	if err := authorize(); err != nil {
		release()
		return nil, nil, err
	}
	// Recheck after waiting for the websocket writer too. A share revoked in
	// storage must not execute merely because an HTTP request was accepted.
	return context.WithValue(ctx, deviceDispatchGuardKey{}, authorize), release, nil
}

func (a *App) cancelShareCalls(shareID string) {
	a.shareCallsMu.Lock()
	defer a.shareCallsMu.Unlock()
	for call := range a.shareCalls[shareID] {
		call.cancel()
	}
}

func (a *App) callAuthorizedDevice(ctx context.Context, token *VerifiedToken, device *LiveDevice, tool Tool, args json.RawMessage) (CallToolResult, error) {
	ctx = withWorkspaceCaller(ctx, token)
	if token.ShareID != "" {
		var release func()
		var err error
		ctx, release, err = a.shareCallContext(ctx, token, device.ID)
		if err != nil {
			return CallToolResult{}, err
		}
		defer release()
	}
	return device.call(ctx, tool.Name, args, toolExecutionTimeout(tool.Name, args))
}
