package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestOpenAIResponsesProviderChatReportsAPIAndEmptyOutputErrors(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "api_error",
			body: `{"error":{"message":"permission denied"}}`,
			want: "permission denied",
		},
		{
			name: "empty_output",
			body: `{"id":"resp_empty","status":"completed","output":[]}`,
			want: "empty response",
		},
		{
			name: "incomplete_output",
			body: `{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}]}`,
			want: "max_output_tokens",
		},
		{
			name: "failed_output_with_code_only",
			body: `{"id":"resp_failed","status":"failed","error":{"code":"provider_overloaded"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}`,
			want: "provider_overloaded",
		},
		{
			name: "completed_output_with_code_only_error",
			body: `{"id":"resp_failed","status":"completed","error":{"code":"provider_overloaded"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}`,
			want: "provider_overloaded",
		},
		{
			name: "cancelled_output",
			body: `{"id":"resp_cancelled","status":"cancelled","error":{"code":"user_cancelled"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}`,
			want: "user_cancelled",
		},
		{
			name: "unexpected_terminal_status",
			body: `{"id":"resp_in_progress","status":"in_progress","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}`,
			want: "in_progress",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()

			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}

			_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "ping"}},
			})
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tt.want)) {
				t.Fatalf("expected error containing %q, got %v", tt.want, err)
			}
		})
	}
}

func TestOpenAIResponsesProviderChatStreamRejectsInvalidTerminalEvent(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "failed",
			body: `{"type":"response.completed","response":{"id":"resp_failed","status":"failed","error":{"code":"provider_overloaded"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "provider_overloaded",
		},
		{
			name: "incomplete",
			body: `{"type":"response.completed","response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}]}}`,
			want: "max_output_tokens",
		},
		{
			name: "cancelled",
			body: `{"type":"response.completed","response":{"id":"resp_cancelled","status":"cancelled","error":{"code":"user_cancelled"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "user_cancelled",
		},
		{
			name: "canceled",
			body: `{"type":"response.completed","response":{"id":"resp_canceled","status":"canceled","error":{"code":"user_canceled"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "user_canceled",
		},
		{
			name: "unexpected_terminal_status",
			body: `{"type":"response.completed","response":{"id":"resp_in_progress","status":"in_progress","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "in_progress",
		},
		{
			name: "completed_with_top_level_message",
			body: `{"type":"response.completed","message":"upstream response failed","response":{"id":"resp_completed","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "upstream response failed",
		},
		{
			name: "completed_with_top_level_code",
			body: `{"type":"response.completed","code":"provider_overloaded","response":{"id":"resp_completed","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "provider_overloaded",
		},
		{
			name: "completed_with_top_level_error",
			body: `{"type":"response.completed","error":{"message":"invalid tool output"},"response":{"id":"resp_completed","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"must not be accepted"}]}]}}`,
			want: "invalid tool output",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte("data: " + tt.body + "\n\n"))
			}))
			defer server.Close()

			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}

			oldState := json.RawMessage(`{"input":[{"type":"message","role":"user","content":"previous"}]}`)
			done := false
			nextState, err := providerInstance.(*OpenAIResponsesProvider).ChatStreamWithState(
				context.Background(), oldState, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}},
				func(chunk ai.StreamChunk) { done = done || chunk.Done },
			)
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tt.want)) {
				t.Fatalf("expected stream error containing %q, got %v", tt.want, err)
			}
			if done {
				t.Fatal("non-completed terminal status emitted Done")
			}
			if string(nextState) != string(oldState) {
				t.Fatalf("terminal failure advanced provider state: old=%s next=%s", oldState, nextState)
			}
		})
	}
}

func TestOpenAIResponsesProviderChatStreamReportsFailedAndErrorEvents(t *testing.T) {
	tests := []struct {
		name  string
		event string
		want  string
	}{
		{
			name:  "response_failed",
			event: `data: {"type":"response.failed","response":{"id":"resp_failed","status":"failed","error":{"message":"rate limited"}}}`,
			want:  "rate limited",
		},
		{
			name:  "response_failed_top_level_error",
			event: `data: {"type":"response.failed","error":{"code":"invalid_request_error","message":"invalid tool output"}}`,
			want:  "invalid tool output",
		},
		{
			name:  "response_failed_top_level_message_before_nested_code",
			event: `data: {"type":"response.failed","message":"request input is invalid","response":{"status":"failed","error":{"code":"server_error"}}}`,
			want:  "request input is invalid",
		},
		{
			name:  "response_failed_nested_code_only",
			event: `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error"}}}`,
			want:  "server_error",
		},
		{
			name:  "response_failed_top_level_error_code_only",
			event: `data: {"type":"response.failed","error":{"code":"provider_overloaded"}}`,
			want:  "provider_overloaded",
		},
		{
			name:  "response_failed_top_level_code_only",
			event: `data: {"type":"response.failed","code":"response_validation_failed"}`,
			want:  "response_validation_failed",
		},
		{
			name:  "response_failed_top_level_error_string",
			event: `data: {"type":"response.failed","error":"provider rejected the response"}`,
			want:  "provider rejected the response",
		},
		{
			name:  "response_failed_nested_error_string",
			event: `data: {"type":"response.failed","response":{"status":"failed","error":"provider overloaded"}}`,
			want:  "provider overloaded",
		},
		{
			name:  "response_failed_blank_details_use_fallback",
			event: `data: {"type":"response.failed","message":"  ","code":"\t","error":{"message":"\n","code":" "},"response":{"status":"failed","error":{"message":" ","code":"  "}}}`,
			want:  "OpenAI Responses request failed",
		},
		{
			name:  "error_event",
			event: `data: {"type":"error","code":"server_error","message":"upstream unavailable"}`,
			want:  "upstream unavailable",
		},
		{
			name:  "error_event_code_only",
			event: `data: {"type":"error","code":"gateway_timeout"}`,
			want:  "gateway_timeout",
		},
		{
			name:  "response_incomplete",
			event: `data: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}`,
			want:  "max_output_tokens",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte(tt.event + "\n\n"))
			}))
			defer server.Close()

			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}

			err = providerInstance.ChatStream(context.Background(), ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "ping"}},
			}, func(ai.StreamChunk) {})
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tt.want)) {
				t.Fatalf("expected stream error containing %q, got %v", tt.want, err)
			}
		})
	}
}

func TestOpenAIResponsesProviderChatRetriesWithoutToolsOnHTTP400(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request: %v", err)
		}
		defer r.Body.Close()

		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if _, hasTools := payload["tools"]; hasTools {
			http.Error(w, `{"error":{"message":"tools unsupported"}}`, http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"resp_without_tools",
			"status":"completed",
			"output":[
				{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}
			],
			"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}
		}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	response, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping"}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:       "inspect_table_schema",
				Parameters: map[string]any{"type": "object"},
			},
		}},
	})
	if err != nil {
		t.Fatalf("expected tools fallback to succeed, got %v", err)
	}
	if requestCount != 2 {
		t.Fatalf("expected one retry without unsupported tools, got %d requests", requestCount)
	}
	if response.Content != "pong" {
		t.Fatalf("unexpected fallback response: %#v", response)
	}
}

func TestOpenAIResponsesProviderChatRetriesWithoutUnsupportedIncludeOnHTTP400(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		defer r.Body.Close()
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if _, hasInclude := payload["include"]; hasInclude {
			http.Error(w, `{"error":{"message":"include unsupported"}}`, http.StatusBadRequest)
			return
		}
		if _, hasTools := payload["tools"]; !hasTools {
			t.Fatalf("expected include fallback to preserve tools, got %#v", payload)
		}
		inputJSON, _ := json.Marshal(payload["input"])
		if !strings.Contains(string(inputJSON), `"type":"input_image"`) {
			t.Fatalf("expected include fallback to preserve images, got %s", inputJSON)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_without_include","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}]}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	response, err := providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "ping", Images: []string{"data:image/png;base64,abc"}}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:       "inspect_table_schema",
				Parameters: map[string]any{"type": "object"},
			},
		}},
	})
	if err != nil {
		t.Fatalf("expected include fallback to succeed, got %v", err)
	}
	if response.Content != "pong" || requestCount != 2 {
		t.Fatalf("unexpected include fallback result: response=%#v requests=%d", response, requestCount)
	}
}

func TestOpenAIResponsesProviderChatDoesNotDropToolsForUnrelatedClientError(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		defer r.Body.Close()

		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if _, hasTools := payload["tools"]; !hasTools {
			t.Fatalf("tools were removed from retry request: %#v", payload)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"Invalid JSON data: input did not match any variant of ResponseInput"}}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "glm-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}

	_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "continue"}},
		Tools: []ai.Tool{{
			Type: "function",
			Function: ai.ToolFunction{
				Name:       "execute_sql",
				Parameters: map[string]any{"type": "object"},
			},
		}},
	})
	if err == nil || !strings.Contains(err.Error(), "Invalid JSON data") {
		t.Fatalf("expected original input error, got %v", err)
	}
	if requestCount != 1 {
		t.Fatalf("requests=%d, want 1 (unrelated client errors must not trigger compatibility fallback)", requestCount)
	}
}

func TestOpenAIResponsesProviderChatDoesNotDropToolsForNestedSchemaJSONPointer(t *testing.T) {
	tests := []struct {
		name    string
		message string
	}{
		{
			name:    "relative JSON pointer",
			message: `unexpected field: tools/0/parameters/properties/sql/nullable`,
		},
		{
			name:    "fragment JSON pointer",
			message: `unexpected field: #/tools/0/parameters/properties/sql/nullable`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requestCount := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requestCount++
				defer r.Body.Close()

				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Fatalf("decode request: %v", err)
				}
				if _, hasTools := payload["tools"]; !hasTools {
					t.Fatalf("tools were removed from retry request: %#v", payload)
				}

				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnprocessableEntity)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{"message": tt.message},
				})
			}))
			defer server.Close()

			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "glm-test",
			})
			if err != nil {
				t.Fatalf("create provider: %v", err)
			}

			_, err = providerInstance.Chat(context.Background(), ai.ChatRequest{
				Messages: []ai.Message{{Role: "user", Content: "continue"}},
				Tools: []ai.Tool{{
					Type: "function",
					Function: ai.ToolFunction{
						Name:       "execute_sql",
						Parameters: map[string]any{"type": "object"},
					},
				}},
			})
			if err == nil || !strings.Contains(err.Error(), tt.message) {
				t.Fatalf("expected original nested schema error, got %v", err)
			}
			if requestCount != 1 {
				t.Fatalf("requests=%d, want 1 (nested schema errors must not trigger tools fallback)", requestCount)
			}
		})
	}
}

func TestOpenAIResponsesUnsupportedCapabilityErrorClassification(t *testing.T) {
	tests := []struct {
		name string
		err  error
		is   func(error) bool
		want bool
	}{
		{
			name: "tools explicitly unsupported on 400",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 400): tools unsupported"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: true,
		},
		{
			name: "function calling unsupported on 422",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 422): model does not support function calling"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: true,
		},
		{
			name: "include unknown parameter",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 400): unknown parameter: include"),
			is:   isOpenAIResponsesUnsupportedIncludeError,
			want: true,
		},
		{
			name: "invalid response input is unrelated",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 400): input did not match any variant of ResponseInput"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "invalid tools schema is not unsupported",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 422): invalid tools schema"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema unexpected field is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): tools[0].parameters: unexpected field "nullable"`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema path separated by whitespace is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): unexpected field: tools [0].parameters.nullable`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested dotted tools path separated by whitespace is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): unexpected field: tools .0.parameters.nullable`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema value not allowed is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 400): tools[0].parameters.properties.sql: value is not allowed`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema relative JSON pointer is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): unexpected field: tools/0/parameters/properties/sql/nullable`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "nested tools schema fragment JSON pointer is not unsupported",
			err:  fmt.Errorf(`OpenAI Responses API returned error (HTTP 422): unexpected field: #/tools/0/parameters/properties/sql/nullable`),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "unsupported response input item is not unsupported tools",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 400): unsupported ResponseInput item type function_call"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
		{
			name: "404 is not a compatibility fallback",
			err:  fmt.Errorf("OpenAI Responses API returned error (HTTP 404): tools unsupported"),
			is:   isOpenAIResponsesUnsupportedToolsError,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.is(tt.err); got != tt.want {
				t.Fatalf("classification=%t, want %t for %v", got, tt.want, tt.err)
			}
		})
	}
}

func TestOpenAIResponsesProviderStreamWithoutCompletedReturnsErrorAndPreservesSessionState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	sessionProvider := providerInstance.(SessionStreamProvider)
	oldState := json.RawMessage(`{"input":[{"type":"message","role":"user","content":"old"}]}`)
	nextState, err := sessionProvider.ChatStreamWithState(context.Background(), oldState, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "new"}},
	}, func(ai.StreamChunk) {})
	if err == nil || !strings.Contains(err.Error(), "response.completed") {
		t.Fatalf("expected missing response.completed error, got %v", err)
	}
	if string(nextState) != string(oldState) {
		t.Fatalf("expected failed stream to preserve old state, got %s", nextState)
	}
}

func TestOpenAIResponsesProviderEmptyCompletedResponseReturnsErrorAndPreservesSessionState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_empty\",\"status\":\"completed\",\"output\":[]}}\n\n"))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	sessionProvider := providerInstance.(SessionStreamProvider)
	oldState := json.RawMessage(`{"input":[{"type":"message","role":"user","content":"old"}]}`)
	nextState, err := sessionProvider.ChatStreamWithState(context.Background(), oldState, ai.ChatRequest{
		Messages: []ai.Message{{Role: "user", Content: "new"}},
	}, func(ai.StreamChunk) {})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "empty response") {
		t.Fatalf("expected empty completed response error, got %v", err)
	}
	if string(nextState) != string(oldState) {
		t.Fatalf("expected empty completed response to preserve old state, got %s", nextState)
	}
}

func TestOpenAIResponsesProviderUsesConfiguredMaxOutputTokens(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}]}`))
	}))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-test", MaxTokens: 321,
	})
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if _, err := providerInstance.Chat(context.Background(), ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}}); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if received["max_output_tokens"] != float64(321) {
		t.Fatalf("expected configured max_output_tokens, got %#v", received["max_output_tokens"])
	}
}

func TestProviderFactoriesSelectOpenAIResponsesProtocol(t *testing.T) {
	config := ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: "https://api.example.com/v1", Model: "gpt-test",
	}
	customProvider, err := NewCustomProvider(config)
	if err != nil {
		t.Fatalf("create custom provider: %v", err)
	}
	custom, ok := customProvider.(*CustomProvider)
	if !ok {
		t.Fatalf("expected CustomProvider, got %T", customProvider)
	}
	if _, ok := custom.inner.(*OpenAIResponsesProvider); !ok {
		t.Fatalf("expected OpenAIResponsesProvider inner, got %T", custom.inner)
	}

	directProvider, err := NewProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", Model: "gpt-test",
	})
	if err != nil {
		t.Fatalf("create direct provider: %v", err)
	}
	if _, ok := directProvider.(*OpenAIResponsesProvider); !ok {
		t.Fatalf("expected direct OpenAIResponsesProvider, got %T", directProvider)
	}
}
