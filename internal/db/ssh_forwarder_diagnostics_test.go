package db

import (
	"errors"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/shared/i18n"
)

func TestWrapDatabaseConnectionVerifyErrorWithRemoteDialFailureIncludesRemoteTarget(t *testing.T) {
	SetBackendLanguage(i18n.LanguageZhCN)
	t.Cleanup(func() { SetBackendLanguage(i18n.LanguageZhCN) })

	localErr := errors.New("read tcp 127.0.0.1:58229->127.0.0.1:58228: read: connection reset by peer")
	remoteErr := errors.New("ssh: rejected: connect failed (Connection refused)")
	got := wrapDatabaseConnectionVerifyErrorWithRemoteDialFailure(localErr, "127.0.0.1:58228", ssh.RemoteDialFailure{
		RemoteAddr: "127.0.0.1:21433",
		Err:        remoteErr,
		OccurredAt: time.Now(),
	})
	if got == nil {
		t.Fatal("expected wrapped verification error")
	}
	message := got.Error()
	for _, want := range []string{
		"127.0.0.1:58228",
		"127.0.0.1:21433",
		"Connection refused",
		"connection reset by peer",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("wrapped error %q does not contain %q", message, want)
		}
	}
	if !errors.Is(got, localErr) {
		t.Fatalf("wrapped error must retain the original verification error: %v", got)
	}
}

func TestWrapDatabaseConnectionVerifyErrorWithForwarderUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() { SetBackendLanguage(i18n.LanguageZhCN) })

	localErr := errors.New("connection reset by peer")
	got := wrapDatabaseConnectionVerifyErrorWithRemoteTarget(localErr, "127.0.0.1:59225", "127.0.0.1:19200")
	if got == nil {
		t.Fatal("expected wrapped verification error")
	}
	message := got.Error()
	for _, want := range []string{
		"Failed to verify the established connection:",
		"SSH tunnel established",
		"127.0.0.1:59225",
		"127.0.0.1:19200",
		"connection reset by peer",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("localized wrapped error %q does not contain %q", message, want)
		}
	}
	if strings.Contains(message, "SSH 隧道") {
		t.Fatalf("localized wrapped error unexpectedly contains Chinese text: %q", message)
	}
	if !errors.Is(got, localErr) {
		t.Fatalf("wrapped error must retain the original verification error: %v", got)
	}
}

func TestWrapDatabaseConnectionVerifyErrorWithForwarderIncludesRemoteTargetWithoutDialFailure(t *testing.T) {
	localErr := errors.New("read tcp 127.0.0.1:58229->127.0.0.1:58228: read: connection reset by peer")
	forwarder := &ssh.LocalForwarder{
		LocalAddr:  "127.0.0.1:58228",
		RemoteAddr: "127.0.0.1:21433",
	}

	got := wrapDatabaseConnectionVerifyErrorWithForwarder(localErr, forwarder, time.Now())
	if got == nil {
		t.Fatal("expected wrapped verification error")
	}
	message := got.Error()
	for _, want := range []string{
		"127.0.0.1:58228",
		"127.0.0.1:21433",
		"connection reset by peer",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("wrapped error %q does not contain %q", message, want)
		}
	}
	if !errors.Is(got, localErr) {
		t.Fatalf("wrapped error must retain the original verification error: %v", got)
	}
}
