package aiservice

import (
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/shared/i18n"
)

func (s *Service) AISetLanguage(language string) {
	normalized, ok := i18n.NormalizeLanguage(language)
	if !ok {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.localizer == nil {
		s.localizer = newServiceLocalizer()
	}
	if s.localizer != nil {
		s.localizer.SetLanguage(normalized)
	}
}

func (s *Service) serviceTextLocked(key string, params map[string]any) string {
	if s.localizer == nil {
		s.localizer = newServiceLocalizer()
	}
	if s.localizer == nil {
		return key
	}
	return s.localizer.T(key, params)
}

func (s *Service) serviceLanguageLocked() i18n.Language {
	if s.localizer == nil {
		return i18n.LanguageEnUS
	}
	return s.localizer.Language()
}

func (s *Service) serviceLocalizerForLanguageLocked() *i18n.Localizer {
	return newServiceLocalizerForLanguage(s.serviceLanguageLocked())
}

func (s *Service) serviceLocalizerForLanguage() *i18n.Localizer {
	return newServiceLocalizerForLanguage(s.serviceLanguage())
}

func (s *Service) serviceLanguage() i18n.Language {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.serviceLanguageLocked()
}

func (s *Service) serviceText(key string, params map[string]any) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.serviceTextLocked(key, params)
}

type localizedAIServiceError struct {
	key     string
	message string
	cause   error
}

func (e localizedAIServiceError) Error() string {
	return e.message
}

func (e localizedAIServiceError) Key() string {
	return e.key
}

func (e localizedAIServiceError) Unwrap() error {
	return e.cause
}

func serviceTextWithDetail(params map[string]any, cause error) map[string]any {
	result := make(map[string]any, len(params)+1)
	for key, value := range params {
		result[key] = value
	}
	if cause != nil {
		result["detail"] = cause.Error()
	}
	return result
}

func serviceErrorFromText(key string, text string, cause error) error {
	if cause == nil {
		return nil
	}
	if text == key {
		text = fmt.Sprintf("%s: %s", key, cause.Error())
	}
	return localizedAIServiceError{key: key, message: text, cause: cause}
}

func serviceTextFromLocalizer(localizer *i18n.Localizer, key string, params map[string]any) string {
	if localizer == nil {
		localizer = newServiceLocalizer()
	}
	if localizer == nil {
		return key
	}
	return localizer.T(key, params)
}

func serviceErrorFromLocalizer(localizer *i18n.Localizer, key string, params map[string]any, cause error) error {
	return serviceErrorFromText(key, serviceTextFromLocalizer(localizer, key, serviceTextWithDetail(params, cause)), cause)
}

func (s *Service) serviceErrorLocked(key string, params map[string]any, cause error) error {
	return serviceErrorFromText(key, s.serviceTextLocked(key, serviceTextWithDetail(params, cause)), cause)
}

func (s *Service) serviceError(key string, params map[string]any, cause error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.serviceErrorLocked(key, params, cause)
}

func localizedAIServiceErrorKey(err error) string {
	var localizedErr localizedAIServiceError
	if errors.As(err, &localizedErr) {
		return localizedErr.key
	}
	return ""
}

func (s *Service) providerTestFailedMessage(detail string) string {
	return s.serviceText("ai_service.backend.error.provider_test_failed", map[string]any{"detail": detail})
}

func (s *Service) localizeProviderHealthCheckRequestError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	switch {
	case strings.HasPrefix(message, "create request failed: "):
		return fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_request_create_failed", map[string]any{
			"detail": strings.TrimPrefix(message, "create request failed: "),
		}))
	case strings.HasPrefix(message, "serialize request failed: "):
		return fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_request_serialize_failed", map[string]any{
			"detail": strings.TrimPrefix(message, "serialize request failed: "),
		}))
	default:
		return err
	}
}

func trimLocalizedModelListRequestCreateDetail(err error) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(err.Error())
	for _, prefix := range []string{"create request failed: "} {
		if strings.HasPrefix(message, prefix) {
			return strings.TrimPrefix(message, prefix)
		}
	}
	return message
}

func localizeModelListRequestCreateError(localizer *i18n.Localizer, err error) error {
	if err == nil {
		return nil
	}
	key := "ai_service.backend.error.models_request_create_failed"
	text := serviceTextFromLocalizer(localizer, key, map[string]any{
		"detail": trimLocalizedModelListRequestCreateDetail(err),
	})
	return serviceErrorFromText(key, text, err)
}

func localizeModelListRequestError(localizer *i18n.Localizer, err error) error {
	return serviceErrorFromLocalizer(localizer, "ai_service.backend.error.models_request_failed", nil, err)
}

func localizeModelListHTTPStatusError(localizer *i18n.Localizer, status int, body []byte) error {
	return fmt.Errorf("%s", serviceTextFromLocalizer(localizer, "ai_service.backend.error.models_http_status_failed", map[string]any{
		"status": status,
		"body":   formatProviderHTTPBody(body),
	}))
}

func localizeModelListParseError(localizer *i18n.Localizer, err error) error {
	return serviceErrorFromLocalizer(localizer, "ai_service.backend.error.models_parse_failed", nil, err)
}
