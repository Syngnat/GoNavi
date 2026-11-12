package webserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/uievents"
	"GoNavi-Wails/internal/webidentity"
)

const (
	webAuthLanguageCookieName = "gonavi_web_lang"
	webAuthFrontendStorageKey = "lite-db-storage"
	webSetupGateHeaderName    = "X-GoNavi-Setup-Token"
)

var webAuthPageLocalizers sync.Map

type webSetupCompleteRequest struct {
	SetupToken           string `json:"setupToken"`
	Username             string `json:"username"`
	Password             string `json:"password"`
	ConfirmPassword      string `json:"confirmPassword"`
	Code                 string `json:"code"`
	EnableTOTP           bool   `json:"enableTotp"`
	SessionIdleMinutes   int    `json:"sessionIdleMinutes"`
	SessionAbsoluteHours int    `json:"sessionAbsoluteHours"`
	SessionRememberDays  int    `json:"sessionRememberDays"`
}

type webLoginRequest struct {
	Username string `json:"username"`
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
	if actor, ok := webidentity.ActorFromContext(r.Context()); ok {
		settings.CurrentUser = actor.Username
		settings.CurrentRole = string(actor.Role)
		settings.CurrentPasswordManaged = settings.PasswordManagedByEnvironment && actor.Username == webDefaultAdminUsername
		settings.CurrentTOTPEnabled = s.auth.UserTOTPEnabled(actor.Username)
		if actor.Role != webidentity.RoleAdmin {
			// 账号列表只对管理员可见；只读账号仍可改自己的密码。
			settings.Users = nil
		}
	}
	s.writeJSON(w, http.StatusOK, settings)
}

func (s *Server) handleSetupBootstrap(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	if r.Method != http.MethodPost {
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	payload, err := s.auth.BeginSetup(r.Host, r.Header.Get(webSetupGateHeaderName))
	if err != nil {
		if err == errWebAuthAlreadyConfigured {
			s.writeAuthJSONError(w, http.StatusConflict, webAuthText(localizer, "web_auth.error.already_configured", nil), 0)
			return
		}
		if errors.Is(err, errWebAuthSetupGateRequired) {
			s.writeAuthJSONError(w, http.StatusForbidden, webAuthText(localizer, "web_auth.error.setup_gate_required", nil), 0)
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
	setupUsername := strings.TrimSpace(request.Username)
	if setupUsername == "" {
		setupUsername = webDefaultAdminUsername
	}
	cfg, sessionID, err := s.auth.CompleteSetup(
		request.SetupToken,
		setupUsername,
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
	cfg, sessionID, usedRecoveryCode, retryAfter, err := s.auth.Login(request.Username, request.Password, request.Code, clientIP(r))
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

	actor, _ := webidentity.ActorFromContext(r.Context())
	cfg, sessionID, usedRecoveryCode, err := s.auth.ChangePassword(actor.Username, request.CurrentPassword, request.Code, request.NewPassword)
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
		http.Redirect(w, r, s.buildSetupRedirectURL(r.URL.RequestURI()), http.StatusSeeOther)
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
	if s.redirectMissingLocalSetupGate(w, r) {
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
				http.Redirect(w, r, s.buildSetupRedirectURL(r.URL.RequestURI()), http.StatusSeeOther)
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
		actor := webidentity.NormalizeActor(webidentity.Actor{
			Username:             status.Username,
			Role:                 webidentity.Role(status.Role),
			AllowedConnectionIDs: s.auth.ConnectionACL(status.Username),
		})
		ctx := webidentity.WithActor(r.Context(), actor)
		if sessionID != "" && s.events != nil {
			// 请求内产生的事件只回发给当前登录会话，避免多客户端互相看到进度。
			ctx = uievents.WithEmitter(ctx, s.events.emitterForSession(sessionID))
		}
		next.ServeHTTP(w, r.WithContext(ctx))
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
	// 认证页只加载本站资源、内联样式/脚本与 data: 二维码，适合严格 CSP。
	// 主工作台包含 Monaco worker（blob:）等运行时，CSP 需单独评估，故不在此处统一加。
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "+
			"img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "+
			"frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, strings.NewReader(payload))
}
