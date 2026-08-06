//go:build !windows

package app

import (
	"context"
	"strings"
	"testing"
)

func TestRefreshWebViewBoundsReturnsErrorOnNonWindows(t *testing.T) {
	err := refreshWebViewBounds(context.Background())
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "windows") {
		t.Fatalf("expected Windows-only error, got %v", err)
	}
}

func TestAppRefreshWebViewBoundsRPCReportsFailureOnNonWindows(t *testing.T) {
	app := &App{ctx: context.Background()}
	result := app.RefreshWebViewBounds()
	if result.Success {
		t.Fatal("expected RPC to report failure on non-Windows platform")
	}
	if strings.TrimSpace(result.Message) == "" {
		t.Fatal("expected failure message to explain why")
	}
}
