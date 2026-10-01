package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func newReasoningSummaryProvider(t *testing.T, baseURL string) Provider {
	t.Helper()
	provider, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: baseURL + "/v1",
		Model: "gpt-5.4", ThinkingIntensity: "medium",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	return provider
}

func streamReasoning(t *testing.T, provider Provider) string {
	t.Helper()
	var reasoning strings.Builder
	err := provider.ChatStream(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "inspect"}},
	}, func(chunk ai.StreamChunk) {
		reasoning.WriteString(chunk.ReasoningContent)
	})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	return reasoning.String()
}

const completedEvent = `data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}`

func TestOpenAIResponsesRequestsDetailedReasoningSummaries(t *testing.T) {
	var mu sync.Mutex
	var summaries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			Reasoning struct {
				Summary string `json:"summary"`
			} `json:"reasoning"`
		}
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		summaries = append(summaries, body.Reasoning.Summary)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(completedEvent + "\n\n"))
	}))
	defer server.Close()

	streamReasoning(t, newReasoningSummaryProvider(t, server.URL))

	if len(summaries) != 1 || summaries[0] != "detailed" {
		t.Fatalf("reasoning.summary = %v, want [detailed] so the model returns node details", summaries)
	}
}

func TestOpenAIResponsesFallsBackToAutoSummaryWhenDetailedIsRejected(t *testing.T) {
	var mu sync.Mutex
	var summaries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			Reasoning struct {
				Summary string `json:"summary"`
			} `json:"reasoning"`
		}
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		summaries = append(summaries, body.Reasoning.Summary)
		mu.Unlock()
		if body.Reasoning.Summary == "detailed" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"Unsupported parameter: reasoning.summary 'detailed'"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(completedEvent + "\n\n"))
	}))
	defer server.Close()

	streamReasoning(t, newReasoningSummaryProvider(t, server.URL))

	if len(summaries) != 2 || summaries[0] != "detailed" || summaries[1] != "auto" {
		t.Fatalf("reasoning.summary sequence = %v, want [detailed auto]", summaries)
	}
}

func TestOpenAIResponsesSeparatesReasoningSummaryParts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"type":"response.reasoning_summary_part.added","summary_index":0}`,
			``,
			`data: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"**Plan**\n\nCheck the version."}`,
			``,
			`data: {"type":"response.reasoning_summary_part.added","summary_index":1}`,
			``,
			`data: {"type":"response.reasoning_summary_text.delta","summary_index":1,"delta":"**Run**"}`,
			``,
			completedEvent,
			``,
		}, "\n")))
	}))
	defer server.Close()

	got := streamReasoning(t, newReasoningSummaryProvider(t, server.URL))

	if got != "**Plan**\n\nCheck the version.\n\n**Run**" {
		t.Fatalf("reasoning = %q, want the two summary parts separated by a blank line", got)
	}
}

func TestOpenAIResponsesJoinsReasoningSummaryPartsInCompletedOutput(t *testing.T) {
	item := json.RawMessage(`{"type":"reasoning","summary":[{"type":"summary_text","text":"**Plan**"},{"type":"summary_text","text":"**Run**"}]}`)
	response := parseOpenAIResponsesOutput(openAIResponsesResponse{Output: []json.RawMessage{item}})

	if response.ReasoningContent != "**Plan**\n\n**Run**" {
		t.Fatalf("reasoning = %q", response.ReasoningContent)
	}
}
