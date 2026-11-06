package webserver

import (
	"encoding/json"
	"errors"
	"net/http"

	"GoNavi-Wails/internal/webidentity"
	"GoNavi-Wails/shared/i18n"
)

// handleAuthUsers 提供账号列表与管理员账号变更。
// 只有 admin 角色可以调用；viewer 只能读取，且不返回密码哈希。
func (s *Server) handleAuthUsers(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	actor, ok := webidentity.ActorFromContext(r.Context())
	if !ok || actor.Role != webidentity.RoleAdmin {
		s.writeAuthJSONError(w, http.StatusForbidden, webAuthText(localizer, "web_auth.error.admin_required", nil), 0)
		return
	}

	switch r.Method {
	case http.MethodGet:
		users, err := s.auth.Users()
		if err != nil {
			s.writeAuthJSONError(w, http.StatusPreconditionFailed, localizeWebAuthError(localizer, err), 0)
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]any{"users": users})
	case http.MethodPost:
		defer r.Body.Close()
		var request webAuthUserMutation
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			s.writeAuthJSONError(w, http.StatusBadRequest, webAuthText(localizer, "web_auth.error.invalid_setup_payload", nil), 0)
			return
		}
		users, err := s.auth.MutateUser(actor.Username, request)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, errWebAuthNotConfigured) {
				status = http.StatusPreconditionFailed
			}
			s.writeAuthJSONError(w, status, userMutationErrorMessage(localizer, err), 0)
			return
		}
		s.writeJSON(w, http.StatusOK, map[string]any{"success": true, "users": users})
	default:
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
	}
}

// userMutationErrorMessage 把账号变更的校验错误映射到 i18n 文案。
// 未覆盖的错误保留原文，便于管理员定位（这些文案只出现在已认证的管理界面）。
func userMutationErrorMessage(localizer *i18n.Localizer, err error) string {
	if err == nil {
		return ""
	}
	switch err.Error() {
	case "username is required":
		return webAuthText(localizer, "web_auth.error.username_required", nil)
	case "password is required":
		return webAuthText(localizer, "web_auth.error.password_required", nil)
	case "user not found":
		return webAuthText(localizer, "web_auth.error.user_not_found", nil)
	case "the current user cannot be removed":
		return webAuthText(localizer, "web_auth.error.current_user_remove", nil)
	case "the current user cannot be disabled":
		return webAuthText(localizer, "web_auth.error.current_user_disable", nil)
	case "the last enabled administrator cannot be demoted or disabled",
		"the last enabled administrator cannot be removed":
		return webAuthText(localizer, "web_auth.error.last_admin_required", nil)
	case "unsupported user action":
		return webAuthText(localizer, "web_auth.error.user_action_unsupported", nil)
	default:
		return err.Error()
	}
}
