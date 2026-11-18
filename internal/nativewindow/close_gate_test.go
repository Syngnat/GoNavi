//go:build !wails3

package nativewindow

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestBridgeHideActionDoesNotCommitTerminalState(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	bridge.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(
				`{"success":true,"id":"ai-chat","visibilityRevision":1}`,
			)),
			Header: make(http.Header),
		}, nil
	})

	result := bridge.Action("hide", map[string]any{"id": "ai-chat", "kind": "ai-chat"})
	if !result.Success || result.VisibilityRevision != 1 {
		t.Fatalf("hide Action result = %#v", result)
	}
	bridge.mu.Lock()
	terminal := bridge.terminal
	bridge.mu.Unlock()
	if terminal != "" {
		t.Fatalf("hide action committed terminal state %q", terminal)
	}
}

func TestCloseGateVetoesAndRequestsFrontendUntilExitIsAllowed(t *testing.T) {
	var gate closeGate

	if veto, first := gate.intercept(); !veto || !first {
		t.Fatalf("first intercept = veto %v first %v, want true true", veto, first)
	}
	if veto, request := gate.intercept(); !veto || !request {
		t.Fatalf("second intercept = veto %v request %v, want true true", veto, request)
	}

	gate.allow()
	if veto, first := gate.intercept(); veto || first {
		t.Fatalf("allowed intercept = veto %v first %v, want false false", veto, first)
	}
}

func TestControlBeforeCloseRequestsOneGracefulFrontendClose(t *testing.T) {
	bridge := newBridge(ChildOptions{ID: "ai-chat", Kind: "ai-chat"})
	bridge.mu.Lock()
	bridge.ready = true
	bridge.mu.Unlock()
	control := newControl(bridge)
	commands := make([]childCommand, 0, 1)
	control.emitCommand = func(_ context.Context, command childCommand) {
		commands = append(commands, command)
	}

	if veto := control.handleBeforeClose(context.Background()); !veto {
		t.Fatal("first native close was not vetoed")
	}
	if veto := control.handleBeforeClose(context.Background()); !veto {
		t.Fatal("repeated native close was not vetoed while final sync is pending")
	}
	if len(commands) != 2 {
		t.Fatalf("graceful close commands = %d, want 2", len(commands))
	}
	for _, command := range commands {
		if command.ID != "ai-chat" || command.Action != "close" || command.Reason != ExitReasonWindowClosed {
			t.Fatalf("unexpected graceful close command: %#v", command)
		}
	}

	control.closeGate.allow()
	if veto := control.handleBeforeClose(context.Background()); veto {
		t.Fatal("frontend-approved native close was still vetoed")
	}
}

func TestControlBeforeCloseForcesExitWhenFrontendDoesNotRespond(t *testing.T) {
	bridge := newBridge(ChildOptions{ID: "ai-chat", Kind: "ai-chat"})
	bridge.mu.Lock()
	bridge.ready = true
	bridge.mu.Unlock()
	control := newControl(bridge)
	control.closeFallbackDelay = 10 * time.Millisecond
	control.emitCommand = func(context.Context, childCommand) {}
	quit := make(chan struct{}, 1)
	control.quit = func(context.Context) {
		quit <- struct{}{}
	}
	InitializeControl(control, context.Background())

	if veto := control.handleBeforeClose(context.Background()); !veto {
		t.Fatal("native close was not initially vetoed")
	}
	select {
	case <-quit:
	case <-time.After(time.Second):
		t.Fatal("native close fallback did not force exit")
	}
	if veto, _ := control.closeGate.intercept(); veto {
		t.Fatal("close gate remained locked after fallback")
	}
}

func TestControlCancelCloseInvalidatesFallbackAndAllowsRetry(t *testing.T) {
	bridge := newBridge(ChildOptions{ID: "ai-chat", Kind: "ai-chat"})
	bridge.mu.Lock()
	bridge.ready = true
	bridge.mu.Unlock()
	control := newControl(bridge)
	control.closeFallbackDelay = 20 * time.Millisecond
	control.emitCommand = func(context.Context, childCommand) {}
	quit := make(chan struct{}, 2)
	control.quit = func(context.Context) {
		quit <- struct{}{}
	}
	InitializeControl(control, context.Background())

	if veto := control.handleBeforeClose(context.Background()); !veto {
		t.Fatal("native close was not initially vetoed")
	}
	if result := control.CancelClose(); !result.Success {
		t.Fatalf("CancelClose result = %#v", result)
	}
	select {
	case <-quit:
		t.Fatal("cancelled close fallback still forced exit")
	case <-time.After(60 * time.Millisecond):
	}

	if veto := control.handleBeforeClose(context.Background()); !veto {
		t.Fatal("native close retry was not vetoed")
	}
	select {
	case <-quit:
	case <-time.After(time.Second):
		t.Fatal("close retry did not schedule a new fallback")
	}
}

func TestBridgeCancelCloseResetsTerminalFallback(t *testing.T) {
	requests := make(chan actionRequest, 3)
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	bridge.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		defer r.Body.Close()
		var request actionRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode fallback action: %v", err)
		}
		requests <- request
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"success":true,"id":"ai-chat"}`)),
			Header:     make(http.Header),
		}, nil
	})
	control := newControl(bridge)

	if result := bridge.Action("attach", map[string]any{"revision": 1}); !result.Success {
		t.Fatalf("attach Action result = %#v", result)
	}
	if result := bridge.Action("cancel-close", map[string]any{"revision": 2}); !result.Success {
		t.Fatalf("cancel-close Action result = %#v", result)
	}
	if result := control.CancelClose(); !result.Success {
		t.Fatalf("CancelClose result = %#v", result)
	}
	bridge.notifyClosing()

	for _, expectedAction := range []string{"attach", "cancel-close", "close"} {
		select {
		case request := <-requests:
			if request.Action != expectedAction {
				t.Fatalf("action = %q, want %q", request.Action, expectedAction)
			}
		case <-time.After(time.Second):
			t.Fatalf("missing %q action after terminal rollback", expectedAction)
		}
	}
}

func TestBridgeIgnoredTerminalActionDoesNotSuppressCloseFallback(t *testing.T) {
	requests := make(chan actionRequest, 2)
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	bridge.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		defer r.Body.Close()
		var request actionRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode action: %v", err)
		}
		requests <- request
		body := `{"success":true,"id":"ai-chat"}`
		if request.Action == "attach" {
			body = `{"success":true,"applied":false,"message":"stale detached action ignored","id":"ai-chat"}`
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})

	result := bridge.Action("attach", map[string]any{"revision": 1})
	if !result.Success || result.Applied == nil || *result.Applied {
		t.Fatalf("ignored attach result = %#v", result)
	}
	bridge.notifyClosing()

	for _, expectedAction := range []string{"attach", "close"} {
		select {
		case request := <-requests:
			if request.Action != expectedAction {
				t.Fatalf("action = %q, want %q", request.Action, expectedAction)
			}
		case <-time.After(time.Second):
			t.Fatalf("missing %q action after ignored terminal action", expectedAction)
		}
	}
}

func TestNotifyClosingStillSendsOneFallbackAction(t *testing.T) {
	requests := make(chan actionRequest, 2)
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	bridge.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		defer r.Body.Close()
		var request actionRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode fallback action: %v", err)
			return &http.Response{
				StatusCode: http.StatusBadRequest,
				Body:       io.NopCloser(strings.NewReader(`{"success":false}`)),
				Header:     make(http.Header),
			}, nil
		}
		requests <- request
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"success":true,"id":"ai-chat"}`)),
			Header:     make(http.Header),
		}, nil
	})
	bridge.notifyClosing()
	bridge.notifyClosing()

	request := <-requests
	if request.Action != "close" {
		t.Fatalf("fallback action = %q, want close", request.Action)
	}
	payload, ok := request.Payload.(map[string]any)
	if !ok || payload["id"] != "ai-chat" || payload["kind"] != "ai-chat" {
		t.Fatalf("unexpected fallback payload: %#v", request.Payload)
	}
	select {
	case duplicate := <-requests:
		t.Fatalf("notifyClosing sent duplicate fallback: %#v", duplicate)
	default:
	}
}
