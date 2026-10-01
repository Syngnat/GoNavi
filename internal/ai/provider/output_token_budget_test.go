package provider

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"GoNavi-Wails/internal/ai"
)

// 输出上限的策略是「默认不限制」：请求与配置都没有给出正数上限时，不替用户设上限。
// 这里锁定各协议的默认行为，以及「默认值被上游拒绝」时的兜底。

func resetLearnedOutputTokenCaps() {
	learnedOutputTokenCaps.Range(func(key, _ any) bool {
		learnedOutputTokenCaps.Delete(key)
		return true
	})
}

// budgetTestLoopbackClient 让指向任意域名（例如 api.deepseek.com）的请求都落到本地测试服务，
// 用来覆盖「按域名识别原生 DeepSeek 端点」的分支。
func budgetTestLoopbackClient(server *httptest.Server) *http.Client {
	address := server.Listener.Addr().String()
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, address)
		},
	}}
}

// budgetTestRecorder 记录每次请求体，并按脚本返回响应。
type budgetTestRecorder struct {
	mu      sync.Mutex
	bodies  []map[string]any
	respond func(call int, body map[string]any, w http.ResponseWriter)
}

func (r *budgetTestRecorder) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		defer req.Body.Close()
		raw, _ := io.ReadAll(req.Body)
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		r.mu.Lock()
		r.bodies = append(r.bodies, body)
		call := len(r.bodies)
		r.mu.Unlock()
		r.respond(call, body, w)
	}
}

func (r *budgetTestRecorder) calls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.bodies)
}

func (r *budgetTestRecorder) body(index int) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bodies[index]
}

func budgetTestPing() ai.ChatRequest {
	return ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}}
}

func writeJSON(w http.ResponseWriter, status int, payload string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(payload))
}

const (
	responsesOKBody   = `{"id":"resp","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}]}`
	chatOKBody        = `{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`
	anthropicOKBody   = `{"id":"msg","type":"message","role":"assistant","content":[{"type":"text","text":"pong"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`
	geminiOKBody      = `{"candidates":[{"content":{"parts":[{"text":"pong"}]}}]}`
	anthropicCapError = `{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-haiku-4-5-20251001"}}`
)

func TestOutputTokenCapFromRejection(t *testing.T) {
	tests := []struct {
		name    string
		message string
		sent    int
		want    int
		wantOK  bool
	}{
		{
			name:    "anthropic names the model cap",
			message: "Anthropic API returned error (HTTP 400): " + anthropicCapError,
			sent:    128000, want: 64000, wantOK: true,
		},
		{
			name:    "openai-compatible range",
			message: "OpenAI API returned error (HTTP 400): Invalid max_tokens value, the valid range of max_tokens is [1, 8192]",
			sent:    393216, want: 8192, wantOK: true,
		},
		{
			name:    "responses style",
			message: "OpenAI Responses API returned error (HTTP 400): max_output_tokens must be at most 32000",
			sent:    393216, want: 32000, wantOK: true,
		},
		{
			name:    "mentions the limit but gives no number",
			message: "OpenAI API returned error (HTTP 400): max_tokens is too large",
			sent:    393216, wantOK: false,
		},
		{
			name:    "unrelated client error",
			message: "OpenAI API returned error (HTTP 400): invalid api key 12345",
			sent:    393216, wantOK: false,
		},
		{
			name:    "server error is never a limit rejection",
			message: "OpenAI API returned error (HTTP 500): max_tokens 8192",
			sent:    393216, wantOK: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := errors.New(tt.message)
			rejected := isOutputTokenLimitRejection(err)
			got, ok := outputTokenCapFromRejection(err, tt.sent)
			if ok != tt.wantOK || got != tt.want {
				t.Fatalf("cap = %d ok=%v (rejected=%v), want %d ok=%v", got, ok, rejected, tt.want, tt.wantOK)
			}
		})
	}
	// 只认 provider 报出的「(HTTP 400)」形式，避免误伤其它文本。
	if isOutputTokenLimitRejection(errors.New("HTTP 400 max_tokens is too large")) {
		t.Fatal("plain 'HTTP 400' text must not be treated as a provider rejection")
	}
}

func TestOpenAIResponsesDoesNotLimitOutputByDefault(t *testing.T) {
	for _, model := range []string{"gpt-5.6", "o3-mini", "gpt-4o", "deepseek/deepseek-v4-flash-0731"} {
		t.Run(model, func(t *testing.T) {
			recorder := &budgetTestRecorder{respond: func(_ int, _ map[string]any, w http.ResponseWriter) {
				writeJSON(w, http.StatusOK, responsesOKBody)
			}}
			server := httptest.NewServer(recorder.handler(t))
			defer server.Close()

			providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
				Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: model,
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err != nil {
				t.Fatalf("chat: %v", err)
			}
			if _, present := recorder.body(0)["max_output_tokens"]; present {
				t.Fatalf("max_output_tokens must be omitted by default, got %#v", recorder.body(0)["max_output_tokens"])
			}
		})
	}
}

func TestOpenAIResponsesRequestMaxOutputTokensResolution(t *testing.T) {
	resetLearnedOutputTokenCaps()
	tests := []struct {
		name       string
		model      string
		baseURL    string
		request    int
		configured int
		want       int
	}{
		{name: "openai default is unlimited", model: "gpt-5.6", baseURL: "https://api.openai.com/v1", want: 0},
		{name: "ordinary model default is unlimited", model: "gpt-4o", baseURL: "https://api.openai.com/v1", want: 0},
		{name: "gateway alias stays unlimited", model: "deepseek/deepseek-v4-flash-0731", baseURL: "https://gateway.example.com/v1", want: 0},
		{name: "native deepseek omits nothing: server default is only 8K/64K", model: "deepseek-v4.1-flash", baseURL: "https://api.deepseek.com", want: deepSeekMaxOutputTokens},
		{name: "configured budget is honored", model: "gpt-5.6", baseURL: "https://api.openai.com/v1", configured: 321, want: 321},
		{name: "request budget beats configured", model: "gpt-5.6", baseURL: "https://api.openai.com/v1", request: 256, configured: 321, want: 256},
		{name: "explicit small budget is never raised", model: "deepseek-v4.1-flash", baseURL: "https://api.deepseek.com", request: 64, want: 64},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := openAIResponsesRequestMaxOutputTokens(tt.model, tt.baseURL, tt.request, tt.configured); got != tt.want {
				t.Fatalf("max output tokens = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestOpenAIResponsesNativeDeepSeekFallsBackToTheCapTheUpstreamStates(t *testing.T) {
	resetLearnedOutputTokenCaps()
	recorder := &budgetTestRecorder{respond: func(_ int, body map[string]any, w http.ResponseWriter) {
		if tokens, _ := body["max_output_tokens"].(float64); tokens > 8192 {
			writeJSON(w, http.StatusBadRequest, `{"error":{"message":"Invalid max_output_tokens value, the valid range is [1, 8192]"}}`)
			return
		}
		writeJSON(w, http.StatusOK, responsesOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	newProvider := func() Provider {
		providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
			Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: "http://api.deepseek.com", Model: "deepseek-legacy-cap",
		})
		if err != nil {
			t.Fatal(err)
		}
		providerInstance.(*OpenAIResponsesProvider).client = budgetTestLoopbackClient(server)
		return providerInstance
	}

	if _, err := newProvider().Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("first chat should recover from the rejected default: %v", err)
	}
	if recorder.calls() != 2 {
		t.Fatalf("calls = %d, want the rejected default plus one retry", recorder.calls())
	}
	if got := recorder.body(0)["max_output_tokens"]; got != float64(deepSeekMaxOutputTokens) {
		t.Fatalf("first attempt budget = %#v, want %d", got, deepSeekMaxOutputTokens)
	}
	if got := recorder.body(1)["max_output_tokens"]; got != float64(8192) {
		t.Fatalf("retry budget = %#v, want the stated cap 8192", got)
	}

	// 同一端点与模型再来一次：直接用已学到的上限，不再白挨一次 400。
	if _, err := newProvider().Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("second chat: %v", err)
	}
	if recorder.calls() != 3 {
		t.Fatalf("calls = %d, want the learned cap to avoid another rejection", recorder.calls())
	}
	if got := recorder.body(2)["max_output_tokens"]; got != float64(8192) {
		t.Fatalf("learned budget = %#v, want 8192", got)
	}
}

func TestOpenAIResponsesNativeDeepSeekOmitsBudgetWhenUpstreamStatesNoCap(t *testing.T) {
	resetLearnedOutputTokenCaps()
	recorder := &budgetTestRecorder{respond: func(_ int, body map[string]any, w http.ResponseWriter) {
		if _, present := body["max_output_tokens"]; present {
			writeJSON(w, http.StatusBadRequest, `{"error":{"message":"max_output_tokens is not supported"}}`)
			return
		}
		writeJSON(w, http.StatusOK, responsesOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "custom", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: "http://api.deepseek.com", Model: "deepseek-nocap",
	})
	if err != nil {
		t.Fatal(err)
	}
	providerInstance.(*OpenAIResponsesProvider).client = budgetTestLoopbackClient(server)
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if _, present := recorder.body(recorder.calls() - 1)["max_output_tokens"]; present {
		t.Fatal("retry must drop max_output_tokens when the upstream states no usable cap")
	}
}

func TestOpenAIResponsesExplicitBudgetRejectionIsNotSwallowed(t *testing.T) {
	resetLearnedOutputTokenCaps()
	recorder := &budgetTestRecorder{respond: func(_ int, _ map[string]any, w http.ResponseWriter) {
		writeJSON(w, http.StatusBadRequest, `{"error":{"message":"max_output_tokens must be at most 100"}}`)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewOpenAIResponsesProvider(ai.ProviderConfig{
		Type: "openai", APIFormat: "openai-responses", APIKey: "sk-test", BaseURL: server.URL + "/v1", Model: "gpt-explicit", MaxTokens: 4000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err == nil {
		t.Fatal("an explicitly configured budget the upstream rejects must surface the error")
	}
	if recorder.calls() != 1 {
		t.Fatalf("calls = %d, an explicit budget must not be silently rewritten", recorder.calls())
	}
}

func TestOpenAIChatCompletionsDoesNotLimitOutputByDefault(t *testing.T) {
	recorder := &budgetTestRecorder{respond: func(_ int, _ map[string]any, w http.ResponseWriter) {
		writeJSON(w, http.StatusOK, chatOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{Type: "openai", APIKey: "sk-test", BaseURL: server.URL, Model: "gpt-chat"})
	if err != nil {
		t.Fatal(err)
	}
	if got := providerInstance.(*OpenAIProvider).config.MaxTokens; got != 0 {
		t.Fatalf("provider config must not invent a default limit, got %d", got)
	}
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if _, present := recorder.body(0)["max_tokens"]; present {
		t.Fatalf("max_tokens must be omitted by default, got %#v", recorder.body(0)["max_tokens"])
	}
}

func TestOpenAIChatCompletionsHonorsConfiguredBudget(t *testing.T) {
	recorder := &budgetTestRecorder{respond: func(_ int, _ map[string]any, w http.ResponseWriter) {
		writeJSON(w, http.StatusOK, chatOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{Type: "openai", APIKey: "sk-test", BaseURL: server.URL, Model: "gpt-chat", MaxTokens: 777})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if got := recorder.body(0)["max_tokens"]; got != float64(777) {
		t.Fatalf("configured max_tokens = %#v, want 777", got)
	}
}

func TestOpenAIChatCompletionsNativeDeepSeekLiftsItsSmallServerDefault(t *testing.T) {
	resetLearnedOutputTokenCaps()
	recorder := &budgetTestRecorder{respond: func(_ int, body map[string]any, w http.ResponseWriter) {
		if tokens, _ := body["max_tokens"].(float64); tokens > 8192 {
			writeJSON(w, http.StatusBadRequest, `{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 8192]"}}`)
			return
		}
		writeJSON(w, http.StatusOK, chatOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewOpenAIProvider(ai.ProviderConfig{Type: "custom", APIKey: "sk-test", BaseURL: "http://api.deepseek.com", Model: "deepseek-chat-legacy"})
	if err != nil {
		t.Fatal(err)
	}
	providerInstance.(*OpenAIProvider).client = budgetTestLoopbackClient(server)
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("chat should recover from the rejected default: %v", err)
	}
	if got := recorder.body(0)["max_tokens"]; got != float64(deepSeekMaxOutputTokens) {
		t.Fatalf("first attempt = %#v, want DeepSeek's documented maximum %d", got, deepSeekMaxOutputTokens)
	}
	if got := recorder.body(recorder.calls() - 1)["max_tokens"]; got != float64(8192) {
		t.Fatalf("retry = %#v, want the stated cap 8192", got)
	}
}

func TestAnthropicUsesLargestOutputBudgetByDefault(t *testing.T) {
	resetLearnedOutputTokenCaps()
	recorder := &budgetTestRecorder{respond: func(_ int, _ map[string]any, w http.ResponseWriter) {
		writeJSON(w, http.StatusOK, anthropicOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewAnthropicProvider(ai.ProviderConfig{Type: "anthropic", APIKey: "sk-test", BaseURL: server.URL, Model: "claude-default-budget"})
	if err != nil {
		t.Fatal(err)
	}
	if got := providerInstance.(*AnthropicProvider).config.MaxTokens; got != 0 {
		t.Fatalf("provider config must not invent a default limit, got %d", got)
	}
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if got := recorder.body(0)["max_tokens"]; got != float64(anthropicDefaultMaxTokens) {
		t.Fatalf("max_tokens = %#v, want %d (the field is mandatory, so use the largest current limit)", got, anthropicDefaultMaxTokens)
	}
}

func TestAnthropicFallsBackToTheModelCapAndRemembersIt(t *testing.T) {
	resetLearnedOutputTokenCaps()
	recorder := &budgetTestRecorder{respond: func(_ int, body map[string]any, w http.ResponseWriter) {
		if tokens, _ := body["max_tokens"].(float64); tokens > 64000 {
			writeJSON(w, http.StatusBadRequest, anthropicCapError)
			return
		}
		writeJSON(w, http.StatusOK, anthropicOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	newProvider := func() Provider {
		providerInstance, err := NewAnthropicProvider(ai.ProviderConfig{Type: "anthropic", APIKey: "sk-test", BaseURL: server.URL, Model: "claude-haiku-cap"})
		if err != nil {
			t.Fatal(err)
		}
		return providerInstance
	}
	if _, err := newProvider().Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("first chat should recover from the rejected default: %v", err)
	}
	if recorder.calls() != 2 || recorder.body(1)["max_tokens"] != float64(64000) {
		t.Fatalf("calls=%d retry budget=%#v, want 2 calls and the stated cap 64000", recorder.calls(), recorder.body(recorder.calls() - 1)["max_tokens"])
	}
	if _, err := newProvider().Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("second chat: %v", err)
	}
	if recorder.calls() != 3 || recorder.body(2)["max_tokens"] != float64(64000) {
		t.Fatalf("calls=%d, want the learned cap to avoid another rejection", recorder.calls())
	}
}

func TestAnthropicFallsBackToLegacyBudgetWhenTheCapCannotBeParsed(t *testing.T) {
	resetLearnedOutputTokenCaps()
	recorder := &budgetTestRecorder{respond: func(_ int, body map[string]any, w http.ResponseWriter) {
		if tokens, _ := body["max_tokens"].(float64); tokens > legacyOutputTokenFallback {
			writeJSON(w, http.StatusBadRequest, `{"error":{"message":"max_tokens is too large"}}`)
			return
		}
		writeJSON(w, http.StatusOK, anthropicOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewAnthropicProvider(ai.ProviderConfig{Type: "custom", APIKey: "sk-test", BaseURL: server.URL, Model: "gateway-model-unparsable"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("chat must stay usable on gateways whose cap is unknown: %v", err)
	}
	if got := recorder.body(recorder.calls() - 1)["max_tokens"]; got != float64(legacyOutputTokenFallback) {
		t.Fatalf("fallback budget = %#v, want the historical %d", got, legacyOutputTokenFallback)
	}
}

func TestAnthropicExplicitBudgetRejectionIsNotSwallowed(t *testing.T) {
	resetLearnedOutputTokenCaps()
	recorder := &budgetTestRecorder{respond: func(_ int, _ map[string]any, w http.ResponseWriter) {
		writeJSON(w, http.StatusBadRequest, anthropicCapError)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewAnthropicProvider(ai.ProviderConfig{Type: "anthropic", APIKey: "sk-test", BaseURL: server.URL, Model: "claude-explicit", MaxTokens: 512})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err == nil {
		t.Fatal("an explicitly configured budget the upstream rejects must surface the error")
	}
	if recorder.calls() != 1 || recorder.body(0)["max_tokens"] != float64(512) {
		t.Fatalf("calls=%d body=%#v, an explicit budget must be sent as-is and never rewritten", recorder.calls(), recorder.body(0)["max_tokens"])
	}
}

func TestGeminiDoesNotLimitOutputByDefault(t *testing.T) {
	recorder := &budgetTestRecorder{respond: func(_ int, _ map[string]any, w http.ResponseWriter) {
		writeJSON(w, http.StatusOK, geminiOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewGeminiProvider(ai.ProviderConfig{Type: "gemini", APIKey: "test", BaseURL: server.URL, Model: "gemini-test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("chat: %v", err)
	}
	generationConfig, _ := recorder.body(0)["generationConfig"].(map[string]any)
	if _, present := generationConfig["maxOutputTokens"]; present {
		t.Fatalf("maxOutputTokens must be omitted by default, got %#v", generationConfig["maxOutputTokens"])
	}
}

func TestGeminiHonorsConfiguredBudget(t *testing.T) {
	recorder := &budgetTestRecorder{respond: func(_ int, _ map[string]any, w http.ResponseWriter) {
		writeJSON(w, http.StatusOK, geminiOKBody)
	}}
	server := httptest.NewServer(recorder.handler(t))
	defer server.Close()

	providerInstance, err := NewGeminiProvider(ai.ProviderConfig{Type: "gemini", APIKey: "test", BaseURL: server.URL, Model: "gemini-test", MaxTokens: 512})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := providerInstance.Chat(context.Background(), budgetTestPing()); err != nil {
		t.Fatalf("chat: %v", err)
	}
	generationConfig, _ := recorder.body(0)["generationConfig"].(map[string]any)
	if generationConfig["maxOutputTokens"] != float64(512) {
		t.Fatalf("maxOutputTokens = %#v, want 512", generationConfig["maxOutputTokens"])
	}
}
