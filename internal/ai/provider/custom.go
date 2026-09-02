package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/ai"
)

// CustomProvider 自定义 Provider，根据 apiFormat 选择底层协议
// 支持 openai / openai-responses / anthropic / gemini / cursor-agent / CLI 等 API 格式
type CustomProvider struct {
	inner Provider
	name  string
}

// NewCustomProvider 创建自定义 Provider 实例
func NewCustomProvider(config ai.ProviderConfig) (Provider, error) {
	// 根据 apiFormat 决定使用哪个底层协议，默认 openai
	apiFormat := strings.ToLower(strings.TrimSpace(config.APIFormat))
	if apiFormat == "" {
		apiFormat = "openai"
	}
	if strings.TrimSpace(config.BaseURL) == "" && apiFormat != "codex-cli" && apiFormat != "claude-cli" && apiFormat != "codebuddy-cli" && apiFormat != "grok-cli" && apiFormat != "cursor-cli" {
		return nil, fmt.Errorf("custom provider Base URL is required")
	}

	var innerProvider Provider
	var err error
	switch apiFormat {
	case "openai-responses":
		innerProvider, err = NewOpenAIResponsesProvider(config)
	case "anthropic":
		innerProvider, err = NewAnthropicProvider(config)
	case "gemini":
		innerProvider, err = NewGeminiProvider(config)
	case "cursor-agent":
		innerProvider, err = NewCursorAgentProvider(config)
	case "cursor-cli":
		innerProvider, err = NewCursorCLIProvider(config)
	case "codex-cli":
		innerProvider, err = NewCodexCLIProvider(config)
	case "claude-cli":
		innerProvider, err = NewClaudeCLIProvider(config)
	case "codebuddy-cli":
		innerProvider, err = NewCodeBuddyCLIProvider(config)
	case "grok-cli":
		innerProvider, err = NewGrokCLIProvider(config)
	default: // "openai" 及其他
		innerProvider, err = NewOpenAIProvider(config)
	}
	if err != nil {
		return nil, err
	}

	name := strings.TrimSpace(config.Name)
	if name == "" {
		name = "Custom"
	}

	return &CustomProvider{
		inner: innerProvider,
		name:  name,
	}, nil
}

func (p *CustomProvider) Name() string {
	return p.name
}

func (p *CustomProvider) Validate() error {
	if strings.TrimSpace(p.inner.(interface{ Name() string }).Name()) == "" {
		// 对自定义 Provider，API Key 可选（部分本地服务不需要）
	}
	return nil
}

func (p *CustomProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	return p.inner.Chat(ctx, req)
}

func (p *CustomProvider) ChatStream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	return p.inner.ChatStream(ctx, req, callback)
}

func (p *CustomProvider) ChatWithState(ctx context.Context, state json.RawMessage, req ai.ChatRequest) (*ai.ChatResponse, json.RawMessage, error) {
	sessionProvider, ok := p.inner.(SessionChatProvider)
	if !ok {
		resp, err := p.inner.Chat(ctx, req)
		return resp, nil, err
	}
	return sessionProvider.ChatWithState(ctx, state, req)
}

func (p *CustomProvider) ChatStreamWithState(ctx context.Context, state json.RawMessage, req ai.ChatRequest, callback func(ai.StreamChunk)) (json.RawMessage, error) {
	sessionProvider, ok := p.inner.(SessionStreamProvider)
	if !ok {
		return nil, p.inner.ChatStream(ctx, req, callback)
	}
	return sessionProvider.ChatStreamWithState(ctx, state, req, callback)
}
