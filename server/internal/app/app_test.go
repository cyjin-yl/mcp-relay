package app

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func newTestApp(t *testing.T) (*App, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	cfg := Config{
		BaseURL:        "http://localhost:8080",
		Issuer:         "http://localhost:8080",
		Resource:       "http://localhost:8080/mcp",
		Addr:           "127.0.0.1:0",
		DataDir:        dir,
		DBPath:         filepath.Join(dir, "relay.sqlite"),
		Env:            "test",
		SecureCookies:  false,
		InviteRequired: false,
		SessionTTL:     time.Hour,
	}
	app, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	server := httptest.NewServer(app.Handler())
	t.Cleanup(server.Close)
	return app, server
}

func testUser(t *testing.T, app *App, login string) (*User, *http.Cookie, string) {
	t.Helper()
	user, err := app.store.CreateUser("gh-"+login, login, login+"@example.com", "active", false)
	if err != nil {
		t.Fatal(err)
	}
	token, csrf, expiresAt, err := app.store.CreateSession(user.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: "mrl_session", Value: token, Expires: time.Unix(expiresAt, 0)}
	return user, cookie, csrf
}

func newHTTPClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{
		Jar: jar,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Timeout: 10 * time.Second,
	}
}

func doJSON(t *testing.T, client *http.Client, method, endpoint string, body any) (int, http.Header, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = strings.NewReader(string(raw))
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, data
}

func doForm(t *testing.T, client *http.Client, endpoint string, values url.Values) (int, http.Header, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, data
}

func TestOAuthCodeFlowAndMCP(t *testing.T) {
	app, server := newTestApp(t)
	user, cookie, csrf := testUser(t, app, "alice")
	client := newHTTPClient()
	client.Jar.SetCookies(mustURL(server.URL), []*http.Cookie{cookie})

	status, _, body := doJSON(t, client, http.MethodPost, server.URL+"/oauth/register", map[string]any{
		"client_name":                "flow-test",
		"redirect_uris":              []string{"http://127.0.0.1:18765/callback"},
		"token_endpoint_auth_method": "none",
	})
	if status != http.StatusCreated {
		t.Fatalf("DCR status %d: %s", status, body)
	}
	var registration struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal(body, &registration); err != nil || registration.ClientID == "" {
		t.Fatalf("DCR response: %s", body)
	}

	verifier := strings.Repeat("a", 48)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	redirectURI := "http://127.0.0.1:18765/callback"
	query := url.Values{
		"response_type":         {"code"},
		"client_id":             {registration.ClientID},
		"redirect_uri":          {redirectURI},
		"state":                 {"state-1"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"scope":                 {"relay.read relay.write"},
		"resource":              {"http://localhost:8080/mcp"},
	}
	authorizeURL := server.URL + "/oauth/authorize?" + query.Encode()
	resp, err := client.Get(authorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	pageBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("authorize status %d: %s", resp.StatusCode, pageBody)
	}
	pending := regexp.MustCompile(`name="pending" value="([^"]+)"`).FindSubmatch(pageBody)
	if len(pending) != 2 {
		t.Fatalf("no pending id in consent page: %s", pageBody)
	}
	status, headers, body := doForm(t, client, server.URL+"/oauth/authorize/decision", url.Values{
		"pending":  {string(pending[1])},
		"_csrf":    {csrf},
		"decision": {"approve"},
	})
	if status != http.StatusFound {
		t.Fatalf("decision status %d: %s", status, body)
	}
	location, err := url.Parse(headers.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if location.Query().Get("iss") != app.cfg.Issuer {
		t.Fatalf("missing iss: %s", location)
	}
	code := location.Query().Get("code")
	if code == "" {
		t.Fatalf("missing code: %s", location)
	}

	status, _, body = doForm(t, client, server.URL+"/oauth/token", url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {registration.ClientID},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
		"resource":      {"http://localhost:8080/mcp"},
	})
	if status != http.StatusOK {
		t.Fatalf("token status %d: %s", status, body)
	}
	var tokens struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
	}
	if err := json.Unmarshal(body, &tokens); err != nil || tokens.AccessToken == "" || tokens.RefreshToken == "" {
		t.Fatalf("token response: %s", body)
	}

	// Authorization codes are single-use.
	status, _, _ = doForm(t, client, server.URL+"/oauth/token", url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {registration.ClientID},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
		"resource":      {"http://localhost:8080/mcp"},
	})
	if status != http.StatusBadRequest {
		t.Fatalf("code replay status %d", status)
	}

	// Refresh rotation: old token must die, and a replay revokes the family.
	status, _, body = doForm(t, client, server.URL+"/oauth/token", url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {registration.ClientID},
		"refresh_token": {tokens.RefreshToken},
		"resource":      {"http://localhost:8080/mcp"},
	})
	if status != http.StatusOK {
		t.Fatalf("refresh status %d: %s", status, body)
	}
	var rotated struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = json.Unmarshal(body, &rotated)
	status, _, _ = doForm(t, client, server.URL+"/oauth/token", url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {registration.ClientID},
		"refresh_token": {tokens.RefreshToken},
		"resource":      {"http://localhost:8080/mcp"},
	})
	if status != http.StatusBadRequest {
		t.Fatalf("refresh replay status %d", status)
	}
	status, _, _ = doForm(t, client, server.URL+"/oauth/token", url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {registration.ClientID},
		"refresh_token": {rotated.RefreshToken},
		"resource":      {"http://localhost:8080/mcp"},
	})
	if status != http.StatusBadRequest {
		t.Fatalf("family revocation status %d", status)
	}

	// MCP requires the bearer token and lists the built-in tool.
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}`))
	req.Header.Set("Content-Type", "application/json")
	unauth, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	unauth.Body.Close()
	if unauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated MCP status %d", unauth.StatusCode)
	}
	if !strings.Contains(unauth.Header.Get("WWW-Authenticate"), "resource_metadata=") {
		t.Fatalf("missing challenge: %q", unauth.Header.Get("WWW-Authenticate"))
	}

	status, _, body = doJSONWithAuth(t, client, server.URL+"/mcp", tokens.AccessToken, map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{},
	})
	if status != http.StatusOK {
		t.Fatalf("tools/list status %d: %s", status, body)
	}
	var listed struct {
		Result struct {
			Tools []Tool `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Result.Tools) == 0 || listed.Result.Tools[0].Name != "devices_list" {
		t.Fatalf("unexpected tools: %s", body)
	}
	_ = user
}

func doJSONWithAuth(t *testing.T, client *http.Client, endpoint, token string, body any) (int, http.Header, []byte) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, data
}

func TestRegistryIsolation(t *testing.T) {
	registry := NewRegistry()
	readOnly := true
	device := &LiveDevice{
		ID:     "dev_a",
		UserID: "user_a",
		Slug:   "alpha",
		Name:   "alpha",
		Tools: []Tool{{
			Name:        "read",
			Description: "read",
			InputSchema: json.RawMessage(`{"type":"object"}`),
			Annotations: &Annotations{ReadOnly: &readOnly},
		}},
		ToolIndex: map[string]Tool{},
		conn:      nil,
		pending:   map[string]chan CallToolResult{},
		closed:    make(chan struct{}),
	}
	device.ToolIndex[deviceToolName(device.Slug, "read")] = device.Tools[0]
	registry.devices[device.ID] = device

	if len(registry.ToolsForUser("user_b")) != 0 {
		t.Fatal("user_b sees user_a tools")
	}
	if _, _, ok := registry.FindTool("user_b", deviceToolName("alpha", "read")); ok {
		t.Fatal("user_b can resolve user_a tool")
	}
	if _, _, ok := registry.FindTool("user_a", deviceToolName("alpha", "read")); !ok {
		t.Fatal("user_a cannot see its own tool")
	}
	if _, ok := registry.FindDevice("user_b", "dev_a"); ok {
		t.Fatal("user_b can resolve user_a device by id")
	}
	if d, ok := registry.FindDevice("user_a", "alpha"); !ok || d.ID != "dev_a" {
		t.Fatal("user_a cannot resolve its own device by slug")
	}
}

func TestCIMDAndRedirectValidation(t *testing.T) {
	if !isAllowedCimdURL("https://chatgpt.com/oauth/client.json") {
		t.Fatal("rejected ChatGPT CIMD")
	}
	if isAllowedCimdURL("https://evil.example/client.json") {
		t.Fatal("accepted unknown CIMD host")
	}
	if isAllowedCimdURL("http://chatgpt.com/client.json") {
		t.Fatal("accepted http CIMD")
	}
	if !redirectMatches("http://localhost:4567/callback", "http://localhost/callback") {
		t.Fatal("loopback port should be ignored")
	}
	if redirectMatches("http://localhost:4567/callback", "http://127.0.0.1/callback") {
		t.Fatal("different loopback hosts should not match")
	}
	if redirectMatches("http://localhost:4567/callback", "https://claude.ai/callback") {
		t.Fatal("loopback vs https matched")
	}
	if !allowedRedirectURI("http://127.0.0.1:9999/cb") || allowedRedirectURI("http://example.com/cb") {
		t.Fatal("redirect allowlist broken")
	}
}

func insertAccessToken(t *testing.T, app *App, userID, raw, scope string) {
	t.Helper()
	_, err := app.store.DB.Exec(
		`INSERT INTO access_tokens (token_hash, client_id, user_id, scope, audience, created_at, expires_at)
		 VALUES (?, 'test-client', ?, ?, ?, ?, ?)`,
		hashToken(raw), userID, scope, app.cfg.Resource, nowUnix(), nowUnix()+3600)
	if err != nil {
		t.Fatal(err)
	}
}

func TestReadScopeIsRequired(t *testing.T) {
	app, server := newTestApp(t)
	user, _, _ := testUser(t, app, "scope-user")
	insertAccessToken(t, app, user.ID, "mra_offline_only", scopeOffline)
	status, headers, body := doJSONWithAuth(t, http.DefaultClient, server.URL+"/mcp", "mra_offline_only", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": map[string]any{},
	})
	if status != http.StatusForbidden {
		t.Fatalf("offline-only tools/list status %d: %s", status, body)
	}
	if !strings.Contains(headers.Get("WWW-Authenticate"), "insufficient_scope") {
		t.Fatalf("missing insufficient_scope challenge: %q", headers.Get("WWW-Authenticate"))
	}
	insertAccessToken(t, app, user.ID, "mra_read_only", scopeRead)
	status, _, body = doJSONWithAuth(t, http.DefaultClient, server.URL+"/mcp", "mra_read_only", map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{},
	})
	if status != http.StatusOK {
		t.Fatalf("read tools/list status %d: %s", status, body)
	}
}

func TestCrossUserRevokeDoesNotTouchDevice(t *testing.T) {
	app, server := newTestApp(t)
	owner, _, _ := testUser(t, app, "owner")
	other, otherCookie, otherCSRF := testUser(t, app, "other")
	_, err := app.store.DB.Exec(
		`INSERT INTO devices (id, user_id, slug, name, platform, arch, packs, token_hash, created_at, last_seen_at)
		 VALUES ('dev_victim', ?, 'victim-1234', 'victim', 'linux', 'x64', '[]', ?, ?, 0)`,
		owner.ID, hashToken("mrd_victim"), nowUnix())
	if err != nil {
		t.Fatal(err)
	}
	client := newHTTPClient()
	client.Jar.SetCookies(mustURL(server.URL), []*http.Cookie{otherCookie})
	status, _, body := doForm(t, client, server.URL+"/devices/dev_victim/revoke", url.Values{
		"_csrf": {otherCSRF},
	})
	if status != http.StatusFound {
		t.Fatalf("revoke status %d: %s", status, body)
	}
	var revoked sql.NullInt64
	if err := app.store.DB.QueryRow(`SELECT revoked_at FROM devices WHERE id = 'dev_victim'`).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked.Valid {
		t.Fatal("another user revoked the device")
	}
	_ = other
}

func mustURL(raw string) *url.URL {
	u, _ := url.Parse(raw)
	return u
}

func TestClientSecretBasicAuthentication(t *testing.T) {
	app := &App{}
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", nil)
	req.SetBasicAuth("client-1", "secret-value")
	client := &OAuthClient{ID: "client-1", AuthMethod: "client_secret_basic", SecretHash: hashToken("secret-value")}
	if !app.authenticateClient(req, client) {
		t.Fatal("valid basic client rejected")
	}
	bad := httptest.NewRequest(http.MethodPost, "/oauth/token", nil)
	bad.SetBasicAuth("client-1", "wrong")
	if app.authenticateClient(bad, client) {
		t.Fatal("invalid basic secret accepted")
	}
}
