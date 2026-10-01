package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestOpenAIResponsesProviderKeepsExplicitOutputBudget(t *testing.T) {
	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", Model: "gpt-5.6", MaxTokens: 512,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	responsesProvider, ok := providerInstance.(*OpenAIResponsesProvider)
	if !ok {
		t.Fatalf("expected OpenAIResponsesProvider, got %T", providerInstance)
	}
	if responsesProvider.config.MaxTokens != 512 {
		t.Fatalf("explicit max tokens = %d, want 512", responsesProvider.config.MaxTokens)
	}
}

func TestOpenAIResponsesProviderPreservesExplicitReasoningBudget(t *testing.T) {
	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", Model: "deepseek-v4.1-flash", MaxTokens: 4096,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	responsesProvider, ok := providerInstance.(*OpenAIResponsesProvider)
	if !ok {
		t.Fatalf("expected OpenAIResponsesProvider, got %T", providerInstance)
	}
	if responsesProvider.config.MaxTokens != 4096 {
		t.Fatalf("explicit reasoning max tokens = %d, want 4096", responsesProvider.config.MaxTokens)
	}
}

func TestOpenAIResponsesProviderSendsExplicitNoneEffortForDeepSeekAliases(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_none","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1",
		Model: "deepseek/deepseek-v4-flash-0731", ThinkingIntensity: "off",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if _, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
	}); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if _, present := received["max_output_tokens"]; present {
		t.Fatalf("a gateway alias must not get an invented output limit, got %#v", received["max_output_tokens"])
	}
	reasoning, _ := received["reasoning"].(map[string]any)
	if reasoning["effort"] != "none" {
		t.Fatalf("expected explicit none reasoning effort, got %#v", received["reasoning"])
	}
	if _, present := reasoning["summary"]; present {
		t.Fatalf("DeepSeek reasoning request must not include summary, got %#v", reasoning)
	}
}
