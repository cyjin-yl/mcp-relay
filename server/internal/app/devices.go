package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxToolsPerDevice  = 100
	maxInflightPerDev  = 8
	deviceHeartbeat    = 25 * time.Second
	deviceSilenceLimit = 60 * time.Second
	deviceCallTimeout  = 20 * time.Second
	maxToolSchemaBytes = 64 * 1024
)

var toolNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

type LiveDevice struct {
	ID        string
	UserID    string
	Slug      string
	Name      string
	Tools     []Tool
	ToolIndex map[string]Tool
	conn      *websocket.Conn
	writeMu   sync.Mutex
	pendingMu sync.Mutex
	pending   map[string]chan CallToolResult
	inflight  int
	lastSeen  atomic.Int64
	closed    chan struct{}
	closeOnce sync.Once
}

type Registry struct {
	mu      sync.RWMutex
	devices map[string]*LiveDevice
}

func NewRegistry() *Registry {
	return &Registry{devices: make(map[string]*LiveDevice)}
}

func (r *Registry) Register(d *LiveDevice) {
	r.mu.Lock()
	old := r.devices[d.ID]
	r.devices[d.ID] = d
	r.mu.Unlock()
	if old != nil && old != d {
		old.close(websocket.CloseNormalClosure, "replaced by a newer connection")
	}
}

func (r *Registry) Unregister(d *LiveDevice) {
	r.mu.Lock()
	if r.devices[d.ID] == d {
		delete(r.devices, d.ID)
	}
	r.mu.Unlock()
}

func (r *Registry) Get(id string) *LiveDevice {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.devices[id]
}

func (r *Registry) Kick(id string) {
	if d := r.Get(id); d != nil {
		d.close(websocket.ClosePolicyViolation, "device revoked")
	}
}

func (r *Registry) Online(id string) bool { return r.Get(id) != nil }

func (r *Registry) ListForUser(userID string) []*LiveDevice {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []*LiveDevice
	for _, d := range r.devices {
		if d.UserID == userID {
			out = append(out, d)
		}
	}
	return out
}

func (r *Registry) ToolsForUser(userID string) []Tool {
	var out []Tool
	for _, d := range r.ListForUser(userID) {
		for _, tool := range d.Tools {
			out = append(out, Tool{
				Name:        deviceToolName(d.Slug, tool.Name),
				Title:       tool.Title,
				Description: "[" + d.Name + "] " + tool.Description,
				InputSchema: tool.InputSchema,
				Annotations: tool.Annotations,
			})
		}
	}
	return out
}

func (r *Registry) FindDevice(userID, identifier string) (*LiveDevice, bool) {
	for _, d := range r.ListForUser(userID) {
		if d.ID == identifier || d.Slug == identifier {
			return d, true
		}
	}
	return nil, false
}

func (r *Registry) FindTool(userID, name string) (*LiveDevice, Tool, bool) {
	for _, d := range r.ListForUser(userID) {
		if tool, ok := d.ToolIndex[name]; ok {
			return d, tool, true
		}
	}
	return nil, Tool{}, false
}

func (d *LiveDevice) send(v any) error {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	_ = d.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return d.conn.WriteJSON(v)
}

func (d *LiveDevice) call(tool string, args json.RawMessage, timeout time.Duration) (CallToolResult, error) {
	d.pendingMu.Lock()
	if d.inflight >= maxInflightPerDev {
		d.pendingMu.Unlock()
		return CallToolResult{}, errors.New("device is busy; retry shortly")
	}
	id := randomID()
	ch := make(chan CallToolResult, 1)
	d.pending[id] = ch
	d.inflight++
	d.pendingMu.Unlock()

	if err := d.send(map[string]any{
		"type":      "call",
		"id":        id,
		"tool":      tool,
		"args":      args,
		"timeoutMs": timeout.Milliseconds(),
	}); err != nil {
		d.finish(id)
		return CallToolResult{}, fmt.Errorf("failed to send call to device: %w", err)
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case result := <-ch:
		return result, nil
	case <-timer.C:
		d.finish(id)
		return CallToolResult{}, errors.New("device tool call timed out")
	case <-d.closed:
		return CallToolResult{}, errors.New("device disconnected")
	}
}

func (d *LiveDevice) finish(id string) {
	d.pendingMu.Lock()
	if _, ok := d.pending[id]; ok {
		delete(d.pending, id)
		d.inflight--
	}
	d.pendingMu.Unlock()
}

func (d *LiveDevice) deliver(id string, result CallToolResult) {
	d.pendingMu.Lock()
	ch, ok := d.pending[id]
	if ok {
		delete(d.pending, id)
		d.inflight--
	}
	d.pendingMu.Unlock()
	if ok {
		select {
		case ch <- result:
		default:
		}
	}
}

func (d *LiveDevice) close(code int, reason string) {
	d.closeOnce.Do(func() {
		close(d.closed)
		d.pendingMu.Lock()
		for id, ch := range d.pending {
			delete(d.pending, id)
			select {
			case ch <- textResult("device disconnected", true):
			default:
			}
		}
		d.inflight = 0
		d.pendingMu.Unlock()
		d.writeMu.Lock()
		_ = d.conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(code, reason), time.Now().Add(2*time.Second))
		d.writeMu.Unlock()
		_ = d.conn.Close()
	})
}

func deviceToolName(slug, tool string) string {
	raw := "d_" + slug + "__" + tool
	if len(raw) <= 64 {
		return raw
	}
	return raw[:55] + "_" + hashToken(raw)[:8]
}

type helloMessage struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol"`
	Device   struct {
		Name     string   `json:"name"`
		Platform string   `json:"platform"`
		Arch     string   `json:"arch"`
		Version  string   `json:"version"`
		Packs    []string `json:"packs"`
	} `json:"device"`
	Tools []Tool `json:"tools"`
}

type resultMessage struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	CheckOrigin:     func(*http.Request) bool { return true },
}

func (a *App) registerDeviceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /device/ws", a.deviceWebSocket)
	mux.HandleFunc("POST /api/device/pair", a.pairDevice)
}

func (a *App) deviceAuth(r *http.Request) (*Device, *User, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return nil, nil, false
	}
	raw := strings.TrimSpace(header[7:])
	if !strings.HasPrefix(raw, "mrd_") {
		return nil, nil, false
	}
	var d Device
	var platform, arch, packs sql.NullString
	var lastSeen, revoked sql.NullInt64
	var userID, login, status string
	err := a.store.DB.QueryRow(
		`SELECT d.id, d.user_id, d.slug, d.name, d.platform, d.arch, d.packs, d.created_at, d.last_seen_at, d.revoked_at,
		        u.id, u.login, u.status
		   FROM devices d JOIN users u ON u.id = d.user_id
		  WHERE d.token_hash = ?`, hashToken(raw)).
		Scan(&d.ID, &d.UserID, &d.Slug, &d.Name, &platform, &arch, &packs, &d.CreatedAt, &lastSeen, &revoked,
			&userID, &login, &status)
	if err != nil {
		return nil, nil, false
	}
	d.Platform = platform.String
	d.Arch = arch.String
	d.Packs = splitJSONArray(packs.String)
	d.LastSeenAt = lastSeen.Int64
	d.RevokedAt = revoked.Int64
	if d.RevokedAt != 0 || status != "active" {
		return nil, nil, false
	}
	return &d, &User{ID: userID, Login: login, Status: status}, true
}

func (a *App) deviceWebSocket(w http.ResponseWriter, r *http.Request) {
	device, _, ok := a.deviceAuth(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="mcp-relay-device"`)
		http.Error(w, "invalid device token", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(1024 * 1024)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var hello helloMessage
	if err := conn.ReadJSON(&hello); err != nil {
		_ = conn.Close()
		return
	}
	if hello.Type != "hello" || hello.Protocol != 1 {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4002, "unsupported protocol"), time.Now().Add(time.Second))
		_ = conn.Close()
		return
	}
	tools, err := validateTools(hello.Tools)
	if err != nil {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4003, err.Error()), time.Now().Add(time.Second))
		_ = conn.Close()
		return
	}
	name := strings.TrimSpace(hello.Device.Name)
	if name == "" {
		name = device.Name
	}
	if len(name) > 64 {
		name = name[:64]
	}
	live := &LiveDevice{
		ID:        device.ID,
		UserID:    device.UserID,
		Slug:      device.Slug,
		Name:      name,
		Tools:     tools,
		ToolIndex: make(map[string]Tool, len(tools)),
		conn:      conn,
		pending:   make(map[string]chan CallToolResult),
		closed:    make(chan struct{}),
	}
	for _, tool := range tools {
		live.ToolIndex[deviceToolName(device.Slug, tool.Name)] = tool
	}
	live.lastSeen.Store(time.Now().Unix())
	a.registry.Register(live)

	platform := truncate(hello.Device.Platform, 64)
	arch := truncate(hello.Device.Arch, 32)
	packs := hello.Device.Packs
	if len(packs) > 10 {
		packs = packs[:10]
	}
	_, _ = a.store.DB.Exec(
		`UPDATE devices SET name = ?, platform = ?, arch = ?, packs = ?, last_seen_at = ? WHERE id = ?`,
		name, platform, arch, marshalJSON(packs), nowUnix(), device.ID)

	if err := live.send(map[string]any{
		"type":       "hello_ack",
		"deviceId":   device.ID,
		"slug":       device.Slug,
		"serverTime": time.Now().Unix(),
	}); err != nil {
		live.close(websocket.CloseInternalServerErr, "hello failed")
		a.registry.Unregister(live)
		return
	}

	go a.deviceHeartbeat(live)
	defer func() {
		a.registry.Unregister(live)
		live.close(websocket.CloseNormalClosure, "bye")
	}()
	_ = conn.SetReadDeadline(time.Now().Add(deviceSilenceLimit))
	for {
		var raw json.RawMessage
		if err := conn.ReadJSON(&raw); err != nil {
			return
		}
		live.lastSeen.Store(time.Now().Unix())
		_ = conn.SetReadDeadline(time.Now().Add(deviceSilenceLimit))
		var envelope struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			continue
		}
		switch envelope.Type {
		case "pong":
			// liveness already recorded
		case "result":
			var msg resultMessage
			if err := json.Unmarshal(raw, &msg); err != nil || msg.ID == "" {
				continue
			}
			if msg.OK {
				var result CallToolResult
				if err := json.Unmarshal(msg.Result, &result); err == nil {
					live.deliver(msg.ID, result)
				} else {
					live.deliver(msg.ID, textResult("device returned an invalid result", true))
				}
			} else {
				message := "device tool failed"
				if msg.Error != nil && msg.Error.Message != "" {
					message = msg.Error.Message
				}
				live.deliver(msg.ID, textResult(message, true))
			}
		}
	}
}

func (a *App) deviceHeartbeat(d *LiveDevice) {
	ticker := time.NewTicker(deviceHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-d.closed:
			return
		case <-ticker.C:
			if time.Since(time.Unix(d.lastSeen.Load(), 0)) > deviceSilenceLimit {
				d.close(websocket.CloseGoingAway, "heartbeat timeout")
				return
			}
			if err := d.send(map[string]any{"type": "ping"}); err != nil {
				d.close(websocket.CloseGoingAway, "heartbeat write failed")
				return
			}
		}
	}
}

func validateTools(tools []Tool) ([]Tool, error) {
	if len(tools) == 0 {
		return nil, errors.New("device exposed no tools")
	}
	if len(tools) > maxToolsPerDevice {
		return nil, fmt.Errorf("too many tools (max %d)", maxToolsPerDevice)
	}
	seen := make(map[string]bool, len(tools))
	out := make([]Tool, 0, len(tools))
	for _, tool := range tools {
		if !toolNamePattern.MatchString(tool.Name) {
			return nil, fmt.Errorf("invalid tool name %q", tool.Name)
		}
		if seen[tool.Name] {
			return nil, fmt.Errorf("duplicate tool name %q", tool.Name)
		}
		seen[tool.Name] = true
		if len(tool.InputSchema) == 0 || len(tool.InputSchema) > maxToolSchemaBytes || !json.Valid(tool.InputSchema) {
			return nil, fmt.Errorf("invalid input schema for %q", tool.Name)
		}
		var obj map[string]any
		if err := json.Unmarshal(tool.InputSchema, &obj); err != nil {
			return nil, fmt.Errorf("invalid input schema for %q", tool.Name)
		}
		if tool.Description == "" {
			tool.Description = tool.Name
		}
		out = append(out, tool)
	}
	return out, nil
}

type pairRequest struct {
	Code     string   `json:"code"`
	Name     string   `json:"name"`
	Platform string   `json:"platform"`
	Arch     string   `json:"arch"`
	Packs    []string `json:"packs"`
	Version  string   `json:"version"`
}

func (a *App) pairDevice(w http.ResponseWriter, r *http.Request) {
	if !a.allow(a.pairLimiter, r) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "too_many_requests"})
		return
	}
	defer r.Body.Close()
	var req pairRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 16*1024)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid_request"})
		return
	}
	code := normalizePairingCode(req.Code)
	if len(code) != 8 {
		writeJSON(w, 400, map[string]any{"error": "invalid_code"})
		return
	}
	tx, err := a.store.DB.Begin()
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": "server_error"})
		return
	}
	defer tx.Rollback()
	var userID string
	var expiresAt int64
	var usedAt sql.NullInt64
	if err := tx.QueryRow(`SELECT user_id, expires_at, used_at FROM pairing_codes WHERE code_hash = ?`, hashToken(code)).
		Scan(&userID, &expiresAt, &usedAt); err != nil || usedAt.Valid || expiresAt <= nowUnix() {
		writeJSON(w, 400, map[string]any{"error": "invalid_code"})
		return
	}
	res, err := tx.Exec(`UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`, nowUnix(), hashToken(code))
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": "server_error"})
		return
	}
	if n, _ := res.RowsAffected(); n != 1 {
		writeJSON(w, 400, map[string]any{"error": "invalid_code"})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "device"
	}
	name = truncate(name, 64)
	baseSlug := slugifyDeviceName(name)
	deviceID := "dev_" + randomID()
	token := randomToken("mrd_")
	var slug string
	inserted := false
	for range 8 {
		slug = baseSlug + "-" + randomHex(2)
		_, err = tx.Exec(
			`INSERT INTO devices (id, user_id, slug, name, platform, arch, packs, token_hash, created_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			deviceID, userID, slug, name, truncate(req.Platform, 64), truncate(req.Arch, 32),
			marshalJSON(req.Packs), hashToken(token), nowUnix(), 0)
		if err == nil {
			inserted = true
			break
		}
	}
	if !inserted {
		writeJSON(w, 500, map[string]any{"error": "could_not_allocate_device_slug"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSON(w, 500, map[string]any{"error": "server_error"})
		return
	}
	wsScheme := "wss"
	if strings.HasPrefix(a.cfg.BaseURL, "http://") {
		wsScheme = "ws"
	}
	writeJSON(w, 201, map[string]any{
		"deviceId": deviceID,
		"slug":     slug,
		"token":    token,
		"wsUrl":    wsScheme + strings.TrimPrefix(a.cfg.BaseURL, "http") + "/device/ws",
	})
}
