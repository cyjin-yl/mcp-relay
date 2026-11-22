package app

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
)

func (a *App) registerWebRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /", a.landing)
	mux.HandleFunc("GET /dashboard", a.dashboard)
	mux.HandleFunc("GET /audit", a.auditPage)
	mux.HandleFunc("GET /invites", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/", http.StatusFound)
	})
	mux.HandleFunc("GET /devices/pairing-code", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/", http.StatusFound)
	})
	mux.HandleFunc("GET /welcome", a.welcome)
	mux.HandleFunc("POST /welcome", a.redeemInvite)
	mux.HandleFunc("POST /devices/pairing-code", a.createPairingCode)
	mux.HandleFunc("POST /devices/{id}/revoke", a.revokeDevice)
	mux.HandleFunc("POST /invites", a.createInvite)
	mux.HandleFunc("POST /logout", a.logout)
}

func (a *App) landing(w http.ResponseWriter, r *http.Request) {
	sc := a.session(r)
	var b strings.Builder
	b.WriteString(`<h1>mcp-relay</h1><p class="muted">ChatGPT 和 Claude 通过 MCP 调用你机器上的工具。</p>
<div class="card"><h2>它是什么</h2>
<p>在你自己的机器上长期运行一个 <code>npx</code> 设备进程。relay 只负责鉴权、列出在线设备和转发工具调用；文件和命令都在你的机器上执行。</p>
<ul><li>Pi 风格的最小工具：read / write / edit / bash / grep / find / ls</li>
<li>OMP 风格：hash 校验的 apply_patch、glob、grep、带行号的 read</li>
<li>可选的持久 code kernel（默认关闭）</li></ul></div>`)
	if sc != nil && sc.User.Status == "active" {
		b.WriteString(`<p><a href="/app/">进入控制台</a></p>`)
	} else {
		b.WriteString(`<p><a href="/login"><button>使用 GitHub 登录</button></a></p>`)
	}
	b.WriteString(`<p class="muted">MCP endpoint：<code>` + esc(a.cfg.Resource) + `</code></p>`)
	writeHTML(w, 200, "mcp-relay", b.String())
}

func navHTML(sc *SessionCtx) string {
	var b strings.Builder
	b.WriteString(`<nav><a href="/">mcp-relay</a><a href="/dashboard">设备</a><a href="/audit">审计</a>`)
	if sc != nil && sc.User.Status == "active" {
		b.WriteString(`<span class="muted">` + esc(sc.User.Login) + `</span>`)
		b.WriteString(`<form method="post" action="/logout" style="display:inline"><input type="hidden" name="_csrf" value="` + esc(sc.CSRFToken) + `"><button class="secondary" type="submit">退出</button></form>`)
	}
	b.WriteString(`</nav>`)
	return b.String()
}

func (a *App) dashboard(w http.ResponseWriter, r *http.Request) {
	sc := a.requireUser(w, r)
	if sc == nil {
		return
	}
	http.Redirect(w, r, "/app/", http.StatusFound)
}

func (a *App) dashboardLegacy(w http.ResponseWriter, r *http.Request) {
	sc := a.requireUser(w, r)
	if sc == nil {
		return
	}
	var b strings.Builder
	b.WriteString(navHTML(sc))
	b.WriteString(`<h1>设备</h1>`)
	b.WriteString(`<p class="muted">在线设备会出现在 ChatGPT / Claude 的工具列表里，前缀 <code>d_&lt;slug&gt;__</code>。</p>`)
	b.WriteString(`<div class="card"><h2>如何在 ChatGPT 里添加</h2>
<ol>
<li>打开 ChatGPT 的 <strong>Plugins</strong> 页面，选择 <strong>Add custom MCP server</strong>。</li>
<li>名称填 <code>mcp-relay</code>，Server URL 填 <code>` + esc(a.cfg.Resource) + `</code>。</li>
<li>Authentication 选 <strong>OAuth</strong>；授权服务器和 PKCE 会自动发现，不需要 API key。</li>
<li>选择 <strong>Create as a plugin</strong> 并安装；在对话里用 <code>@</code> 选择它，再让它先调用 <code>devices_list</code>。</li>
</ol>
<p class="muted">Claude：Settings → Connectors → Add custom connector，URL 相同，认证选 OAuth。同意页里的 <code>relay.read</code> 只读，<code>relay.write</code> 允许写文件和运行命令。</p></div>`)
	b.WriteString(`<div class="card"><h2>添加设备</h2>
<p>点击生成一次性配对码，然后在目标机器上运行：</p>
<form method="post" action="/devices/pairing-code"><input type="hidden" name="_csrf" value="` + esc(sc.CSRFToken) + `"><button type="submit">生成配对码</button></form>
<p class="muted">配对码 10 分钟内有效，只能使用一次。</p></div>`)

	rows, err := a.store.DB.Query(
		`SELECT id, slug, name, COALESCE(platform, ''), COALESCE(arch, ''), packs, created_at,
		        COALESCE(last_seen_at, 0), COALESCE(revoked_at, 0)
		   FROM devices WHERE user_id = ? ORDER BY created_at DESC`, sc.User.ID)
	if err != nil {
		writeHTML(w, 500, "错误", esc(err.Error()))
		return
	}
	defer rows.Close()
	b.WriteString(`<div class="card"><h2>我的设备</h2><table><tr><th>设备</th><th>状态</th><th>平台</th><th>工具包</th><th>最后在线</th><th></th></tr>`)
	count := 0
	for rows.Next() {
		var id, slug, name, platform, arch, packs string
		var createdAt, lastSeen, revoked int64
		if err := rows.Scan(&id, &slug, &name, &platform, &arch, &packs, &createdAt, &lastSeen, &revoked); err != nil {
			continue
		}
		count++
		status := `<span class="error">已撤销</span>`
		if revoked == 0 {
			if a.registry.Online(id) {
				status = "在线"
			} else {
				status = `<span class="muted">离线</span>`
			}
		}
		b.WriteString(`<tr><td><strong>` + esc(name) + `</strong><br><code>` + esc(slug) + `</code></td><td>` + status + `</td><td>` + esc(platform) + ` ` + esc(arch) + `</td><td><code>` + esc(strings.Join(splitJSONArray(packs), ",")) + `</code></td><td class="muted">` + esc(formatTime(lastSeen)) + `</td><td>`)
		if revoked == 0 {
			b.WriteString(`<form method="post" action="/devices/` + esc(id) + `/revoke"><input type="hidden" name="_csrf" value="` + esc(sc.CSRFToken) + `"><button class="danger" type="submit">撤销</button></form>`)
		}
		b.WriteString(`</td></tr>`)
	}
	if count == 0 {
		b.WriteString(`<tr><td colspan="6" class="muted">还没有设备。</td></tr>`)
	}
	b.WriteString(`</table></div>`)

	if sc.User.IsAdmin {
		b.WriteString(`<div class="card"><h2>邀请码（管理员）</h2><form method="post" action="/invites"><input type="hidden" name="_csrf" value="` + esc(sc.CSRFToken) + `"><button type="submit">生成邀请码</button></form>`)
		invites, err := a.store.DB.Query(`SELECT created_at, expires_at, COALESCE(used_at, 0) FROM invites WHERE created_by = ? ORDER BY created_at DESC LIMIT 10`, sc.User.ID)
		if err == nil {
			defer invites.Close()
			b.WriteString(`<table><tr><th>创建</th><th>过期</th><th>状态</th></tr>`)
			for invites.Next() {
				var created, expires, used int64
				if invites.Scan(&created, &expires, &used) != nil {
					continue
				}
				state := "未使用"
				if used != 0 {
					state = "已使用"
				} else if expires <= nowUnix() {
					state = "已过期"
				}
				b.WriteString(`<tr><td>` + esc(formatTime(created)) + `</td><td>` + esc(formatTime(expires)) + `</td><td>` + esc(state) + `</td></tr>`)
			}
			b.WriteString(`</table>`)
		}
		b.WriteString(`</div>`)
	}
	writeHTML(w, 200, "设备", b.String())
}

func (a *App) createPairingCode(w http.ResponseWriter, r *http.Request) {
	sc := a.requireUser(w, r)
	if sc == nil {
		return
	}
	if !a.checkCSRF(r, sc) {
		writeHTML(w, 403, "校验失败", `<p class="error">页面已过期或会话已更换。请刷新 <a href="/dashboard">控制台</a> 后重试。</p>`)
		return
	}
	code := randomPairingCode()
	_, err := a.store.DB.Exec(`INSERT INTO pairing_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		hashToken(code), sc.User.ID, nowUnix(), nowUnix()+600)
	if err != nil {
		writeHTML(w, 500, "错误", `<p class="error">`+esc(err.Error())+`</p>`)
		return
	}
	display := displayPairingCode(code)
	body := navHTML(sc) + `<h1>配对码</h1>
<div class="card"><p>在目标机器上运行：</p>
<pre>npx -y @cyjin/mcp-relay connect --code ` + esc(display) + ` --root . --packs minimal,omp</pre>
<p>配对码：<code>` + esc(display) + `</code>（10 分钟内有效，仅一次）</p>
<p class="muted">设备连接后刷新此页即可看到在线状态。</p></div>`
	writeHTML(w, 200, "配对码", body)
}

func (a *App) revokeDevice(w http.ResponseWriter, r *http.Request) {
	sc := a.requireUser(w, r)
	if sc == nil {
		return
	}
	if !a.checkCSRF(r, sc) {
		writeHTML(w, 403, "校验失败", `<p class="error">CSRF 校验失败。</p>`)
		return
	}
	id := r.PathValue("id")
	res, err := a.store.DB.Exec(`UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		nowUnix(), id, sc.User.ID)
	if err != nil {
		writeHTML(w, 500, "错误", `<p class="error">`+esc(err.Error())+`</p>`)
		return
	}
	if n, _ := res.RowsAffected(); n == 1 {
		a.registry.Kick(id)
	}
	http.Redirect(w, r, "/app/", http.StatusFound)
}

func (a *App) createInvite(w http.ResponseWriter, r *http.Request) {
	sc := a.requireUser(w, r)
	if sc == nil {
		return
	}
	if !sc.User.IsAdmin {
		writeHTML(w, 403, "禁止", `<p class="error">需要管理员权限。</p>`)
		return
	}
	if !a.checkCSRF(r, sc) {
		writeHTML(w, 403, "校验失败", `<p class="error">CSRF 校验失败。</p>`)
		return
	}
	code := randomPairingCode()
	_, err := a.store.DB.Exec(`INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		hashToken(code), sc.User.ID, nowUnix(), nowUnix()+14*24*3600)
	if err != nil {
		writeHTML(w, 500, "错误", `<p class="error">`+esc(err.Error())+`</p>`)
		return
	}
	display := displayPairingCode(code)
	writeHTML(w, 200, "邀请码", navHTML(sc)+`<h1>邀请码</h1>
<div class="card"><p>把这个码发给朋友，在 GitHub 登录后的欢迎页输入：</p>
<pre>`+esc(display)+`</pre><p class="muted">14 天内有效，仅一次。</p></div>`)
}

func (a *App) welcome(w http.ResponseWriter, r *http.Request) {
	sc := a.session(r)
	if sc == nil {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	if sc.User.Status == "active" {
		http.Redirect(w, r, "/app/", http.StatusFound)
		return
	}
	body := `<h1>需要邀请码</h1><p class="muted">当前 GitHub 账号：<strong>` + esc(sc.User.Login) + `</strong></p>
<div class="card"><form method="post" action="/welcome">
<input type="hidden" name="_csrf" value="` + esc(sc.CSRFToken) + `">
<input type="text" name="code" placeholder="ABCD-EFGH" autofocus>
<button type="submit">激活</button></form>
<p class="muted">mcp-relay 目前是邀请制。</p></div>`
	writeHTML(w, 200, "需要邀请码", body)
}

func (a *App) redeemInvite(w http.ResponseWriter, r *http.Request) {
	sc := a.session(r)
	if sc == nil {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	if !a.checkCSRF(r, sc) {
		writeHTML(w, 403, "校验失败", `<p class="error">CSRF 校验失败。</p>`)
		return
	}
	code := normalizePairingCode(r.PostFormValue("code"))
	if len(code) != 8 {
		writeHTML(w, 400, "邀请码无效", `<p class="error">邀请码格式不正确。</p>`)
		return
	}
	tx, err := a.store.DB.Begin()
	if err != nil {
		writeHTML(w, 500, "错误", `<p class="error">`+esc(err.Error())+`</p>`)
		return
	}
	defer tx.Rollback()
	var expiresAt int64
	var usedAt sql.NullInt64
	if err := tx.QueryRow(`SELECT expires_at, used_at FROM invites WHERE code_hash = ?`, hashToken(code)).Scan(&expiresAt, &usedAt); err != nil || usedAt.Valid || expiresAt <= nowUnix() {
		writeHTML(w, 400, "邀请码无效", `<p class="error">邀请码不存在、已过期或已使用。</p>`)
		return
	}
	if _, err := tx.Exec(`UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL`, sc.User.ID, nowUnix(), hashToken(code)); err != nil {
		writeHTML(w, 500, "错误", `<p class="error">`+esc(err.Error())+`</p>`)
		return
	}
	if _, err := tx.Exec(`UPDATE users SET status = 'active' WHERE id = ?`, sc.User.ID); err != nil {
		writeHTML(w, 500, "错误", `<p class="error">`+esc(err.Error())+`</p>`)
		return
	}
	if err := tx.Commit(); err != nil {
		writeHTML(w, 500, "错误", `<p class="error">`+esc(err.Error())+`</p>`)
		return
	}
	http.Redirect(w, r, "/app/", http.StatusFound)
}

func (a *App) auditPage(w http.ResponseWriter, r *http.Request) {
	sc := a.requireUser(w, r)
	if sc == nil {
		return
	}
	http.Redirect(w, r, "/app/", http.StatusFound)
}

func (a *App) auditPageLegacy(w http.ResponseWriter, r *http.Request) {
	sc := a.requireUser(w, r)
	if sc == nil {
		return
	}
	rows, err := a.store.DB.Query(
		`SELECT tool, COALESCE(device_id, ''), status, COALESCE(error_code, ''), COALESCE(duration_ms, 0), created_at
		   FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 100`, sc.User.ID)
	body := navHTML(sc) + `<h1>审计</h1><p class="muted">最近 100 次工具调用。参数只保存 SHA-256 摘要。</p><div class="card"><table><tr><th>时间</th><th>工具</th><th>设备</th><th>状态</th><th>耗时</th></tr>`
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var tool, device, status, errCode string
			var duration, created int64
			if rows.Scan(&tool, &device, &status, &errCode, &duration, &created) != nil {
				continue
			}
			body += `<tr><td class="muted">` + esc(formatTime(created)) + `</td><td><code>` + esc(tool) + `</code></td><td>` + esc(device) + `</td><td>` + esc(status) + esc(errCode) + `</td><td>` + esc(duration) + ` ms</td></tr>`
		}
	}
	body += `</table></div>`
	writeHTML(w, 200, "审计", body)
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	sc := a.session(r)
	if sc != nil && !a.checkCSRF(r, sc) {
		writeHTML(w, 403, "校验失败", `<p class="error">CSRF 校验失败。</p>`)
		return
	}
	a.destroySession(w, r)
	http.Redirect(w, r, "/", http.StatusFound)
}

func formatTime(sec int64) string {
	if sec <= 0 {
		return "—"
	}
	return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04 MST")
}
