package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestWorkspaceCallerStableAndScoped(t *testing.T) {
	first := &VerifiedToken{UserID: "owner", ClientID: "client-a", ExpiresAt: 2000000000}
	renewed := *first
	renewed.ExpiresAt++
	if workspaceCaller(first).OwnerKey != workspaceCaller(&renewed).OwnerKey {
		t.Fatal("OAuth refresh changed desktop owner")
	}
	keys := map[string]bool{workspaceCaller(first).OwnerKey: true}
	for _, token := range []*VerifiedToken{
		{UserID: "owner", ClientID: "client-b"},
		{UserID: "other", ClientID: "client-a"},
		{UserID: "owner", ClientID: "client-a", ShareID: "share-one"},
		{UserID: "owner", ClientID: "client-a", ShareID: "share-two"},
	} {
		key := workspaceCaller(token).OwnerKey
		if keys[key] || strings.Contains(key, "owner") || strings.Contains(key, "share-") {
			t.Fatalf("workspace owner identity leaked or collided: %q", key)
		}
		keys[key] = true
	}
	if workspaceCaller(first).AuthorizationExpiresAt != first.ExpiresAt*1000 {
		t.Fatal("device authorization expiry is not in milliseconds")
	}
}

func TestAuthorizedDeviceCallBindsWorkspaceCallerOutsideArguments(t *testing.T) {
	device, peer := liveDevicePair(t)
	app := &App{}
	token := &VerifiedToken{UserID: "owner", ClientID: "trusted-client", ExpiresAt: nowUnix() + 3600}
	done := make(chan error, 1)
	go func() {
		_, err := app.callAuthorizedDevice(context.Background(), token, device,
			Tool{Name: "computer_session"},
			json.RawMessage(`{"action":"open","caller":{"ownerKey":"forged","authorizationExpiresAt":9999999999999}}`))
		done <- err
	}()
	var call struct {
		ID     string       `json:"id"`
		Caller deviceCaller `json:"caller"`
	}
	_ = peer.SetReadDeadline(time.Now().Add(3 * time.Second))
	if err := peer.ReadJSON(&call); err != nil {
		t.Fatal(err)
	}
	if call.Caller != workspaceCaller(token) {
		t.Fatalf("wrong server identity: %+v", call.Caller)
	}
	device.deliver(call.ID, textResult("opened", false))
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestShareRevocationReachesWorkspaceAfterOpenCallFinishes(t *testing.T) {
	app, server := newTestApp(t)
	owner, cookie, csrf := testUser(t, app, "workspace-share")
	registered := shareMCPDevice(t, app, owner.ID, "workspace-device")
	device, peer := liveDevicePair(t)
	device.ID, device.UserID = registered.ID, registered.UserID
	device.Tools = []Tool{{Name: "computer_session", InputSchema: json.RawMessage(`{"type":"object"}`)}}
	app.registry.Unregister(registered)
	app.registry.Register(device)
	share, _, token := shareMCPToken(t, app, owner.ID, []string{device.ID}, []string{scopeRead, scopeWrite})
	done := make(chan error, 1)
	go func() {
		_, err := app.callAuthorizedDevice(context.Background(), token, device,
			device.Tools[0], json.RawMessage(`{"action":"open"}`))
		done <- err
	}()
	var call struct {
		ID     string       `json:"id"`
		Caller deviceCaller `json:"caller"`
	}
	_ = peer.SetReadDeadline(time.Now().Add(3 * time.Second))
	if err := peer.ReadJSON(&call); err != nil {
		t.Fatal(err)
	}
	if call.Caller.OwnerKey != workspaceShareOwner(share.ID) || call.Caller.AuthorizationExpiresAt != token.ExpiresAt*1000 {
		t.Fatalf("share identity/expiry did not reach device: %+v", call.Caller)
	}
	device.deliver(call.ID, textResult("opened", false))
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	app.shareCallsMu.Lock()
	active := len(app.shareCalls[share.ID])
	app.shareCallsMu.Unlock()
	if active != 0 {
		t.Fatal("finished request remained active")
	}
	shareOwnerRevoke(t, server, cookie, csrf, share.ID)
	var frame map[string]any
	if err := peer.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
	if frame["type"] != "workspace_revoke" || frame["ownerKey"] != call.Caller.OwnerKey {
		t.Fatalf("idle workspace did not receive scoped revocation: %v", frame)
	}
}

func TestWorkspaceSessionAlwaysUsesWriteScopeAndComputerDeadline(t *testing.T) {
	if !isComputerWriteTool("computer_session") || !isComputerTool("computer_session") {
		t.Fatal("desktop lease lifecycle must use computer write authorization")
	}
	if got := toolExecutionTimeout("computer_session", json.RawMessage(`{"timeout_ms":120000}`)); got != 123*time.Second {
		t.Fatalf("workspace lifecycle lost native cleanup deadline: %v", got)
	}
}

func TestInteractiveWorkspaceLoginKeepsExplicitBudget(t *testing.T) {
	for _, tc := range []struct {
		args string
		want time.Duration
	}{
		{`{"operation":"open","interactive_sign_in":true}`, 123 * time.Second},
		{`{"operation":"open","interactive_sign_in":true,"timeout_ms":5000}`, 8 * time.Second},
		{`{"operation":"open"}`, 33 * time.Second},
		{`{"operation":"status","interactive_sign_in":true}`, 33 * time.Second},
	} {
		if got := toolExecutionTimeout("computer_session", json.RawMessage(tc.args)); got != tc.want {
			t.Fatalf("%s: got %v, want %v", tc.args, got, tc.want)
		}
	}
}
