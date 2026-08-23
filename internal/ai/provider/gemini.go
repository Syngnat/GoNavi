package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"GoNavi-Wails/internal/ai"
)

const (
	defaultGeminiBaseURL = "https://generativelanguage.googleapis.com"
)

// GeminiProvider 实现 Google Gemini API 的 Provider
type GeminiProvider struct {
	config  ai.ProviderConfig
	baseURL string
	client  *http.Client
}

// NewGeminiProvider 创建 Gemini Provider 实例
func NewGeminiProvider(config ai.ProviderConfig) (Provider, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL == "" {
		baseURL = defaultGeminiBaseURL
	}
	model := strings.TrimSpace(config.Model)
	if model == "" {
		return nil, fmt.Errorf("model ID is required; select or enter a model in Settings")
	}
	maxTokens := config.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultOpenAIMaxTokens
	}
	temperature := config.Temperature
	if temperature <= 0 {
		temperature = defaultOpenAITemperature
	}

	normalized := config
	normalized.BaseURL = baseURL
	normalized.Model = model
	normalized.MaxTokens = maxTokens
	normalized.Temperature = temperature
	profile := ResolveThinkingProfile(config.Type, config.APIFormat, baseURL, model)
	normalized.ThinkingIntensity = string(clampThinkingIntensityToProfile(config.ThinkingIntensity, profile))

	return &GeminiProvider{
		config:  normalized,
		baseURL: baseURL,
		client:  &http.Client{Timeout: openAIHTTPTimeout},
	}, nil
}

func (p *GeminiProvider) Name() string {
	if strings.TrimSpace(p.config.Name) != "" {
		return p.config.Name
	}
	return "Gemini"
}

func (p *GeminiProvider) Validate() error {
	if strings.TrimSpace(p.config.APIKey) == "" {
		return fmt.Errorf("API key is required")
	}
	return nil
}

type geminiRequest struct {
	Contents          []geminiContent `json:"contents"`
	SystemInstruction *geminiContent  `json:"systemInstruction,omitempty"`
	GenerationConfig  geminiGenConfig `json:"generationConfig,omitempty"`
}

type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text       string      `json:"text,omitempty"`
	InlineData *geminiBlob `json:"inlineData,omitempty"`
}

type geminiBlob struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type geminiGenConfig struct {
	Temperature     float64              `json:"temperature,omitempty"`
	MaxOutputTokens int                  `json:"maxOutputTokens,omitempty"`
	ThinkingConfig  *geminiThinkingConfig `json:"thinkingConfig,omitempty"`
}

// geminiThinkingConfig 兼容 Gemini 2.5 budget 与 Gemini 3 thinking_level。
type geminiThinkingConfig struct {
	ThinkingBudget *int   `json:"thinkingBudget,omitempty"`
	ThinkingLevel  string `json:"thinkingLevel,omitempty"`
}

func (p *GeminiProvider) applyThinkingToGenConfig(cfg *geminiGenConfig) {
	if cfg == nil {
		return
	}
	intensity := NormalizeThinkingIntensity(p.config.ThinkingIntensity)
	if intensity == "" {
		return
	}
	level := geminiThinkingLevel(intensity)
	budget := geminiThinkingBudget(intensity)
	thinking := &geminiThinkingConfig{}
	if intensity == ai.ThinkingIntensityOff || intensity == ai.ThinkingIntensity("none") {
		zero := 0
		thinking.ThinkingBudget = &zero
		cfg.ThinkingConfig = thinking
		return
	}
	if level != "" {
		thinking.ThinkingLevel = strings.ToUpper(level)
	}
	// 同时带 budget，兼容仍识别 thinkingBudget 的 2.5 端点
	if budget >= 0 {
		b := budget
		thinking.ThinkingBudget = &b
	}
	cfg.ThinkingConfig = thinking
}

type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
	UsageMetadata *struct {
		PromptTokenCount     int `json:"promptTokenCount"`
		CandidatesTokenCount int `json:"candidatesTokenCount"`
		TotalTokenCount      int `json:"totalTokenCount"`
	} `json:"usageMetadata"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (p *GeminiProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}

	geminiReq := p.buildRequest(req)

	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent?key=%s",
		p.baseURL, p.config.Model, p.config.APIKey)

	respBody, err := p.doRequest(ctx, url, geminiReq)
	if err != nil {
		return nil, err
	}
	defer respBody.Close()

	var result geminiResponse
	if err := json.NewDecoder(respBody).Decode(&result); err != nil {
		return nil, fmt.Errorf("parse Gemini response failed: %w", err)
	}
	if result.Error != nil && result.Error.Message != "" {
		return nil, fmt.Errorf("Gemini API error: %s", result.Error.Message)
	}
	if len(result.Candidates) == 0 || len(result.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("Gemini returned empty response")
	}

	var tokens ai.TokenUsage
	if result.UsageMetadata != nil {
		tokens = ai.TokenUsage{
			PromptTokens:     result.UsageMetadata.PromptTokenCount,
			CompletionTokens: result.UsageMetadata.CandidatesTokenCount,
			TotalTokens:      result.UsageMetadata.TotalTokenCount,
		}
	}

	var textParts []string
	for _, part := range result.Candidates[0].Content.Parts {
		if part.Text != "" {
			textParts = append(textParts, part.Text)
		}
	}

	return &ai.ChatResponse{
		Content:    strings.Join(textParts, ""),
		TokensUsed: tokens,
	}, nil
}

func (p *GeminiProvider) ChatStream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	if err := p.Validate(); err != nil {
		return err
	}

	geminiReq := p.buildRequest(req)

	url := fmt.Sprintf("%s/v1beta/models/%s:streamGenerateContent?alt=sse&key=%s",
		p.baseURL, p.config.Model, p.config.APIKey)

	respBody, err := p.doRequest(ctx, url, geminiReq)
	if err != nil {
		return err
	}
	defer respBody.Close()

	scanner := bufio.NewScanner(respBody)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")

		var chunk geminiResponse
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}

		if len(chunk.Candidates) > 0 && len(chunk.Candidates[0].Content.Parts) > 0 {
			for _, part := range chunk.Candidates[0].Content.Parts {
				if part.Text != "" {
					callback(ai.StreamChunk{Content: part.Text})
				}
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return err
	}
	callback(ai.StreamChunk{Done: true})
	return nil
}

func (p *GeminiProvider) buildRequest(req ai.ChatRequest) geminiRequest {
	temperature := req.Temperature
	if temperature <= 0 {
		temperature = p.config.Temperature
	}

	var systemInstruction *geminiContent
	var contents []geminiContent

	for _, m := range req.Messages {
		if m.Role == "system" {
			systemInstruction = &geminiContent{
				Parts: []geminiPart{{Text: m.Content}},
			}
			continue
		}
		role := m.Role
		if role == "assistant" {
			role = "model"
		}
		var parts []geminiPart
		text := m.Content
		if text == "" && len(m.Images) > 0 {
			text = providerImageFallbackPrompt(req.ImageFallbackPrompt) // 同样避免 Gemini 认为意图不明确
		}
		if text != "" {
			parts = append(parts, geminiPart{Text: text})
		}
		for _, img := range m.Images {
			mimeType, rawBase64, err := ParseDataURI(img)
			if err == nil {
				parts = append(parts, geminiPart{
					InlineData: &geminiBlob{
						MimeType: mimeType,
						Data:     rawBase64,
					},
				})
			}
		}

		contents = append(contents, geminiContent{
			Role:  role,
			Parts: parts,
		})
	}

	genCfg := geminiGenConfig{
		Temperature:     temperature,
		MaxOutputTokens: p.config.MaxTokens,
	}
	if req.MaxTokens > 0 {
		genCfg.MaxOutputTokens = req.MaxTokens
	}
	p.applyThinkingToGenConfig(&genCfg)

	return geminiRequest{
		Contents:          contents,
		SystemInstruction: systemInstruction,
		GenerationConfig:  genCfg,
	}
}

func (p *GeminiProvider) doRequest(ctx context.Context, url string, body interface{}) (io.ReadCloser, error) {
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("serialize request failed: %w", err)
	}

	requestLog := logAIUpstreamRequestStart(p.Name(), http.MethodPost, url, body)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(jsonBody))
	if err != nil {
		logAIUpstreamRequestFinish(requestLog, 0, err)
		return nil, fmt.Errorf("create HTTP request failed: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	if strings.Contains(url, "alt=sse") {
		httpReq.Header.Set("Accept", "text/event-stream")
		httpReq.Header.Set("Cache-Control", "no-cache")
		httpReq.Header.Set("Connection", "keep-alive")
	}

	resp, err := p.client.Do(httpReq)
	if err != nil {
		logAIUpstreamRequestFinish(requestLog, 0, err)
		return nil, fmt.Errorf("request to Gemini failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		statusErr := fmt.Errorf("Gemini API returned error (HTTP %d): %s", resp.StatusCode, readProviderErrorBody(resp.Body, resp.ContentLength))
		logAIUpstreamRequestFinish(requestLog, resp.StatusCode, statusErr)
		return nil, statusErr
	}

	logAIUpstreamRequestFinish(requestLog, resp.StatusCode, nil)
	return resp.Body, nil
}
