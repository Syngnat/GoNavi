package aiservice

import (
	"context"
	"encoding/json"
	"errors"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
)

// localizeCodeBuddyCLIError 统一连接测试与聊天的登录提示，并保留认证错误类型。
func (s *Service) localizeCodeBuddyCLIError(err error) error {
	if errors.Is(err, provider.ErrCodeBuddyCLIAuthRequired) {
		return s.serviceError("ai_service.backend.error.codebuddy_cli_auth_required", nil, err)
	}
	return err
}

type codeBuddyCLISessionProvider interface {
	provider.Provider
	provider.SessionChatProvider
	provider.SessionStreamProvider
}

// localizedCodeBuddyCLIProvider 在 service 边界翻译认证错误，同时保留 CLI 会话能力。
type localizedCodeBuddyCLIProvider struct {
	codeBuddyCLISessionProvider
	localize func(error) error
}

var _ provider.SessionChatProvider = (*localizedCodeBuddyCLIProvider)(nil)
var _ provider.SessionStreamProvider = (*localizedCodeBuddyCLIProvider)(nil)

func (s *Service) withCodeBuddyCLILocalization(instance provider.Provider, config ai.ProviderConfig) provider.Provider {
	if normalizedProviderType(config) != "codebuddy-cli" {
		return instance
	}
	// 工厂返回 CustomProvider，按配置选协议，并通过可选接口保留内层 CLI 会话。
	cli, ok := instance.(codeBuddyCLISessionProvider)
	if !ok {
		return instance
	}
	return &localizedCodeBuddyCLIProvider{codeBuddyCLISessionProvider: cli, localize: s.localizeCodeBuddyCLIError}
}

func (p *localizedCodeBuddyCLIProvider) Chat(ctx context.Context, req ai.ChatRequest) (*ai.ChatResponse, error) {
	response, _, err := p.ChatWithState(ctx, nil, req)
	return response, err
}

func (p *localizedCodeBuddyCLIProvider) ChatWithState(ctx context.Context, state json.RawMessage, req ai.ChatRequest) (*ai.ChatResponse, json.RawMessage, error) {
	response, nextState, err := p.codeBuddyCLISessionProvider.ChatWithState(ctx, state, req)
	return response, nextState, p.localize(err)
}

func (p *localizedCodeBuddyCLIProvider) ChatStream(ctx context.Context, req ai.ChatRequest, callback func(ai.StreamChunk)) error {
	_, err := p.ChatStreamWithState(ctx, nil, req, callback)
	return err
}

func (p *localizedCodeBuddyCLIProvider) ChatStreamWithState(ctx context.Context, state json.RawMessage, req ai.ChatRequest, callback func(ai.StreamChunk)) (json.RawMessage, error) {
	nextState, err := p.codeBuddyCLISessionProvider.ChatStreamWithState(ctx, state, req, callback)
	return nextState, p.localize(err)
}
