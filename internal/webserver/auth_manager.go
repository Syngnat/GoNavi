package webserver

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type webAuthManager struct {
	mu                           sync.RWMutex
	store                        *webAuthStore
	config                       webAuthConfig
	pending                      map[string]pendingSetup
	sessions                     *webSessionManager
	loginAttempts                *loginAttemptTracker
	usedTOTPCodes                map[string]time.Time
	now                          func() time.Time
	passwordManagedByEnvironment bool
}

type webAuthStatus struct {
	Configured           bool `json:"configured"`
	Authenticated        bool `json:"authenticated"`
	TOTPEnabled          bool `json:"totpEnabled"`
	SessionIdleMinutes   int  `json:"sessionIdleMinutes,omitempty"`
	SessionAbsoluteHours int  `json:"sessionAbsoluteHours,omitempty"`
	SessionRememberDays  int  `json:"sessionRememberDays,omitempty"`
}

type webAuthSettingsSummary struct {
	Configured                   bool   `json:"configured"`
	TOTPEnabled                  bool   `json:"totpEnabled"`
	RecoveryCodesRemaining       int    `json:"recoveryCodesRemaining"`
	SessionIdleMinutes           int    `json:"sessionIdleMinutes,omitempty"`
	SessionAbsoluteHours         int    `json:"sessionAbsoluteHours,omitempty"`
	SessionRememberDays          int    `json:"sessionRememberDays,omitempty"`
	UpdatedAt                    string `json:"updatedAt,omitempty"`
	PasswordManagedByEnvironment bool   `json:"passwordManagedByEnvironment"`
}

func newWebAuthManager(root string) (*webAuthManager, error) {
	return newWebAuthManagerWithPassword(root, "")
}

func newWebAuthManagerFromEnvironment(root string) (*webAuthManager, error) {
	return newWebAuthManagerWithPassword(root, os.Getenv(webAuthPasswordEnvName))
}

func newWebAuthManagerWithPassword(root string, configuredPassword string) (*webAuthManager, error) {
	store := newWebAuthStore(root)
	cfg, err := store.Load()
	if err != nil {
		return nil, err
	}
	manager := &webAuthManager{
		store:         store,
		config:        cfg,
		pending:       make(map[string]pendingSetup),
		sessions:      newWebSessionManager(),
		loginAttempts: newLoginAttemptTracker(),
		now:           time.Now,
	}
	if err := manager.applyEnvironmentPassword(configuredPassword); err != nil {
		return nil, err
	}
	return manager, nil
}

func (m *webAuthManager) applyEnvironmentPassword(password string) error {
	if strings.TrimSpace(password) == "" {
		return nil
	}
	normalizedPassword, err := normalizeWebAuthPassword(password)
	if err != nil {
		return fmt.Errorf("%s: %w", webAuthPasswordEnvName, err)
	}
	m.passwordManagedByEnvironment = true

	m.mu.Lock()
	defer m.mu.Unlock()
	cfg := cloneWebAuthConfig(m.config)
	if cfg.IsConfigured() && verifyPassword(cfg.PasswordHash, normalizedPassword) {
		return nil
	}
	passwordHash, err := hashPassword(normalizedPassword)
	if err != nil {
		return fmt.Errorf("%s: %w", webAuthPasswordEnvName, err)
	}
	if !cfg.IsConfigured() {
		cfg = normalizeWebAuthConfig(webAuthConfig{Enabled: true})
	}
	cfg.Enabled = true
	cfg.PasswordHash = passwordHash
	cfg.UpdatedAt = m.now().UTC().Format(time.RFC3339)
	if err := m.store.Save(cfg); err != nil {
		return fmt.Errorf("persist %s: %w", webAuthPasswordEnvName, err)
	}
	m.config = cfg
	return nil
}

func (m *webAuthManager) currentConfig() webAuthConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return cloneWebAuthConfig(m.config)
}

func cloneWebAuthConfig(cfg webAuthConfig) webAuthConfig {
	copied := cfg
	if cfg.RecoveryCodeHashes != nil {
		copied.RecoveryCodeHashes = append([]string(nil), cfg.RecoveryCodeHashes...)
	}
	return copied
}

func buildWebAuthSettingsSummary(cfg webAuthConfig, passwordManagedByEnvironment bool) webAuthSettingsSummary {
	return webAuthSettingsSummary{
		Configured:                   cfg.IsConfigured(),
		TOTPEnabled:                  cfg.TOTPEnabled,
		RecoveryCodesRemaining:       len(cfg.RecoveryCodeHashes),
		SessionIdleMinutes:           cfg.SessionIdleMinutes,
		SessionAbsoluteHours:         cfg.SessionAbsoluteHours,
		SessionRememberDays:          cfg.SessionRememberDays,
		UpdatedAt:                    strings.TrimSpace(cfg.UpdatedAt),
		PasswordManagedByEnvironment: passwordManagedByEnvironment,
	}
}

func (m *webAuthManager) Status(sessionID string) webAuthStatus {
	cfg := m.currentConfig()
	status := webAuthStatus{
		Configured:           cfg.IsConfigured(),
		TOTPEnabled:          cfg.TOTPEnabled,
		SessionIdleMinutes:   cfg.SessionIdleMinutes,
		SessionAbsoluteHours: cfg.SessionAbsoluteHours,
		SessionRememberDays:  cfg.SessionRememberDays,
	}
	if status.Configured {
		status.Authenticated = m.sessions.Authenticate(sessionID, cfg, m.now())
	}
	return status
}

func (m *webAuthManager) Settings() (webAuthSettingsSummary, error) {
	cfg := m.currentConfig()
	if !cfg.IsConfigured() {
		return webAuthSettingsSummary{}, errWebAuthNotConfigured
	}
	return buildWebAuthSettingsSummary(cfg, m.passwordManagedByEnvironment), nil
}

func (m *webAuthManager) BeginSetup(host string) (pendingSetupResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.config.IsConfigured() {
		return pendingSetupResponse{}, errWebAuthAlreadyConfigured
	}
	token, err := generateRandomToken(24)
	if err != nil {
		return pendingSetupResponse{}, err
	}
	secret, err := generateTOTPSecret()
	if err != nil {
		return pendingSetupResponse{}, err
	}
	recoveryCodes, err := generateRecoveryCodes(8)
	if err != nil {
		return pendingSetupResponse{}, err
	}
	accountName := buildTOTPAccountName(host)
	setup := pendingSetup{
		Token:         token,
		Secret:        secret,
		RecoveryCodes: recoveryCodes,
		Issuer:        "GoNavi",
		AccountName:   accountName,
		CreatedAt:     m.now(),
	}
	now := m.now()
	for key, item := range m.pending {
		if now.Sub(item.CreatedAt) > webSetupTokenTTL {
			delete(m.pending, key)
		}
	}
	m.pending[token] = setup
	otpauthURL := buildOtpauthURL(setup.Issuer, setup.AccountName, secret)
	qrCodeDataURL, err := generateQRCodeDataURL(otpauthURL)
	if err != nil {
		return pendingSetupResponse{}, err
	}
	return pendingSetupResponse{
		SetupToken:           token,
		Secret:               secret,
		OtpauthURL:           otpauthURL,
		QRCodeDataURL:        qrCodeDataURL,
		Issuer:               setup.Issuer,
		AccountName:          setup.AccountName,
		RecoveryCodes:        append([]string(nil), recoveryCodes...),
		SessionIdleMinutes:   webDefaultSessionIdleMinutes,
		SessionAbsoluteHours: webDefaultSessionAbsoluteHours,
		SessionRememberDays:  webDefaultSessionRememberDays,
	}, nil
}

func (m *webAuthManager) CompleteSetup(token string, password string, code string, enableTOTP bool, idleMinutes int, absoluteHours int, rememberDays int) (webAuthConfig, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.config.IsConfigured() {
		return webAuthConfig{}, "", errWebAuthAlreadyConfigured
	}
	setup, ok := m.pending[strings.TrimSpace(token)]
	if !ok {
		return webAuthConfig{}, "", errWebAuthInvalidSetup
	}
	if m.now().Sub(setup.CreatedAt) > webSetupTokenTTL {
		delete(m.pending, strings.TrimSpace(token))
		return webAuthConfig{}, "", errWebAuthSetupExpired
	}
	normalizedPassword, err := normalizeWebAuthPassword(password)
	if err != nil {
		return webAuthConfig{}, "", err
	}
	if enableTOTP && !validateTOTPCode(setup.Secret, code, m.now()) {
		return webAuthConfig{}, "", fmt.Errorf("invalid google authenticator code")
	}
	passwordHash, err := hashPassword(normalizedPassword)
	if err != nil {
		return webAuthConfig{}, "", err
	}
	cfg := normalizeWebAuthConfig(webAuthConfig{
		Enabled:              true,
		PasswordHash:         passwordHash,
		TOTPEnabled:          enableTOTP,
		TOTPSecret:           setup.Secret,
		SessionIdleMinutes:   idleMinutes,
		SessionAbsoluteHours: absoluteHours,
		SessionRememberDays:  rememberDays,
		UpdatedAt:            m.now().UTC().Format(time.RFC3339),
	})
	if enableTOTP {
		cfg.RecoveryCodeHashes = make([]string, 0, len(setup.RecoveryCodes))
		for _, item := range setup.RecoveryCodes {
			cfg.RecoveryCodeHashes = append(cfg.RecoveryCodeHashes, hashRecoveryCode(item))
		}
	}
	if err := m.store.Save(cfg); err != nil {
		return webAuthConfig{}, "", err
	}
	m.config = cfg
	delete(m.pending, strings.TrimSpace(token))
	sessionID, err := m.sessions.Create(cfg, m.now())
	if err != nil {
		return webAuthConfig{}, "", err
	}
	return cloneWebAuthConfig(cfg), sessionID, nil
}

func (m *webAuthManager) Login(password string, code string, remoteIP string) (webAuthConfig, string, bool, time.Duration, error) {
	now := m.now()
	if wait, ok := m.loginAttempts.allow(remoteIP, now); !ok {
		return webAuthConfig{}, "", false, wait, errWebAuthRateLimited
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	cfg := cloneWebAuthConfig(m.config)
	if !cfg.IsConfigured() {
		return webAuthConfig{}, "", false, 0, errWebAuthNotConfigured
	}
	if !verifyPassword(cfg.PasswordHash, strings.TrimSpace(password)) {
		wait := m.loginAttempts.recordFailure(remoteIP, now)
		return webAuthConfig{}, "", false, wait, errWebAuthInvalidCredentials
	}

	usedRecoveryCode := false
	if cfg.TOTPEnabled {
		normalizedCode := normalizeUserCode(code)
		if normalizedCode == "" {
			wait := m.loginAttempts.recordFailure(remoteIP, now)
			return webAuthConfig{}, "", false, wait, errWebAuthInvalidCredentials
		}
		if !m.consumeTOTPCodeForLogin(cfg.TOTPSecret, normalizedCode, now) {
			nextCfg, consumed := consumeRecoveryCode(cfg, normalizedCode)
			if !consumed {
				wait := m.loginAttempts.recordFailure(remoteIP, now)
				return webAuthConfig{}, "", false, wait, errWebAuthInvalidCredentials
			}
			if err := m.store.Save(nextCfg); err != nil {
				return webAuthConfig{}, "", false, 0, err
			}
			cfg = nextCfg
			m.config = nextCfg
			usedRecoveryCode = true
		}
	}

	sessionID, err := m.sessions.Create(cfg, now)
	if err != nil {
		return webAuthConfig{}, "", false, 0, err
	}
	m.loginAttempts.recordSuccess(remoteIP)
	return cfg, sessionID, usedRecoveryCode, 0, nil
}

func (m *webAuthManager) Logout(sessionID string) {
	m.sessions.Destroy(sessionID)
}

func (m *webAuthManager) ChangePassword(currentPassword string, code string, nextPassword string) (webAuthConfig, string, bool, error) {
	if m.passwordManagedByEnvironment {
		return webAuthConfig{}, "", false, errWebAuthPasswordManaged
	}
	now := m.now()

	m.mu.Lock()
	defer m.mu.Unlock()

	cfg := cloneWebAuthConfig(m.config)
	if !cfg.IsConfigured() {
		return webAuthConfig{}, "", false, errWebAuthNotConfigured
	}
	if !verifyPassword(cfg.PasswordHash, strings.TrimSpace(currentPassword)) {
		return webAuthConfig{}, "", false, errWebAuthInvalidCredentials
	}

	usedRecoveryCode := false
	if cfg.TOTPEnabled {
		normalizedCode := normalizeUserCode(code)
		if normalizedCode == "" {
			return webAuthConfig{}, "", false, errWebAuthInvalidCredentials
		}
		// NB: the plain validator, not the login replay guard. A password change
		// already requires the current password, and a user who changes their
		// password then signs in again inside the same TOTP step legitimately
		// reuses the code; rejecting that here would break a normal flow for no
		// security gain the login path does not already cover.
		if !validateTOTPCode(cfg.TOTPSecret, normalizedCode, now) {
			nextCfg, consumed := consumeRecoveryCode(cfg, normalizedCode)
			if !consumed {
				return webAuthConfig{}, "", false, errWebAuthInvalidCredentials
			}
			cfg = nextCfg
			usedRecoveryCode = true
		}
	}

	passwordHash, err := hashPassword(nextPassword)
	if err != nil {
		return webAuthConfig{}, "", false, err
	}
	cfg.PasswordHash = passwordHash
	cfg.UpdatedAt = now.UTC().Format(time.RFC3339)

	if err := m.store.Save(cfg); err != nil {
		return webAuthConfig{}, "", false, err
	}
	m.config = cfg
	m.sessions.DestroyAll()
	sessionID, err := m.sessions.Create(cfg, now)
	if err != nil {
		return webAuthConfig{}, "", false, err
	}
	return cloneWebAuthConfig(cfg), sessionID, usedRecoveryCode, nil
}
