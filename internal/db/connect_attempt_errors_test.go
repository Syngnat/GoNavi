package db

import (
	"errors"
	"strings"
	"testing"
)

func TestNewConnectAttemptErrorKeepsCauseUnwrappable(t *testing.T) {
	cause := errors.New("EOF")
	err := newConnectAttemptError("连接建立后验证失败", []string{
		"第1次连接验证失败: EOF",
		"第2次连接验证失败: EOF",
	}, cause)

	if !strings.HasPrefix(err.Error(), "连接建立后验证失败：") {
		t.Fatalf("message should keep the prefix, got %q", err.Error())
	}
	if !strings.Contains(err.Error(), "第2次连接验证失败") {
		t.Fatalf("message should list every attempt, got %q", err.Error())
	}
	// 关键：cause 必须在错误链上，否则 logger.ErrorChain 只能重复外层消息。
	if unwrapped := errors.Unwrap(err); unwrapped == nil || unwrapped.Error() != "EOF" {
		t.Fatalf("expected unwrappable EOF cause, got %v", unwrapped)
	}
	if !errors.Is(err, cause) {
		t.Fatal("errors.Is should reach the underlying cause")
	}
}

func TestNewConnectAttemptErrorWithoutCause(t *testing.T) {
	err := newConnectAttemptError("连接建立后验证失败", nil, nil)
	if err.Error() != "连接建立后验证失败" {
		t.Fatalf("unexpected message: %q", err.Error())
	}
	if errors.Unwrap(err) != nil {
		t.Fatal("no cause expected")
	}
}

func TestWrapDatabaseConnectCause(t *testing.T) {
	cause := errors.New("dial tcp: connection refused")

	t.Run("nil message stays nil", func(t *testing.T) {
		if got := wrapDatabaseConnectCause(nil, cause); got != nil {
			t.Fatalf("expected nil, got %v", got)
		}
	})

	t.Run("nil cause keeps the message as-is", func(t *testing.T) {
		message := errors.New("连接失败")
		got := wrapDatabaseConnectCause(message, nil)
		if got != message {
			t.Fatalf("expected the original message, got %v", got)
		}
	})

	t.Run("wraps cause so it stays unwrappable", func(t *testing.T) {
		message := errors.New("连接失败")
		got := wrapDatabaseConnectCause(message, cause)
		if got.Error() != "连接失败" {
			t.Fatalf("unexpected message: %q", got.Error())
		}
		if !errors.Is(got, cause) {
			t.Fatalf("cause should be reachable through the chain, got %v", got)
		}
	})
}
