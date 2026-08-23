package redis

import (
	"fmt"
	"sync"

	"GoNavi-Wails/shared/i18n"
)

var (
	redisBackendTextMu        sync.RWMutex
	redisBackendTextLanguage  = i18n.LanguageZhCN
	redisBackendTextLocalizer *i18n.Localizer
)

func SetBackendLanguage(language i18n.Language) {
	normalized, ok := i18n.NormalizeLanguage(string(language))
	if !ok {
		return
	}

	redisBackendTextMu.Lock()
	defer redisBackendTextMu.Unlock()

	redisBackendTextLanguage = normalized
	if redisBackendTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(normalized)
		if err != nil {
			return
		}
		redisBackendTextLocalizer = localizer
		return
	}
	redisBackendTextLocalizer.SetLanguage(normalized)
}

func localizedRedisBackendText(key string, params map[string]any) string {
	redisBackendTextMu.RLock()
	if redisBackendTextLocalizer != nil {
		text := redisBackendTextLocalizer.T(key, params)
		redisBackendTextMu.RUnlock()
		return text
	}
	redisBackendTextMu.RUnlock()

	redisBackendTextMu.Lock()
	defer redisBackendTextMu.Unlock()

	if redisBackendTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(redisBackendTextLanguage)
		if err != nil {
			return key
		}
		redisBackendTextLocalizer = localizer
	}
	return redisBackendTextLocalizer.T(key, params)
}

func localizedRedisBackendError(key string, params map[string]any) error {
	return fmt.Errorf("%s", localizedRedisBackendText(key, params))
}

// localizedRedisBackendErrorWithCause keeps the localized, user-safe message
// while retaining the original error for callers that need to classify it.
// In particular, SSH host-key confirmation errors must remain discoverable by
// the app layer via errors.As instead of being flattened into display text.
func localizedRedisBackendErrorWithCause(key string, params map[string]any, cause error) error {
	if cause == nil {
		return localizedRedisBackendError(key, params)
	}
	return &localizedRedisBackendCauseError{
		message: localizedRedisBackendText(key, params),
		cause:   cause,
	}
}

type localizedRedisBackendCauseError struct {
	message string
	cause   error
}

func (e *localizedRedisBackendCauseError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

func (e *localizedRedisBackendCauseError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}
