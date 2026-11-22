package app

import (
	"bufio"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

//go:embed static/app.css
var staticFS embed.FS

type App struct {
	cfg          Config
	store        *Store
	registry     *Registry
	client       *http.Client
	limiter      *limiter
	oauthLimiter *limiter
	mcpLimiter   *limiter
	pairLimiter  *limiter
}

func New(cfg Config) (*App, error) {
	st, err := OpenStore(cfg.DBPath)
	if err != nil {
		return nil, err
	}
	return &App{
		cfg:          cfg,
		store:        st,
		registry:     NewRegistry(),
		client:       &http.Client{Timeout: 10 * time.Second},
		limiter:      newLimiter(20, time.Hour),
		oauthLimiter: newLimiter(300, time.Minute),
		mcpLimiter:   newLimiter(120, time.Minute),
		pairLimiter:  newLimiter(10, time.Hour),
	}, nil
}

func (a *App) Close() error { return a.store.Close() }

func (a *App) Prune() { a.store.Prune() }

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	a.registerRoutes(mux)
	return a.middleware(mux)
}

func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": "mcp-relay"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if err := a.store.DB.Ping(); err != nil {
			writeJSON(w, 503, map[string]any{"ok": false})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	a.registerOAuthRoutes(mux)
	a.registerGitHubRoutes(mux)
	a.registerWebRoutes(mux)
	a.registerAPIRoutes(mux)
	a.registerMCPRoutes(mux)
	a.registerDeviceRoutes(mux)
	mux.HandleFunc("GET /static/app.css", func(w http.ResponseWriter, _ *http.Request) {
		data, err := staticFS.ReadFile("static/app.css")
		if err != nil {
			http.NotFound(w, nil)
			return
		}
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write(data)
	})
}

func (a *App) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
		if a.cfg.SecureCookies {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		defer func() {
			if recovered := recover(); recovered != nil {
				slog.Error("panic", "path", r.URL.Path, "err", recovered)
				if rec.status == 200 {
					http.Error(rec, "internal error", http.StatusInternalServerError)
				}
			}
			slog.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "ms", time.Since(start).Milliseconds(), "ip", a.clientIP(r))
		}()
		next.ServeHTTP(rec, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("hijacking not supported")
	}
	return h.Hijack()
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (a *App) clientIP(r *http.Request) string {
	if a.cfg.TrustProxy {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err == nil {
			ip := net.ParseIP(host)
			if ip != nil && (ip.IsLoopback() || ip.IsPrivate()) {
				if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
					return cf
				}
				if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
					if first, _, ok := strings.Cut(xff, ","); ok {
						return strings.TrimSpace(first)
					}
					return strings.TrimSpace(xff)
				}
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *App) origin() string {
	u, _ := url.Parse(a.cfg.BaseURL)
	return u.Scheme + "://" + u.Host
}

func (a *App) cookieName() string {
	if a.cfg.SecureCookies {
		return "__Host-mrl_session"
	}
	return "mrl_session"
}

func (a *App) session(r *http.Request) *SessionCtx {
	c, err := r.Cookie(a.cookieName())
	if err != nil || c.Value == "" {
		return nil
	}
	sc, err := a.store.Session(hashToken(c.Value))
	if err != nil {
		slog.Error("session lookup", "err", err)
		return nil
	}
	return sc
}

func (a *App) createSession(w http.ResponseWriter, userID string) (*SessionCtx, error) {
	token, csrf, expiresAt, err := a.store.CreateSession(userID, a.cfg.SessionTTL)
	if err != nil {
		return nil, err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     a.cookieName(),
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   a.cfg.SecureCookies,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Unix(expiresAt, 0),
	})
	sc, err := a.store.Session(hashToken(token))
	if err != nil {
		return nil, err
	}
	if sc == nil {
		return &SessionCtx{CSRFToken: csrf, ExpiresAt: expiresAt}, nil
	}
	return sc, nil
}

func (a *App) destroySession(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(a.cookieName()); err == nil && c.Value != "" {
		_ = a.store.DeleteSession(hashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{
		Name:     a.cookieName(),
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   a.cfg.SecureCookies,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func (a *App) requireUser(w http.ResponseWriter, r *http.Request) *SessionCtx {
	sc := a.session(r)
	if sc == nil {
		target := url.QueryEscape(r.URL.RequestURI())
		http.Redirect(w, r, "/login?return_to="+target, http.StatusFound)
		return nil
	}
	if sc.User.Status != "active" {
		http.Redirect(w, r, "/welcome", http.StatusFound)
		return nil
	}
	return sc
}

func (a *App) checkCSRF(r *http.Request, sc *SessionCtx) bool {
	origin := r.Header.Get("Origin")
	// ChatGPT's consent webview posts with "Origin: null"; the session-bound CSRF
	// token remains the authorization check, so accept null/absent origin.
	if origin != "" && origin != "null" && origin != a.origin() {
		slog.Warn("csrf origin mismatch", "path", r.URL.Path, "origin", origin, "expected", a.origin())
		return false
	}
	if err := r.ParseForm(); err != nil {
		slog.Warn("csrf form parse failed", "path", r.URL.Path, "err", err)
		return false
	}
	token := r.PostFormValue("_csrf")
	if token == "" {
		slog.Warn("csrf token missing", "path", r.URL.Path, "content_type", r.Header.Get("Content-Type"), "content_length", r.ContentLength)
		return false
	}
	if !constantTimeEqual(token, sc.CSRFToken) {
		slog.Warn("csrf token mismatch", "path", r.URL.Path, "token_len", len(token), "expected_len", len(sc.CSRFToken))
		return false
	}
	return true
}

func (a *App) allow(limiter *limiter, r *http.Request) bool {
	return limiter.Allow(a.clientIP(r))
}

type limiter struct {
	mu     sync.Mutex
	hits   map[string][]int64
	max    int
	window time.Duration
}

func newLimiter(max int, window time.Duration) *limiter {
	return &limiter{hits: make(map[string][]int64), max: max, window: window}
}

func (l *limiter) Allow(key string) bool {
	now := time.Now().UnixNano()
	cutoff := now - int64(l.window)
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.hits[key]
	kept := entry[:0]
	for _, ts := range entry {
		if ts > cutoff {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= l.max {
		l.hits[key] = kept
		return false
	}
	if len(l.hits) > 10000 {
		for candidate, timestamps := range l.hits {
			if len(timestamps) == 0 || timestamps[len(timestamps)-1] <= cutoff {
				delete(l.hits, candidate)
			}
		}
	}
	l.hits[key] = append(kept, now)
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeHTML(w http.ResponseWriter, status int, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(page(title, body)))
}

func page(title, body string) string {
	css, _ := staticFS.ReadFile("static/app.css")
	_ = css
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>` + html.EscapeString(title) + ` · mcp-relay</title>
<link rel="stylesheet" href="/static/app.css"></head>
<body><main>` + body + `</main></body></html>`
}

func esc(v any) string { return html.EscapeString(fmt.Sprint(v)) }

func isNotFound(err error) bool { return errors.Is(err, os.ErrNotExist) }
