package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"github.com/gorilla/websocket"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestComputerExecutionBudgets(t *testing.T) {
	for _, name := range []string{"computer_info", "computer_screenshot", "computer_action", "computer_handoff", "computer_setup"} {
		for _, tc := range []struct {
			args string
			want time.Duration
		}{
			{"{}", 33 * time.Second},
			{`{"timeout_ms":1}`, 3001 * time.Millisecond},
			{`{"timeout_ms":0}`, 33 * time.Second},
			{`{"timeout_ms":1000}`, 4 * time.Second},
			{`{"timeout_ms":120000}`, 123 * time.Second},
			{`{"timeout_ms":999}`, 3999 * time.Millisecond},
			{`{"timeout_ms":120001}`, 33 * time.Second},
			{`{"timeout_ms":"120000"}`, 33 * time.Second},
		} {
			if got := toolExecutionTimeout(name, json.RawMessage(tc.args)); got != tc.want {
				t.Errorf("%s %s: got %s, want %s", name, tc.args, got, tc.want)
			}
		}
	}
}
func TestComputerSchemasKeepStructureAndWriteScopes(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"action":{"oneOf":[{"const":"click"},{"const":"type"}]},"display":{"type":["string","null"]}},"additionalProperties":false}`)
	readOnly := true
	for _, name := range []string{"computer_action", "computer_handoff", "computer_setup"} {
		advertised := Tool{Name: name, InputSchema: schema, Annotations: &Annotations{ReadOnly: &readOnly}}
		if advertised.readOnly() {
			t.Fatalf("%s trusted an incorrect read-only hint", name)
		}
		validated, err := validateTools([]Tool{advertised})
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(validated[0].InputSchema, schema) {
			t.Fatal("nested JSON Schema was changed")
		}
		if validated[0].Annotations == nil || validated[0].Annotations.ReadOnly == nil || *validated[0].Annotations.ReadOnly {
			t.Fatalf("%s still advertises read-only", name)
		}
		if !*advertised.Annotations.ReadOnly {
			t.Fatal("normalization mutated caller annotations")
		}
	}
	for _, name := range []string{"computer_info", "computer_screenshot"} {
		if !(Tool{Name: name, Annotations: &Annotations{ReadOnly: &readOnly}}).readOnly() {
			t.Fatalf("%s lost read access", name)
		}
	}
}
func computerWSFixture(t *testing.T, tools []Tool) (*App, *httptest.Server, *websocket.Conn) {
	t.Helper()
	app, server := newTestApp(t)
	user, _, _ := testUser(t, app, "computer-fixture")
	_, err := app.store.DB.Exec(`INSERT INTO devices(id,user_id,slug,name,platform,arch,packs,token_hash,created_at,last_seen_at)
 VALUES('dev_computer_fixture',?,'computer-fixture','computer-fixture','test','test','[]',?,?,0)`, user.ID, hashToken("mrd_computer_fixture"), nowUnix())
	if err != nil {
		t.Fatal(err)
	}
	insertAccessToken(t, app, user.ID, "mra_computer_read", scopeRead)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/device/ws", http.Header{"Authorization": []string{"Bearer mrd_computer_fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(map[string]any{"type": "hello", "protocol": 1, "device": map[string]any{"name": "computer-fixture", "platform": "test", "arch": "test", "version": "test", "packs": []string{"computer"}}, "tools": tools}); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "hello_ack" {
		t.Fatalf("unexpected handshake: %v", ack)
	}
	_ = conn.SetReadDeadline(time.Time{})
	return app, server, conn
}
func computerDescriptors() []Tool {
	readOnly := true
	var result []Tool
	for _, name := range []string{"computer_info", "computer_screenshot", "computer_action", "computer_handoff", "computer_setup"} {
		result = append(result, Tool{Name: name, Description: name, InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`), Annotations: &Annotations{ReadOnly: &readOnly}})
	}
	return result
}

type unexpectedComputerCall struct{ tool string }

func (e *unexpectedComputerCall) Error() string { return "unexpected computer tool: " + e.tool }
func TestNativeImageSurvivesWebSocketAndBothMCPPaths(t *testing.T) {
	_, server, conn := computerWSFixture(t, computerDescriptors())
	picture := image.NewNRGBA(image.Rect(0, 0, 1024, 512))
	for i := 3; i < len(picture.Pix); i += 4 {
		picture.Pix[i] = 255
	}
	var encoded bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.NoCompression}).Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	if encoded.Len() <= 1024*1024 {
		t.Fatal("fixture must cross old websocket limit")
	}
	data := base64.StdEncoding.EncodeToString(encoded.Bytes())
	result := CallToolResult{Content: []ContentBlock{
		{"type": "text", "text": "fixture screenshot"},
		{"type": "image", "data": data, "mimeType": "image/png", "annotations": map[string]any{"audience": []string{"user", "assistant"}}},
	}, StructuredContent: map[string]any{"width": 1024, "height": 512, "coordinateSpace": "native"}, Meta: map[string]any{"fixture": true}}
	for _, generic := range []bool{false, true} {
		finished := make(chan error, 1)
		go func() {
			var call struct{ Type, ID, Tool string }
			if err := conn.ReadJSON(&call); err != nil {
				finished <- err
				return
			}
			if call.Type != "call" || call.Tool != "computer_screenshot" {
				finished <- &unexpectedComputerCall{call.Tool}
				return
			}
			finished <- conn.WriteJSON(map[string]any{"type": "result", "id": call.ID, "ok": true, "result": result})
		}()
		params := map[string]any{"name": deviceToolName("computer-fixture", "computer_screenshot"), "arguments": map[string]any{}}
		if generic {
			params = map[string]any{"name": "device_call", "arguments": map[string]any{"device": "computer-fixture", "tool": "computer_screenshot", "arguments": map[string]any{}}}
		}
		status, _, body := doJSONWithAuth(t, newHTTPClient(), server.URL+"/mcp", "mra_computer_read", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params})
		if err := <-finished; err != nil {
			t.Fatal(err)
		}
		if status != http.StatusOK {
			t.Fatalf("status %d: %.200s", status, body)
		}
		var decoded struct{ Result CallToolResult }
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.Result.IsError || len(decoded.Result.Content) != 2 {
			t.Fatalf("native result changed: error=%v content=%d", decoded.Result.IsError, len(decoded.Result.Content))
		}
		block := decoded.Result.Content[1]
		if block["type"] != "image" || block["data"] != data || block["mimeType"] != "image/png" || block["annotations"] == nil {
			t.Fatal("image block or annotations lost")
		}
		if bytes.Count(body, []byte(data)) != 1 {
			t.Fatal("image duplicated into text or structured content")
		}
		if decoded.Result.StructuredContent == nil || decoded.Result.Meta["fixture"] != true {
			t.Fatal("result metadata lost")
		}
	}
	for _, name := range []string{"computer_action", "computer_handoff", "computer_setup"} {
		for _, generic := range []bool{false, true} {
			params := map[string]any{"name": deviceToolName("computer-fixture", name), "arguments": map[string]any{}}
			if generic {
				params = map[string]any{"name": "device_call", "arguments": map[string]any{"device": "computer-fixture", "tool": name, "arguments": map[string]any{}}}
			}
			status, _, body := doJSONWithAuth(t, newHTTPClient(), server.URL+"/mcp", "mra_computer_read", map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": params})
			if status != http.StatusForbidden {
				t.Fatalf("%s generic=%v escaped write scope: %d %.200s", name, generic, status, body)
			}
		}
	}
}
func TestNativeImageRejectsMalformedOrExcessiveData(t *testing.T) {
	valid := base64.StdEncoding.EncodeToString([]byte("fixture"))
	for _, tc := range []struct {
		name  string
		block ContentBlock
	}{
		{"missing data", ContentBlock{"type": "image", "mimeType": "image/png"}},
		{"invalid encoding", ContentBlock{"type": "image", "mimeType": "image/png", "data": "not base64!"}},
		{"invalid MIME", ContentBlock{"type": "image", "mimeType": "text/plain", "data": valid}},
		{"too large", ContentBlock{"type": "image", "mimeType": "image/png", "data": strings.Repeat("A", base64.StdEncoding.EncodedLen(maxNativeImageBytes)+4)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if validateNativeImages(CallToolResult{Content: []ContentBlock{tc.block}}) == nil {
				t.Fatal("invalid image accepted")
			}
		})
	}
	if err := validateNativeImages(CallToolResult{Content: []ContentBlock{{"type": "image", "mimeType": "image/png", "data": valid}, {"type": "resource_link", "uri": "https://example.com/fixture"}}}); err != nil {
		t.Fatal(err)
	}
}
func TestDeviceWebSocketBoundsTwentyMiBResults(t *testing.T) {
	_, _, conn := computerWSFixture(t, computerDescriptors())
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = conn.WriteMessage(websocket.TextMessage, []byte(strings.Repeat(" ", maxDeviceMessageBytes+1)))
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err := conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseMessageTooBig) {
		t.Fatalf("oversized frame did not get close1009: %v", err)
	}
}
