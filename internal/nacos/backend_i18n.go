package nacos

import (
	"fmt"
	"strconv"
	"strings"
	"sync"

	"GoNavi-Wails/shared/i18n"
)

var (
	nacosBackendTextMu        sync.RWMutex
	nacosBackendTextLanguage  = i18n.LanguageZhCN
	nacosBackendTextLocalizer *i18n.Localizer
)

// SetBackendLanguage updates backend i18n language for this package.
func SetBackendLanguage(language i18n.Language) {
	normalized, ok := i18n.NormalizeLanguage(string(language))
	if !ok {
		return
	}

	nacosBackendTextMu.Lock()
	defer nacosBackendTextMu.Unlock()

	nacosBackendTextLanguage = normalized
	if nacosBackendTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(normalized)
		if err != nil {
			return
		}
		nacosBackendTextLocalizer = localizer
		return
	}
	nacosBackendTextLocalizer.SetLanguage(normalized)
}

func localizedNacosBackendText(key string, params map[string]any) string {
	params = sanitizeNacosBackendDiagnosticParams(params)

	nacosBackendTextMu.RLock()
	if nacosBackendTextLocalizer != nil {
		text := nacosBackendTextLocalizer.T(key, params)
		nacosBackendTextMu.RUnlock()
		return text
	}
	nacosBackendTextMu.RUnlock()

	nacosBackendTextMu.Lock()
	defer nacosBackendTextMu.Unlock()

	if nacosBackendTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(nacosBackendTextLanguage)
		if err != nil {
			return key
		}
		nacosBackendTextLocalizer = localizer
	}
	return nacosBackendTextLocalizer.T(key, params)
}

func sanitizeNacosBackendDiagnosticParams(params map[string]any) map[string]any {
	if len(params) == 0 {
		return params
	}
	sanitized := make(map[string]any, len(params))
	for key, value := range params {
		sanitized[key] = value
	}
	for _, key := range []string{"body", "detail", "message"} {
		if text, ok := sanitized[key].(string); ok {
			sanitized[key] = truncateForError(text)
		}
	}
	return sanitized
}

func localizedNacosBackendError(key string, params map[string]any) error {
	switch key {
	case "nacos.backend.error.http_status":
		status, err := strconv.Atoi(strings.TrimSpace(fmt.Sprint(params["status"])))
		if err == nil && status >= 100 && status <= 599 {
			return &nacosHTTPError{
				status: status,
				body:   truncateForError(fmt.Sprint(params["body"])),
			}
		}
	case "nacos.backend.error.config_not_found":
		return &nacosConfigNotFoundError{
			group:  strings.TrimSpace(fmt.Sprint(params["group"])),
			dataID: strings.TrimSpace(fmt.Sprint(params["dataId"])),
		}
	}
	return fmt.Errorf("%s", localizedNacosBackendText(key, params))
}

// localizedNacosBackendErrorWithCause keeps display text localized without
// discarding an underlying error that the app layer needs to classify.
func localizedNacosBackendErrorWithCause(key string, params map[string]any, cause error) error {
	if cause == nil {
		return localizedNacosBackendError(key, params)
	}
	return &localizedNacosBackendCauseError{
		message: localizedNacosBackendText(key, params),
		cause:   cause,
	}
}

type localizedNacosBackendCauseError struct {
	message string
	cause   error
}

func (e *localizedNacosBackendCauseError) Error() string {
	if e == nil {
		return ""
	}
	return e.message
}

func (e *localizedNacosBackendCauseError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}
