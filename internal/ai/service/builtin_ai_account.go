package aiservice

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/dailysecret"
)

const (
	// builtinAIAccountKey is where the GoNavi AI OAuth bundle lives. It is
	// deliberately NOT the provider id: the generic provider-secret machinery
	// (load/save/delete of provider records) is keyed by provider id, and sharing
	// the key let an unrelated settings write replace a freshly rotated refresh
	// token with a stale in-memory copy, or delete the login outright.
	builtinAIAccountKey = "gonavi-ai-account"
	// builtinAILegacyAccountKey is where earlier builds stored the bundle.
	builtinAILegacyAccountKey = builtinAIProviderID

	builtinAIRefreshTokenKey = "refresh-token"
	builtinAITokenTypeKey    = "token-type"
	builtinAITokenExpiresKey = "expires-at"

	// builtinAIRefreshSkew refreshes slightly early so a request never leaves
	// the desktop with a token that expires in flight.
	builtinAIRefreshSkew = 60 * time.Second
)

var (
	// errBuiltinAILoginRequired: no credentials are stored on this device.
	errBuiltinAILoginRequired = errors.New("GoNavi AI login required")
	// errBuiltinAIUnauthorized: the Gateway rejected the stored credentials.
	errBuiltinAIUnauthorized = errors.New("GoNavi AI authorization expired")
	// errBuiltinAINetwork: the Gateway could not be reached; credentials are
	// untouched and a retry is the right action.
	errBuiltinAINetwork = errors.New("GoNavi AI Gateway is unreachable")
)

// builtinAIRefreshMu serializes read-refresh-write of the rotating refresh
// token. The Gateway invalidates the old refresh token on every use, so two
// concurrent refreshes would make the loser look like an expired login.
var builtinAIRefreshMu sync.Mutex

// builtinAIToken returns the stored account bundle, migrating the layout used
// by earlier builds on first read.
func (s *Service) builtinAIToken() (dailysecret.ProviderBundle, bool, error) {
	store := s.dailySecretStore()
	bundle, ok, err := store.GetAIProvider(builtinAIAccountKey)
	if err != nil {
		return dailysecret.ProviderBundle{}, false, err
	}
	if ok && strings.TrimSpace(bundle.APIKey) != "" {
		return bundle, true, nil
	}
	legacy, ok, err := store.GetAIProvider(builtinAILegacyAccountKey)
	if err != nil {
		return dailysecret.ProviderBundle{}, false, err
	}
	if !ok || strings.TrimSpace(legacy.APIKey) == "" {
		return dailysecret.ProviderBundle{}, false, nil
	}
	if err := store.PutAIProvider(builtinAIAccountKey, legacy); err != nil {
		return dailysecret.ProviderBundle{}, false, err
	}
	_ = store.DeleteAIProvider(builtinAILegacyAccountKey)
	return legacy, true, nil
}

func (s *Service) saveBuiltinAIToken(bundle dailysecret.ProviderBundle) error {
	store := s.dailySecretStore()
	if err := store.PutAIProvider(builtinAIAccountKey, bundle); err != nil {
		return err
	}
	_ = store.DeleteAIProvider(builtinAILegacyAccountKey)
	return nil
}

func (s *Service) clearBuiltinAIToken() error {
	store := s.dailySecretStore()
	if err := store.DeleteAIProvider(builtinAIAccountKey); err != nil {
		return err
	}
	return store.DeleteAIProvider(builtinAILegacyAccountKey)
}

// builtinAIHasLocalToken reports whether this device holds credentials. It is a
// cheap local read used for list/readiness views and never touches the network.
func (s *Service) builtinAIHasLocalToken() bool {
	bundle, ok, err := s.builtinAIToken()
	return err == nil && ok && strings.TrimSpace(bundle.APIKey) != ""
}

func builtinAITokenFresh(bundle dailysecret.ProviderBundle) bool {
	expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(bundle.SensitiveHeaders[builtinAITokenExpiresKey]))
	return err == nil && time.Until(expiresAt) > builtinAIRefreshSkew
}

func builtinAITokenStillValid(bundle dailysecret.ProviderBundle) bool {
	expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(bundle.SensitiveHeaders[builtinAITokenExpiresKey]))
	return err == nil && time.Until(expiresAt) > 0
}

func builtinAIBundleFromToken(token builtinAITokenResponse, fallbackRefresh string) dailysecret.ProviderBundle {
	refresh := strings.TrimSpace(token.RefreshToken)
	if refresh == "" {
		refresh = fallbackRefresh
	}
	return dailysecret.ProviderBundle{
		APIKey: token.AccessToken,
		SensitiveHeaders: map[string]string{
			builtinAITokenTypeKey:    strings.TrimSpace(token.TokenType),
			builtinAIRefreshTokenKey: refresh,
			builtinAITokenExpiresKey: time.Now().Add(time.Duration(token.ExpiresIn) * time.Second).UTC().Format(time.RFC3339),
		},
	}
}

// ensureBuiltinAIAccessToken returns a usable access token, refreshing it when
// it is (nearly) expired or when force is set because the Gateway rejected it.
//
// Failure taxonomy callers rely on:
//   - errBuiltinAILoginRequired: nothing stored; start the device flow.
//   - errBuiltinAIUnauthorized: the refresh token was refused; stored
//     credentials are cleared and the user must sign in again.
//   - errBuiltinAINetwork / other errors: transient; credentials are kept.
func (s *Service) ensureBuiltinAIAccessToken(config builtinAIConfig, force bool) (dailysecret.ProviderBundle, error) {
	builtinAIRefreshMu.Lock()
	defer builtinAIRefreshMu.Unlock()
	// Re-read under the lock: another caller may have refreshed while we waited.
	bundle, ok, err := s.builtinAIToken()
	if err != nil {
		return dailysecret.ProviderBundle{}, err
	}
	if !ok {
		return dailysecret.ProviderBundle{}, errBuiltinAILoginRequired
	}
	if !force && builtinAITokenFresh(bundle) {
		return bundle, nil
	}
	refreshToken := strings.TrimSpace(bundle.SensitiveHeaders[builtinAIRefreshTokenKey])
	if refreshToken == "" {
		// Credentials without an expiry/refresh token (older fixtures) are used
		// as-is until the Gateway says otherwise.
		if !force && strings.TrimSpace(bundle.SensitiveHeaders[builtinAITokenExpiresKey]) == "" {
			return bundle, nil
		}
		return dailysecret.ProviderBundle{}, errBuiltinAIUnauthorized
	}
	body, err := json.Marshal(map[string]string{
		"client_id":     config.clientID,
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
	})
	if err != nil {
		return dailysecret.ProviderBundle{}, err
	}
	response, err := doBuiltinAIJSONRequest(http.MethodPost, config.tokenURL, "", body)
	if err != nil {
		if !force && builtinAITokenStillValid(bundle) {
			return bundle, nil
		}
		return dailysecret.ProviderBundle{}, fmt.Errorf("%w: %v", errBuiltinAINetwork, err)
	}
	switch {
	case response.statusCode == http.StatusOK:
	case isBuiltinAIInvalidGrant(response):
		_ = s.clearBuiltinAIToken()
		return dailysecret.ProviderBundle{}, errBuiltinAIUnauthorized
	default:
		if !force && builtinAITokenStillValid(bundle) {
			return bundle, nil
		}
		return dailysecret.ProviderBundle{}, fmt.Errorf("GoNavi AI refresh endpoint returned HTTP %d", response.statusCode)
	}
	var token builtinAITokenResponse
	if err := json.Unmarshal(response.body, &token); err != nil || strings.TrimSpace(token.AccessToken) == "" {
		return dailysecret.ProviderBundle{}, fmt.Errorf("GoNavi AI refresh response is invalid")
	}
	refreshed := builtinAIBundleFromToken(token, refreshToken)
	if err := s.saveBuiltinAIToken(refreshed); err != nil {
		return dailysecret.ProviderBundle{}, fmt.Errorf("store refreshed GoNavi AI token: %w", err)
	}
	return refreshed, nil
}

// isBuiltinAIInvalidGrant treats only an explicit refusal of the refresh token
// as "sign in again". A 400 for any other reason (bad client id, malformed
// request) is a configuration problem, not an expired login.
func isBuiltinAIInvalidGrant(response builtinAIHTTPResponse) bool {
	if response.statusCode != http.StatusBadRequest && response.statusCode != http.StatusUnauthorized {
		return false
	}
	var oauthErr builtinAIOAuthError
	if err := json.Unmarshal(response.body, &oauthErr); err != nil {
		return response.statusCode == http.StatusUnauthorized
	}
	return oauthErr.Error == "invalid_grant" || (oauthErr.Error == "" && response.statusCode == http.StatusUnauthorized)
}
