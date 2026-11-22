package app

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type ghCookie struct {
	State    string `json:"state"`
	ReturnTo string `json:"return_to"`
}

type ghUser struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Email string `json:"email"`
}

type ghEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

func (a *App) registerGitHubRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /login", a.login)
	mux.HandleFunc("GET /auth/github/callback", a.githubCallback)
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	returnTo := safeReturnTo(r.URL.Query().Get("return_to"))
	if sc := a.session(r); sc != nil && sc.User.Status == "active" {
		http.Redirect(w, r, returnTo, http.StatusFound)
		return
	}
	if a.cfg.GitHubClientID == "" || a.cfg.GitHubSecret == "" {
		writeHTML(w, http.StatusInternalServerError, "登录未配置",
			`<h1>GitHub 登录未配置</h1><p class="error">服务器缺少 <code>GITHUB_CLIENT_ID</code> / <code>GITHUB_CLIENT_SECRET</code>。</p>`)
		return
	}
	state := randomHex(16)
	payload, _ := json.Marshal(ghCookie{State: state, ReturnTo: returnTo})
	http.SetCookie(w, &http.Cookie{
		Name:     "mrl_gh",
		Value:    base64.RawURLEncoding.EncodeToString(payload),
		Path:     "/",
		HttpOnly: true,
		Secure:   a.cfg.SecureCookies,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   600,
	})
	q := url.Values{
		"client_id":    {a.cfg.GitHubClientID},
		"redirect_uri": {a.cfg.GitHubRedirect},
		"scope":        {"read:user user:email"},
		"state":        {state},
		"allow_signup": {"true"},
	}
	http.Redirect(w, r, "https://github.com/login/oauth/authorize?"+q.Encode(), http.StatusFound)
}

func (a *App) githubCallback(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("mrl_gh")
	if err != nil {
		writeHTML(w, 400, "登录失败", `<p class="error">缺少登录状态，请重新登录。</p>`)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "mrl_gh", Value: "", Path: "/", MaxAge: -1})
	var saved ghCookie
	rawCookie, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil {
		writeHTML(w, 400, "登录失败", `<p class="error">登录状态无效，请重新登录。</p>`)
		return
	}
	if err := json.Unmarshal(rawCookie, &saved); err != nil || saved.State == "" {
		writeHTML(w, 400, "登录失败", `<p class="error">登录状态无效，请重新登录。</p>`)
		return
	}
	if r.URL.Query().Get("error") != "" {
		writeHTML(w, 400, "登录取消", `<p class="error">GitHub 返回：`+esc(r.URL.Query().Get("error_description"))+`</p>`)
		return
	}
	if r.URL.Query().Get("state") != saved.State {
		writeHTML(w, 400, "登录失败", `<p class="error">state 校验失败，请重新登录。</p>`)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		writeHTML(w, 400, "登录失败", `<p class="error">缺少 GitHub code。</p>`)
		return
	}
	token, err := a.githubAccessToken(code)
	if err != nil {
		writeHTML(w, 502, "登录失败", `<p class="error">GitHub token 交换失败：`+esc(err.Error())+`</p>`)
		return
	}
	user, err := a.githubUser(token)
	if err != nil {
		writeHTML(w, 502, "登录失败", `<p class="error">读取 GitHub 用户失败：`+esc(err.Error())+`</p>`)
		return
	}
	email := a.githubPrimaryEmail(token)
	githubID := strconv.FormatInt(user.ID, 10)
	login := strings.ToLower(user.Login)
	if email == "" {
		email = user.Email
	}

	existing, err := a.store.UserByGitHubID(githubID)
	if err != nil {
		writeHTML(w, 500, "登录失败", `<p class="error">数据库错误。</p>`)
		return
	}
	var adminCount int
	_ = a.store.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE is_admin = 1`).Scan(&adminCount)
	isAdmin := adminCount == 0 && a.cfg.AdminLogin != "" && login == a.cfg.AdminLogin
	status := "active"
	if !isAdmin && a.cfg.InviteRequired {
		status = "pending"
	}
	if existing == nil {
		existing, err = a.store.CreateUser(githubID, login, email, status, isAdmin)
		if err != nil {
			writeHTML(w, 500, "登录失败", `<p class="error">创建用户失败。</p>`)
			return
		}
	} else {
		if existing.Status == "blocked" {
			writeHTML(w, 403, "账号被禁用", `<p class="error">该 GitHub 账号已被禁用。</p>`)
			return
		}
		_ = a.store.UpdateUserLogin(existing.ID, login, email)
		existing.Login = login
		existing.Email = email
	}
	if isAdmin && (existing.Status != "active" || !existing.IsAdmin) {
		_, _ = a.store.DB.Exec(`UPDATE users SET status = 'active', is_admin = 1 WHERE id = ?`, existing.ID)
		existing.Status = "active"
		existing.IsAdmin = true
	}
	if _, err := a.createSession(w, existing.ID); err != nil {
		writeHTML(w, 500, "登录失败", `<p class="error">无法创建会话。</p>`)
		return
	}
	if existing.Status != "active" {
		http.Redirect(w, r, "/welcome", http.StatusFound)
		return
	}
	http.Redirect(w, r, safeReturnTo(saved.ReturnTo), http.StatusFound)
}

func (a *App) githubAccessToken(code string) (string, error) {
	form := url.Values{
		"client_id":     {a.cfg.GitHubClientID},
		"client_secret": {a.cfg.GitHubSecret},
		"code":          {code},
		"redirect_uri":  {a.cfg.GitHubRedirect},
	}
	req, err := http.NewRequest(http.MethodPost, "https://github.com/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "mcp-relay")
	resp, err := a.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", err
	}
	var parsed struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("invalid GitHub response")
	}
	if parsed.AccessToken == "" {
		return "", fmt.Errorf("%s %s", parsed.Error, parsed.Description)
	}
	return parsed.AccessToken, nil
}

func (a *App) githubUser(token string) (*ghUser, error) {
	var user ghUser
	if err := a.githubGET(token, "https://api.github.com/user", &user); err != nil {
		return nil, err
	}
	if user.ID == 0 || user.Login == "" {
		return nil, fmt.Errorf("GitHub user response incomplete")
	}
	return &user, nil
}

func (a *App) githubPrimaryEmail(token string) string {
	var emails []ghEmail
	if err := a.githubGET(token, "https://api.github.com/user/emails", &emails); err != nil {
		return ""
	}
	for _, e := range emails {
		if e.Primary && e.Verified {
			return e.Email
		}
	}
	for _, e := range emails {
		if e.Verified {
			return e.Email
		}
	}
	return ""
}

func (a *App) githubGET(token, endpoint string, out any) error {
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "mcp-relay")
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub API HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 256*1024)).Decode(out)
}

func safeReturnTo(raw string) string {
	if raw == "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.Contains(raw, "\\") {
		return "/app/"
	}
	return raw
}
