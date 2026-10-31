package sync

import (
	"sync"

	"GoNavi-Wails/shared/i18n"
)

var (
	syncBackendTextMu        sync.RWMutex
	syncBackendTextLanguage  = i18n.LanguageZhCN
	syncBackendTextLocalizer *i18n.Localizer
)

type syncLocalizedError struct {
	message string
	cause   error
}

func (e syncLocalizedError) Error() string {
	return e.message
}

func (e syncLocalizedError) Unwrap() error {
	return e.cause
}

func SetBackendLanguage(language i18n.Language) {
	normalized, ok := i18n.NormalizeLanguage(string(language))
	if !ok {
		return
	}

	syncBackendTextMu.Lock()
	defer syncBackendTextMu.Unlock()

	syncBackendTextLanguage = normalized
	if syncBackendTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(normalized)
		if err != nil {
			return
		}
		syncBackendTextLocalizer = localizer
		return
	}
	syncBackendTextLocalizer.SetLanguage(normalized)
}

func localizedSyncBackendText(key string, params map[string]any) string {
	syncBackendTextMu.RLock()
	if syncBackendTextLocalizer != nil {
		text := syncBackendTextLocalizer.T(key, params)
		syncBackendTextMu.RUnlock()
		return text
	}
	syncBackendTextMu.RUnlock()

	syncBackendTextMu.Lock()
	defer syncBackendTextMu.Unlock()

	if syncBackendTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(syncBackendTextLanguage)
		if err != nil {
			return key
		}
		syncBackendTextLocalizer = localizer
	}
	return syncBackendTextLocalizer.T(key, params)
}

func syncTextError(key string, params map[string]any) error {
	return syncLocalizedError{message: localizedSyncBackendText(key, params)}
}

func syncWrapError(key string, params map[string]any, cause error) error {
	return syncLocalizedError{
		message: localizedSyncBackendText(key, params),
		cause:   cause,
	}
}

func localizedSyncBackendDetailText(key string, err error) string {
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	return localizedSyncBackendText(key, map[string]any{
		"detail": detail,
	})
}

func syncWrapDetailError(key string, err error) error {
	return syncWrapError(key, map[string]any{
		"detail": err.Error(),
	}, err)
}
