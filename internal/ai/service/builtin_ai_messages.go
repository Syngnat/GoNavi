package aiservice

import (
	"errors"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/shared/i18n"
)

// errBuiltinAIServiceUnavailable: the Gateway answered, but no model node is
// healthy. Retrying later is the only remedy.
var errBuiltinAIServiceUnavailable = errors.New("GoNavi AI has no healthy model node")

// builtinAIQuotaError reports an exhausted window together with when it frees.
type builtinAIQuotaError struct {
	window  string // "daily" | "rolling"
	resetAt string
}

func (e builtinAIQuotaError) Error() string { return "GoNavi AI " + e.window + " quota exhausted" }

// builtinAIQuotaExhausted returns a non-nil error when either window is used up.
func builtinAIQuotaExhausted(quota *ai.BuiltinAIQuota) error {
	if quota == nil {
		return nil
	}
	if quota.DailyTokenLimit > 0 && quota.DailyTokensUsed >= quota.DailyTokenLimit {
		return builtinAIQuotaError{window: "daily", resetAt: quota.DailyResetAt}
	}
	if quota.Rolling5HTokenLimit > 0 && quota.Rolling5HTokensUsed >= quota.Rolling5HTokenLimit {
		return builtinAIQuotaError{window: "rolling", resetAt: quota.Rolling5HResetAt}
	}
	return nil
}

// builtinAIMessageKey maps a failure to a localized catalog key. The Gateway's
// status codes are mapped to distinct copy so the user sees what to do:
// sign in, retry, wait for the quota, or contact the operator.
func builtinAIMessageKey(err error) (string, map[string]any) {
	var statusErr builtinAIHTTPStatusError
	var quotaErr builtinAIQuotaError
	switch {
	case errors.Is(err, errBuiltinAILoginRequired):
		return "ai_service.backend.builtin.login_required", nil
	case errors.Is(err, errBuiltinAIUnauthorized):
		return "ai_service.backend.builtin.login_expired", nil
	case errors.Is(err, errBuiltinAINetwork):
		return "ai_service.backend.builtin.network_error", nil
	case errors.Is(err, errBuiltinAIServiceUnavailable):
		return "ai_service.backend.builtin.service_unavailable", nil
	case errors.As(err, &quotaErr):
		key := "ai_service.backend.builtin.quota_exhausted_" + quotaErr.window
		resetAt := formatBuiltinAIResetTime(quotaErr.resetAt)
		if resetAt == "" {
			return key + "_no_reset", nil
		}
		return key, map[string]any{"resetAt": resetAt}
	case errors.As(err, &statusErr):
		switch statusErr.statusCode {
		case 403:
			return "ai_service.backend.builtin.forbidden", nil
		case 404:
			return "ai_service.backend.builtin.not_found", nil
		}
		return "ai_service.backend.builtin.service_error", map[string]any{"status": statusErr.statusCode}
	}
	return "ai_service.backend.builtin.unknown_error", map[string]any{"detail": err.Error()}
}

func formatBuiltinAIResetTime(raw string) string {
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return ""
	}
	return parsed.Local().Format("2006-01-02 15:04")
}

// builtinAIMessage returns the localized text for err. It takes s.mu, so it
// must not be called while the lock is held; use builtinAIServiceError there.
func (s *Service) builtinAIMessage(err error) string {
	key, params := builtinAIMessageKey(err)
	return s.serviceText(key, params)
}

// builtinAIServiceError wraps err with localized text while keeping the cause
// reachable through errors.Is. Safe under s.mu: it only needs a localizer.
func builtinAIServiceError(localizer *i18n.Localizer, err error) error {
	key, params := builtinAIMessageKey(err)
	return serviceErrorFromLocalizer(localizer, key, params, err)
}
