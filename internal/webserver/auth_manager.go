package webserver

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/webidentity"
)

type webAuthManager struct {
	mu                           sync.RWMutex
	store                        *webAuthStore
	config                       webAuthConfig
	pending                      map[string]pendingSetup
	pendingTOTP                  map[string]pendingSetup
	sessions                     *webSessionManager
	loginAttempts                *loginAttemptTracker
	usedTOTPCodes                map[string]time.Time
	setupGateToken               string
	lastConfigModTime            time.Time
	now                          func() time.Time
	passwordManagedByEnvironment bool
}

type webAuthStatus struct {
	Configured           bool   `json:"configured"`
	Authenticated        bool   `json:"authenticated"`
	TOTPEnabled          bool   `json:"totpEnabled"`
	Username             string `json:"username,omitempty"`
	Role                 string `json:"role,omitempty"`
	SessionIdleMinutes   int    `json:"sessionIdleMinutes,omitempty"`
	SessionAbsoluteHours int    `json:"sessionAbsoluteHours,omitempty"`
	SessionRememberDays  int    `json:"sessionRememberDays,omitempty"`
}

type webAuthSettingsSummary struct {
	Configured                   bool                 `json:"configured"`
	TOTPEnabled                  bool                 `json:"totpEnabled"`
	RecoveryCodesRemaining       int                  `json:"recoveryCodesRemaining"`
	Users                        []webAuthUserSummary `json:"users,omitempty"`
	CurrentUser                  string               `json:"currentUser,omitempty"`
	CurrentRole                  string               `json:"currentRole,omitempty"`
	CurrentPasswordManaged       bool                 `json:"currentPasswordManaged,omitempty"`
	CurrentTOTPEnabled           bool                 `json:"currentTotpEnabled,omitempty"`
	SessionIdleMinutes           int                  `json:"sessionIdleMinutes,omitempty"`
	SessionAbsoluteHours         int                  `json:"sessionAbsoluteHours,omitempty"`
	SessionRememberDays          int                  `json:"sessionRememberDays,omitempty"`
	UpdatedAt                    string               `json:"updatedAt,omitempty"`
	PasswordManagedByEnvironment bool                 `json:"passwordManagedByEnvironment"`
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
		store:             store,
		config:            cfg,
		pending:           make(map[string]pendingSetup),
		pendingTOTP:       make(map[string]pendingSetup),
		sessions:          newWebSessionManagerWithStore(root),
		loginAttempts:     newLoginAttemptTracker(),
		setupGateToken:    resolveWebSetupGateToken(),
		lastConfigModTime: store.ModTime(),
		now:               time.Now,
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
	if admin, ok := findWebAuthUser(cfg, webDefaultAdminUsername); ok && verifyPassword(admin.PasswordHash, normalizedPassword) {
		if cfg.Enabled {
			return nil
		}
	}
	passwordHash, err := hashPassword(normalizedPassword)
	if err != nil {
		return fmt.Errorf("%s: %w", webAuthPasswordEnvName, err)
	}
	cfg.Enabled = true
	if err := upsertWebAuthUser(&cfg, webDefaultAdminUsername, passwordHash, webRoleAdmin, false, nil); err != nil {
		return fmt.Errorf("initialize %s administrator: %w", webAuthPasswordEnvName, err)
	}
	cfg = normalizeWebAuthConfig(cfg)
	cfg.UpdatedAt = m.now().UTC().Format(time.RFC3339)
	if err := m.saveConfigLocked(cfg); err != nil {
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
	if cfg.Users != nil {
		copied.Users = make([]webAuthUser, len(cfg.Users))
		for index, user := range cfg.Users {
			copied.Users[index] = user
			if user.RecoveryCodeHashes != nil {
				copied.Users[index].RecoveryCodeHashes = append([]string(nil), user.RecoveryCodeHashes...)
			}
		}
	}
	return copied
}

func buildWebAuthSettingsSummary(cfg webAuthConfig, passwordManagedByEnvironment bool) webAuthSettingsSummary {
	recoveryCodes := 0
	for _, user := range cfg.Users {
		recoveryCodes += len(user.RecoveryCodeHashes)
	}
	return webAuthSettingsSummary{
		Configured:                   cfg.IsConfigured(),
		TOTPEnabled:                  anyWebAuthUserTOTPEnabled(cfg),
		RecoveryCodesRemaining:       recoveryCodes,
		SessionIdleMinutes:           cfg.SessionIdleMinutes,
		SessionAbsoluteHours:         cfg.SessionAbsoluteHours,
		SessionRememberDays:          cfg.SessionRememberDays,
		UpdatedAt:                    strings.TrimSpace(cfg.UpdatedAt),
		PasswordManagedByEnvironment: passwordManagedByEnvironment,
	}
}

// refreshConfigFromDisk 让多副本共享同一数据目录时，其他副本修改的账号、
// 密码、角色与连接白名单能在下一次请求前生效。
func (m *webAuthManager) refreshConfigFromDisk() {
	if m == nil || m.store == nil {
		return
	}
	modTime := m.store.ModTime()
	if modTime.IsZero() {
		return
	}
	m.mu.RLock()
	last := m.lastConfigModTime
	m.mu.RUnlock()
	if !modTime.After(last) {
		return
	}
	cfg, err := m.store.Load()
	if err != nil {
		return
	}
	m.mu.Lock()
	if modTime.After(m.lastConfigModTime) {
		m.config = cfg
		m.lastConfigModTime = modTime
	}
	m.mu.Unlock()
}

func (m *webAuthManager) saveConfigLocked(cfg webAuthConfig) error {
	if err := m.store.Save(cfg); err != nil {
		return err
	}
	m.lastConfigModTime = m.store.ModTime()
	return nil
}

func (m *webAuthManager) Status(sessionID string) webAuthStatus {
	m.refreshConfigFromDisk()
	cfg := m.currentConfig()
	status := webAuthStatus{
		Configured:           cfg.IsConfigured(),
		TOTPEnabled:          anyWebAuthUserTOTPEnabled(cfg),
		SessionIdleMinutes:   cfg.SessionIdleMinutes,
		SessionAbsoluteHours: cfg.SessionAbsoluteHours,
		SessionRememberDays:  cfg.SessionRememberDays,
	}
	if status.Configured {
		session, ok := m.sessions.Authenticate(sessionID, cfg, m.now())
		if ok {
			user, found := findWebAuthUser(cfg, session.Username)
			switch {
			case !found || user.Disabled:
				// 账号被删除或停用后，已签发的会话必须立即失效；
				// 角色以当前配置为准，管理员降级无需等待重新登录。
				m.sessions.Destroy(session.ID)
			default:
				status.Authenticated = true
				status.Username = user.Username
				status.Role = user.Role
				status.TOTPEnabled = user.TOTPEnabled
			}
		}
	}
	return status
}

// ConnectionACL 返回账号允许访问的已保存连接；空列表表示不限制。
func (m *webAuthManager) ConnectionACL(username string) []string {
	if m == nil {
		return nil
	}
	m.refreshConfigFromDisk()
	m.mu.RLock()
	defer m.mu.RUnlock()
	user, ok := findWebAuthUser(m.config, webidentity.NormalizeUsername(username))
	if !ok || user.Role == webRoleAdmin {
		return nil
	}
	return append([]string(nil), user.AllowedConnectionIDs...)
}

func (m *webAuthManager) Settings() (webAuthSettingsSummary, error) {
	m.refreshConfigFromDisk()
	cfg := m.currentConfig()
	if !cfg.IsConfigured() {
		return webAuthSettingsSummary{}, errWebAuthNotConfigured
	}
	summary := buildWebAuthSettingsSummary(cfg, m.passwordManagedByEnvironment)
	summary.Users = buildWebAuthUserSummaries(cfg, m.passwordManagedByEnvironment)
	return summary, nil
}

func (m *webAuthManager) BeginSetup(host string, gateToken string) (pendingSetupResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.config.IsConfigured() {
		return pendingSetupResponse{}, errWebAuthAlreadyConfigured
	}
	if !m.verifySetupGateToken(gateToken) {
		return pendingSetupResponse{}, errWebAuthSetupGateRequired
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

func (m *webAuthManager) CompleteSetup(token string, username string, password string, code string, enableTOTP bool, idleMinutes int, absoluteHours int, rememberDays int) (webAuthConfig, string, error) {
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
	normalizedUsername, err := normalizeWebAuthUsername(username)
	if err != nil {
		return webAuthConfig{}, "", err
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
	now := m.now().UTC().Format(time.RFC3339)
	admin := webAuthUser{
		Username:     normalizedUsername,
		PasswordHash: passwordHash,
		Role:         webRoleAdmin,
		TOTPEnabled:  enableTOTP,
		TOTPSecret:   setup.Secret,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if enableTOTP {
		admin.RecoveryCodeHashes = make([]string, 0, len(setup.RecoveryCodes))
		for _, item := range setup.RecoveryCodes {
			admin.RecoveryCodeHashes = append(admin.RecoveryCodeHashes, hashRecoveryCode(item))
		}
	}
	cfg := normalizeWebAuthConfig(webAuthConfig{
		Enabled:              true,
		Users:                []webAuthUser{admin},
		SessionIdleMinutes:   idleMinutes,
		SessionAbsoluteHours: absoluteHours,
		SessionRememberDays:  rememberDays,
		UpdatedAt:            now,
	})
	if err := m.saveConfigLocked(cfg); err != nil {
		return webAuthConfig{}, "", err
	}
	m.config = cfg
	delete(m.pending, strings.TrimSpace(token))
	sessionID, err := m.sessions.Create(cfg, normalizedUsername, webRoleAdmin, m.now())
	if err != nil {
		return webAuthConfig{}, "", err
	}
	return cloneWebAuthConfig(cfg), sessionID, nil
}

func (m *webAuthManager) Login(username string, password string, code string, remoteIP string) (webAuthConfig, string, bool, time.Duration, error) {
	m.refreshConfigFromDisk()
	now := m.now()
	normalizedUsername := normalizeLoginUsername(username)
	if wait, ok := m.allowLogin(remoteIP, normalizedUsername, now); !ok {
		return webAuthConfig{}, "", false, wait, errWebAuthRateLimited
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	cfg := cloneWebAuthConfig(m.config)
	if !cfg.IsConfigured() {
		return webAuthConfig{}, "", false, 0, errWebAuthNotConfigured
	}
	user, found := findWebAuthUser(cfg, normalizedUsername)
	if !found || user.Disabled || strings.TrimSpace(user.PasswordHash) == "" {
		wait := m.recordLoginFailure(remoteIP, normalizedUsername, now)
		return webAuthConfig{}, "", false, wait, errWebAuthInvalidCredentials
	}
	if !verifyPassword(user.PasswordHash, strings.TrimSpace(password)) {
		wait := m.recordLoginFailure(remoteIP, normalizedUsername, now)
		return webAuthConfig{}, "", false, wait, errWebAuthInvalidCredentials
	}

	usedRecoveryCode := false
	if user.TOTPEnabled {
		normalizedCode := normalizeUserCode(code)
		if normalizedCode == "" {
			wait := m.recordLoginFailure(remoteIP, normalizedUsername, now)
			return webAuthConfig{}, "", false, wait, errWebAuthInvalidCredentials
		}
		if !m.consumeTOTPCodeForLogin(user.TOTPSecret, normalizedCode, now) {
			nextCfg, consumed := consumeUserRecoveryCode(cfg, normalizedUsername, normalizedCode)
			if !consumed {
				wait := m.recordLoginFailure(remoteIP, normalizedUsername, now)
				return webAuthConfig{}, "", false, wait, errWebAuthInvalidCredentials
			}
			if err := m.saveConfigLocked(nextCfg); err != nil {
				return webAuthConfig{}, "", false, 0, err
			}
			cfg = nextCfg
			m.config = nextCfg
			usedRecoveryCode = true
		}
	}

	sessionID, err := m.sessions.Create(cfg, user.Username, user.Role, now)
	if err != nil {
		return webAuthConfig{}, "", false, 0, err
	}
	m.recordLoginSuccess(remoteIP, normalizedUsername)
	return cfg, sessionID, usedRecoveryCode, 0, nil
}

// normalizeLoginUsername 让旧版只填密码的登录请求继续落到默认管理员账号。
func normalizeLoginUsername(username string) string {
	normalized := webidentity.NormalizeUsername(username)
	if normalized == "" {
		return webDefaultAdminUsername
	}
	return normalized
}

func (m *webAuthManager) allowLogin(remoteIP string, username string, now time.Time) (time.Duration, bool) {
	var wait time.Duration
	for _, key := range loginAttemptKeys(remoteIP, username) {
		if current, ok := m.loginAttempts.allow(key, now); !ok {
			if current > wait {
				wait = current
			}
			return wait, false
		}
	}
	return 0, true
}

func (m *webAuthManager) recordLoginFailure(remoteIP string, username string, now time.Time) time.Duration {
	var wait time.Duration
	for _, key := range loginAttemptKeys(remoteIP, username) {
		if current := m.loginAttempts.recordFailure(key, now); current > wait {
			wait = current
		}
	}
	return wait
}

func (m *webAuthManager) recordLoginSuccess(remoteIP string, username string) {
	for _, key := range loginAttemptKeys(remoteIP, username) {
		m.loginAttempts.recordSuccess(key)
	}
}

func loginAttemptKeys(remoteIP string, username string) []string {
	keys := make([]string, 0, 2)
	if ip := strings.TrimSpace(remoteIP); ip != "" {
		keys = append(keys, "ip:"+ip)
	}
	if user := webidentity.NormalizeUsername(username); user != "" {
		keys = append(keys, "user:"+user)
	}
	return keys
}

func (m *webAuthManager) Logout(sessionID string) {
	m.sessions.Destroy(sessionID)
}

func (m *webAuthManager) ChangePassword(username string, currentPassword string, code string, nextPassword string) (webAuthConfig, string, bool, error) {
	normalizedUsername := webidentity.NormalizeUsername(username)
	if m.passwordManagedByEnvironment && normalizedUsername == webDefaultAdminUsername {
		return webAuthConfig{}, "", false, errWebAuthPasswordManaged
	}
	now := m.now()

	m.mu.Lock()
	defer m.mu.Unlock()

	cfg := cloneWebAuthConfig(m.config)
	if !cfg.IsConfigured() {
		return webAuthConfig{}, "", false, errWebAuthNotConfigured
	}
	user, found := findWebAuthUser(cfg, normalizedUsername)
	if !found || user.Disabled {
		return webAuthConfig{}, "", false, errWebAuthInvalidCredentials
	}
	if !verifyPassword(user.PasswordHash, strings.TrimSpace(currentPassword)) {
		return webAuthConfig{}, "", false, errWebAuthInvalidCredentials
	}

	usedRecoveryCode := false
	if user.TOTPEnabled {
		normalizedCode := normalizeUserCode(code)
		if normalizedCode == "" {
			return webAuthConfig{}, "", false, errWebAuthInvalidCredentials
		}
		// NB: the plain validator, not the login replay guard. A password change
		// already requires the current password, and a user who changes their
		// password then signs in again inside the same TOTP step legitimately
		// reuses the code; rejecting that here would break a normal flow for no
		// security gain the login path does not already cover.
		if !validateTOTPCode(user.TOTPSecret, normalizedCode, now) {
			nextCfg, consumed := consumeUserRecoveryCode(cfg, normalizedUsername, normalizedCode)
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
	if err := setWebAuthUserPassword(&cfg, normalizedUsername, passwordHash); err != nil {
		return webAuthConfig{}, "", false, err
	}
	cfg.UpdatedAt = now.UTC().Format(time.RFC3339)

	if err := m.saveConfigLocked(cfg); err != nil {
		return webAuthConfig{}, "", false, err
	}
	m.config = cfg
	m.sessions.DestroyUser(normalizedUsername)
	role := webRoleViewer
	if updated, ok := findWebAuthUser(cfg, normalizedUsername); ok {
		role = updated.Role
	}
	sessionID, err := m.sessions.Create(cfg, normalizedUsername, role, now)
	if err != nil {
		return webAuthConfig{}, "", false, err
	}
	return cloneWebAuthConfig(cfg), sessionID, usedRecoveryCode, nil
}
