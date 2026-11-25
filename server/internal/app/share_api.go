package app

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

func (a *App) registerShareRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/shares", a.apiShares)
	mux.HandleFunc("POST /api/shares", a.apiCreateShare)
	mux.HandleFunc("POST /api/shares/{id}/revoke", a.apiRevokeShare)
	mux.HandleFunc("POST /api/share-claims", a.apiClaimShare)
	mux.HandleFunc("GET /share", a.shareLanding)
	mux.HandleFunc("GET /share/client.js", a.shareClientJS)
}

func shareResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func decodeShareJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		apiError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32*1024)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		apiError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	return true
}

func (a *App) apiShares(w http.ResponseWriter, r *http.Request) {
	shareResponseHeaders(w)
	sc := a.apiSession(w, r)
	if sc == nil {
		return
	}
	shares, err := a.store.ListShares(sc.User.ID)
	if err != nil {
		apiError(w, http.StatusInternalServerError, "database_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"shares": shares})
}

func (a *App) apiCreateShare(w http.ResponseWriter, r *http.Request) {
	shareResponseHeaders(w)
	sc := a.apiSession(w, r)
	if sc == nil {
		return
	}
	if !a.apiCSRF(r, sc) {
		apiError(w, http.StatusForbidden, "csrf")
		return
	}
	if !a.oauthLimiter.Allow("share-create|" + sc.User.ID) {
		apiError(w, http.StatusTooManyRequests, "too_many_requests")
		return
	}
	var input struct {
		Label      string   `json:"label"`
		DeviceIDs  []string `json:"deviceIds"`
		Permission string   `json:"permission"`
		TTLSeconds int64    `json:"ttlSeconds"`
	}
	if !decodeShareJSON(w, r, &input) {
		return
	}
	input.Label = strings.TrimSpace(input.Label)
	if input.Label == "" {
		input.Label = "临时访问"
	}
	if utf8.RuneCountInString(input.Label) > 80 || strings.IndexFunc(input.Label, unicode.IsControl) >= 0 {
		apiError(w, http.StatusBadRequest, "invalid_label")
		return
	}
	if len(input.DeviceIDs) == 0 || len(input.DeviceIDs) > 32 {
		apiError(w, http.StatusBadRequest, "invalid_devices")
		return
	}
	seen := make(map[string]bool, len(input.DeviceIDs))
	for _, id := range input.DeviceIDs {
		if id == "" || len(id) > 128 || seen[id] {
			apiError(w, http.StatusBadRequest, "invalid_devices")
			return
		}
		seen[id] = true
	}
	var scopes []string
	switch input.Permission {
	case "read":
		scopes = []string{scopeRead}
	case "write":
		scopes = []string{scopeRead, scopeWrite}
	default:
		apiError(w, http.StatusBadRequest, "invalid_permission")
		return
	}
	if input.TTLSeconds < 300 || input.TTLSeconds > 7*24*3600 {
		apiError(w, http.StatusBadRequest, "invalid_expiry")
		return
	}
	share, claimToken, err := a.store.CreateShare(sc.User.ID, a.cfg.Resource, input.Label, input.DeviceIDs, scopes, input.TTLSeconds)
	if errors.Is(err, errShareDevices) {
		apiError(w, http.StatusBadRequest, "invalid_devices")
		return
	}
	if errors.Is(err, errShareLimit) {
		apiError(w, http.StatusConflict, "share_limit")
		return
	}
	if err != nil {
		apiError(w, http.StatusInternalServerError, "database_error")
		return
	}
	a.store.Audit(sc.User.ID, "share:"+share.ID, "", "share.create", "", "ok", "", 0)
	writeJSON(w, http.StatusCreated, map[string]any{
		"share": share, "claimUrl": a.cfg.BaseURL + "/share#claim=" + claimToken,
	})
}

func (a *App) apiRevokeShare(w http.ResponseWriter, r *http.Request) {
	shareResponseHeaders(w)
	sc := a.apiSession(w, r)
	if sc == nil {
		return
	}
	if !a.apiCSRF(r, sc) {
		apiError(w, http.StatusForbidden, "csrf")
		return
	}
	id := r.PathValue("id")
	err := a.store.RevokeShare(id, sc.User.ID)
	if errors.Is(err, errShareUnavailable) {
		apiError(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		apiError(w, http.StatusInternalServerError, "database_error")
		return
	}
	a.cancelShareCalls(id)
	a.revokeWorkspaceShare(sc.User.ID, id)
	a.store.Audit(sc.User.ID, "share:"+id, "", "share.revoke", "", "ok", "", 0)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) apiClaimShare(w http.ResponseWriter, r *http.Request) {
	shareResponseHeaders(w)
	// A browser must claim from this relay's landing page. Non-browser clients
	// authenticate with the one-time credential and need no account session.
	if origin := r.Header.Get("Origin"); origin != "" && origin != a.origin() {
		apiError(w, http.StatusForbidden, "invalid_origin")
		return
	}
	if !a.oauthLimiter.Allow("share-claim|" + a.clientIP(r)) {
		apiError(w, http.StatusTooManyRequests, "too_many_requests")
		return
	}
	var input struct {
		ClaimToken string `json:"claimToken"`
	}
	if !decodeShareJSON(w, r, &input) {
		return
	}
	if len(input.ClaimToken) != len("mrclaim_")+43 || !strings.HasPrefix(input.ClaimToken, "mrclaim_") {
		apiError(w, http.StatusGone, "share_unavailable")
		return
	}
	share, accessToken, err := a.store.ClaimShare(hashToken(input.ClaimToken), a.cfg.Resource)
	if errors.Is(err, errShareUnavailable) {
		apiError(w, http.StatusGone, "share_unavailable")
		return
	}
	if err != nil {
		apiError(w, http.StatusInternalServerError, "database_error")
		return
	}
	a.store.Audit(share.UserID, "share:"+share.ID, "", "share.claim", "", "ok", "", 0)
	writeJSON(w, http.StatusOK, map[string]any{
		"share": share, "accessToken": accessToken, "tokenType": "Bearer", "mcpUrl": a.cfg.Resource,
		"expiresAt": share.ExpiresAt, "filename": "relay-access-" + share.ID + ".md",
		"document": shareConnectionDocument(a.cfg.Resource, share, accessToken),
	})
}
