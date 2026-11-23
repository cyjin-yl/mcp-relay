package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestToolExecutionTimeoutMatchesAdvertisedShellBudget(t *testing.T) {
	for _, tc := range []struct {
		tool, args string
		want       time.Duration
	}{
		{"read", `{}`, 20 * time.Second},
		{"bash", `{}`, 31 * time.Second},
		{"bash", `{"timeout_ms":1000}`, 2 * time.Second},
		{"bash", `{"timeout_ms":120000}`, 121 * time.Second},
		{"bash", `{"timeout_ms":999999999}`, 31 * time.Second},
		{"bash", `{"timeout_ms":"120000"}`, 31 * time.Second},
		{"bash_confirm", `{}`, 121 * time.Second},
	} {
		if got := toolExecutionTimeout(tc.tool, json.RawMessage(tc.args)); got != tc.want {
			t.Errorf("%s %s: got %s, want %s", tc.tool, tc.args, got, tc.want)
		}
	}
}

func liveDevicePair(t *testing.T) (*LiveDevice, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			accepted <- conn
		}
	}))
	peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	device := &LiveDevice{conn: <-accepted, pending: make(map[string]chan CallToolResult), closed: make(chan struct{})}
	t.Cleanup(func() { _ = peer.Close(); _ = device.conn.Close(); server.Close() })
	return device, peer
}

func TestDeviceCallCancelsOnRequestContext(t *testing.T) {
	device, peer := liveDevicePair(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := device.call(ctx, "bash", json.RawMessage(`{}`), 31*time.Second); done <- err }()
	_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
	var call, stop map[string]any
	if err := peer.ReadJSON(&call); err != nil {
		t.Fatal(err)
	}
	budget, ok := call["timeoutMs"].(float64)
	if call["type"] != "call" || !ok || budget <= 30000 || budget > 31000 {
		t.Fatalf("unexpected call: %v", call)
	}
	cancel()
	if err := peer.ReadJSON(&stop); err != nil {
		t.Fatal(err)
	}
	if stop["type"] != "cancel" || stop["id"] != call["id"] {
		t.Fatalf("unexpected cancellation: %v", stop)
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	device.pendingMu.Lock()
	defer device.pendingMu.Unlock()
	if len(device.pending) != 0 || device.inflight != 0 {
		t.Fatal("cancelled call leaked its inflight slot")
	}
}

func TestDeviceCallCancelsWhenPeerNeverReturns(t *testing.T) {
	device, peer := liveDevicePair(t)
	done := make(chan error, 1)
	go func() {
		_, err := device.call(context.Background(), "write", json.RawMessage(`{}`), 100*time.Millisecond)
		done <- err
	}()
	_ = peer.SetReadDeadline(time.Now().Add(4 * time.Second))
	var call, stop map[string]any
	if err := peer.ReadJSON(&call); err != nil {
		t.Fatal(err)
	}
	if err := peer.ReadJSON(&stop); err != nil {
		t.Fatal(err)
	}
	if stop["type"] != "cancel" || stop["id"] != call["id"] {
		t.Fatalf("unexpected cancellation: %v", stop)
	}
	if err := <-done; err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("got %v", err)
	}
}

func TestCancelledCallWaitingForWebsocketWriterIsNeverSent(t *testing.T) {
	device, peer := liveDevicePair(t)
	device.writeMu.Lock()
	unlocked := false
	defer func() {
		if !unlocked {
			device.writeMu.Unlock()
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := device.call(ctx, "write", json.RawMessage(`{}`), time.Second); done <- err }()
	for deadline := time.Now().Add(time.Second); ; {
		device.pendingMu.Lock()
		admitted := device.inflight == 1
		device.pendingMu.Unlock()
		if admitted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("call was not admitted")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("HTTP cancellation blocked behind the websocket writer")
	}
	device.writeMu.Unlock()
	unlocked = true
	_ = peer.SetReadDeadline(time.Now().Add(time.Second))
	var message map[string]any
	if err := peer.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	if message["type"] != "cancel" {
		t.Fatalf("cancelled mutation was sent late: %v", message)
	}
}

func TestDeviceCallDoesNotSendAlreadyCancelledWork(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	device := &LiveDevice{}
	if _, err := device.call(ctx, "write", nil, time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}
