package webserver

import (
	"errors"
	"html"
	"net/http"
	"strings"

	"GoNavi-Wails/shared/i18n"
)

func resolveWebAuthLanguage(r *http.Request) i18n.Language {
	if r != nil {
		if lang, ok := i18n.NormalizeLanguage(r.URL.Query().Get("lang")); ok {
			return lang
		}
		if cookie, err := r.Cookie(webAuthLanguageCookieName); err == nil {
			if lang, ok := i18n.NormalizeLanguage(cookie.Value); ok {
				return lang
			}
		}
		return i18n.ResolveLanguage("", parseAcceptLanguages(r.Header.Get("Accept-Language")))
	}
	return i18n.LanguageEnUS
}

func parseAcceptLanguages(header string) []string {
	parts := strings.Split(header, ",")
	languages := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(strings.SplitN(part, ";", 2)[0])
		if value != "" {
			languages = append(languages, value)
		}
	}
	return languages
}

func newWebAuthLocalizer(language i18n.Language) *i18n.Localizer {
	if cached, ok := webAuthPageLocalizers.Load(language); ok {
		if localizer, ok := cached.(*i18n.Localizer); ok {
			return localizer
		}
	}
	localizer, err := i18n.NewLocalizer(language)
	if err != nil {
		return nil
	}
	actual, _ := webAuthPageLocalizers.LoadOrStore(language, localizer)
	cached, _ := actual.(*i18n.Localizer)
	return cached
}

func webAuthText(localizer *i18n.Localizer, key string, params map[string]any) string {
	if localizer == nil {
		return key
	}
	return localizer.T(key, params)
}

func webAuthHTML(localizer *i18n.Localizer, key string, params map[string]any) string {
	return html.EscapeString(webAuthText(localizer, key, params))
}

func localizeWebAuthError(localizer *i18n.Localizer, err error) string {
	if err == nil {
		return ""
	}
	switch {
	case errors.Is(err, errWebAuthNotConfigured):
		return webAuthText(localizer, "web_auth.error.setup_required", nil)
	case errors.Is(err, errWebAuthAlreadyConfigured):
		return webAuthText(localizer, "web_auth.error.already_configured", nil)
	case errors.Is(err, errWebAuthSetupExpired):
		return webAuthText(localizer, "web_auth.error.setup_token_expired", nil)
	case errors.Is(err, errWebAuthInvalidSetup):
		return webAuthText(localizer, "web_auth.error.invalid_setup_token", nil)
	case errors.Is(err, errWebAuthInvalidCredentials):
		return webAuthText(localizer, "web_auth.error.invalid_password_or_code", nil)
	case errors.Is(err, errWebAuthRateLimited):
		return webAuthText(localizer, "web_auth.error.too_many_login_attempts", nil)
	case errors.Is(err, errWebAuthPasswordManaged):
		return webAuthText(localizer, "web_auth.error.password_managed_by_environment", nil)
	}

	message := strings.TrimSpace(err.Error())
	switch {
	case strings.HasPrefix(message, "password must be at least "):
		return webAuthText(localizer, "web_auth.error.password_min_length", map[string]any{
			"count": webMinPasswordLength,
		})
	case message == "invalid google authenticator code":
		return webAuthText(localizer, "web_auth.error.invalid_totp_code", nil)
	case message == "password is required":
		return webAuthText(localizer, "web_auth.error.password_required", nil)
	default:
		return message
	}
}

func setWebAuthLanguageCookie(w http.ResponseWriter, r *http.Request, language i18n.Language) {
	if w == nil || language == "" {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     webAuthLanguageCookieName,
		Value:    string(language),
		Path:     "/",
		MaxAge:   365 * 24 * 60 * 60,
		SameSite: http.SameSiteLaxMode,
		Secure:   r != nil && r.TLS != nil,
	})
}
