package runharness

import (
	"context"
	"errors"
	"fmt"
	"io"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
)

func TestClassifyModelError(t *testing.T) {
	cases := []struct {
		name      string
		err       error
		class     string
		retryable bool
	}{
		{name: "canceled", err: context.Canceled, class: ModelErrorCanceled},
		{name: "deadline", err: context.DeadlineExceeded, class: ModelErrorDeadline},
		{name: "stream transport", err: fmt.Errorf("read OpenAI Responses streaming response failed: %w", errors.New("connection reset by peer")), class: ModelErrorTransport, retryable: true},
		{name: "http 429", err: errors.New("OpenAI Responses API returned error (HTTP 429): too many requests"), class: ModelErrorRateLimit, retryable: true},
		{name: "http 503", err: errors.New("OpenAI Responses API returned error (HTTP 503): upstream unavailable"), class: ModelErrorTransport, retryable: true},
		{name: "auth", err: errors.New("OpenAI Responses API returned error (HTTP 401): invalid api key"), class: ModelErrorProvider},
		{name: "response failed fallback", err: errors.New("OpenAI Responses request failed"), class: ModelErrorProvider},
		{name: "bad request", err: errors.New("OpenAI Responses API returned error (HTTP 400): invalid input"), class: ModelErrorProvider},
		{name: "protocol", err: errors.New("OpenAI Responses stream ended before response.completed"), class: ModelErrorProtocol},
		{name: "unexpected eof", err: fmt.Errorf("read OpenAI Responses streaming response failed: %w", io.ErrUnexpectedEOF), class: ModelErrorTransport, retryable: true},
		{name: "malformed tool", err: fmt.Errorf("%w: duplicate callId", ErrMalformedToolCall), class: ModelErrorMalformedToolCall},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyError(tc.err); got != tc.class {
				t.Fatalf("classifyError() = %q, want %q", got, tc.class)
			}
			if got := IsRetryableModelError(tc.err); got != tc.retryable {
				t.Fatalf("IsRetryableModelError() = %v, want %v", got, tc.retryable)
			}
		})
	}
}

func TestProviderModelTurnAdapterPropagatesStreamChunkError(t *testing.T) {
	adapter := NewProviderModelTurnAdapter(func(context.Context, ModelTurnRequest) (provider.Provider, error) {
		return &streamErrorProvider{}, nil
	})
	_, err := adapter.Execute(context.Background(), ModelTurnRequest{}, nil)
	if err == nil {
		t.Fatal("adapter returned nil after provider reported a stream error")
	}
	if classifyError(err) != ModelErrorTransport {
		t.Fatalf("classifyError(%v) = %q, want %q", err, classifyError(err), ModelErrorTransport)
	}
}

type streamErrorProvider struct{}

func (*streamErrorProvider) Chat(context.Context, ai.ChatRequest) (*ai.ChatResponse, error) {
	return nil, errors.New("unexpected non-stream call")
}

func (*streamErrorProvider) ChatStream(_ context.Context, _ ai.ChatRequest, callback func(ai.StreamChunk)) error {
	callback(ai.StreamChunk{Content: "partial"})
	callback(ai.StreamChunk{Error: "read OpenAI Responses streaming response failed: connection reset by peer", Done: true})
	return nil
}

func (*streamErrorProvider) Name() string    { return "stream-error" }
func (*streamErrorProvider) Validate() error { return nil }
