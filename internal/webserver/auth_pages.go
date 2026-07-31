package webserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/shared/i18n"
)

const (
	webAuthLanguageCookieName = "gonavi_web_lang"
	webAuthFrontendStorageKey = "lite-db-storage"
)

var webAuthPageLocalizers sync.Map

type webSetupCompleteRequest struct {
	SetupToken           string `json:"setupToken"`
	Password             string `json:"password"`
	ConfirmPassword      string `json:"confirmPassword"`
	Code                 string `json:"code"`
	EnableTOTP           bool   `json:"enableTotp"`
	SessionIdleMinutes   int    `json:"sessionIdleMinutes"`
	SessionAbsoluteHours int    `json:"sessionAbsoluteHours"`
	SessionRememberDays  int    `json:"sessionRememberDays"`
}

type webLoginRequest struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

type webAuthPasswordChangeRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
	ConfirmPassword string `json:"confirmPassword"`
	Code            string `json:"code"`
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, webAuthText(newWebAuthLocalizer(resolveWebAuthLanguage(r)), "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	sessionID, _ := readSessionCookie(r)
	s.writeJSON(w, http.StatusOK, s.auth.Status(sessionID))
}

func (s *Server) handleAuthSettings(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	if r.Method != http.MethodGet {
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	settings, err := s.auth.Settings()
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errWebAuthNotConfigured) {
			status = http.StatusPreconditionFailed
		}
		s.writeAuthJSONError(w, status, localizeWebAuthError(localizer, err), 0)
		return
	}
	s.writeJSON(w, http.StatusOK, settings)
}

func (s *Server) handleSetupBootstrap(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	if r.Method != http.MethodPost {
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	payload, err := s.auth.BeginSetup(r.Host)
	if err != nil {
		if err == errWebAuthAlreadyConfigured {
			s.writeAuthJSONError(w, http.StatusConflict, webAuthText(localizer, "web_auth.error.already_configured", nil), 0)
			return
		}
		s.writeAuthJSONError(w, http.StatusInternalServerError, localizeWebAuthError(localizer, err), 0)
		return
	}
	s.writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleSetupComplete(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	if r.Method != http.MethodPost {
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()

	var request webSetupCompleteRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.writeAuthJSONError(w, http.StatusBadRequest, webAuthText(localizer, "web_auth.error.invalid_setup_payload", nil), 0)
		return
	}
	if strings.TrimSpace(request.Password) != strings.TrimSpace(request.ConfirmPassword) {
		s.writeAuthJSONError(w, http.StatusBadRequest, webAuthText(localizer, "web_auth.error.password_confirmation_mismatch", nil), 0)
		return
	}
	cfg, sessionID, err := s.auth.CompleteSetup(
		request.SetupToken,
		request.Password,
		request.Code,
		request.EnableTOTP,
		request.SessionIdleMinutes,
		request.SessionAbsoluteHours,
		request.SessionRememberDays,
	)
	if err != nil {
		status := http.StatusBadRequest
		switch err {
		case errWebAuthAlreadyConfigured:
			status = http.StatusConflict
		case errWebAuthInvalidSetup, errWebAuthSetupExpired:
			status = http.StatusUnauthorized
		}
		s.writeAuthJSONError(w, status, localizeWebAuthError(localizer, err), 0)
		return
	}
	setSessionCookie(w, r, sessionID, cfg, s.auth.now())
	s.writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	if r.Method != http.MethodPost {
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()

	var request webLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.writeAuthJSONError(w, http.StatusBadRequest, webAuthText(localizer, "web_auth.error.invalid_login_payload", nil), 0)
		return
	}
	cfg, sessionID, usedRecoveryCode, retryAfter, err := s.auth.Login(request.Password, request.Code, clientIP(r))
	if err != nil {
		switch err {
		case errWebAuthNotConfigured:
			s.writeAuthJSONError(w, http.StatusPreconditionFailed, webAuthText(localizer, "web_auth.error.setup_required", nil), 0)
			return
		case errWebAuthRateLimited:
			s.writeAuthJSONError(w, http.StatusTooManyRequests, webAuthText(localizer, "web_auth.error.too_many_login_attempts", nil), retryAfter)
			return
		default:
			s.writeAuthJSONError(w, http.StatusUnauthorized, webAuthText(localizer, "web_auth.error.invalid_password_or_code", nil), retryAfter)
			return
		}
	}
	setSessionCookie(w, r, sessionID, cfg, s.auth.now())
	s.writeJSON(w, http.StatusOK, map[string]any{
		"success":          true,
		"usedRecoveryCode": usedRecoveryCode,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, webAuthText(newWebAuthLocalizer(resolveWebAuthLanguage(r)), "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	if sessionID, ok := readSessionCookie(r); ok {
		s.auth.Logout(sessionID)
	}
	clearSessionCookie(w, r)
	if r.Method == http.MethodGet {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) handleAuthPasswordChange(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	if r.Method != http.MethodPost {
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()

	var request webAuthPasswordChangeRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.writeAuthJSONError(w, http.StatusBadRequest, webAuthText(localizer, "web_auth.error.invalid_setup_payload", nil), 0)
		return
	}
	if strings.TrimSpace(request.NewPassword) != strings.TrimSpace(request.ConfirmPassword) {
		s.writeAuthJSONError(w, http.StatusBadRequest, webAuthText(localizer, "web_auth.error.password_confirmation_mismatch", nil), 0)
		return
	}

	cfg, sessionID, usedRecoveryCode, err := s.auth.ChangePassword(request.CurrentPassword, request.Code, request.NewPassword)
	if err != nil {
		status := http.StatusBadRequest
		switch {
		case errors.Is(err, errWebAuthNotConfigured):
			status = http.StatusPreconditionFailed
		case errors.Is(err, errWebAuthInvalidCredentials):
			status = http.StatusUnauthorized
		case errors.Is(err, errWebAuthPasswordManaged):
			status = http.StatusConflict
		}
		s.writeAuthJSONError(w, status, localizeWebAuthError(localizer, err), 0)
		return
	}

	setSessionCookie(w, r, sessionID, cfg, s.auth.now())
	s.writeJSON(w, http.StatusOK, map[string]any{
		"success":          true,
		"usedRecoveryCode": usedRecoveryCode,
		"settings":         buildWebAuthSettingsSummary(cfg, s.auth.passwordManagedByEnvironment),
	})
}

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	language := resolveWebAuthLanguage(r)
	localizer := newWebAuthLocalizer(language)
	setWebAuthLanguageCookie(w, r, language)
	sessionID, _ := readSessionCookie(r)
	status := s.auth.Status(sessionID)
	if status.Configured && status.Authenticated {
		http.Redirect(w, r, resolvePostAuthRedirect(r), http.StatusSeeOther)
		return
	}
	if !status.Configured {
		http.Redirect(w, r, buildAuthRedirectURL("/setup", r.URL.RequestURI()), http.StatusSeeOther)
		return
	}
	s.serveStaticPage(w, r, renderAuthPage(
		language,
		webAuthText(localizer, "web_auth.page.login.title", nil),
		webAuthText(localizer, "web_auth.page.login.subtitle", nil),
		renderLoginBody(localizer),
		renderLoginScript(localizer),
	))
}

func (s *Server) handleSetupPage(w http.ResponseWriter, r *http.Request) {
	language := resolveWebAuthLanguage(r)
	localizer := newWebAuthLocalizer(language)
	setWebAuthLanguageCookie(w, r, language)
	sessionID, _ := readSessionCookie(r)
	status := s.auth.Status(sessionID)
	if status.Configured && status.Authenticated {
		http.Redirect(w, r, resolvePostAuthRedirect(r), http.StatusSeeOther)
		return
	}
	if status.Configured {
		http.Redirect(w, r, buildAuthRedirectURL("/login", r.URL.RequestURI()), http.StatusSeeOther)
		return
	}
	s.serveStaticPage(w, r, renderAuthPage(
		language,
		webAuthText(localizer, "web_auth.page.setup.title", nil),
		webAuthText(localizer, "web_auth.page.setup.subtitle", nil),
		renderSetupBody(localizer),
		renderSetupScript(localizer),
	))
}

func (s *Server) requireWebAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessionID, ok := readSessionCookie(r)
		status := s.auth.Status(sessionID)
		if !status.Configured {
			clearSessionCookie(w, r)
			if wantsHTMLResponse(r) {
				http.Redirect(w, r, buildAuthRedirectURL("/setup", r.URL.RequestURI()), http.StatusSeeOther)
				return
			}
			s.writeAuthJSONError(w, http.StatusPreconditionFailed, webAuthText(newWebAuthLocalizer(resolveWebAuthLanguage(r)), "web_auth.error.setup_required", nil), 0)
			return
		}
		if !ok || !status.Authenticated {
			clearSessionCookie(w, r)
			if wantsHTMLResponse(r) {
				http.Redirect(w, r, buildAuthRedirectURL("/login", r.URL.RequestURI()), http.StatusSeeOther)
				return
			}
			s.writeAuthJSONError(w, http.StatusUnauthorized, webAuthText(newWebAuthLocalizer(resolveWebAuthLanguage(r)), "web_auth.error.auth_required", nil), 0)
			return
		}
		next.ServeHTTP(w, r)
	})
}

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

func wantsHTMLResponse(r *http.Request) bool {
	if r == nil || r.Method != http.MethodGet {
		return false
	}
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html")
}

// isSafeLocalRedirect 判断 next 是否为可安全跳转的站内路径。
//
// 除了 "//host"（协议相对 URL）之外还必须拒绝 "/\host"：WHATWG URL 解析器对 http/https
// 这类 special scheme 把反斜杠等价于斜杠，因此 "/\evil.com" 会被浏览器解析成 "//evil.com"
// 而变成跨站跳转，仅检查 "//" 前缀挡不住这个变体。
func isSafeLocalRedirect(next string) bool {
	if !strings.HasPrefix(next, "/") {
		return false
	}
	if strings.HasPrefix(next, "//") || strings.HasPrefix(next, `/\`) {
		return false
	}
	return true
}

func resolvePostAuthRedirect(r *http.Request) string {
	if r == nil {
		return "/"
	}
	next := strings.TrimSpace(r.URL.Query().Get("next"))
	if next == "" {
		return "/"
	}
	if !isSafeLocalRedirect(next) {
		return "/"
	}
	return next
}

func buildAuthRedirectURL(target string, next string) string {
	values := url.Values{}
	normalizedNext := strings.TrimSpace(next)
	if normalizedNext != "" && isSafeLocalRedirect(normalizedNext) {
		values.Set("next", normalizedNext)
	}
	if encoded := values.Encode(); encoded != "" {
		return target + "?" + encoded
	}
	return target
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (s *Server) writeAuthJSONError(w http.ResponseWriter, status int, message string, retryAfter time.Duration) {
	response := map[string]any{
		"error": strings.TrimSpace(message),
	}
	if retryAfter > 0 {
		seconds := int(retryAfter.Seconds())
		if seconds <= 0 {
			seconds = 1
		}
		w.Header().Set("Retry-After", fmt.Sprintf("%d", seconds))
		response["retryAfterSeconds"] = seconds
	}
	s.writeJSON(w, status, response)
}

func (s *Server) serveStaticPage(w http.ResponseWriter, r *http.Request, payload string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, strings.NewReader(payload))
}

func renderAuthPage(language i18n.Language, title string, subtitle string, body string, script string) string {
	return `<!doctype html>
<html lang="` + html.EscapeString(string(language)) + `">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>` + html.EscapeString(title) + `</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #141618;
      --panel: #1b1f24;
      --panel-header: #20252b;
      --panel-border: rgba(229, 231, 235, 0.1);
      --panel-rule: rgba(229, 231, 235, 0.08);
      --text: #f3f4f6;
      --muted: #a4adb6;
      --accent: #34d399;
      --accent-strong: #10b981;
      --accent-soft: rgba(52, 211, 153, 0.16);
      --danger: #f87171;
      --field-bg: rgba(255, 255, 255, 0.03);
      --field-border: rgba(229, 231, 235, 0.1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .shell {
      width: min(720px, 100%);
      border: 1px solid var(--panel-border);
      background: var(--panel);
      border-radius: 16px;
      box-shadow: 0 28px 70px rgba(0, 0, 0, 0.34);
      overflow: hidden;
    }
    .header {
      padding: 28px 28px 14px;
      border-bottom: 1px solid var(--panel-rule);
      background: var(--panel-header);
    }
    .header h1 {
      margin: 0 0 10px;
      font-size: 24px;
      line-height: 1.2;
    }
    .header p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
    }
    .body {
      padding: 24px 28px 28px;
      display: grid;
      gap: 20px;
    }
    .grid {
      display: grid;
      gap: 14px;
    }
    .page-form {
      display: grid;
      gap: 18px;
    }
    .grid.two {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .intro {
      padding-bottom: 18px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.7;
    }
    label {
      display: grid;
      gap: 8px;
      font-size: 13px;
      color: var(--muted);
    }
    input, textarea, button {
      font: inherit;
    }
    input, textarea {
      width: 100%;
      border: 1px solid var(--field-border);
      background: var(--field-bg);
      border-radius: 10px;
      color: var(--text);
      padding: 12px 14px;
      outline: none;
    }
    textarea {
      min-height: 96px;
      resize: vertical;
    }
    input:focus, textarea:focus {
      border-color: rgba(52, 211, 153, 0.56);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    button {
      border: none;
      border-radius: 10px;
      padding: 12px 16px;
      background: var(--accent);
      color: #06281f;
      font-weight: 700;
      cursor: pointer;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
    }
    button.secondary {
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }
    .inline-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .section {
      display: grid;
      gap: 14px;
      padding-top: 20px;
      border-top: 1px solid var(--panel-rule);
      background: transparent;
    }
    .section h2 {
      margin: 0;
      font-size: 16px;
    }
    .section.lead {
      padding-top: 0;
      border-top: none;
    }
    .wizard-nav {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .wizard-step {
      display: grid;
      gap: 12px;
      padding: 14px 16px;
      text-align: left;
      border: 1px solid var(--panel-rule);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      color: var(--text);
      box-shadow: none;
    }
    .wizard-step:hover:not(:disabled) {
      border-color: rgba(52, 211, 153, 0.26);
      background: rgba(255, 255, 255, 0.04);
    }
    .wizard-step:disabled {
      cursor: default;
      opacity: 0.82;
    }
    .wizard-step.is-active {
      border-color: rgba(52, 211, 153, 0.42);
      background: rgba(52, 211, 153, 0.1);
    }
    .wizard-step.is-completed:not(.is-active) {
      border-color: rgba(52, 211, 153, 0.22);
      background: rgba(255, 255, 255, 0.035);
    }
    .wizard-step-head {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .wizard-step-index {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .wizard-step.is-active .wizard-step-index {
      color: var(--text);
      border-color: rgba(52, 211, 153, 0.46);
      background: rgba(52, 211, 153, 0.18);
    }
    .wizard-step.is-completed .wizard-step-index {
      color: #06281f;
      border-color: transparent;
      background: var(--accent);
    }
    .wizard-step-copy {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .wizard-step-title {
      color: var(--text);
      font-size: 14px;
      font-weight: 700;
      line-height: 1.4;
    }
    .wizard-step-description {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .wizard-step.is-active .wizard-step-description {
      color: rgba(243, 244, 246, 0.78);
    }
    .wizard-panel {
      padding-top: 0;
      border-top: none;
    }
    .wizard-panel[hidden] {
      display: none;
    }
    .step-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-top: 18px;
      border-top: 1px solid var(--panel-rule);
    }
    .step-action-main {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-left: auto;
    }
    .step-note {
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .section-copy {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.7;
    }
    .qr-shell {
      display: grid;
      grid-template-columns: minmax(180px, 232px) minmax(0, 1fr);
      gap: 18px;
      align-items: center;
    }
    .qr-shell img {
      width: min(232px, 100%);
      aspect-ratio: 1;
      object-fit: contain;
      border-radius: 10px;
      background: #ffffff;
      padding: 12px;
      justify-self: center;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
    }
    .qr-copy {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .muted {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .error {
      display: none;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(248, 113, 113, 0.28);
      background: rgba(127, 29, 29, 0.22);
      color: #fecaca;
      font-size: 13px;
      line-height: 1.5;
    }
    .info-list {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.7;
    }
    .code-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .code-item {
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
      padding: 10px 12px;
      font-family: Consolas, "SFMono-Regular", monospace;
      letter-spacing: 0;
    }
    .checkbox {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      font-size: 14px;
    }
    .checkbox input {
      width: 16px;
      height: 16px;
      margin: 0;
      padding: 0;
      accent-color: var(--accent);
    }
    .footer-note {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.6;
    }
    @media (max-width: 760px) {
      body { padding: 16px; }
      .grid.two, .code-list, .qr-shell, .wizard-nav { grid-template-columns: 1fr; }
      .step-actions { align-items: stretch; flex-direction: column-reverse; }
      .step-action-main { width: 100%; margin-left: 0; }
      .step-action-main button, .step-actions > button { width: 100%; }
      .header, .body { padding-left: 18px; padding-right: 18px; }
      .qr-shell img { width: min(220px, 100%); }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="header">
      <h1>` + html.EscapeString(title) + `</h1>
      <p>` + html.EscapeString(subtitle) + `</p>
    </header>
    <section class="body">` + body + `</section>
  </main>
  <script>` + renderAuthBootstrapScript(language) + script + `</script>
</body>
</html>`
}

func renderAuthBootstrapScript(language i18n.Language) string {
	return `
const __gonaviWebAuthPage = ` + mustJSON(map[string]string{
		"language":   string(language),
		"cookieName": webAuthLanguageCookieName,
		"storageKey": webAuthFrontendStorageKey,
	}) + `;

(function syncAuthPageLanguage() {
  const normalizeLanguage = (value) => {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/_/g, '-').toLowerCase();
    if (!normalized) return null;
    if (normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-mo') return 'zh-TW';
    if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-sg') return 'zh-CN';
    if (normalized === 'en-us' || normalized.startsWith('en-')) return 'en-US';
    if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja-JP';
    if (normalized === 'de' || normalized.startsWith('de-')) return 'de-DE';
    if (normalized === 'ru' || normalized.startsWith('ru-')) return 'ru-RU';
    return null;
  };

  const resolveStoredLanguage = () => {
    try {
      if (!window.localStorage) return null;
      const payload = window.localStorage.getItem(__gonaviWebAuthPage.storageKey);
      if (!payload) return null;
      const parsed = JSON.parse(payload);
      const state = parsed && typeof parsed === 'object' && parsed.state && typeof parsed.state === 'object'
        ? parsed.state
        : parsed;
      const preference = state && typeof state === 'object' ? state.languagePreference : null;
      if (preference === 'system') {
        const systemLanguages = Array.isArray(navigator.languages) && navigator.languages.length > 0
          ? navigator.languages
          : [navigator.language];
        for (const candidate of systemLanguages) {
          const resolved = normalizeLanguage(candidate);
          if (resolved) return resolved;
        }
        return null;
      }
      return normalizeLanguage(preference);
    } catch (_) {
      return null;
    }
  };

  const syncCookie = (language) => {
    document.cookie = __gonaviWebAuthPage.cookieName + '=' + encodeURIComponent(language) + '; Path=/; Max-Age=31536000; SameSite=Lax';
  };

  const storedLanguage = resolveStoredLanguage();
  if (!storedLanguage || storedLanguage === __gonaviWebAuthPage.language) {
    syncCookie(__gonaviWebAuthPage.language);
    return;
  }

  syncCookie(storedLanguage);
  const url = new URL(window.location.href);
  if (url.searchParams.get('lang') !== storedLanguage) {
    url.searchParams.set('lang', storedLanguage);
    window.location.replace(url.toString());
  }
})();
`
}

func renderLoginBody(localizer *i18n.Localizer) string {
	return `
<div id="error" class="error"></div>
<div class="section lead">
  <h2>` + webAuthHTML(localizer, "web_auth.page.login.heading", nil) + `</h2>
  <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.login.description", nil) + `</div>
  <form id="login-form" class="grid">
    <label>
      ` + webAuthHTML(localizer, "web_auth.page.login.password_label", nil) + `
      <input id="password" type="password" autocomplete="current-password" placeholder="` + webAuthHTML(localizer, "web_auth.page.login.password_placeholder", nil) + `">
    </label>
    <label id="code-wrap">
      ` + webAuthHTML(localizer, "web_auth.page.login.code_label", nil) + `
      <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="` + webAuthHTML(localizer, "web_auth.page.login.code_placeholder", nil) + `">
    </label>
    <button id="submit" type="submit">` + webAuthHTML(localizer, "web_auth.page.login.submit", nil) + `</button>
  </form>
</div>
<div class="section">
  <h2>` + webAuthHTML(localizer, "web_auth.page.login.security_title", nil) + `</h2>
  <ul class="info-list">
    <li>` + webAuthHTML(localizer, "web_auth.page.login.security_cookie", nil) + `</li>
    <li>` + webAuthHTML(localizer, "web_auth.page.login.security_recovery", nil) + `</li>
    <li>` + webAuthHTML(localizer, "web_auth.page.login.security_rate_limit", nil) + `</li>
  </ul>
</div>`
}

// authSafeNextTargetScript 是登录页与初始化页共用的 next 参数归一化脚本。
//
// 这两个页面都在客户端用 location.search 重新读取原始 next，因此服务端
// resolvePostAuthRedirect / buildAuthRedirectURL 的过滤对它们完全无效，必须在客户端再做一次。
// 未归一化时 ?next=javascript:... 会经 window.location.replace(nextTarget) 在页面自身源内执行
// （HTML 规范只阻止跨源的 javascript: 导航，同文档自导航是允许的，且返回 undefined 时页面不跳转，
// 更难察觉），进而可携带会话 Cookie 调用 /__gonavi/api/invoke 读取全部已保存连接并执行任意 SQL。
//
// 用 URL 解析器判定同源而非字符串前缀：javascript:/data: 这类 URL 的 origin 为 "null"，
// 与页面 origin 不等；同时一并挡掉 //evil.com、/\evil.com、https://evil.com。
const authSafeNextTargetScript = `
function safeNextTarget(raw) {
  try {
    const parsed = new URL(String(raw || '/'), window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return '/';
    }
    return parsed.pathname + parsed.search + parsed.hash;
  } catch (err) {
    return '/';
  }
}`

func renderLoginScript(localizer *i18n.Localizer) string {
	return `
const i18n = ` + mustJSON(map[string]string{
		"loginFailed":      webAuthText(localizer, "web_auth.error.login_failed", nil),
		"loadStatusFailed": webAuthText(localizer, "web_auth.error.load_status_failed", nil),
		"retryAfter":       webAuthText(localizer, "web_auth.error.retry_after_seconds", nil),
	}) + `;
const errorEl = document.getElementById('error');
const formEl = document.getElementById('login-form');
const submitEl = document.getElementById('submit');
const codeWrapEl = document.getElementById('code-wrap');
` + authSafeNextTargetScript + `
const nextTarget = safeNextTarget(new URLSearchParams(window.location.search).get('next'));

function showError(message) {
  errorEl.textContent = message || i18n.loginFailed;
  errorEl.style.display = 'block';
}

function clearError() {
  errorEl.textContent = '';
  errorEl.style.display = 'none';
}

async function loadStatus() {
  const response = await fetch('` + internalRoutePrefix + `/auth/status', {
    credentials: 'same-origin',
    cache: 'no-store'
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    showError(payload.error || i18n.loadStatusFailed);
    return;
  }
  if (!payload.configured) {
    window.location.replace('/setup?next=' + encodeURIComponent(nextTarget));
    return;
  }
  codeWrapEl.hidden = payload.totpEnabled !== true;
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  submitEl.disabled = true;
  try {
    const response = await fetch('` + internalRoutePrefix + `/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        password: document.getElementById('password').value || '',
        code: document.getElementById('code').value || ''
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const retryAfter = Number(payload.retryAfterSeconds || 0);
      const suffix = retryAfter > 0 ? i18n.retryAfter.replace('{{seconds}}', String(retryAfter)) : '';
      showError((payload.error || i18n.loginFailed) + suffix);
      submitEl.disabled = false;
      return;
    }
    window.location.replace(nextTarget);
  } catch (_) {
    showError(i18n.loginFailed);
    submitEl.disabled = false;
  }
});

void loadStatus();`
}

func renderSetupBody(localizer *i18n.Localizer) string {
	return `
<div id="error" class="error"></div>
<div class="intro">` + webAuthHTML(localizer, "web_auth.page.setup.intro", nil) + `</div>
<div class="wizard-nav" id="setup-steps">
  <button type="button" class="wizard-step is-active" data-step-target="0" aria-current="step">
    <span class="wizard-step-head">
      <span class="wizard-step-index">1</span>
      <span class="wizard-step-copy">
        <span class="wizard-step-title">` + webAuthHTML(localizer, "web_auth.page.setup.step_admin_title", nil) + `</span>
        <span class="wizard-step-description">` + webAuthHTML(localizer, "web_auth.page.setup.step_admin_description", nil) + `</span>
      </span>
    </span>
  </button>
  <button type="button" class="wizard-step" data-step-target="1" disabled>
    <span class="wizard-step-head">
      <span class="wizard-step-index">2</span>
      <span class="wizard-step-copy">
        <span class="wizard-step-title">` + webAuthHTML(localizer, "web_auth.page.setup.step_totp_title", nil) + `</span>
        <span class="wizard-step-description">` + webAuthHTML(localizer, "web_auth.page.setup.step_totp_description", nil) + `</span>
      </span>
    </span>
  </button>
  <button type="button" class="wizard-step" data-step-target="2" disabled>
    <span class="wizard-step-head">
      <span class="wizard-step-index">3</span>
      <span class="wizard-step-copy">
        <span class="wizard-step-title">` + webAuthHTML(localizer, "web_auth.page.setup.step_session_title", nil) + `</span>
        <span class="wizard-step-description">` + webAuthHTML(localizer, "web_auth.page.setup.step_session_description", nil) + `</span>
      </span>
    </span>
  </button>
</div>
<form id="setup-form" class="page-form">
  <div class="section lead wizard-panel" data-step-panel="0">
    <h2>` + webAuthHTML(localizer, "web_auth.page.setup.admin_title", nil) + `</h2>
    <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.setup.step_admin_hint", nil) + `</div>
    <label>
      ` + webAuthHTML(localizer, "web_auth.page.setup.password_label", nil) + `
      <input id="password" type="password" autocomplete="new-password" placeholder="` + webAuthHTML(localizer, "web_auth.page.setup.password_placeholder", nil) + `">
    </label>
    <label>
      ` + webAuthHTML(localizer, "web_auth.page.setup.confirm_label", nil) + `
      <input id="confirm-password" type="password" autocomplete="new-password" placeholder="` + webAuthHTML(localizer, "web_auth.page.setup.confirm_placeholder", nil) + `">
    </label>
    <label class="checkbox">
      <input id="enable-totp" type="checkbox" checked>
      ` + webAuthHTML(localizer, "web_auth.page.setup.enable_totp", nil) + `
    </label>
  </div>
  <div class="section wizard-panel" data-step-panel="1" hidden>
    <h2>` + webAuthHTML(localizer, "web_auth.page.setup.totp_title", nil) + `</h2>
    <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.setup.step_totp_hint", nil) + `</div>
    <div id="totp-config" class="grid">
      <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.setup.totp_description", nil) + `</div>
      <div class="qr-shell">
        <img id="totp-qr-code" alt="` + webAuthHTML(localizer, "web_auth.page.setup.qr_alt", nil) + `">
        <div class="qr-copy">
          <div class="muted">` + webAuthHTML(localizer, "web_auth.page.setup.totp_clients", nil) + `</div>
          <div class="muted">` + webAuthHTML(localizer, "web_auth.page.setup.totp_naming", nil) + `</div>
        </div>
      </div>
      <div class="grid two">
        <label>
          ` + webAuthHTML(localizer, "web_auth.page.setup.issuer_label", nil) + `
          <input id="issuer" type="text" readonly>
        </label>
        <label>
          ` + webAuthHTML(localizer, "web_auth.page.setup.account_label", nil) + `
          <input id="account-name" type="text" readonly>
        </label>
      </div>
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.secret_label", nil) + `
        <input id="secret" type="text" readonly>
      </label>
      <div class="inline-actions">
        <button id="copy-secret" type="button" class="secondary">` + webAuthHTML(localizer, "web_auth.page.setup.copy_secret", nil) + `</button>
        <button id="copy-uri" type="button" class="secondary">` + webAuthHTML(localizer, "web_auth.page.setup.copy_uri", nil) + `</button>
      </div>
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.otpauth_label", nil) + `
        <textarea id="otpauth-url" readonly></textarea>
      </label>
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.first_code_label", nil) + `
        <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="` + webAuthHTML(localizer, "web_auth.page.setup.first_code_placeholder", nil) + `">
      </label>
      <div>
        <div class="muted">` + webAuthHTML(localizer, "web_auth.page.setup.recovery_intro", nil) + `</div>
        <ul id="recovery-codes" class="code-list"></ul>
      </div>
    </div>
    <div id="totp-disabled-note" class="step-note" hidden>` + webAuthHTML(localizer, "web_auth.page.setup.totp_disabled_note", nil) + `</div>
  </div>
  <div class="section wizard-panel" data-step-panel="2" hidden>
    <h2>` + webAuthHTML(localizer, "web_auth.page.setup.session_title", nil) + `</h2>
    <div class="section-copy">` + webAuthHTML(localizer, "web_auth.page.setup.step_session_hint", nil) + `</div>
    <div class="grid two">
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.idle_label", nil) + `
        <input id="idle-minutes" type="number" min="5" max="1440" value="30">
      </label>
      <label>
        ` + webAuthHTML(localizer, "web_auth.page.setup.absolute_label", nil) + `
        <input id="absolute-hours" type="number" min="1" max="720" value="168">
      </label>
    </div>
    <label>
      ` + webAuthHTML(localizer, "web_auth.page.setup.remember_label", nil) + `
      <input id="remember-days" type="number" min="1" max="30" value="7">
    </label>
    <div class="footer-note">` + webAuthHTML(localizer, "web_auth.page.setup.footer_note", nil) + `</div>
  </div>
  <div class="step-actions">
    <button id="back-step" type="button" class="secondary" hidden>` + webAuthHTML(localizer, "web_auth.page.setup.back", nil) + `</button>
    <div class="step-action-main">
      <button id="next-step" type="button">` + webAuthHTML(localizer, "web_auth.page.setup.next", nil) + `</button>
      <button id="submit" type="submit" hidden>` + webAuthHTML(localizer, "web_auth.page.setup.submit", nil) + `</button>
    </div>
  </div>
</form>`
}

func renderSetupScript(localizer *i18n.Localizer) string {
	return `
const i18n = ` + mustJSON(map[string]string{
		"initFailed":              webAuthText(localizer, "web_auth.error.init_failed", nil),
		"initInfoFailed":          webAuthText(localizer, "web_auth.error.init_info_failed", nil),
		"setupInfoExpired":        webAuthText(localizer, "web_auth.error.setup_info_expired", nil),
		"copyManual":              webAuthText(localizer, "web_auth.error.copy_manual", nil),
		"passwordRequired":        webAuthText(localizer, "web_auth.error.password_required", nil),
		"passwordTooShort":        webAuthText(localizer, "web_auth.error.password_min_length", map[string]any{"count": webMinPasswordLength}),
		"passwordConfirmMismatch": webAuthText(localizer, "web_auth.error.password_confirmation_mismatch", nil),
		"totpCodeRequired":        webAuthText(localizer, "web_auth.error.totp_code_required", nil),
	}) + `;
const errorEl = document.getElementById('error');
const setupFormEl = document.getElementById('setup-form');
const passwordEl = document.getElementById('password');
const confirmPasswordEl = document.getElementById('confirm-password');
const codeEl = document.getElementById('code');
const submitEl = document.getElementById('submit');
const nextStepEl = document.getElementById('next-step');
const backStepEl = document.getElementById('back-step');
const enableTotpEl = document.getElementById('enable-totp');
const totpConfigEl = document.getElementById('totp-config');
const totpDisabledNoteEl = document.getElementById('totp-disabled-note');
const stepButtons = Array.from(document.querySelectorAll('[data-step-target]'));
const stepPanels = Array.from(document.querySelectorAll('[data-step-panel]'));
` + authSafeNextTargetScript + `
const nextTarget = safeNextTarget(new URLSearchParams(window.location.search).get('next'));
let bootstrapState = null;
let currentStep = 0;
const lastStepIndex = stepPanels.length - 1;

function showError(message) {
  errorEl.textContent = message || i18n.initFailed;
  errorEl.style.display = 'block';
}

function clearError() {
  errorEl.textContent = '';
  errorEl.style.display = 'none';
}

function toggleTotpSection() {
  const enabled = enableTotpEl.checked;
  totpConfigEl.hidden = !enabled;
  totpDisabledNoteEl.hidden = enabled;
}

function getWizardPath() {
  return enableTotpEl.checked ? [0, 1, 2] : [0, 2];
}

function normalizeCurrentStep() {
  const path = getWizardPath();
  if (path.includes(currentStep)) {
    return;
  }
  currentStep = path.find((step) => step > currentStep) ?? path[path.length - 1];
}

function getPathIndex(step) {
  return getWizardPath().indexOf(step);
}

function getAdjacentStep(step, direction) {
  const path = getWizardPath();
  const currentIndex = path.indexOf(step);
  if (currentIndex === -1) {
    return path[0];
  }
  const targetIndex = Math.max(0, Math.min(path.length - 1, currentIndex + direction));
  return path[targetIndex];
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  window.prompt(i18n.copyManual, text);
}

function updateWizard() {
  normalizeCurrentStep();
  const path = getWizardPath();
  const currentPathIndex = getPathIndex(currentStep);
  const lastActiveStep = path[path.length - 1];
  let visibleStepIndex = 1;
  stepPanels.forEach((panel) => {
    const step = Number(panel.dataset.stepPanel || 0);
    panel.hidden = step !== currentStep;
  });
  stepButtons.forEach((button) => {
    const step = Number(button.dataset.stepTarget || 0);
    const inPath = path.includes(step);
    const stepIndexEl = button.querySelector('.wizard-step-index');
    button.hidden = !inPath;
    if (!inPath) {
      button.disabled = true;
      button.classList.remove('is-active', 'is-completed');
      button.removeAttribute('aria-current');
      return;
    }
    if (stepIndexEl) {
      stepIndexEl.textContent = String(visibleStepIndex);
    }
    visibleStepIndex += 1;
    const pathIndex = getPathIndex(step);
    button.disabled = pathIndex > currentPathIndex;
    button.classList.toggle('is-active', step === currentStep);
    button.classList.toggle('is-completed', pathIndex < currentPathIndex);
    if (step === currentStep) {
      button.setAttribute('aria-current', 'step');
    } else {
      button.removeAttribute('aria-current');
    }
  });
  backStepEl.hidden = currentStep === 0;
  nextStepEl.hidden = currentStep >= lastActiveStep;
  submitEl.hidden = currentStep !== lastActiveStep;
}

function validateStep(stepIndex) {
  if (stepIndex === 0) {
    const password = String(passwordEl.value || '').trim();
    const confirmPassword = String(confirmPasswordEl.value || '').trim();
    if (!password) {
      showError(i18n.passwordRequired);
      return false;
    }
    if (Array.from(password).length < ` + fmt.Sprintf("%d", webMinPasswordLength) + `) {
      showError(i18n.passwordTooShort);
      return false;
    }
    if (password !== confirmPassword) {
      showError(i18n.passwordConfirmMismatch);
      return false;
    }
  }
  if (stepIndex === 1 && enableTotpEl.checked && !String(codeEl.value || '').trim()) {
    showError(i18n.totpCodeRequired);
    return false;
  }
  return true;
}

function goToStep(nextStep, options) {
  const validateCurrent = !options || options.validateCurrent !== false;
  const path = getWizardPath();
  const requestedStep = Number(nextStep || 0);
  const boundedStep = path.includes(requestedStep) ? requestedStep : (path.find((step) => step >= requestedStep) ?? path[path.length - 1]);
  if (boundedStep > currentStep && validateCurrent && !validateStep(currentStep)) {
    return;
  }
  clearError();
  currentStep = boundedStep;
  updateWizard();
}

async function bootstrapSetup() {
  try {
    clearError();
    const statusResponse = await fetch('` + internalRoutePrefix + `/auth/status', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    const statusPayload = await statusResponse.json().catch(() => ({}));
    if (statusPayload.configured) {
      const target = statusPayload.authenticated ? nextTarget : '/login?next=' + encodeURIComponent(nextTarget);
      window.location.replace(target);
      return;
    }
    const response = await fetch('` + internalRoutePrefix + `/auth/setup/bootstrap', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      showError(payload.error || i18n.initInfoFailed);
      return;
    }
    bootstrapState = payload;
    document.getElementById('issuer').value = payload.issuer || '';
    document.getElementById('account-name').value = payload.accountName || '';
    document.getElementById('secret').value = payload.secret || '';
    document.getElementById('otpauth-url').value = payload.otpauthUrl || '';
    document.getElementById('totp-qr-code').src = payload.qrCodeDataUrl || '';
    document.getElementById('idle-minutes').value = String(payload.sessionIdleMinutes || 30);
    document.getElementById('absolute-hours').value = String(payload.sessionAbsoluteHours || 168);
    document.getElementById('remember-days').value = String(payload.sessionRememberDays || 7);
    const codesEl = document.getElementById('recovery-codes');
    codesEl.innerHTML = '';
    (payload.recoveryCodes || []).forEach((item) => {
      const li = document.createElement('li');
      li.className = 'code-item';
      li.textContent = item;
      codesEl.appendChild(li);
    });
    updateWizard();
  } catch (_) {
    showError(i18n.initInfoFailed);
    return;
  }
}

document.getElementById('copy-secret').addEventListener('click', () => {
  void copyText(document.getElementById('secret').value);
});

document.getElementById('copy-uri').addEventListener('click', () => {
  void copyText(document.getElementById('otpauth-url').value);
});

enableTotpEl.addEventListener('change', () => {
  toggleTotpSection();
  updateWizard();
});
stepButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const targetStep = Number(button.dataset.stepTarget || 0);
    if (getPathIndex(targetStep) !== -1 && getPathIndex(targetStep) <= getPathIndex(currentStep)) {
      goToStep(targetStep, { validateCurrent: false });
    }
  });
});
backStepEl.addEventListener('click', () => {
  goToStep(getAdjacentStep(currentStep, -1), { validateCurrent: false });
});
nextStepEl.addEventListener('click', () => {
  goToStep(getAdjacentStep(currentStep, 1));
});
toggleTotpSection();
updateWizard();

setupFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (currentStep !== getWizardPath()[getWizardPath().length - 1]) {
    goToStep(getAdjacentStep(currentStep, 1));
    return;
  }
  clearError();
  if (!validateStep(0)) {
    currentStep = 0;
    updateWizard();
    return;
  }
  if (!validateStep(1)) {
    currentStep = 1;
    updateWizard();
    return;
  }
  if (!bootstrapState || !bootstrapState.setupToken) {
    showError(i18n.setupInfoExpired);
    return;
  }
  submitEl.disabled = true;
  try {
    const response = await fetch('` + internalRoutePrefix + `/auth/setup/complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        setupToken: bootstrapState.setupToken,
        password: document.getElementById('password').value || '',
        confirmPassword: document.getElementById('confirm-password').value || '',
        code: document.getElementById('code').value || '',
        enableTotp: enableTotpEl.checked,
        sessionIdleMinutes: Number(document.getElementById('idle-minutes').value || 30),
        sessionAbsoluteHours: Number(document.getElementById('absolute-hours').value || 168),
        sessionRememberDays: Number(document.getElementById('remember-days').value || 7)
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      showError(payload.error || i18n.initFailed);
      submitEl.disabled = false;
      return;
    }
    window.location.replace(nextTarget);
  } catch (_) {
    showError(i18n.initFailed);
    submitEl.disabled = false;
  }
});

void bootstrapSetup();`
}

func mustJSON(value any) string {
	payload, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(payload)
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		next.ServeHTTP(w, r)
	})
}
