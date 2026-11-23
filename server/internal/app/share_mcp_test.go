package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func shareMCPDevice(t *testing.T, a *App, userID, id string) *LiveDevice {
	t.Helper()
	_, err := a.store.DB.Exec(`INSERT INTO devices
		(id,user_id,slug,name,platform,arch,packs,token_hash,created_at)
		VALUES (?,?,?,?,?,?,?,?,?)`, id, userID, id, id, "linux", "x64", `["minimal"]`, hashToken(id), nowUnix())
	if err != nil {
		t.Fatal(err)
	}
	ro := true
	d := &LiveDevice{ID: id, UserID: userID, Slug: id, Name: id,
		Tools: []Tool{
			{Name: "read", Description: "read file", InputSchema: json.RawMessage(`{"type":"object"}`), Annotations: &Annotations{ReadOnly: &ro}},
			{Name: "write", Description: "write file", InputSchema: json.RawMessage(`{"type":"object"}`)},
			{Name: "bash", Description: "shell", InputSchema: json.RawMessage(`{"type":"object"}`)},
		}, ToolIndex: make(map[string]Tool), pending: make(map[string]chan CallToolResult), closed: make(chan struct{})}
	for _, tool := range d.Tools {
		d.ToolIndex[deviceToolName(d.Slug, tool.Name)] = tool
	}
	a.registry.Register(d)
	return d
}

func shareMCPToken(t *testing.T, a *App, userID string, ids, scopes []string) (*DeviceShare, string, *VerifiedToken) {
	t.Helper()
	share, claim, err := a.store.CreateShare(userID, a.cfg.Resource, "rescue", ids, scopes, 3600)
	if err != nil {
		t.Fatal(err)
	}
	_, raw, err := a.store.ClaimShare(hashToken(claim), a.cfg.Resource)
	if err != nil {
		t.Fatal(err)
	}
	token, err := a.store.VerifyShareToken(hashToken(raw), a.cfg.Resource)
	if err != nil || token == nil {
		t.Fatalf("verify delegated token: %v", err)
	}
	return share, raw, token
}

func shareMCPRequest(t *testing.T, server *httptest.Server, raw, method string, params any) (int, []byte) {
	t.Helper()
	status, _, body := doJSONWithAuth(t, http.DefaultClient, server.URL+"/mcp", raw, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	return status, body
}

func shareOwnerRevoke(t *testing.T, server *httptest.Server, cookie *http.Cookie, csrf, id string) {
	t.Helper()
	req, _ := http.NewRequest("POST", server.URL+"/api/shares/"+id+"/revoke", nil)
	req.AddCookie(cookie)
	req.Header.Set("X-CSRF-Token", csrf)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("revoke: %d %s", response.StatusCode, body)
	}
}

func TestShareMCPScopeAndDeviceIsolation(t *testing.T) {
	a, server := newTestApp(t)
	owner, _, _ := testUser(t, a, "share-owner")
	other, _, _ := testUser(t, a, "share-other")
	shareMCPDevice(t, a, owner.ID, "selected-a")
	shareMCPDevice(t, a, owner.ID, "selected-b")
	shareMCPDevice(t, a, owner.ID, "private-c")
	shareMCPDevice(t, a, other.ID, "other-d")
	_, raw, _ := shareMCPToken(t, a, owner.ID, []string{"selected-a", "selected-b"}, []string{scopeRead})

	for _, request := range []struct {
		method string
		params any
	}{
		{"tools/list", map[string]any{}},
		{"tools/call", map[string]any{"name": "devices_list"}},
	} {
		status, body := shareMCPRequest(t, server, raw, request.method, request.params)
		if status != 200 || !strings.Contains(string(body), "selected-a") || !strings.Contains(string(body), "selected-b") {
			t.Fatalf("authorized devices missing: %d %s", status, body)
		}
		for _, forbidden := range []string{"private-c", "other-d", "__write", "__bash"} {
			if strings.Contains(string(body), forbidden) {
				t.Fatalf("share exposed %q: %s", forbidden, body)
			}
		}
	}
	status, body := shareMCPRequest(t, server, raw, "tools/call", map[string]any{"name": "device_tools_list", "arguments": map[string]any{"device": "selected-a"}})
	if status != 200 || !strings.Contains(string(body), `"name":"read"`) || strings.Contains(string(body), `"name":"bash"`) {
		t.Fatalf("raw tool discovery escaped scope: %d %s", status, body)
	}
	for _, device := range []string{"private-c", "other-d", "missing-device"} {
		for _, params := range []map[string]any{
			{"name": "device_tools_list", "arguments": map[string]any{"device": device}},
			{"name": "device_call", "arguments": map[string]any{"device": device, "tool": "read"}},
			{"name": deviceToolName(device, "read"), "arguments": map[string]any{}},
		} {
			status, body := shareMCPRequest(t, server, raw, "tools/call", params)
			if status != 200 || !strings.Contains(string(body), `"isError":true`) {
				t.Fatalf("unshared device accepted: %d %s", status, body)
			}
		}
	}
	for _, params := range []map[string]any{
		{"name": "device_call", "arguments": map[string]any{"device": "selected-a", "tool": "write"}},
		{"name": deviceToolName("selected-b", "bash"), "arguments": map[string]any{}},
	} {
		status, body := shareMCPRequest(t, server, raw, "tools/call", params)
		if status != http.StatusForbidden || !strings.Contains(string(body), "insufficient_scope") {
			t.Fatalf("read share accepted mutation: %d %s", status, body)
		}
	}
	if len(a.mcpDeviceLimiter.hits) != 2 {
		t.Fatalf("unshared devices allocated execution buckets: %v", a.mcpDeviceLimiter.hits)
	}
}

func TestShareTokenCannotManageOwnerOrRefresh(t *testing.T) {
	a, server := newTestApp(t)
	owner, _, _ := testUser(t, a, "share-no-management")
	shareMCPDevice(t, a, owner.ID, "selected")
	share, raw, _ := shareMCPToken(t, a, owner.ID, []string{"selected"}, []string{scopeRead, scopeWrite})
	for _, target := range []struct{ method, path string }{
		{"GET", "/api/me"}, {"GET", "/api/devices"}, {"GET", "/api/shares"}, {"GET", "/api/audit"},
		{"POST", "/api/shares"}, {"POST", "/api/shares/" + share.ID + "/revoke"},
		{"POST", "/api/pairing-code"}, {"POST", "/api/devices/selected/revoke"},
	} {
		req, _ := http.NewRequest(target.method, server.URL+target.path, strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer "+raw)
		req.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("delegated token accepted for %s %s: %d", target.method, target.path, response.StatusCode)
		}
	}
	req, _ := http.NewRequest("POST", server.URL+"/oauth/token", strings.NewReader("grant_type=refresh_token&refresh_token="+raw+"&client_id=share:"+share.ID))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode < 400 {
		t.Fatal("share token obtained OAuth refresh")
	}
}

func TestShareRevocationInvalidatesInitializedClient(t *testing.T) {
	a, server := newTestApp(t)
	owner, cookie, csrf := testUser(t, a, "share-revoke")
	shareMCPDevice(t, a, owner.ID, "selected")
	share, raw, staleToken := shareMCPToken(t, a, owner.ID, []string{"selected"}, []string{scopeRead})
	status, body := shareMCPRequest(t, server, raw, "initialize", map[string]any{"protocolVersion": "2025-11-25"})
	if status != 200 || !strings.Contains(string(body), share.ID) {
		t.Fatalf("initialization: %d %s", status, body)
	}
	shareOwnerRevoke(t, server, cookie, csrf, share.ID)
	status, _ = shareMCPRequest(t, server, raw, "tools/list", map[string]any{})
	if status != http.StatusUnauthorized {
		t.Fatalf("initialized client survived revoke: %d", status)
	}
	// Reproduce verification before revocation but registration afterwards.
	_, _, err := a.shareCallContext(context.Background(), staleToken, "selected")
	if !errors.Is(err, errShareAuthorization) {
		t.Fatalf("stale verified token admitted after revoke: %v", err)
	}
	a.shareCallsMu.Lock()
	defer a.shareCallsMu.Unlock()
	if len(a.shareCalls) != 0 {
		t.Fatal("denied authorization leaked active invocation")
	}
}

func TestShareDispatchBudgetAndCancellation(t *testing.T) {
	for _, scenario := range []string{"revoke_running", "revoke_queued", "expiry_running"} {
		t.Run(scenario, func(t *testing.T) {
			a, server := newTestApp(t)
			owner, cookie, csrf := testUser(t, a, scenario)
			registered := shareMCPDevice(t, a, owner.ID, "selected")
			device, peer := liveDevicePair(t)
			device.ID, device.UserID, device.Slug, device.Name = registered.ID, registered.UserID, registered.Slug, registered.Name
			device.Tools, device.ToolIndex = registered.Tools, registered.ToolIndex
			a.registry.Unregister(registered)
			a.registry.Register(device)
			share, raw, token := shareMCPToken(t, a, owner.ID, []string{"selected"}, []string{scopeRead, scopeWrite})
			if scenario == "expiry_running" {
				if _, err := a.store.DB.Exec(`UPDATE device_shares SET expires_at = ? WHERE id = ?`, nowUnix()+2, share.ID); err != nil {
					t.Fatal(err)
				}
				var err error
				token, err = a.store.VerifyShareToken(hashToken(raw), a.cfg.Resource)
				if err != nil || token == nil {
					t.Fatalf("expiry fixture: %v", err)
				}
			}
			locked := scenario == "revoke_queued"
			if locked {
				device.writeMu.Lock()
			}
			defer func() {
				if locked {
					device.writeMu.Unlock()
				}
			}()
			done := make(chan error, 1)
			go func() {
				_, err := a.callAuthorizedDevice(context.Background(), token, device, device.Tools[2], json.RawMessage(`{"timeout_ms":120000}`))
				done <- err
			}()
			var call map[string]any
			_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
			if !locked {
				if err := peer.ReadJSON(&call); err != nil {
					t.Fatal(err)
				}
				if call["type"] != "call" {
					t.Fatalf("expected call: %v", call)
				}
				if scenario == "expiry_running" {
					if budget := call["timeoutMs"].(float64); budget <= 0 || budget > 2000 {
						t.Fatalf("device budget exceeds share expiry: %v", budget)
					}
				}
			} else {
				deadline := time.Now().Add(2 * time.Second)
				for {
					device.pendingMu.Lock()
					ready := device.inflight == 1
					device.pendingMu.Unlock()
					if ready {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("queued share call was not admitted")
					}
					time.Sleep(time.Millisecond)
				}
			}
			if scenario != "expiry_running" {
				shareOwnerRevoke(t, server, cookie, csrf, share.ID)
			}
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("expected authorization cancellation: %v", err)
				}
			case <-time.After(4 * time.Second):
				t.Fatal("revoked/expired call remained active")
			}
			if locked {
				device.writeMu.Unlock()
				locked = false
			}
			var stop map[string]any
			if err := peer.ReadJSON(&stop); err != nil {
				t.Fatal(err)
			}
			if stop["type"] != "cancel" || (call != nil && stop["id"] != call["id"]) {
				t.Fatalf("expected cancel, never a late mutation: %v", stop)
			}
			if status, _ := shareMCPRequest(t, server, raw, "ping", map[string]any{}); status != http.StatusUnauthorized {
				t.Fatalf("expired/revoked token remained usable: %d", status)
			}
		})
	}
}

func TestShareDispatchRechecksCancellationAfterAuthorization(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx = context.WithValue(ctx, deviceDispatchGuardKey{}, func() error {
		// Model cancellation while a database authorization query is in flight.
		cancel()
		return nil
	})
	device := &LiveDevice{}
	err := device.sendCall(ctx, time.Now().Add(time.Minute), "not-sent", "write", json.RawMessage(`{}`))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled authorization was dispatched: %v", err)
	}
}

type shareBlockedBody struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	reader  io.Reader
}

func (b *shareBlockedBody) Read(p []byte) (int, error) {
	b.once.Do(func() {
		close(b.entered)
		<-b.release
	})
	return b.reader.Read(p)
}

func (b *shareBlockedBody) Close() error { return nil }

func TestShareDiscoveryRevalidatesAfterSlowRequestBody(t *testing.T) {
	a, _ := newTestApp(t)
	owner, _, _ := testUser(t, a, "share-slow-body")
	shareMCPDevice(t, a, owner.ID, "selected")
	share, raw, _ := shareMCPToken(t, a, owner.ID, []string{"selected"}, []string{scopeRead})
	body := &shareBlockedBody{entered: make(chan struct{}), release: make(chan struct{}),
		reader: strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)}
	req := httptest.NewRequest("POST", "/mcp", nil)
	req.Body = body
	req.Header.Set("Authorization", "Bearer "+raw)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { a.Handler().ServeHTTP(w, req); close(done) }()
	select {
	case <-body.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not reach body read")
	}
	if err := a.store.RevokeShare(share.ID, owner.ID); err != nil {
		close(body.release)
		t.Fatal(err)
	}
	close(body.release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not finish")
	}
	if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "selected") {
		t.Fatalf("revoked slow request disclosed devices: %d %s", w.Code, w.Body.String())
	}
}

func TestSharedDeviceCallsActuallyReachOnlyTheGrantedDevice(t *testing.T) {
	a, server := newTestApp(t)
	owner, _, _ := testUser(t, a, "share-dispatch")
	registered := shareMCPDevice(t, a, owner.ID, "selected")
	device, peer := liveDevicePair(t)
	device.ID, device.UserID, device.Slug, device.Name = registered.ID, registered.UserID, registered.Slug, registered.Name
	device.Tools, device.ToolIndex = registered.Tools, registered.ToolIndex
	a.registry.Unregister(registered)
	a.registry.Register(device)
	_, raw, _ := shareMCPToken(t, a, owner.ID, []string{"selected"}, []string{scopeRead, scopeWrite})
	for _, params := range []map[string]any{
		{"name": "device_call", "arguments": map[string]any{"device": "selected", "tool": "read", "arguments": map[string]any{"path": "example"}}},
		{"name": deviceToolName("selected", "write"), "arguments": map[string]any{"path": "example", "content": "ok"}},
	} {
		delivered := make(chan error, 1)
		go func() {
			var call struct {
				ID string `json:"id"`
			}
			_ = peer.SetReadDeadline(time.Now().Add(3 * time.Second))
			if err := peer.ReadJSON(&call); err != nil {
				delivered <- err
				return
			}
			device.deliver(call.ID, textResult("granted-device-result", false))
			delivered <- nil
		}()
		status, body := shareMCPRequest(t, server, raw, "tools/call", params)
		if status != 200 || !strings.Contains(string(body), "granted-device-result") {
			t.Fatalf("authorized dispatch failed: %d %s", status, body)
		}
		if err := <-delivered; err != nil {
			t.Fatal(err)
		}
	}
}
