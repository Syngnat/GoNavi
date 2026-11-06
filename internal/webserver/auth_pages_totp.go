package webserver

import (
	"encoding/json"
	"errors"
	"net/http"

	"GoNavi-Wails/internal/webidentity"
)

type webTOTPBeginRequest struct {
	Password string `json:"password"`
}

type webTOTPEnableRequest struct {
	SetupToken string `json:"setupToken"`
	Code       string `json:"code"`
}

type webTOTPDisableRequest struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

func (s *Server) handleTOTPBegin(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	if r.Method != http.MethodPost {
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	actor, ok := webidentity.ActorFromContext(r.Context())
	if !ok {
		s.writeAuthJSONError(w, http.StatusUnauthorized, webAuthText(localizer, "web_auth.error.auth_required", nil), 0)
		return
	}
	defer r.Body.Close()
	var request webTOTPBeginRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.writeAuthJSONError(w, http.StatusBadRequest, webAuthText(localizer, "web_auth.error.invalid_setup_payload", nil), 0)
		return
	}
	payload, err := s.auth.BeginTOTPSetup(actor.Username, request.Password, r.Host)
	if err != nil {
		s.writeAuthJSONError(w, http.StatusBadRequest, localizeWebAuthError(localizer, err), 0)
		return
	}
	s.writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleTOTPEnable(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	if r.Method != http.MethodPost {
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	actor, ok := webidentity.ActorFromContext(r.Context())
	if !ok {
		s.writeAuthJSONError(w, http.StatusUnauthorized, webAuthText(localizer, "web_auth.error.auth_required", nil), 0)
		return
	}
	defer r.Body.Close()
	var request webTOTPEnableRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.writeAuthJSONError(w, http.StatusBadRequest, webAuthText(localizer, "web_auth.error.invalid_setup_payload", nil), 0)
		return
	}
	if _, err := s.auth.CompleteTOTPSetup(actor.Username, request.SetupToken, request.Code); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errWebAuthInvalidCredentials) {
			status = http.StatusUnauthorized
		}
		s.writeAuthJSONError(w, status, localizeWebAuthError(localizer, err), 0)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	localizer := newWebAuthLocalizer(resolveWebAuthLanguage(r))
	if r.Method != http.MethodPost {
		http.Error(w, webAuthText(localizer, "web_auth.error.method_not_allowed", nil), http.StatusMethodNotAllowed)
		return
	}
	actor, ok := webidentity.ActorFromContext(r.Context())
	if !ok {
		s.writeAuthJSONError(w, http.StatusUnauthorized, webAuthText(localizer, "web_auth.error.auth_required", nil), 0)
		return
	}
	defer r.Body.Close()
	var request webTOTPDisableRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.writeAuthJSONError(w, http.StatusBadRequest, webAuthText(localizer, "web_auth.error.invalid_setup_payload", nil), 0)
		return
	}
	if _, err := s.auth.DisableTOTP(actor.Username, request.Password, request.Code); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errWebAuthInvalidCredentials) {
			status = http.StatusUnauthorized
		}
		s.writeAuthJSONError(w, status, localizeWebAuthError(localizer, err), 0)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"success": true})
}
