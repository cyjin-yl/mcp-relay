package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func shareAPITestApp(t *testing.T) *App {
	t.Helper()
	app, err := New(Config{
		BaseURL: "https://relay.example.test", Resource: "https://relay.example.test/mcp",
		Issuer: "https://relay.example.test", DBPath: filepath.Join(t.TempDir(), "relay.sqlite"), SessionTTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	return app
}

func shareAPITestDevice(t *testing.T, app *App, userID, id string) {
	t.Helper()
	_, err := app.store.DB.Exec(`INSERT INTO devices (id, user_id, slug, name, packs, token_hash, created_at)
		VALUES (?, ?, ?, ?, '[]', ?, ?)`, id, userID, id+"-slug", id+" name", hashToken(id), nowUnix())
	if err != nil {
		t.Fatal(err)
	}
}

func shareAPITestRequest(t *testing.T, app *App, method, path string, body any, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	app.Handler().ServeHTTP(w, req)
	return w
}

func shareAPITestCreate(t *testing.T, app *App, cookie *http.Cookie, csrf string, ids []string) (*DeviceShare, string) {
	t.Helper()
	w := shareAPITestRequest(t, app, "POST", "/api/shares", map[string]any{
		"label": "Help with device", "deviceIds": ids, "permission": "write", "ttlSeconds": 3600,
	}, cookie, csrf)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var payload struct {
		Share    DeviceShare `json:"share"`
		ClaimURL string      `json:"claimUrl"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(payload.ClaimURL)
	if err != nil || u.RawQuery != "" || u.Path != "/share" {
		t.Fatalf("claim secret must only be in fragment: %q %v", payload.ClaimURL, err)
	}
	fragment, _ := url.ParseQuery(u.Fragment)
	return &payload.Share, fragment.Get("claim")
}

func TestShareAPIClaimBurnAndSecretHygiene(t *testing.T) {
	app := shareAPITestApp(t)
	u, cookie, csrf := testUser(t, app, "share-owner")
	shareAPITestDevice(t, app, u.ID, "dev_first")
	shareAPITestDevice(t, app, u.ID, "dev_second")
	share, claimToken := shareAPITestCreate(t, app, cookie, csrf, []string{"dev_first", "dev_second"})
	if share.Status != "pending" || share.ClaimedAt != 0 || share.RevokedAt != 0 || share.ExpiresAt-share.CreatedAt != 3600 || len(share.Devices) != 2 {
		t.Fatalf("created metadata: %+v", share)
	}
	var storedClaim string
	if err := app.store.DB.QueryRow(`SELECT claim_hash FROM device_shares WHERE id = ?`, share.ID).Scan(&storedClaim); err != nil || storedClaim != hashToken(claimToken) {
		t.Fatalf("claim hash not stored correctly: %v", err)
	}
	for _, method := range []string{"GET", "HEAD"} {
		req := httptest.NewRequest(method, "/share", nil)
		req.Header.Set("Accept", "text/markdown")
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, req)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), claimToken) || strings.Contains(w.Body.String(), "dev_first") {
			t.Fatalf("landing leaks capability or metadata: %d", w.Code)
		}
	}
	w := shareAPITestRequest(t, app, "POST", "/api/share-claims", map[string]any{"claimToken": claimToken}, nil, "")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("claim: %d %s", w.Code, w.Body.String())
	}
	var claimed struct {
		Share       DeviceShare `json:"share"`
		AccessToken string      `json:"accessToken"`
		Document    string      `json:"document"`
		ExpiresAt   int64       `json:"expiresAt"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	if claimed.Share.Status != "active" || claimed.ExpiresAt != share.ExpiresAt || !strings.HasPrefix(claimed.AccessToken, "mrshare_") {
		t.Fatalf("invalid claim metadata: %+v", claimed.Share)
	}
	for _, expected := range []string{claimed.AccessToken, "2025-11-25", "Authorization: Bearer", "Accept: application/json, text/event-stream", "notifications/initialized", "device_tools_list", "UTC", "dev_first", "dev_second"} {
		if !strings.Contains(claimed.Document, expected) {
			t.Errorf("connection document missing %q", expected)
		}
	}
	var burnt bool
	var storedAccess string
	if err := app.store.DB.QueryRow(`SELECT claim_hash IS NULL, access_hash FROM device_shares WHERE id = ?`, share.ID).Scan(&burnt, &storedAccess); err != nil || !burnt || storedAccess != hashToken(claimed.AccessToken) {
		t.Fatalf("claim not burnt/token not hashed: %v", err)
	}
	w = shareAPITestRequest(t, app, "POST", "/api/share-claims", map[string]any{"claimToken": claimToken}, nil, "")
	if w.Code != http.StatusGone {
		t.Fatalf("second claim succeeded: %d", w.Code)
	}
	w = shareAPITestRequest(t, app, "GET", "/api/shares", nil, cookie, "")
	if w.Code != 200 || strings.Contains(w.Body.String(), claimed.AccessToken) || strings.Contains(w.Body.String(), claimToken) || strings.Contains(w.Body.String(), storedAccess) || strings.Contains(w.Body.String(), storedClaim) {
		t.Fatalf("share listing exposes a secret: %d", w.Code)
	}
	for range 2 {
		verified, err := app.store.VerifyShareToken(hashToken(claimed.AccessToken), app.cfg.Resource)
		if err != nil || verified == nil || len(verified.AllowedDeviceIDs) != 2 || verified.UserID != u.ID {
			t.Fatalf("token must remain reusable: %v", err)
		}
	}
}

func TestShareAPIOwnerValidationAndRevoke(t *testing.T) {
	app := shareAPITestApp(t)
	owner, cookie, csrf := testUser(t, app, "owner-validation")
	other, otherCookie, otherCSRF := testUser(t, app, "other-validation")
	shareAPITestDevice(t, app, owner.ID, "dev_mine")
	shareAPITestDevice(t, app, other.ID, "dev_foreign")
	shareAPITestDevice(t, app, owner.ID, "dev_revoked")
	_, _ = app.store.DB.Exec(`UPDATE devices SET revoked_at = ? WHERE id = 'dev_revoked'`, nowUnix())
	valid := map[string]any{"label": "rescue", "deviceIds": []string{"dev_mine"}, "permission": "read", "ttlSeconds": 600}
	w := shareAPITestRequest(t, app, "POST", "/api/shares", valid, cookie, "")
	if w.Code != 403 {
		t.Fatalf("creation without CSRF: %d", w.Code)
	}
	w = shareAPITestRequest(t, app, "POST", "/api/shares", valid, nil, "")
	if w.Code != 401 {
		t.Fatalf("creation without session: %d", w.Code)
	}
	cases := []struct {
		field string
		value any
	}{
		{"deviceIds", []string{}}, {"deviceIds", []string{"dev_mine", "dev_mine"}},
		{"deviceIds", []string{"dev_foreign"}}, {"deviceIds", []string{"dev_revoked"}},
		{"ttlSeconds", 299}, {"ttlSeconds", 604801}, {"ttlSeconds", 3600.5},
		{"permission", "admin"}, {"permission", "offline_access"},
		{"label", strings.Repeat("长", 81)}, {"label", "x\ninstruction"}, {"unrecognized", true},
	}
	for _, tc := range cases {
		input := map[string]any{}
		for k, v := range valid {
			input[k] = v
		}
		input[tc.field] = tc.value
		w = shareAPITestRequest(t, app, "POST", "/api/shares", input, cookie, csrf)
		if w.Code != 400 {
			t.Errorf("accepted invalid %s=%v: %d %s", tc.field, tc.value, w.Code, w.Body.String())
		}
	}
	share, claimToken := shareAPITestCreate(t, app, cookie, csrf, []string{"dev_mine"})
	w = shareAPITestRequest(t, app, "POST", "/api/shares/"+share.ID+"/revoke", nil, otherCookie, otherCSRF)
	if w.Code != 404 {
		t.Fatalf("cross-owner revoke: %d", w.Code)
	}
	w = shareAPITestRequest(t, app, "GET", "/api/shares", nil, otherCookie, "")
	if w.Code != 200 || strings.Contains(w.Body.String(), share.ID) {
		t.Fatal("cross-owner list exposed share")
	}
	for range 2 {
		w = shareAPITestRequest(t, app, "POST", "/api/shares/"+share.ID+"/revoke", nil, cookie, csrf)
		if w.Code != 200 {
			t.Fatalf("own idempotent revoke: %d %s", w.Code, w.Body.String())
		}
	}
	w = shareAPITestRequest(t, app, "POST", "/api/share-claims", map[string]any{"claimToken": claimToken}, nil, "")
	if w.Code != 410 {
		t.Fatalf("revoked claim succeeded: %d", w.Code)
	}
}

func TestShareStoreConcurrentClaimHasOneWinner(t *testing.T) {
	app := shareAPITestApp(t)
	owner, _, _ := testUser(t, app, "claim-race")
	shareAPITestDevice(t, app, owner.ID, "dev_race")
	share, claimToken, err := app.store.CreateShare(owner.ID, app.cfg.Resource, "race", []string{"dev_race"}, []string{scopeRead}, 3600)
	if err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		token string
		err   error
	}
	results := make(chan outcome, 12)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, token, err := app.store.ClaimShare(hashToken(claimToken), app.cfg.Resource)
			results <- outcome{token, err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	winners := 0
	for result := range results {
		if result.err == nil {
			winners++
			verified, err := app.store.VerifyShareToken(hashToken(result.token), app.cfg.Resource)
			if err != nil || verified == nil || verified.ShareID != share.ID {
				t.Fatalf("winner unusable: %v", err)
			}
		} else if !errors.Is(result.err, errShareUnavailable) {
			t.Errorf("claim contention should not cause storage failures: %v", result.err)
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent claim winners=%d, want 1", winners)
	}
}

func TestShareStoreExpiryAudienceAndDeviceRevocation(t *testing.T) {
	app := shareAPITestApp(t)
	owner, _, _ := testUser(t, app, "share-expiry")
	shareAPITestDevice(t, app, owner.ID, "dev_scope_a")
	shareAPITestDevice(t, app, owner.ID, "dev_scope_b")
	share, claimToken, err := app.store.CreateShare(owner.ID, app.cfg.Resource, "expiry", []string{"dev_scope_a", "dev_scope_b"}, []string{scopeRead}, 3600)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := app.store.ClaimShare(hashToken(claimToken), "https://elsewhere.test/mcp"); !errors.Is(err, errShareUnavailable) {
		t.Fatalf("claim audience accepted: %v", err)
	}
	_, token, err := app.store.ClaimShare(hashToken(claimToken), app.cfg.Resource)
	if err != nil {
		t.Fatal(err)
	}
	if v, err := app.store.VerifyShareToken(hashToken(token), "https://elsewhere.test/mcp"); err != nil || v != nil {
		t.Fatal("wrong token audience accepted")
	}
	_, _ = app.store.DB.Exec(`UPDATE devices SET revoked_at = ? WHERE id = 'dev_scope_a'`, nowUnix())
	v, err := app.store.VerifyShareToken(hashToken(token), app.cfg.Resource)
	if err != nil || v == nil || v.AllowedDeviceIDs["dev_scope_a"] || !v.AllowedDeviceIDs["dev_scope_b"] {
		t.Fatal("revoked device still allowed or remaining device lost")
	}
	allowed, err := app.store.ShareAllowsDevice(context.Background(), share.ID, owner.ID, app.cfg.Resource, "dev_scope_a")
	if err != nil || allowed {
		t.Fatal("dispatch permits revoked device")
	}
	_, _ = app.store.DB.Exec(`UPDATE device_shares SET expires_at = ? WHERE id = ?`, nowUnix(), share.ID)
	v, err = app.store.VerifyShareToken(hashToken(token), app.cfg.Resource)
	if err != nil || v != nil {
		t.Fatal("expired token accepted without prune")
	}
	active, err := app.store.ShareActive(share.ID, owner.ID, app.cfg.Resource)
	if err != nil || active {
		t.Fatal("expired dispatch accepted without prune")
	}
	share2, claim2, err := app.store.CreateShare(owner.ID, app.cfg.Resource, "unclaimed expiry", []string{"dev_scope_b"}, []string{scopeRead}, 3600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = app.store.DB.Exec(`UPDATE device_shares SET expires_at = ? WHERE id = ?`, nowUnix(), share2.ID)
	if _, _, err := app.store.ClaimShare(hashToken(claim2), app.cfg.Resource); !errors.Is(err, errShareUnavailable) {
		t.Fatal("expired unclaimed link accepted without prune")
	}
}

func TestShareStoreRestartPreservesClaimAndRevocation(t *testing.T) {
	app := shareAPITestApp(t)
	owner, _, _ := testUser(t, app, "share-restart")
	shareAPITestDevice(t, app, owner.ID, "dev_restart")
	share, claimToken, err := app.store.CreateShare(owner.ID, app.cfg.Resource, "restart", []string{"dev_restart"}, []string{scopeRead}, 3600)
	if err != nil {
		t.Fatal(err)
	}
	_, accessToken, err := app.store.ClaimShare(hashToken(claimToken), app.cfg.Resource)
	if err != nil {
		t.Fatal(err)
	}
	reopen := func() {
		t.Helper()
		if err := app.store.Close(); err != nil {
			t.Fatal(err)
		}
		reopened, err := OpenStore(app.cfg.DBPath)
		if err != nil {
			t.Fatal(err)
		}
		app.store = reopened
	}
	reopen()
	verified, err := app.store.VerifyShareToken(hashToken(accessToken), app.cfg.Resource)
	if err != nil || verified == nil || verified.ShareID != share.ID || !verified.AllowedDeviceIDs["dev_restart"] {
		t.Fatalf("claimed access not durable after reopen: %v", err)
	}
	if _, _, err := app.store.ClaimShare(hashToken(claimToken), app.cfg.Resource); !errors.Is(err, errShareUnavailable) {
		t.Fatalf("reopen revived consumed claim: %v", err)
	}
	if err := app.store.RevokeShare(share.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	reopen()
	verified, err = app.store.VerifyShareToken(hashToken(accessToken), app.cfg.Resource)
	if err != nil || verified != nil {
		t.Fatalf("reopen revived revoked access: %v", err)
	}
	if _, _, err := app.store.ClaimShare(hashToken(claimToken), app.cfg.Resource); !errors.Is(err, errShareUnavailable) {
		t.Fatalf("reopen revived revoked claim: %v", err)
	}
	shares, err := app.store.ListShares(owner.ID)
	if err != nil || len(shares) != 1 || shares[0].Status != "revoked" || shares[0].ClaimedAt == 0 || shares[0].RevokedAt == 0 {
		t.Fatalf("state history lost after restart: %v %+v", err, shares)
	}
}

func TestShareStoreClaimRechecksExpiryAfterWriterWait(t *testing.T) {
	app := shareAPITestApp(t)
	owner, _, _ := testUser(t, app, "share-writer-wait")
	shareAPITestDevice(t, app, owner.ID, "dev_writer_wait")
	share, claimToken, err := app.store.CreateShare(owner.ID, app.cfg.Resource, "wait", []string{"dev_writer_wait"}, []string{scopeRead}, 3600)
	if err != nil {
		t.Fatal(err)
	}
	blocker, err := app.store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	expiresAt := nowUnix() + 2
	// This write holds SQLite's writer lock while a second connection attempts
	// to claim. The old check based on a Go timestamp captured before the wait
	// could issue an already-expired token when the lock finally became free.
	if _, err := blocker.Exec(`UPDATE device_shares SET expires_at = ? WHERE id = ?`, expiresAt, share.ID); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		close(started)
		_, _, err := app.store.ClaimShare(hashToken(claimToken), app.cfg.Resource)
		finished <- err
	}()
	<-started
	<-time.After(time.Until(time.Unix(expiresAt, 0).Add(100 * time.Millisecond)))
	if err := blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if !errors.Is(err, errShareUnavailable) {
			t.Fatalf("claim admitted after waiting beyond expiry: %v", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("blocked claim did not finish")
	}
	var unclaimed bool
	if err := app.store.DB.QueryRow(`SELECT claimed_at IS NULL AND access_hash IS NULL FROM device_shares WHERE id = ?`, share.ID).Scan(&unclaimed); err != nil || !unclaimed {
		t.Fatalf("expired blocked claim still issued credentials: %v", err)
	}
}

func TestShareStoreLiveShareCannotBeHiddenByHistory(t *testing.T) {
	app := shareAPITestApp(t)
	owner, _, _ := testUser(t, app, "share-list-history")
	shareAPITestDevice(t, app, owner.ID, "dev_history")
	share, _, err := app.store.CreateShare(owner.ID, app.cfg.Resource, "old but live", []string{"dev_history"}, []string{scopeRead}, 7*24*3600)
	if err != nil {
		t.Fatal(err)
	}
	now := nowUnix()
	if _, err := app.store.DB.Exec(`UPDATE device_shares SET created_at = ? WHERE id = ?`, now-86400, share.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := app.store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for i := range 201 {
		_, err := tx.Exec(`INSERT INTO device_shares (id, user_id, label, scope, audience, created_at, expires_at, revoked_at)
			VALUES (?, ?, 'newer revoked history', ?, ?, ?, ?, ?)`, fmt.Sprintf("shr_history_%03d", i), owner.ID, scopeRead, app.cfg.Resource, now-int64(i), now+3600, now)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	shares, err := app.store.ListShares(owner.ID)
	if err != nil || len(shares) != 200 {
		t.Fatalf("listing history: %v len=%d", err, len(shares))
	}
	if shares[0].ID != share.ID || shares[0].Status != "pending" {
		t.Fatalf("usable share hidden behind revoked history: first=%+v", shares[0])
	}
}
