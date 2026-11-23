package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMCPDeviceBucketsDoNotShareDiscoveryOrOtherDeviceBudget(t *testing.T) {
	app, _ := newTestApp(t)
	app.mcpLimiter = newLimiter(1, time.Minute)
	app.mcpDeviceLimiter = newLimiter(1, time.Minute)
	for _, id := range []string{"tablet", "server"} {
		tool := Tool{Name: "read"}
		app.registry.Register(&LiveDevice{ID: id, Slug: id, UserID: "owner", Tools: []Tool{tool},
			ToolIndex: map[string]Tool{deviceToolName(id, "read"): tool}})
	}
	token := &VerifiedToken{UserID: "owner", ClientID: "client"}
	control := &rpcRequest{Method: "tools/list"}
	if !app.allowMCPBucket(httptest.NewRecorder(), token, control) {
		t.Fatal("first discovery rejected")
	}
	blocked := httptest.NewRecorder()
	if app.allowMCPBucket(blocked, token, control) || blocked.Code != 429 {
		t.Fatal("discovery flood was not limited")
	}
	if blocked.Header().Get("Retry-After") == "" {
		t.Fatal("missing retry advice")
	}
	call := func(device string) *rpcRequest {
		params, _ := json.Marshal(map[string]any{"name": "device_call", "arguments": map[string]any{"device": device, "tool": "read"}})
		return &rpcRequest{Method: "tools/call", Params: params}
	}
	if !app.allowMCPBucket(httptest.NewRecorder(), token, call("tablet")) {
		t.Fatal("discovery exhausted tablet execution")
	}
	if app.allowMCPBucket(httptest.NewRecorder(), token, call("tablet")) {
		t.Fatal("tablet flood was not limited")
	}
	if !app.allowMCPBucket(httptest.NewRecorder(), token, call("server")) {
		t.Fatal("tablet exhausted server execution")
	}
	for i := 0; i < 50; i++ {
		app.allowMCPBucket(httptest.NewRecorder(), token, call(fmt.Sprintf("unknown-%d", i)))
	}
	if len(app.mcpDeviceLimiter.hits) != 2 {
		t.Fatal("unknown devices allocated execution buckets")
	}
	if got := app.mcpExecutionDevice("another-user", call("tablet")); got != "" {
		t.Fatal("another user's device was bucketed")
	}
	params, _ := json.Marshal(map[string]any{"name": deviceToolName("tablet", "read")})
	if got := app.mcpExecutionDevice("owner", &rpcRequest{Method: "tools/call", Params: params}); got != "tablet" {
		t.Fatalf("prefixed tool did not share its device bucket: %q", got)
	}
}

func TestMCPAccountAggregateStillCapsAllRequests(t *testing.T) {
	app, server := newTestApp(t)
	app.mcpAggregateLimiter = newLimiter(2, time.Minute)
	user, _, _ := testUser(t, app, "rate-user")
	insertAccessToken(t, app, user.ID, "mra_rate_test", scopeRead)
	for index := 0; index < 3; index++ {
		status, headers, body := doJSONWithAuth(t, http.DefaultClient, server.URL+"/mcp", "mra_rate_test", map[string]any{
			"jsonrpc": "2.0", "id": index + 1, "method": "ping",
		})
		if index < 2 && status != 200 {
			t.Fatalf("early rejection: %d %s", status, body)
		}
		if index == 2 && (status != 429 || headers.Get("Retry-After") == "" || !strings.Contains(string(body), `"scope":"account"`)) {
			t.Fatalf("aggregate cap missing: %d %v %s", status, headers, body)
		}
	}
}

func TestRateLimitReturnsRoundedRemainingWindow(t *testing.T) {
	limiter := newLimiter(1, time.Minute)
	limiter.hits["client"] = []int64{time.Now().Add(-45 * time.Second).UnixNano()}
	allowed, retry := limiter.AllowWithRetry("client")
	if allowed || retry > 15*time.Second || retry < 14*time.Second {
		t.Fatalf("unexpected remaining window %v %v", allowed, retry)
	}
	recorder := httptest.NewRecorder()
	writeMCPRateLimit(recorder, "control", 1234*time.Millisecond)
	if recorder.Header().Get("Retry-After") != "2" || !strings.Contains(recorder.Body.String(), `"retry_after":2`) {
		t.Fatalf("incorrect retry response: %v %s", recorder.Header(), recorder.Body.String())
	}
}
