package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestGeminiProviderChatStreamPreservesUsageAndCacheHits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, ":streamGenerateContent") {
			t.Fatalf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"candidates":[{"content":{"parts":[{"text":"pong"}]}}]}`,
			``,
			`data: {"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":5,"totalTokenCount":25,"cachedContentTokenCount":8}}`,
			``,
		}, "\n")))
	}))
	defer server.Close()

	providerInstance, err := NewGeminiProvider(ai.ProviderConfig{
		Type: "gemini", APIKey: "test", BaseURL: server.URL, Model: "gemini-test",
	})
	if err != nil {
		t.Fatal(err)
	}
	var chunks []ai.StreamChunk
	err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}, func(chunk ai.StreamChunk) { chunks = append(chunks, chunk) })
	if err != nil {
		t.Fatal(err)
	}
	final := chunks[len(chunks)-1]
	if !final.Done || final.Usage == nil {
		t.Fatalf("final chunk = %#v", final)
	}
	if final.Usage.PromptTokens != 20 || final.Usage.CompletionTokens != 5 || final.Usage.TotalTokens != 25 {
		t.Fatalf("usage = %#v", final.Usage)
	}
	if final.Usage.CachedTokens == nil || *final.Usage.CachedTokens != 8 {
		t.Fatalf("cached usage = %#v", final.Usage.CachedTokens)
	}
}
