package app

import "net/http"

type apiUser struct {
	Login     string `json:"login"`
	IsAdmin   bool   `json:"isAdmin"`
	Status    string `json:"status"`
	CSRFToken string `json:"csrfToken"`
}

type apiDevice struct {
	ID       string   `json:"id"`
	Slug     string   `json:"slug"`
	Name     string   `json:"name"`
	Platform string   `json:"platform"`
	Arch     string   `json:"arch"`
	Packs    []string `json:"packs"`
	Online   bool     `json:"online"`
	LastSeen int64    `json:"lastSeen"`
	Revoked  bool     `json:"revoked"`
}

type apiAudit struct {
	Tool       string `json:"tool"`
	DeviceID   string `json:"deviceId"`
	Status     string `json:"status"`
	ErrorCode  string `json:"errorCode"`
	DurationMS int64  `json:"durationMs"`
	CreatedAt  int64  `json:"createdAt"`
}

func (a *App) registerAPIRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/me", a.apiMe)
	mux.HandleFunc("GET /api/devices", a.apiDevices)
	mux.HandleFunc("POST /api/pairing-code", a.apiPairingCode)
	mux.HandleFunc("POST /api/devices/{id}/revoke", a.apiRevokeDevice)
	mux.HandleFunc("GET /api/audit", a.apiAudit)
	mux.HandleFunc("POST /api/invites", a.apiCreateInvite)
}

func apiError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func (a *App) apiSession(w http.ResponseWriter, r *http.Request) *SessionCtx {
	sc := a.session(r)
	if sc == nil {
		apiError(w, http.StatusUnauthorized, "unauthorized")
		return nil
	}
	if sc.User.Status != "active" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "pending", "status": sc.User.Status})
		return nil
	}
	return sc
}

func (a *App) apiCSRF(r *http.Request, sc *SessionCtx) bool {
	if origin := r.Header.Get("Origin"); origin != "" && origin != "null" && origin != a.origin() {
		return false
	}
	token := r.Header.Get("X-CSRF-Token")
	if token == "" {
		_ = r.ParseForm()
		token = r.PostFormValue("_csrf")
	}
	return token != "" && constantTimeEqual(token, sc.CSRFToken)
}

func (a *App) apiMe(w http.ResponseWriter, r *http.Request) {
	sc := a.session(r)
	if sc == nil {
		apiError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	writeJSON(w, 200, apiUser{
		Login:     sc.User.Login,
		IsAdmin:   sc.User.IsAdmin,
		Status:    sc.User.Status,
		CSRFToken: sc.CSRFToken,
	})
}

func (a *App) apiDevices(w http.ResponseWriter, r *http.Request) {
	sc := a.apiSession(w, r)
	if sc == nil {
		return
	}
	rows, err := a.store.DB.Query(
		`SELECT id, slug, name, COALESCE(platform, ''), COALESCE(arch, ''), packs,
		        COALESCE(last_seen_at, 0), COALESCE(revoked_at, 0)
		   FROM devices WHERE user_id = ? ORDER BY created_at DESC`, sc.User.ID)
	if err != nil {
		apiError(w, 500, "database_error")
		return
	}
	defer rows.Close()
	out := make([]apiDevice, 0)
	for rows.Next() {
		var d apiDevice
		var packs string
		var revoked int64
		if rows.Scan(&d.ID, &d.Slug, &d.Name, &d.Platform, &d.Arch, &packs, &d.LastSeen, &revoked) != nil {
			continue
		}
		d.Packs = splitJSONArray(packs)
		d.Online = revoked == 0 && a.registry.Online(d.ID)
		d.Revoked = revoked != 0
		out = append(out, d)
	}
	writeJSON(w, 200, map[string]any{"devices": out})
}

func (a *App) apiPairingCode(w http.ResponseWriter, r *http.Request) {
	sc := a.apiSession(w, r)
	if sc == nil {
		return
	}
	if !a.apiCSRF(r, sc) {
		apiError(w, http.StatusForbidden, "csrf")
		return
	}
	if !a.pairLimiter.Allow(a.clientIP(r)) {
		apiError(w, http.StatusTooManyRequests, "too_many_requests")
		return
	}
	code := randomPairingCode()
	expiresAt := nowUnix() + 600
	if _, err := a.store.DB.Exec(
		`INSERT INTO pairing_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		hashToken(code), sc.User.ID, nowUnix(), expiresAt); err != nil {
		apiError(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, map[string]any{
		"code":      code,
		"display":   displayPairingCode(code),
		"expiresAt": expiresAt,
	})
}

func (a *App) apiRevokeDevice(w http.ResponseWriter, r *http.Request) {
	sc := a.apiSession(w, r)
	if sc == nil {
		return
	}
	if !a.apiCSRF(r, sc) {
		apiError(w, http.StatusForbidden, "csrf")
		return
	}
	id := r.PathValue("id")
	res, err := a.store.DB.Exec(
		`UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		nowUnix(), id, sc.User.ID)
	if err != nil {
		apiError(w, 500, "database_error")
		return
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		apiError(w, http.StatusNotFound, "not_found")
		return
	}
	a.registry.Kick(id)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *App) apiAudit(w http.ResponseWriter, r *http.Request) {
	sc := a.apiSession(w, r)
	if sc == nil {
		return
	}
	rows, err := a.store.DB.Query(
		`SELECT tool, COALESCE(device_id, ''), status, COALESCE(error_code, ''), COALESCE(duration_ms, 0), created_at
		   FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 100`, sc.User.ID)
	if err != nil {
		apiError(w, 500, "database_error")
		return
	}
	defer rows.Close()
	out := make([]apiAudit, 0)
	for rows.Next() {
		var item apiAudit
		if rows.Scan(&item.Tool, &item.DeviceID, &item.Status, &item.ErrorCode, &item.DurationMS, &item.CreatedAt) == nil {
			out = append(out, item)
		}
	}
	writeJSON(w, 200, map[string]any{"entries": out})
}

func (a *App) apiCreateInvite(w http.ResponseWriter, r *http.Request) {
	sc := a.apiSession(w, r)
	if sc == nil {
		return
	}
	if !sc.User.IsAdmin {
		apiError(w, http.StatusForbidden, "admin_required")
		return
	}
	if !a.apiCSRF(r, sc) {
		apiError(w, http.StatusForbidden, "csrf")
		return
	}
	code := randomPairingCode()
	expiresAt := nowUnix() + 14*24*3600
	if _, err := a.store.DB.Exec(
		`INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		hashToken(code), sc.User.ID, nowUnix(), expiresAt); err != nil {
		apiError(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, map[string]any{
		"code":      code,
		"display":   displayPairingCode(code),
		"expiresAt": expiresAt,
	})
}
