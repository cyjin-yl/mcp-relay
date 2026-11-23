package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const mcpInstructions = "mcp-relay exposes tools on the user's online devices. Call devices_list first; it returns each device id and slug. If a device's d_<slug>__* tools are not in this conversation's tool list, call device_tools_list then device_call({device,tool,arguments}) using the id or slug. Read-only targets need relay.read; writes need relay.write. Do not assume devices share a filesystem. Use omp_hash before omp_apply_patch."

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
	w.Header().Set("Access-Control-Expose-Headers", "Mcp-Session-Id, Retry-After")
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
	if allowed, retry := a.mcpAggregateLimiter.AllowWithRetry(token.UserID); !allowed {
		writeMCPRateLimit(w, "account", retry)
		return
	}
	if version := r.Header.Get("MCP-Protocol-Version"); version != "" && !protocolSupported(version) {
		if !a.allowMCPBucket(w, token, nil) {
			return
		}
		writeRPCError(w, json.RawMessage("null"), -32600, "unsupported MCP-Protocol-Version")
		return
	}
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
	if err != nil || len(body) > 1024*1024 {
		if !a.allowMCPBucket(w, token, nil) {
			return
		}
		writeRPCError(w, json.RawMessage("null"), -32700, "request body too large or unreadable")
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		if !a.allowMCPBucket(w, token, nil) {
			return
		}
		writeRPCError(w, json.RawMessage("null"), -32700, "parse error")
		return
	}
	if req.JSONRPC != "2.0" || req.Method == "" {
		if !a.allowMCPBucket(w, token, nil) {
			return
		}
		writeRPCError(w, idOrNull(req.ID), -32600, "invalid request")
		return
	}
	if !a.allowMCPBucket(w, token, &req) {
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
		tools := []Tool{devicesListTool(), deviceToolsListTool(), deviceCallTool()}
		tools = append(tools, a.registry.ToolsForUser(token.UserID)...)
		writeRPCResult(w, req.ID, map[string]any{"tools": tools})
	case "tools/call":
		if notification {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		a.mcpToolCall(r.Context(), w, req, token)
	default:
		writeRPCError(w, req.ID, -32601, "method not found")
	}
}

// Bucket only an authenticated user's existing device and exact tool. Invalid
// device IDs remain in the control bucket and cannot allocate arbitrary keys.
func (a *App) mcpExecutionDevice(userID string, req *rpcRequest) string {
	if req == nil || req.Method != "tools/call" {
		return ""
	}
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(req.Params, &params) != nil {
		return ""
	}
	if params.Name == "device_call" {
		var args struct {
			Device string `json:"device"`
			Tool   string `json:"tool"`
		}
		if json.Unmarshal(params.Arguments, &args) != nil {
			return ""
		}
		device, ok := a.registry.FindDevice(userID, args.Device)
		if !ok {
			return ""
		}
		for _, tool := range device.Tools {
			if tool.Name == args.Tool {
				return device.ID
			}
		}
		return ""
	}
	if device, _, ok := a.registry.FindTool(userID, params.Name); ok {
		return device.ID
	}
	return ""
}

func (a *App) allowMCPBucket(w http.ResponseWriter, token *VerifiedToken, req *rpcRequest) bool {
	key := token.UserID + "|" + token.ClientID
	bucket, scope := a.mcpLimiter, "control"
	if deviceID := a.mcpExecutionDevice(token.UserID, req); deviceID != "" {
		bucket, scope = a.mcpDeviceLimiter, "device"
		key += "|" + deviceID
	}
	allowed, retry := bucket.AllowWithRetry(key)
	if !allowed {
		writeMCPRateLimit(w, scope, retry)
	}
	return allowed
}

func writeMCPRateLimit(w http.ResponseWriter, scope string, retry time.Duration) {
	seconds := int64((retry + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	writeJSON(w, http.StatusTooManyRequests, map[string]any{
		"error": "too_many_requests", "retry_after": seconds, "scope": scope,
	})
}

func (a *App) mcpToolCall(ctx context.Context, w http.ResponseWriter, req rpcRequest, token *VerifiedToken) {
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
	if params.Name == "device_tools_list" {
		if !hasScope(token.Scopes, scopeRead) {
			a.sendInsufficientScope(w, scopeRead)
			return
		}
		a.mcpDeviceToolsList(w, req, token, args)
		return
	}
	if params.Name == "device_call" {
		a.mcpDeviceCall(ctx, w, req, token, args)
		return
	}
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
	result, err := device.call(ctx, tool.Name, args, toolExecutionTimeout(tool.Name, args))
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
		ID       string   `json:"id"`
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
				ID:       id,
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

func deviceToolsListTool() Tool {
	schema := json.RawMessage(`{"type":"object","properties":{"device":{"type":"string","description":"Device id (dev_...) or slug from devices_list"}},"required":["device"],"additionalProperties":false}`)
	readOnly := true
	return Tool{
		Name:        "device_tools_list",
		Title:       "List a device's tools",
		Description: "Return the raw tool names, descriptions and JSON Schemas for one online device. Use before device_call when the d_<slug>__* tools are not loaded in this conversation.",
		InputSchema: schema,
		Annotations: &Annotations{ReadOnly: &readOnly},
	}
}

func deviceCallTool() Tool {
	schema := json.RawMessage(`{"type":"object","properties":{"device":{"type":"string","description":"Device id (dev_...) or slug from devices_list"},"tool":{"type":"string","description":"Raw tool name from device_tools_list, e.g. bash or omp_apply_patch"},"arguments":{"type":"object","description":"Tool arguments as a JSON object"}},"required":["device","tool"],"additionalProperties":false}`)
	return Tool{
		Name:        "device_call",
		Title:       "Call a device tool",
		Description: "Call a tool on a specific online device by id or slug. Use this for a device that is missing from the conversation's d_<slug>__* tool list; call device_tools_list first if the raw tool name is unknown. Write targets require relay.write and user confirmation.",
		InputSchema: schema,
	}
}

func (a *App) mcpDeviceToolsList(w http.ResponseWriter, req rpcRequest, token *VerifiedToken, args json.RawMessage) {
	var params struct {
		Device string `json:"device"`
	}
	if err := json.Unmarshal(args, &params); err != nil || params.Device == "" {
		writeRPCResult(w, req.ID, textResult("device_tools_list requires {device}", true))
		return
	}
	device, ok := a.registry.FindDevice(token.UserID, params.Device)
	if !ok {
		writeRPCResult(w, req.ID, textResult("device is not online or does not belong to this account; call devices_list", true))
		return
	}
	writeRPCResult(w, req.ID, jsonResult(map[string]any{
		"device": map[string]any{"id": device.ID, "slug": device.Slug, "name": device.Name},
		"tools":  device.Tools,
	}))
}

func (a *App) mcpDeviceCall(ctx context.Context, w http.ResponseWriter, req rpcRequest, token *VerifiedToken, args json.RawMessage) {
	var params struct {
		Device    string          `json:"device"`
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(args, &params); err != nil || params.Device == "" || params.Tool == "" {
		writeRPCResult(w, req.ID, textResult("device_call requires {device, tool, arguments?}", true))
		return
	}
	callArgs := params.Arguments
	if len(callArgs) == 0 || string(callArgs) == "null" {
		callArgs = json.RawMessage("{}")
	}
	var obj map[string]any
	if err := json.Unmarshal(callArgs, &obj); err != nil || obj == nil {
		writeRPCResult(w, req.ID, textResult("device_call arguments must be a JSON object", true))
		return
	}
	device, ok := a.registry.FindDevice(token.UserID, params.Device)
	if !ok {
		writeRPCResult(w, req.ID, textResult("device is not online or does not belong to this account; call devices_list", true))
		return
	}
	var target Tool
	found := false
	for _, candidate := range device.Tools {
		if candidate.Name == params.Tool {
			target = candidate
			found = true
			break
		}
	}
	if !found {
		names := make([]string, 0, len(device.Tools))
		for _, candidate := range device.Tools {
			names = append(names, candidate.Name)
		}
		writeRPCResult(w, req.ID, textResult("unknown tool "+params.Tool+" on "+device.Slug+"; call device_tools_list. Available: "+strings.Join(names, ", "), true))
		return
	}
	needed := scopeRead
	if !target.readOnly() {
		needed = scopeWrite
	}
	if !hasScope(token.Scopes, needed) {
		a.sendInsufficientScope(w, needed)
		return
	}
	start := time.Now()
	result, err := device.call(ctx, target.Name, callArgs, toolExecutionTimeout(target.Name, callArgs))
	status := "ok"
	errCode := ""
	if err != nil {
		result = textResult(err.Error(), true)
		status = "error"
		errCode = "device_error"
	}
	a.store.Audit(token.UserID, token.ClientID, device.ID, "device_call:"+target.Name, hashToken(string(callArgs)), status, errCode, time.Since(start).Milliseconds())
	writeRPCResult(w, req.ID, result)
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
