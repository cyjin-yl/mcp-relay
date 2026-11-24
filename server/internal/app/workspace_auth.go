package app

import "context"

// Caller identity is supplied only by the authenticated server, never by tool
// arguments. Its opaque key is stable across OAuth refreshes, but shares and
// distinct clients remain separate owners of an isolated desktop lease.
type deviceCallerContextKey struct{}

type deviceCaller struct {
	OwnerKey               string `json:"ownerKey"`
	AuthorizationExpiresAt int64  `json:"authorizationExpiresAt"`
}

func workspaceShareOwner(shareID string) string {
	return hashToken("computer-workspace-share\x00" + shareID)
}

func workspaceCaller(token *VerifiedToken) deviceCaller {
	key := workspaceShareOwner(token.ShareID)
	if token.ShareID == "" {
		key = hashToken("computer-workspace-user\x00" + token.UserID + "\x00" + token.ClientID)
	}
	return deviceCaller{OwnerKey: key, AuthorizationExpiresAt: token.ExpiresAt * 1000}
}

func withWorkspaceCaller(ctx context.Context, token *VerifiedToken) context.Context {
	return context.WithValue(ctx, deviceCallerContextKey{}, workspaceCaller(token))
}

// Completed HTTP calls do not remain in shareCalls. Revocation therefore also
// revokes any persistent desktop lease on the same authenticated device socket.
// Old clients cannot hold these leases and receive no unknown control frames.
func (a *App) revokeWorkspaceShare(userID, shareID string) {
	owner := workspaceShareOwner(shareID)
	for _, device := range a.registry.ListForUser(userID) {
		supported := false
		for _, tool := range device.Tools {
			if tool.Name == "computer_session" {
				supported = true
				break
			}
		}
		if !supported || device.conn == nil {
			continue
		}
		go func(d *LiveDevice) {
			if err := d.send(map[string]any{"type": "workspace_revoke", "ownerKey": owner}); err != nil {
				// Closing the transport is also a revocation signal; the native
				// watchdog is the final bounded fallback if the peer is gone.
				_ = d.conn.Close()
			}
		}(device)
	}
}
