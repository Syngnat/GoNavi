package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestAnthropicStreamDoesNotEmitDoneBeforeScannerError(t *testing.T) {
	server := newOversizedSSEServer(t)
	defer server.Close()

	instance, err := NewAnthropicProvider(ai.ProviderConfig{
		Type:      "anthropic",
		Name:      "test-anthropic",
		APIKey:    "sk-test",
		BaseURL:   server.URL,
		Model:     "claude-test",
		MaxTokens: 64,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	assertScannerErrorWithoutDone(t, instance)
}

func TestGeminiStreamDoesNotEmitDoneBeforeScannerError(t *testing.T) {
	server := newOversizedSSEServer(t)
	defer server.Close()

	instance, err := NewGeminiProvider(ai.ProviderConfig{
		Type:      "gemini",
		Name:      "test-gemini",
		APIKey:    "sk-test",
		BaseURL:   server.URL,
		Model:     "gemini-test",
		MaxTokens: 64,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	assertScannerErrorWithoutDone(t, instance)
}

func newOversizedSSEServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: " + strings.Repeat("x", 70*1024) + "\n\n"))
	}))
}

func assertScannerErrorWithoutDone(t *testing.T, instance Provider) {
	t.Helper()
	var chunks []ai.StreamChunk
	err := instance.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err == nil {
		t.Fatal("expected scanner error")
	}
	for _, chunk := range chunks {
		if chunk.Done {
			t.Fatalf("received terminal done chunk before scanner error: %#v", chunks)
		}
	}
}
