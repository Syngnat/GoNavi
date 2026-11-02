package provider

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestCodeBuddyCLIAuthAfterLongStderrPrefix(t *testing.T) {
	for _, stream := range []bool{false, true} {
		name := "chat"
		if stream {
			name = "stream"
		}
		t.Run(name, func(t *testing.T) {
			prefix := strings.Repeat("startup diagnostic line\n", 35)
			fake := writeFakeCodeBuddyScript(t, "#!/bin/sh\nprintf '%s' '"+prefix+"' >&2\necho '401 Authentication required (traceid: abc123)' >&2\nexit 0\n")
			restore := overrideCodeBuddyCLIForTest(t, fake)
			defer restore()
			p, err := NewCodeBuddyCLIProvider(ai.ProviderConfig{APIKey: "cb-test"})
			if err != nil {
				t.Fatal(err)
			}
			req := ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: "ping"}}}
			if stream {
				err = p.ChatStream(context.Background(), req, func(chunk ai.StreamChunk) {
					if chunk.Error != "" {
						t.Errorf("authentication must retain its error type, got callback error %q", chunk.Error)
					}
				})
			} else {
				_, err = p.Chat(context.Background(), req)
			}
			if !errors.Is(err, ErrCodeBuddyCLIAuthRequired) {
				t.Fatalf("authentication after diagnostics was discarded: %v", err)
			}
		})
	}
}

func TestCodeBuddyCLIStreamSourceUsesEnglishErrorWrappers(t *testing.T) {
	t.Parallel()
	source := providerFunctionSource(t, "codebuddy_cli_stream.go", "func scanCodeBuddyCLIStream(stdout io.Reader, cmd *exec.Cmd, resumeSessionID string, requestID string, callback func(ai.StreamChunk)) (string, bool, error) {")
	for _, message := range []string{`"CodeBuddy CLI 鉴权失败: %s"`, `"CodeBuddy CLI 返回错误: %s"`} {
		if strings.Contains(source, message) {
			t.Fatalf("stream handler still contains raw provider text %q", message)
		}
	}
	for _, message := range []string{`"CodeBuddy CLI authentication failed: %s"`, `"CodeBuddy CLI returned an error: %s"`} {
		if !strings.Contains(source, message) {
			t.Fatalf("stream handler does not reference English wrapper %q", message)
		}
	}
}
