//go:build !wails3

package nativewindow

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestBridgeReplaysLatestHostStateAfterEveryEventStreamConnection(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	revision := int64(3)
	eventConnections := 0
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.URL.Path {
		case EventsPath:
			eventConnections++
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(": connected\n\n")),
				Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			}, nil
		case CommandStatePath:
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		case HostStatePath:
			payload, err := json.Marshal(HostStateRequest{
				ID:         "ai-chat",
				Revision:   revision,
				StoreState: map[string]any{"activeTabId": fmt.Sprintf("query-%d", revision)},
			})
			if err != nil {
				return nil, err
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(string(payload))),
				Header:     make(http.Header),
			}, nil
		default:
			t.Fatalf("unexpected bridge request path: %s", request.URL.Path)
			return nil, nil
		}
	})

	commands := make([]childCommand, 0, 2)
	bridge.mu.Lock()
	bridge.ctx = context.Background()
	bridge.emitToWails = func(_ context.Context, name string, args ...any) {
		if name != CommandEventName || len(args) != 1 {
			t.Fatalf("unexpected replay event: %q %#v", name, args)
		}
		commands = append(commands, args[0].(childCommand))
	}
	bridge.mu.Unlock()

	if err := bridge.consumeEventStream(context.Background()); err != nil {
		t.Fatalf("first event stream: %v", err)
	}
	revision = 4
	if err := bridge.consumeEventStream(context.Background()); err != nil {
		t.Fatalf("reconnected event stream: %v", err)
	}

	if eventConnections != 2 {
		t.Fatalf("event stream connections = %d, want 2", eventConnections)
	}
	if len(commands) != 2 {
		t.Fatalf("replayed commands = %d, want 2", len(commands))
	}
	for index, wantRevision := range []int64{3, 4} {
		command := commands[index]
		if command.ID != "ai-chat" || command.Action != "sync-host-state" {
			t.Fatalf("replay %d command = %#v", index, command)
		}
		payload, ok := command.Payload.(hostStatePayload)
		if !ok || payload.Revision != wantRevision {
			t.Fatalf("replay %d payload = %#v, want revision %d", index, command.Payload, wantRevision)
		}
	}
}

func TestBridgeRefreshesRetainedHostStateForLightweightInvalidation(t *testing.T) {
	bridge := newBridge(ChildOptions{
		ParentURL: "http://127.0.0.1:43119",
		Token:     "test-token",
		ID:        "ai-chat",
		Kind:      "ai-chat",
	})
	invalidation, err := json.Marshal(bridgeEvent{
		Name: CommandEventName,
		Args: []any{map[string]any{
			"id":     "ai-chat",
			"action": "sync-host-state",
			"payload": map[string]any{
				"revision": 4,
			},
		}},
	})
	if err != nil {
		t.Fatalf("marshal invalidation: %v", err)
	}

	hostStateRequests := 0
	bridge.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.URL.Path {
		case EventsPath:
			body := fmt.Sprintf(": connected\n\ndata: %s\n\n", invalidation)
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(body)),
				Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			}, nil
		case CommandStatePath:
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		case HostStatePath:
			hostStateRequests++
			revision := int64(3)
			if hostStateRequests > 1 {
				revision = 4
			}
			payload, marshalErr := json.Marshal(HostStateRequest{
				ID:         "ai-chat",
				Revision:   revision,
				StoreState: map[string]any{"revision": revision},
			})
			if marshalErr != nil {
				return nil, marshalErr
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(string(payload))),
				Header:     make(http.Header),
			}, nil
		default:
			t.Fatalf("unexpected bridge request path: %s", request.URL.Path)
			return nil, nil
		}
	})

	commands := make([]childCommand, 0, 2)
	bridge.mu.Lock()
	bridge.ctx = context.Background()
	bridge.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == CommandEventName && len(args) == 1 {
			commands = append(commands, args[0].(childCommand))
		}
	}
	bridge.mu.Unlock()

	if err := bridge.consumeEventStream(context.Background()); err != nil {
		t.Fatalf("consume invalidation stream: %v", err)
	}
	if hostStateRequests != 2 {
		t.Fatalf("host-state requests = %d, want initial replay plus invalidation refresh", hostStateRequests)
	}
	if len(commands) != 2 {
		t.Fatalf("host-state commands = %d, want 2", len(commands))
	}
	for index, revision := range []int64{3, 4} {
		payload, ok := commands[index].Payload.(hostStatePayload)
		if !ok || payload.Revision != revision {
			t.Fatalf("command %d payload = %#v, want revision %d", index, commands[index].Payload, revision)
		}
	}
}
