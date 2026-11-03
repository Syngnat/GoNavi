package aiservice

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/ai/runharness"
)

func TestCodeBuddyCLIChatUsesSelectedLanguage(t *testing.T) {
	cliPath := writeCodeBuddyCLIAuthFixture(t)
	for _, language := range []string{"zh-CN", "en-US", "de-DE", "ja-JP", "ru-RU", "zh-TW"} {
		t.Run(language, func(t *testing.T) {
			s := NewService()
			s.AISetLanguage(language)
			config := ai.ProviderConfig{ID: "test-codebuddy", Type: "custom", APIFormat: "codebuddy-cli", CLIPath: cliPath, APIKey: "cb-test"}
			want := s.serviceText("ai_service.backend.error.codebuddy_cli_auth_required", nil)
			health := s.AITestProvider(config)
			if health["success"] != false || !strings.Contains(health["message"].(string), want) {
				t.Fatalf("connection test = %#v, want localized authentication hint %q", health, want)
			}
			binding, err := runharness.NewProviderBinding(config.ID, config)
			if err != nil {
				t.Fatal(err)
			}
			adapter := runharness.NewProviderModelTurnAdapter(s.resolveAgentProvider, s.resolveAgentImagePrompts)
			_, err = adapter.Execute(context.Background(), runharness.ModelTurnRequest{
				Provider: config.ID, ProviderBinding: &binding,
				Messages: []runharness.Message{{ID: "user-1", Role: "user", Content: "ping"}},
			}, func(context.Context, runharness.ModelDelta) error { return nil })
			assertCodeBuddyLocalizedAuthError(t, err, want)

			s.providers = []ai.ProviderConfig{config}
			s.activeProvider = config.ID
			instance, _, err := s.getActiveProviderRuntimeWithContext(context.Background(), ai.ChatSendOptions{})
			if err != nil {
				t.Fatal(err)
			}
			stateful, ok := instance.(provider.SessionChatProvider)
			if !ok {
				t.Fatal("localized provider must retain session support")
			}
			_, _, err = stateful.ChatWithState(context.Background(), nil, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}})
			assertCodeBuddyLocalizedAuthError(t, err, want)
		})
	}
}

func assertCodeBuddyLocalizedAuthError(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || err.Error() != want {
		t.Fatalf("authentication error = %v, want %q", err, want)
	}
	if !errors.Is(err, provider.ErrCodeBuddyCLIAuthRequired) {
		t.Fatalf("localized error lost authentication sentinel: %v", err)
	}
}

func TestCodeBuddyCLILocalizationPreservesSuccessfulSession(t *testing.T) {
	result := `{"type":"result","subtype":"success","is_error":false,"result":"connected","session_id":"session-next","usage":{"input_tokens":1,"output_tokens":2}}`
	cliPath := writeCodeBuddyCLIFixture(t, "#!/bin/sh\necho '"+result+"'\n", "@echo off\r\necho "+result+"\r\nexit /b 0\r\n")
	config := ai.ProviderConfig{Type: "custom", APIFormat: "codebuddy-cli", CLIPath: cliPath, Name: "test-provider"}
	instance, err := provider.NewProvider(config)
	if err != nil {
		t.Fatal(err)
	}
	s := NewService()
	s.AISetLanguage("zh-CN")
	instance = s.withCodeBuddyCLILocalization(instance, config)
	if instance.Name() != config.Name {
		t.Fatalf("provider name changed: %q", instance.Name())
	}
	request := ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}}
	state := []byte(`{"sessionId":"session-original"}`)
	response, nextState, err := instance.(provider.SessionChatProvider).ChatWithState(context.Background(), state, request)
	if err != nil || response == nil || response.Content != "connected" || string(nextState) != `{"sessionId":"session-next"}` {
		t.Fatalf("chat response = %#v, state = %s, error = %v", response, nextState, err)
	}
	var chunks []ai.StreamChunk
	nextState, err = instance.(provider.SessionStreamProvider).ChatStreamWithState(context.Background(), state, request, func(chunk ai.StreamChunk) {
		chunks = append(chunks, chunk)
	})
	if err != nil || string(nextState) != `{"sessionId":"session-next"}` || len(chunks) != 1 || !chunks[0].Done || chunks[0].Usage == nil {
		t.Fatalf("stream chunks = %#v, state = %s, error = %v", chunks, nextState, err)
	}
}

func writeCodeBuddyCLIAuthFixture(t *testing.T) string {
	t.Helper()
	return writeCodeBuddyCLIFixture(t,
		"#!/bin/sh\necho '401 Authentication required (traceid: abc123)' >&2\nexit 0\n",
		"@echo off\r\necho 401 Authentication required (traceid: abc123) 1>&2\r\nexit /b 0\r\n")
}

func writeCodeBuddyCLIFixture(t *testing.T, posixScript string, windowsScript string) string {
	t.Helper()
	name := "codebuddy"
	script := posixScript
	if runtime.GOOS == "windows" {
		name = "codebuddy.cmd"
		script = windowsScript
	}
	cliPath := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(cliPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return cliPath
}
