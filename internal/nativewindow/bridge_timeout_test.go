package nativewindow

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type bridgeCallOutcome struct {
	success bool
	message string
	err     error
}

func TestBridgeUsesExplicitRPCTimeoutWithoutClientTimeout(t *testing.T) {
	bridge := newBridge(ChildOptions{ParentURL: "http://127.0.0.1:43119"})
	if bridge.rpcTimeout != defaultDetachedRPCRequestTimeout {
		t.Fatalf("bridge RPC timeout = %s, want %s", bridge.rpcTimeout, defaultDetachedRPCRequestTimeout)
	}
	if bridge.client.Timeout != 0 {
		t.Fatalf("bridge HTTP client timeout = %s, want 0 so SSE remains long-lived", bridge.client.Timeout)
	}
	bridge.rpcTimeout = 0
	if got := bridge.rpcTimeoutDuration(); got != defaultDetachedRPCRequestTimeout {
		t.Fatalf("zero bridge RPC timeout = %s, want default %s", got, defaultDetachedRPCRequestTimeout)
	}
}

func newTimeoutTestBridge(timeout time.Duration) *Bridge {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	bridge.rpcTimeout = timeout
	bridge.allowParentForeground = nil
	return bridge
}

func TestBridgeOrdinaryRPCsHaveDeadline(t *testing.T) {
	const (
		rpcTimeout   = 20 * time.Millisecond
		transportMax = 250 * time.Millisecond
	)

	tests := []struct {
		name string
		path string
		call func(*Bridge) bridgeCallOutcome
	}{
		{
			name: "invoke",
			path: InvokePath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				_, err := bridge.Invoke("app", "App", "Health", nil)
				return bridgeCallOutcome{success: err == nil, err: err, message: errorMessage(err)}
			},
		},
		{
			name: "bootstrap",
			path: BootstrapPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				_, err := bridge.Bootstrap()
				return bridgeCallOutcome{success: err == nil, err: err, message: errorMessage(err)}
			},
		},
		{
			name: "open-window",
			path: ControlPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				result := bridge.OpenWindow(OpenRequest{Kind: "workbench", Title: "Query"})
				return operationOutcome(result)
			},
		},
		{
			name: "focus-window",
			path: ControlPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.FocusWindow("ai-chat"))
			},
		},
		{
			name: "hide-window",
			path: ControlPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.HideWindow("ai-chat"))
			},
		},
		{
			name: "close-window",
			path: ControlPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.CloseWindow("ai-chat"))
			},
		},
		{
			name: "close-owned-windows",
			path: ControlPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.CloseOwnedWindows())
			},
		},
		{
			name: "action-ready",
			path: ActionPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				bridge.mu.Lock()
				bridge.ready = true
				bridge.mu.Unlock()
				return operationOutcome(bridge.Action("ready", nil))
			},
		},
		{
			name: "action-sync",
			path: ActionPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.Action("sync", nil))
			},
		},
		{
			name: "action-attach",
			path: ActionPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.Action("attach", nil))
			},
		},
		{
			name: "action-close",
			path: ActionPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.Action("close", nil))
			},
		},
		{
			name: "action-hide",
			path: ActionPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.Action("hide", nil))
			},
		},
		{
			name: "action-cancel-close",
			path: ActionPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.Action("cancel-close", nil))
			},
		},
		{
			name: "action-host-event",
			path: ActionPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.Action("host-event", nil))
			},
		},
		{
			name: "action-open-ai-settings",
			path: ActionPath,
			call: func(bridge *Bridge) bridgeCallOutcome {
				return operationOutcome(bridge.Action("open-ai-settings", nil))
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bridge := newTimeoutTestBridge(rpcTimeout)
			started := make(chan struct{})
			bridge.client.Transport = bridgeBlockingTransport(test.path, started, transportMax)

			result := make(chan bridgeCallOutcome, 1)
			go func() {
				result <- test.call(bridge)
			}()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("bridge request was not started")
			}

			select {
			case outcome := <-result:
				if outcome.success {
					t.Fatalf("ordinary RPC unexpectedly succeeded: %#v", outcome)
				}
				if outcome.err != nil && !errors.Is(outcome.err, context.DeadlineExceeded) {
					t.Fatalf("ordinary RPC error = %v, want context deadline exceeded", outcome.err)
				}
				if !strings.Contains(strings.ToLower(outcome.message), "deadline") {
					t.Fatalf("ordinary RPC message = %q, want deadline", outcome.message)
				}
			case <-time.After(time.Second):
				t.Fatal("ordinary RPC did not honor its deadline")
			}
		})
	}
}

func TestBridgeStopCancelsInFlightOrdinaryRPC(t *testing.T) {
	bridge := newTimeoutTestBridge(time.Hour)
	started := make(chan struct{})
	var startOnce sync.Once
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == EventsPath {
			return emptyBridgeResponse(http.StatusNoContent), nil
		}
		startOnce.Do(func() { close(started) })
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	InitializeBridge(bridge, context.Background())

	result := make(chan error, 1)
	go func() {
		_, err := bridge.Invoke("app", "App", "Health", nil)
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("invoke request was not started")
	}
	bridge.stop()

	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("stopped invoke error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("stop did not cancel the in-flight invoke")
	}
}

func TestBridgeParentContextCancelsInFlightOrdinaryRPC(t *testing.T) {
	parentCtx, parentCancel := context.WithCancel(context.Background())
	defer parentCancel()
	bridge := newTimeoutTestBridge(time.Hour)
	started := make(chan struct{})
	var startOnce sync.Once
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == EventsPath {
			return emptyBridgeResponse(http.StatusNoContent), nil
		}
		startOnce.Do(func() { close(started) })
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	InitializeBridge(bridge, parentCtx)

	result := make(chan error, 1)
	go func() {
		_, err := bridge.Bootstrap()
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("bootstrap request was not started")
	}
	parentCancel()

	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("parent-cancelled bootstrap error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("parent context did not cancel the in-flight bootstrap")
	}
}

func TestBridgeNotifyClosingKeepsIndependentShortTimeout(t *testing.T) {
	bridge := newTimeoutTestBridge(20 * time.Millisecond)
	started := make(chan struct{})
	var startOnce sync.Once
	requestDone := make(chan error, 1)
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == EventsPath {
			return emptyBridgeResponse(http.StatusNoContent), nil
		}
		startOnce.Do(func() { close(started) })
		deadline, ok := request.Context().Deadline()
		if !ok {
			return nil, errors.New("fallback request has no deadline")
		}
		remaining := time.Until(deadline)
		if remaining < 250*time.Millisecond || remaining > time.Second {
			return nil, errors.New("fallback request deadline is not approximately 750ms")
		}
		<-request.Context().Done()
		requestDone <- request.Context().Err()
		return nil, request.Context().Err()
	})
	InitializeBridge(bridge, context.Background())

	done := make(chan struct{})
	go func() {
		bridge.notifyClosing()
		close(done)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("close fallback request was not started")
	}
	bridge.stop()

	select {
	case err := <-requestDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("fallback context error = %v, want deadline exceeded", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("close fallback did not honor its independent timeout")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("notifyClosing did not return after its timeout")
	}
}

func TestBridgeSSEIsNotBoundByOrdinaryRPCDeadline(t *testing.T) {
	bridge := newTimeoutTestBridge(20 * time.Millisecond)
	if bridge.client.Timeout != 0 {
		t.Fatalf("bridge HTTP client timeout = %s, want 0 so SSE can remain long-lived", bridge.client.Timeout)
	}
	streamStarted := make(chan struct{})
	streamRelease := make(chan struct{})
	var startOnce sync.Once
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != EventsPath {
			return emptyBridgeResponse(http.StatusNoContent), nil
		}
		startOnce.Do(func() { close(streamStarted) })
		select {
		case <-streamRelease:
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(": connected\n\n")),
				Header:     make(http.Header),
			}, nil
		case <-request.Context().Done():
			return nil, request.Context().Err()
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- bridge.consumeEventStream(ctx)
	}()
	select {
	case <-streamStarted:
	case <-time.After(time.Second):
		t.Fatal("SSE request was not started")
	}
	select {
	case err := <-done:
		t.Fatalf("SSE ended at ordinary RPC deadline: %v", err)
	case <-time.After(5 * bridge.rpcTimeout):
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled SSE error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("SSE did not stop with its lifecycle context")
	}
	close(streamRelease)
}

func bridgeBlockingTransport(path string, started chan<- struct{}, fallback time.Duration) roundTripFunc {
	var startOnce sync.Once
	return func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != path {
			return emptyBridgeResponse(http.StatusNoContent), nil
		}
		startOnce.Do(func() { close(started) })
		select {
		case <-request.Context().Done():
			return nil, request.Context().Err()
		case <-time.After(fallback):
			return nil, errors.New("test transport fallback elapsed")
		}
	}
}

func emptyBridgeResponse(status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader("")),
		Header:     make(http.Header),
	}
}

func operationOutcome(result OperationResult) bridgeCallOutcome {
	return bridgeCallOutcome{success: result.Success, message: result.Message}
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
