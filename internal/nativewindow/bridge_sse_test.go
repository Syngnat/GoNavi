package nativewindow

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestBridgeReassemblesFragmentedLargeSSEEventWithoutChangingPayload(t *testing.T) {
	const chunkSize = 256 << 10
	content := strings.Repeat(" value with spaces ", (5<<20)/19)
	payload, err := json.Marshal(bridgeEvent{
		Name: "ai:run:event",
		Args: []any{map[string]any{"content": content}},
	})
	if err != nil {
		t.Fatalf("marshal large event: %v", err)
	}
	var stream strings.Builder
	stream.WriteString(": connected\n\n")
	for offset := 0; offset < len(payload); offset += chunkSize {
		end := offset + chunkSize
		if end > len(payload) {
			end = len(payload)
		}
		stream.WriteString("data: ")
		stream.Write(payload[offset:end])
		stream.WriteByte('\n')
	}
	stream.WriteByte('\n')

	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		status := http.StatusNoContent
		body := ""
		if request.URL.Path == EventsPath {
			status = http.StatusOK
			body = stream.String()
		}
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})

	var received string
	bridge.mu.Lock()
	bridge.ctx = context.Background()
	bridge.emitToWails = func(_ context.Context, name string, args ...any) {
		if name != "ai:run:event" || len(args) != 1 {
			t.Fatalf("unexpected event %q %#v", name, args)
		}
		chunk, ok := args[0].(map[string]any)
		if !ok {
			t.Fatalf("unexpected event payload: %#v", args[0])
		}
		received, _ = chunk["content"].(string)
	}
	bridge.mu.Unlock()

	if err := bridge.consumeEventStream(context.Background()); err != nil {
		t.Fatalf("consume fragmented stream: %v", err)
	}
	if received != content {
		t.Fatalf("round-trip content length = %d, want %d", len(received), len(content))
	}
}

func TestBridgeReplaysPendingCloseWhenEventStreamReconnects(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "workbench:query-1",
		Kind:      "workbench",
	})
	commandPayload, err := json.Marshal(childCommand{
		ID:     "workbench:query-1",
		Action: "close",
		Reason: ExitReasonRequested,
	})
	if err != nil {
		t.Fatalf("marshal close command: %v", err)
	}
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		status := http.StatusNoContent
		body := ""
		switch request.URL.Path {
		case EventsPath:
			status = http.StatusOK
			body = ": connected\n\n"
		case CommandStatePath:
			status = http.StatusOK
			body = string(commandPayload)
		}
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})

	var received childCommand
	bridge.mu.Lock()
	bridge.ctx = context.Background()
	bridge.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == CommandEventName && len(args) == 1 {
			received, _ = args[0].(childCommand)
		}
	}
	bridge.mu.Unlock()

	if err := bridge.consumeEventStream(context.Background()); err != nil {
		t.Fatalf("consume reconnected stream: %v", err)
	}
	if received.ID != "workbench:query-1" || received.Action != "close" || received.Reason != ExitReasonRequested {
		t.Fatalf("replayed command = %#v", received)
	}
}

func TestBridgeReplaysPendingFocusWithoutAcknowledgingBeforeNativeFocus(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	commandPayload, err := json.Marshal(childCommand{
		ID:      "ai-chat",
		Action:  "focus",
		Payload: visibilityCommandPayload{VisibilityRevision: 7},
	})
	if err != nil {
		t.Fatalf("marshal focus command: %v", err)
	}
	acknowledgements := 0
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		status := http.StatusNoContent
		body := ""
		switch {
		case request.URL.Path == EventsPath:
			status = http.StatusOK
			body = ": connected\n\n"
		case request.URL.Path == CommandStatePath && request.Method == http.MethodGet:
			status = http.StatusOK
			body = string(commandPayload)
		case request.URL.Path == CommandStatePath && request.Method == http.MethodPost:
			acknowledgements++
			status = http.StatusOK
			body = `{"success":true,"id":"ai-chat","visibilityRevision":7}`
		}
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})

	var received childCommand
	bridge.mu.Lock()
	bridge.ctx = context.Background()
	bridge.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == CommandEventName && len(args) == 1 {
			received, _ = args[0].(childCommand)
		}
	}
	bridge.mu.Unlock()

	if err := bridge.consumeEventStream(context.Background()); err != nil {
		t.Fatalf("consume reconnected stream: %v", err)
	}
	if received.Action != "focus" || positiveVisibilityRevision(received.Payload) != 7 {
		t.Fatalf("replayed focus command = %#v", received)
	}
	if acknowledgements != 0 {
		t.Fatalf("focus acknowledgements before native focus = %d, want 0", acknowledgements)
	}
}

func TestBridgeDeliversLiveFocusWithoutAcknowledgingBeforeNativeFocus(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	eventPayload, err := json.Marshal(bridgeEvent{
		Name: CommandEventName,
		Args: []any{childCommand{
			ID:      "ai-chat",
			Action:  "focus",
			Payload: visibilityCommandPayload{VisibilityRevision: 9},
		}},
	})
	if err != nil {
		t.Fatalf("marshal focus event: %v", err)
	}
	acknowledgements := 0
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		status := http.StatusNoContent
		body := ""
		switch {
		case request.URL.Path == EventsPath:
			status = http.StatusOK
			body = "data: " + string(eventPayload) + "\n\n"
		case request.URL.Path == CommandStatePath && request.Method == http.MethodPost:
			acknowledgements++
			status = http.StatusOK
			body = `{"success":true,"id":"ai-chat","visibilityRevision":9}`
		}
		return &http.Response{
			StatusCode: status,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
		}, nil
	})
	bridge.mu.Lock()
	bridge.ctx = context.Background()
	bridge.emitToWails = func(context.Context, string, ...any) {}
	bridge.mu.Unlock()

	if err := bridge.consumeEventStream(context.Background()); err != nil {
		t.Fatalf("consume live focus stream: %v", err)
	}
	if acknowledgements != 0 {
		t.Fatalf("focus acknowledgements before native focus = %d, want 0", acknowledgements)
	}
}
