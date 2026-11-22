package app

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var cimdHosts = map[string]bool{
	"chatgpt.com":     true,
	"www.chatgpt.com": true,
	"claude.ai":       true,
	"claude.com":      true,
	"www.claude.com":  true,
}

func (a *App) registerOAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", a.protectedResourceMetadata)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", a.protectedResourceMetadata)
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", a.authorizationServerMetadata)
	mux.HandleFunc("GET /.well-known/oauth-authorization-server/mcp", a.authorizationServerMetadata)
	mux.HandleFunc("GET /oauth/authorize", a.authorize)
	mux.HandleFunc("POST /oauth/authorize/decision", a.authorizeDecision)
	mux.HandleFunc("POST /oauth/register", a.registerClient)
	mux.HandleFunc("POST /oauth/token", a.token)
	mux.HandleFunc("POST /oauth/revoke", a.revokeToken)
}

func (a *App) protectedResourceMetadata(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"resource":                 a.cfg.Resource,
		"authorization_servers":    []string{a.cfg.Issuer},
		"scopes_supported":         []string{scopeRead, scopeWrite},
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "mcp-relay",
	})
}

func (a *App) authorizationServerMetadata(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"issuer":                                         a.cfg.Issuer,
		"service_documentation":                          a.cfg.BaseURL + "/",
		"authorization_endpoint":                         a.cfg.BaseURL + "/oauth/authorize",
		"token_endpoint":                                 a.cfg.BaseURL + "/oauth/token",
		"registration_endpoint":                          a.cfg.BaseURL + "/oauth/register",
		"revocation_endpoint":                            a.cfg.BaseURL + "/oauth/revoke",
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none", "client_secret_post"},
		"revocation_endpoint_auth_methods_supported":     []string{"none"},
		"scopes_supported":                               supportedScopes,
		"client_id_metadata_document_supported":          false,
		"authorization_response_iss_parameter_supported": true,
	})
}

func (a *App) authorize(w http.ResponseWriter, r *http.Request) {
	if !a.allow(a.oauthLimiter, r) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}
	q := r.URL.Query()
	state := q.Get("state")
	redirectURI := q.Get("redirect_uri")
	if q.Get("response_type") != "code" {
		renderAuthError(w, "不支持的 response_type", "只支持 authorization code 流程。", http.StatusBadRequest)
		return
	}
	client, err := a.resolveClient(q.Get("client_id"))
	if err != nil {
		renderAuthError(w, "客户端元数据获取失败", err.Error(), http.StatusBadRequest)
		return
	}
	if client == nil {
		renderAuthError(w, "未知客户端", "无法识别该 OAuth 客户端。", http.StatusUnauthorized)
		return
	}
	if !redirectAllowed(client.RedirectURIs, redirectURI) {
		renderAuthError(w, "redirect_uri 不匹配", "该 redirect_uri 未在客户端元数据中登记。", http.StatusBadRequest)
		return
	}
	challenge := q.Get("code_challenge")
	if q.Get("code_challenge_method") != "S256" || challenge == "" {
		a.redirectOAuthError(w, r, redirectURI, state, "invalid_request", "PKCE S256 required")
		return
	}
	scopes, ok := parseScopes(q.Get("scope"))
	if !ok {
		a.redirectOAuthError(w, r, redirectURI, state, "invalid_scope", "unsupported scope")
		return
	}
	scopes = effectiveScopes(scopes)
	if !hasRelayScope(scopes) {
		a.redirectOAuthError(w, r, redirectURI, state, "invalid_scope", "relay.read or relay.write is required")
		return
	}
	resource := q.Get("resource")
	if resource == "" {
		resource = a.cfg.Resource
	}
	if resource != a.cfg.Resource {
		a.redirectOAuthError(w, r, redirectURI, state, "invalid_target", "resource must be the MCP endpoint")
		return
	}

	sc := a.session(r)
	if sc == nil {
		http.Redirect(w, r, "/login?return_to="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
		return
	}
	if sc.User.Status != "active" {
		http.Redirect(w, r, "/welcome", http.StatusFound)
		return
	}

	var consentScope string
	err = a.store.DB.QueryRow(`SELECT scope FROM consents WHERE user_id = ? AND client_id = ?`, sc.User.ID, client.ID).Scan(&consentScope)
	if err == nil && scopeSubset(scopes, strings.Fields(consentScope)) {
		a.finishAuthorization(w, r, sc, client, redirectURI, scopes, resource, state, challenge)
		return
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		renderAuthError(w, "服务器错误", "无法读取授权状态。", http.StatusInternalServerError)
		return
	}

	pending := randomToken("mrp_")
	_, err = a.store.DB.Exec(
		`INSERT INTO pending_authorizations
		 (id_hash, client_id, user_id, redirect_uri, scope, resource, code_challenge, state, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		hashToken(pending), client.ID, sc.User.ID, redirectURI, strings.Join(scopes, " "), resource, challenge, nullString(state), nowUnix(), nowUnix()+int64(pendingTTL/time.Second))
	if err != nil {
		renderAuthError(w, "服务器错误", "无法保存授权请求。", http.StatusInternalServerError)
		return
	}
	host := ""
	if u, err := url.Parse(redirectURI); err == nil {
		host = u.Host
	}
	body := `<h1>连接 ` + esc(client.Name) + `</h1>
<p class="muted">登录为 <strong>` + esc(sc.User.Login) + `</strong></p>
<div class="card">
<p><strong>` + esc(displayClientName(client)) + `</strong> 请求访问你的 mcp-relay 设备工具。</p>
<p class="muted">回调主机：<code>` + esc(host) + `</code></p>
<p>权限：`
	for _, s := range scopes {
		body += `<code>` + esc(s) + `</code> `
	}
	body += `</p>
<p class="muted"><code>relay.read</code> 只读工具；<code>relay.write</code> 可写文件、修改文件、运行命令。</p>
<form method="post" action="/oauth/authorize/decision">
<input type="hidden" name="pending" value="` + esc(pending) + `">
<input type="hidden" name="_csrf" value="` + esc(sc.CSRFToken) + `">
<div class="row">
<button type="submit" name="decision" value="approve">允许</button>
<button type="submit" name="decision" value="deny" class="secondary">拒绝</button>
</div>
</form></div>`
	writeHTML(w, http.StatusOK, "授权连接", body)
}

func (a *App) authorizeDecision(w http.ResponseWriter, r *http.Request) {
	if !a.allow(a.oauthLimiter, r) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}
	sc := a.session(r)
	if sc == nil {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	if !a.checkCSRF(r, sc) {
		renderAuthError(w, "请求校验失败", "CSRF token 或 Origin 不匹配。", http.StatusForbidden)
		return
	}
	rawPending := r.PostFormValue("pending")
	var (
		clientID      string
		userID        string
		redirectURI   string
		scope         string
		resource      string
		codeChallenge string
		state         sql.NullString
		expiresAt     int64
	)
	err := a.store.DB.QueryRow(
		`SELECT client_id, user_id, redirect_uri, scope, resource, code_challenge, state, expires_at
		   FROM pending_authorizations WHERE id_hash = ?`, hashToken(rawPending)).
		Scan(&clientID, &userID, &redirectURI, &scope, &resource, &codeChallenge, &state, &expiresAt)
	if err != nil || userID != sc.User.ID || expiresAt <= nowUnix() {
		renderAuthError(w, "授权请求已过期", "请回到客户端重新发起连接。", http.StatusBadRequest)
		return
	}
	_, _ = a.store.DB.Exec(`DELETE FROM pending_authorizations WHERE id_hash = ?`, hashToken(rawPending))
	client, err := a.resolveClient(clientID)
	if err != nil || client == nil {
		renderAuthError(w, "客户端已失效", "无法重新读取客户端元数据。", http.StatusBadRequest)
		return
	}
	if r.PostFormValue("decision") != "approve" {
		a.redirectOAuthError(w, r, redirectURI, state.String, "access_denied", "user denied")
		return
	}
	scopes := strings.Fields(scope)
	_, _ = a.store.DB.Exec(
		`INSERT INTO consents (user_id, client_id, scope, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id, client_id) DO UPDATE SET scope = excluded.scope, created_at = excluded.created_at`,
		sc.User.ID, client.ID, strings.Join(scopes, " "), nowUnix())
	a.finishAuthorization(w, r, sc, client, redirectURI, scopes, resource, state.String, codeChallenge)
}

func (a *App) finishAuthorization(
	w http.ResponseWriter,
	r *http.Request,
	sc *SessionCtx,
	client *OAuthClient,
	redirectURI string,
	scopes []string,
	resource, state, challenge string,
) {
	code := randomToken("mrcode_")
	_, err := a.store.DB.Exec(
		`INSERT INTO auth_codes
		 (code_hash, client_id, user_id, redirect_uri, scope, resource, code_challenge, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		hashToken(code), client.ID, sc.User.ID, redirectURI, strings.Join(scopes, " "), resource, challenge,
		nowUnix(), nowUnix()+int64(authCodeTTL/time.Second))
	if err != nil {
		renderAuthError(w, "服务器错误", "无法签发授权码。", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, withParams(redirectURI, map[string]string{
		"code": code, "state": state, "iss": a.cfg.Issuer,
	}), http.StatusFound)
}

type dcrRequest struct {
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
}

func (a *App) registerClient(w http.ResponseWriter, r *http.Request) {
	if !a.allow(a.limiter, r) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "too_many_requests"})
		return
	}
	defer r.Body.Close()
	var req dcrRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid_client_metadata"})
		return
	}
	if len(req.RedirectURIs) == 0 || len(req.RedirectURIs) > 10 {
		writeJSON(w, 400, map[string]any{"error": "invalid_redirect_uri"})
		return
	}
	for _, uri := range req.RedirectURIs {
		if !allowedRedirectURI(uri) {
			writeJSON(w, 400, map[string]any{"error": "invalid_redirect_uri"})
			return
		}
	}
	method := req.TokenEndpointAuthMethod
	if method == "" {
		method = "none"
	}
	if method != "none" && method != "client_secret_post" {
		writeJSON(w, 400, map[string]any{"error": "invalid_client_metadata", "error_description": "unsupported token_endpoint_auth_method"})
		return
	}
	clientSecret := ""
	secretHash := ""
	if method == "client_secret_post" {
		clientSecret = randomToken("mrcs_")
		secretHash = hashToken(clientSecret)
	}
	client := OAuthClient{
		ID:           "mrc_" + randomID(),
		Name:         truncate(req.ClientName, 200),
		RedirectURIs: req.RedirectURIs,
		Source:       "dcr",
		AuthMethod:   method,
		SecretHash:   secretHash,
	}
	if err := a.store.UpsertClient(client); err != nil {
		writeJSON(w, 500, map[string]any{"error": "server_error"})
		return
	}
	grantTypes := req.GrantTypes
	if len(grantTypes) == 0 {
		grantTypes = []string{"authorization_code", "refresh_token"}
	}
	responseTypes := req.ResponseTypes
	if len(responseTypes) == 0 {
		responseTypes = []string{"code"}
	}
	response := map[string]any{
		"client_id":                  client.ID,
		"client_id_issued_at":        nowUnix(),
		"client_name":                client.Name,
		"redirect_uris":              client.RedirectURIs,
		"token_endpoint_auth_method": method,
		"grant_types":                grantTypes,
		"response_types":             responseTypes,
	}
	if clientSecret != "" {
		response["client_secret"] = clientSecret
		response["client_secret_expires_at"] = 0
	}
	writeJSON(w, 201, response)
}

func (a *App) token(w http.ResponseWriter, r *http.Request) {
	if !a.allow(a.oauthLimiter, r) {
		tokenError(w, http.StatusTooManyRequests, "too_many_requests", "rate limit exceeded")
		return
	}
	if err := r.ParseForm(); err != nil {
		tokenError(w, 400, "invalid_request", "invalid form body")
		return
	}
	grantType := r.PostFormValue("grant_type")
	if grantType != "authorization_code" && grantType != "refresh_token" {
		tokenError(w, 400, "unsupported_grant_type", "unsupported grant_type")
		return
	}
	client, err := a.resolveClient(r.PostFormValue("client_id"))
	if err != nil {
		tokenError(w, 500, "server_error", "client metadata fetch failed")
		return
	}
	if client == nil {
		tokenError(w, 401, "invalid_client", "unknown client")
		return
	}
	if !a.authenticateClient(r, client) {
		tokenError(w, 401, "invalid_client", "client authentication failed")
		return
	}
	switch grantType {
	case "authorization_code":
		a.exchangeCode(w, r, client)
	case "refresh_token":
		a.exchangeRefresh(w, r, client)
	}
}

func (a *App) exchangeCode(w http.ResponseWriter, r *http.Request, client *OAuthClient) {
	code := r.PostFormValue("code")
	redirectURI := r.PostFormValue("redirect_uri")
	verifier := r.PostFormValue("code_verifier")
	resource := r.PostFormValue("resource")
	if code == "" || redirectURI == "" || verifier == "" {
		tokenError(w, 400, "invalid_request", "code, redirect_uri and code_verifier required")
		return
	}
	var (
		dbClientID string
		userID     string
		dbRedirect string
		scope      string
		audience   string
		challenge  string
		expiresAt  int64
		usedAt     sql.NullInt64
	)
	err := a.store.DB.QueryRow(
		`SELECT client_id, user_id, redirect_uri, scope, resource, code_challenge, expires_at, used_at
		   FROM auth_codes WHERE code_hash = ?`, hashToken(code)).
		Scan(&dbClientID, &userID, &dbRedirect, &scope, &audience, &challenge, &expiresAt, &usedAt)
	if err != nil || dbClientID != client.ID || usedAt.Valid || expiresAt <= nowUnix() {
		tokenError(w, 400, "invalid_grant", "authorization code is invalid or expired")
		return
	}
	if dbRedirect != redirectURI {
		tokenError(w, 400, "invalid_grant", "redirect_uri mismatch")
		return
	}
	if resource != "" && resource != audience {
		tokenError(w, 400, "invalid_target", "resource mismatch")
		return
	}
	if !verifyPKCE(verifier, challenge) {
		tokenError(w, 400, "invalid_grant", "PKCE verification failed")
		return
	}
	tx, err := a.store.DB.Begin()
	if err != nil {
		tokenError(w, 500, "server_error", "database error")
		return
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`, nowUnix(), hashToken(code))
	if err != nil {
		tokenError(w, 500, "server_error", "database error")
		return
	}
	if n, _ := res.RowsAffected(); n != 1 {
		tokenError(w, 400, "invalid_grant", "authorization code already used")
		return
	}
	out, err := issueTokens(tx, client.ID, userID, strings.Fields(scope), audience, "")
	if err != nil {
		tokenError(w, 500, "server_error", "token persistence failed")
		return
	}
	if err := tx.Commit(); err != nil {
		tokenError(w, 500, "server_error", "database error")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, 200, out)
}

func (a *App) exchangeRefresh(w http.ResponseWriter, r *http.Request, client *OAuthClient) {
	raw := r.PostFormValue("refresh_token")
	resource := r.PostFormValue("resource")
	if raw == "" {
		tokenError(w, 400, "invalid_request", "refresh_token required")
		return
	}
	var (
		family    string
		dbClient  string
		userID    string
		scope     string
		audience  string
		expiresAt int64
		rotatedAt sql.NullInt64
		revokedAt sql.NullInt64
	)
	err := a.store.DB.QueryRow(
		`SELECT family_id, client_id, user_id, scope, audience, expires_at, rotated_at, revoked_at
		   FROM refresh_tokens WHERE token_hash = ?`, hashToken(raw)).
		Scan(&family, &dbClient, &userID, &scope, &audience, &expiresAt, &rotatedAt, &revokedAt)
	if err != nil || dbClient != client.ID || expiresAt <= nowUnix() || revokedAt.Valid {
		tokenError(w, 400, "invalid_grant", "refresh token is invalid or expired")
		return
	}
	if rotatedAt.Valid {
		_, _ = a.store.DB.Exec(`UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`, nowUnix(), family)
		tokenError(w, 400, "invalid_grant", "refresh token was already used")
		return
	}
	if resource != "" && resource != audience {
		tokenError(w, 400, "invalid_target", "resource mismatch")
		return
	}
	original := strings.Fields(scope)
	next := original
	if requested := r.PostFormValue("scope"); requested != "" {
		parsed, ok := parseScopes(requested)
		if !ok || len(parsed) == 0 || !scopeSubset(parsed, original) {
			tokenError(w, 400, "invalid_scope", "requested scope exceeds the original grant")
			return
		}
		next = parsed
	}
	if !hasRelayScope(next) {
		tokenError(w, 400, "invalid_scope", "a relay scope is required")
		return
	}
	tx, err := a.store.DB.Begin()
	if err != nil {
		tokenError(w, 500, "server_error", "database error")
		return
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE refresh_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL`, nowUnix(), hashToken(raw))
	if err != nil {
		tokenError(w, 500, "server_error", "database error")
		return
	}
	if n, _ := res.RowsAffected(); n != 1 {
		_, _ = tx.Exec(`UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`, nowUnix(), family)
		tokenError(w, 400, "invalid_grant", "refresh token was already used")
		return
	}
	out, err := issueTokens(tx, client.ID, userID, next, audience, family)
	if err != nil {
		tokenError(w, 500, "server_error", "token persistence failed")
		return
	}
	if err := tx.Commit(); err != nil {
		tokenError(w, 500, "server_error", "database error")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, 200, out)
}

func issueTokens(tx *sql.Tx, clientID, userID string, scopes []string, audience, family string) (map[string]any, error) {
	if family == "" {
		family = randomID()
	}
	access := randomToken("mra_")
	refresh := randomToken("mrf_")
	now := nowUnix()
	scope := strings.Join(scopes, " ")
	if _, err := tx.Exec(
		`INSERT INTO access_tokens (token_hash, client_id, user_id, scope, audience, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		hashToken(access), clientID, userID, scope, audience, now, now+int64(accessTokenTTL/time.Second)); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(
		`INSERT INTO refresh_tokens (token_hash, family_id, client_id, user_id, scope, audience, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		hashToken(refresh), family, clientID, userID, scope, audience, now, now+int64(refreshTokenTTL/time.Second)); err != nil {
		return nil, err
	}
	return map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int64(accessTokenTTL / time.Second),
		"refresh_token": refresh,
		"scope":         scope,
	}, nil
}

func (a *App) revokeToken(w http.ResponseWriter, r *http.Request) {
	if !a.allow(a.oauthLimiter, r) {
		tokenError(w, http.StatusTooManyRequests, "too_many_requests", "rate limit exceeded")
		return
	}
	if err := r.ParseForm(); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid_request"})
		return
	}
	token := r.PostFormValue("token")
	clientID := r.PostFormValue("client_id")
	if token == "" || clientID == "" {
		writeJSON(w, 400, map[string]any{"error": "invalid_request"})
		return
	}
	hash := hashToken(token)
	_, _ = a.store.DB.Exec(`UPDATE access_tokens SET revoked_at = ? WHERE token_hash = ? AND client_id = ?`, nowUnix(), hash, clientID)
	var family string
	if err := a.store.DB.QueryRow(`SELECT family_id FROM refresh_tokens WHERE token_hash = ? AND client_id = ?`, hash, clientID).Scan(&family); err == nil {
		_, _ = a.store.DB.Exec(`UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`, nowUnix(), family)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{})
}

func (a *App) resolveClient(id string) (*OAuthClient, error) {
	if id == "" {
		return nil, nil
	}
	client, err := a.store.Client(id)
	if err != nil || client != nil {
		return client, err
	}
	if !strings.HasPrefix(id, "https://") {
		return nil, nil
	}
	return a.fetchCIMD(id)
}

func (a *App) fetchCIMD(clientID string) (*OAuthClient, error) {
	if !isAllowedCimdURL(clientID) {
		return nil, nil
	}
	req, err := http.NewRequest(http.MethodGet, clientID, nil)
	if err != nil {
		return nil, nil
	}
	req.Header.Set("Accept", "application/json")
	client := &http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirects are not allowed")
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("client metadata HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024+1))
	if err != nil || len(body) == 0 || len(body) > 256*1024 {
		return nil, errors.New("client metadata too large or unreadable")
	}
	var doc struct {
		ClientID     string   `json:"client_id"`
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, errors.New("client metadata is not JSON")
	}
	if doc.ClientID != clientID {
		return nil, errors.New("client_id does not match metadata URL")
	}
	redirects := make([]string, 0, len(doc.RedirectURIs))
	for _, uri := range doc.RedirectURIs {
		if allowedRedirectURI(uri) {
			redirects = append(redirects, uri)
		}
	}
	if len(redirects) == 0 {
		return nil, errors.New("client metadata has no usable redirect_uris")
	}
	c := &OAuthClient{
		ID:           clientID,
		Name:         truncate(doc.ClientName, 200),
		RedirectURIs: redirects,
		Source:       "cimd",
		AuthMethod:   "none",
	}
	if err := a.store.UpsertClient(*c); err != nil {
		return nil, err
	}
	return c, nil
}

func isAllowedCimdURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") ||
		u.RawQuery != "" || u.Fragment != "" || u.Path == "" || u.Path == "/" {
		return false
	}
	return cimdHosts[strings.ToLower(u.Hostname())]
}

func (a *App) authenticateClient(r *http.Request, client *OAuthClient) bool {
	switch client.AuthMethod {
	case "", "none":
		return true
	case "client_secret_post":
		secret := r.PostFormValue("client_secret")
		if secret == "" || client.SecretHash == "" {
			return false
		}
		return constantTimeEqual(hashToken(secret), client.SecretHash)
	default:
		return false
	}
}

func (a *App) verifyBearer(r *http.Request) (*VerifiedToken, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return nil, false
	}
	raw := strings.TrimSpace(header[7:])
	var userID, clientID, scope, audience string
	var expiresAt int64
	var revokedAt sql.NullInt64
	var status string
	err := a.store.DB.QueryRow(
		`SELECT a.user_id, a.client_id, a.scope, a.audience, a.expires_at, a.revoked_at, u.status
		   FROM access_tokens a JOIN users u ON u.id = a.user_id WHERE a.token_hash = ?`, hashToken(raw)).
		Scan(&userID, &clientID, &scope, &audience, &expiresAt, &revokedAt, &status)
	if err != nil || revokedAt.Valid || expiresAt <= nowUnix() || status != "active" || audience != a.cfg.Resource {
		return nil, false
	}
	return &VerifiedToken{UserID: userID, ClientID: clientID, Scopes: strings.Fields(scope), Audience: audience}, true
}

func (a *App) sendUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate",
		fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource", scope="%s %s"`, a.cfg.BaseURL, scopeRead, scopeWrite))
	writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
}

func (a *App) sendInsufficientScope(w http.ResponseWriter, needed string) {
	w.Header().Set("WWW-Authenticate",
		fmt.Sprintf(`Bearer error="insufficient_scope", scope="%s", resource_metadata="%s/.well-known/oauth-protected-resource"`, needed, a.cfg.BaseURL))
	writeJSON(w, http.StatusForbidden, map[string]any{"error": "insufficient_scope"})
}

func tokenError(w http.ResponseWriter, status int, code, description string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, status, map[string]any{"error": code, "error_description": description})
}

func renderAuthError(w http.ResponseWriter, title, detail string, status int) {
	writeHTML(w, status, "授权失败", `<h1>`+esc(title)+`</h1><p class="error">`+esc(detail)+`</p><p class="muted">可以关闭此页面并回到客户端重试。</p>`)
}

func (a *App) redirectOAuthError(w http.ResponseWriter, r *http.Request, redirectURI, state, code, description string) {
	params := map[string]string{"error": code, "error_description": description, "iss": a.cfg.Issuer}
	if state != "" {
		params["state"] = state
	}
	http.Redirect(w, r, withParams(redirectURI, params), http.StatusFound)
}

func withParams(base string, params map[string]string) string {
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	q := u.Query()
	for k, v := range params {
		if v != "" || k == "iss" {
			q.Set(k, v)
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func parseScopes(raw string) ([]string, bool) {
	if strings.TrimSpace(raw) == "" {
		return nil, true
	}
	seen := make(map[string]bool)
	var out []string
	for _, scope := range strings.Fields(raw) {
		valid := false
		for _, supported := range supportedScopes {
			if scope == supported {
				valid = true
				break
			}
		}
		if !valid {
			return nil, false
		}
		if !seen[scope] {
			seen[scope] = true
			out = append(out, scope)
		}
	}
	return out, true
}

func effectiveScopes(scopes []string) []string {
	if len(scopes) == 0 {
		return strings.Fields(defaultScope)
	}
	return scopes
}

func hasRelayScope(scopes []string) bool {
	return hasScope(scopes, scopeRead) || hasScope(scopes, scopeWrite)
}

func scopeSubset(want, granted []string) bool {
	have := make(map[string]bool, len(granted))
	for _, s := range granted {
		have[s] = true
	}
	for _, s := range want {
		if !have[s] {
			return false
		}
	}
	return true
}

func redirectAllowed(registered []string, requested string) bool {
	if requested == "" {
		return false
	}
	for _, uri := range registered {
		if redirectMatches(requested, uri) {
			return true
		}
	}
	return false
}

func redirectMatches(requested, registered string) bool {
	if requested == registered {
		return true
	}
	l, err := url.Parse(requested)
	if err != nil {
		return false
	}
	r, err := url.Parse(registered)
	if err != nil {
		return false
	}
	if l.Scheme != "http" || r.Scheme != "http" {
		return false
	}
	if !isLoopbackHost(l.Hostname()) || !isLoopbackHost(r.Hostname()) {
		return false
	}
	return l.Hostname() == r.Hostname() && l.Path == r.Path
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
}

func allowedRedirectURI(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	return u.Scheme == "http" && isLoopbackHost(u.Hostname())
}

func verifyPKCE(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	for _, r := range verifier {
		if !(r >= 'A' && r <= 'Z') && !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9') && r != '-' && r != '.' && r != '_' && r != '~' {
			return false
		}
	}
	sum := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(sum[:])
	return constantTimeEqual(computed, challenge)
}

func displayClientName(c *OAuthClient) string {
	if c.Name != "" {
		return c.Name
	}
	return c.ID
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
