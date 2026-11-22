package app

import (
	"encoding/json"
	"io"
	"net/http"
	"time"
)

const mcpInstructions = "mcp-relay exposes tools on the user's online devices. Call devices_list first. Tool names are d_<device-slug>__<tool>. Read-only tools need relay.read; writes need relay.write. Do not assume devices share a filesystem. Use omp_hash before omp_apply_patch."

var supportedProtocols = []string{"2025-11-25", "2025-06-18", "2025-03-26"}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (a *App) registerMCPRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /mcp", a.mcpPost)
	mux.HandleFunc("GET /mcp", a.mcpGet)
	mux.HandleFunc("DELETE /mcp", a.mcpDelete)
	mux.HandleFunc("OPTIONS /mcp", a.mcpOptions)
}

func mcpCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id")
	w.Header().Set("Access-Control-Expose-Headers", "Mcp-Session-Id")
}

func (a *App) mcpOptions(w http.ResponseWriter, _ *http.Request) {
	mcpCORS(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) mcpGet(w http.ResponseWriter, _ *http.Request) {
	mcpCORS(w)
	w.Header().Set("Allow", "POST, DELETE")
	writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "SSE stream is not offered; use POST"})
}

func (a *App) mcpDelete(w http.ResponseWriter, _ *http.Request) {
	mcpCORS(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) mcpPost(w http.ResponseWriter, r *http.Request) {
	mcpCORS(w)
	token, ok := a.verifyBearer(r)
	if !ok {
		a.sendUnauthorized(w)
		return
	}
	if !a.mcpLimiter.Allow(token.UserID + "|" + token.ClientID) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "too_many_requests"})
		return
	}
	if version := r.Header.Get("MCP-Protocol-Version"); version != "" && !protocolSupported(version) {
		writeRPCError(w, json.RawMessage("null"), -32600, "unsupported MCP-Protocol-Version")
		return
	}
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
	if err != nil || len(body) > 1024*1024 {
		writeRPCError(w, json.RawMessage("null"), -32700, "request body too large or unreadable")
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeRPCError(w, json.RawMessage("null"), -32700, "parse error")
		return
	}
	if req.JSONRPC != "2.0" || req.Method == "" {
		writeRPCError(w, idOrNull(req.ID), -32600, "invalid request")
		return
	}
	notification := len(req.ID) == 0 || string(req.ID) == "null"

	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		version := "2025-11-25"
		if protocolSupported(params.ProtocolVersion) {
			version = params.ProtocolVersion
		}
		if notification {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeRPCResult(w, req.ID, map[string]any{
			"protocolVersion": version,
			"capabilities": map[string]any{
				"tools": map[string]any{"listChanged": false},
			},
			"serverInfo":   map[string]any{"name": "mcp-relay", "version": "0.1.0"},
			"instructions": mcpInstructions,
		})
	case "notifications/initialized", "notifications/cancelled":
		w.WriteHeader(http.StatusAccepted)
	case "ping":
		if notification {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeRPCResult(w, req.ID, map[string]any{})
	case "tools/list":
		if notification {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		if !hasScope(token.Scopes, scopeRead) {
			a.sendInsufficientScope(w, scopeRead)
			return
		}
		tools := append([]Tool{devicesListTool()}, a.registry.ToolsForUser(token.UserID)...)
		writeRPCResult(w, req.ID, map[string]any{"tools": tools})
	case "tools/call":
		if notification {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		a.mcpToolCall(w, req, token)
	default:
		writeRPCError(w, req.ID, -32601, "method not found")
	}
}

func (a *App) mcpToolCall(w http.ResponseWriter, req rpcRequest, token *VerifiedToken) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil || params.Name == "" {
		writeRPCError(w, req.ID, -32602, "invalid tools/call params")
		return
	}
	args := params.Arguments
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage("{}")
	}
	start := time.Now()
	if params.Name == "devices_list" {
		if !hasScope(token.Scopes, scopeRead) {
			a.sendInsufficientScope(w, scopeRead)
			return
		}
		result := a.devicesListResult(token.UserID)
		a.store.Audit(token.UserID, token.ClientID, "", params.Name, hashToken(string(args)), "ok", "", time.Since(start).Milliseconds())
		writeRPCResult(w, req.ID, result)
		return
	}
	device, tool, found := a.registry.FindTool(token.UserID, params.Name)
	if !found {
		result := textResult("unknown tool: "+params.Name+" (call devices_list and refresh tools)", true)
		a.store.Audit(token.UserID, token.ClientID, "", params.Name, hashToken(string(args)), "error", "tool_not_found", time.Since(start).Milliseconds())
		writeRPCResult(w, req.ID, result)
		return
	}
	needed := scopeRead
	if !tool.readOnly() {
		needed = scopeWrite
	}
	if !hasScope(token.Scopes, needed) {
		a.sendInsufficientScope(w, needed)
		return
	}
	result, err := device.call(tool.Name, args, deviceCallTimeout)
	status := "ok"
	errCode := ""
	if err != nil {
		result = textResult(err.Error(), true)
		status = "error"
		errCode = "device_error"
	}
	a.store.Audit(token.UserID, token.ClientID, device.ID, params.Name, hashToken(string(args)), status, errCode, time.Since(start).Milliseconds())
	writeRPCResult(w, req.ID, result)
}

func (a *App) devicesListResult(userID string) CallToolResult {
	rows, err := a.store.DB.Query(
		`SELECT id, slug, name, COALESCE(platform, ''), COALESCE(arch, ''), packs, COALESCE(last_seen_at, 0)
		   FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`, userID)
	type view struct {
		Slug     string   `json:"slug"`
		Name     string   `json:"name"`
		Platform string   `json:"platform"`
		Arch     string   `json:"arch"`
		Packs    []string `json:"packs"`
		Online   bool     `json:"online"`
		LastSeen int64    `json:"last_seen"`
	}
	out := []view{}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, slug, name, platform, arch, packs string
			var lastSeen int64
			if rows.Scan(&id, &slug, &name, &platform, &arch, &packs, &lastSeen) != nil {
				continue
			}
			out = append(out, view{
				Slug:     slug,
				Name:     name,
				Platform: platform,
				Arch:     arch,
				Packs:    splitJSONArray(packs),
				Online:   a.registry.Online(id),
				LastSeen: lastSeen,
			})
		}
	}
	payload, _ := json.MarshalIndent(map[string]any{
		"devices": out,
		"hint":    "tool names are d_<slug>__<tool>; only online devices appear in tools/list",
	}, "", "  ")
	return CallToolResult{Content: []ContentBlock{{"type": "text", "text": string(payload)}}}
}

func devicesListTool() Tool {
	schema := json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)
	readOnly := true
	return Tool{
		Name:        "devices_list",
		Title:       "List devices",
		Description: "List this user's mcp-relay devices with online status, packs, and last-seen time. Use this before calling device tools.",
		InputSchema: schema,
		Annotations: &Annotations{ReadOnly: &readOnly},
	}
}

func writeRPCResult(w http.ResponseWriter, id json.RawMessage, result any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      idOrNull(id),
		"result":  result,
	})
}

func writeRPCError(w http.ResponseWriter, id json.RawMessage, code int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      idOrNull(id),
		"error":   rpcError{Code: code, Message: message},
	})
}

func idOrNull(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

func protocolSupported(version string) bool {
	for _, supported := range supportedProtocols {
		if version == supported {
			return true
		}
	}
	return false
}

func hasScope(scopes []string, wanted string) bool {
	for _, scope := range scopes {
		if scope == wanted {
			return true
		}
	}
	return false
}
