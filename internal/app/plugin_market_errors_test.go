package app

import (
	"GoNavi-Wails/internal/pluginmarket"
	"context"
	"fmt"
	"testing"
)

func TestMarketFailureCodesPreserveSafeSourceDiagnostics(t *testing.T) {
	for _, test := range []struct {
		err  error
		want string
	}{
		{&pluginmarket.APIError{StatusCode: 503, Code: "auth_unavailable"}, "auth_unavailable"},
		{&pluginmarket.APIError{StatusCode: 429, Code: "rate_limited"}, "rate_limited"},
		{&pluginmarket.APIError{StatusCode: 500, Code: "untrusted-secret-message"}, "market_unavailable"},
		{fmt.Errorf("wrapped: %w", context.DeadlineExceeded), "timeout"},
		{pluginmarket.ErrSourceChanged, "source_changed"}, {pluginmarket.ErrInvalidResponse, "invalid_response"}, {pluginmarket.ErrRedirect, "redirect_rejected"},
	} {
		if got := marketFailureCode(test.err); got != test.want {
			t.Fatalf("code=%q want %q", got, test.want)
		}
	}
}
