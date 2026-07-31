package webserver

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/appdata"
	"github.com/skip2/go-qrcode"
	"golang.org/x/crypto/argon2"
)

const (
	webAuthConfigFileName            = "web_auth.json"
	webAuthSchemaVersion             = 1
	webSessionCookieName             = "gonavi_web_session"
	webSetupTokenTTL                 = 10 * time.Minute
	webLoginFailureWindow            = 10 * time.Minute
	webLoginFailureLimit             = 5
	webLoginAttemptTrackerMaxEntries = 4096
	webLoginBlockDuration            = 5 * time.Minute
	webDefaultSessionIdleMinutes     = 30
	webDefaultSessionAbsoluteHours   = 24 * 7
	webDefaultSessionRememberDays    = 7
	webMinPasswordLength             = 6
	webAuthPasswordEnvName           = "GONAVI_WEB_PASSWORD"
	webTOTPPeriodSeconds             = 30
	webTOTPDigits                    = 6
)

var (
	base32NoPadding              = base32.StdEncoding.WithPadding(base32.NoPadding)
	errWebAuthNotConfigured      = errors.New("web auth is not configured")
	errWebAuthAlreadyConfigured  = errors.New("web auth is already configured")
	errWebAuthSetupExpired       = errors.New("setup token expired")
	errWebAuthInvalidSetup       = errors.New("invalid setup token")
	errWebAuthInvalidCredentials = errors.New("invalid credentials")
	errWebAuthRateLimited        = errors.New("too many login attempts")
	errWebAuthPasswordManaged    = errors.New("web auth password is managed by environment")
)

type webAuthConfig struct {
	SchemaVersion        int      `json:"schemaVersion,omitempty"`
	Enabled              bool     `json:"enabled"`
	PasswordHash         string   `json:"passwordHash,omitempty"`
	TOTPEnabled          bool     `json:"totpEnabled"`
	TOTPSecret           string   `json:"totpSecret,omitempty"`
	RecoveryCodeHashes   []string `json:"recoveryCodeHashes,omitempty"`
	SessionIdleMinutes   int      `json:"sessionIdleMinutes,omitempty"`
	SessionAbsoluteHours int      `json:"sessionAbsoluteHours,omitempty"`
	SessionRememberDays  int      `json:"sessionRememberDays,omitempty"`
	UpdatedAt            string   `json:"updatedAt,omitempty"`
}

func normalizeWebAuthConfig(cfg webAuthConfig) webAuthConfig {
	cfg.SchemaVersion = webAuthSchemaVersion
	if cfg.SessionIdleMinutes < 5 || cfg.SessionIdleMinutes > 24*60 {
		cfg.SessionIdleMinutes = webDefaultSessionIdleMinutes
	}
	if cfg.SessionAbsoluteHours < 1 || cfg.SessionAbsoluteHours > 24*30 {
		cfg.SessionAbsoluteHours = webDefaultSessionAbsoluteHours
	}
	if cfg.SessionRememberDays < 1 || cfg.SessionRememberDays > 30 {
		cfg.SessionRememberDays = webDefaultSessionRememberDays
	}
	if !cfg.Enabled {
		cfg.PasswordHash = ""
		cfg.TOTPEnabled = false
		cfg.TOTPSecret = ""
		cfg.RecoveryCodeHashes = nil
	}
	if !cfg.TOTPEnabled {
		cfg.TOTPSecret = ""
		cfg.RecoveryCodeHashes = nil
	}
	if cfg.RecoveryCodeHashes == nil {
		cfg.RecoveryCodeHashes = []string{}
	}
	return cfg
}

func (cfg webAuthConfig) IsConfigured() bool {
	return cfg.Enabled && strings.TrimSpace(cfg.PasswordHash) != ""
}

func (cfg webAuthConfig) IdleTimeout() time.Duration {
	return time.Duration(cfg.SessionIdleMinutes) * time.Minute
}

func (cfg webAuthConfig) AbsoluteTimeout() time.Duration {
	return time.Duration(cfg.SessionAbsoluteHours) * time.Hour
}

func (cfg webAuthConfig) RememberDuration() time.Duration {
	return time.Duration(cfg.SessionRememberDays) * 24 * time.Hour
}

type webAuthStore struct {
	path string
}

func newWebAuthStore(root string) *webAuthStore {
	trimmed := strings.TrimSpace(root)
	if trimmed == "" {
		trimmed = appdata.MustResolveActiveRoot()
	}
	return &webAuthStore{path: filepath.Join(trimmed, webAuthConfigFileName)}
}

func (s *webAuthStore) Load() (webAuthConfig, error) {
	if s == nil || strings.TrimSpace(s.path) == "" {
		return normalizeWebAuthConfig(webAuthConfig{}), nil
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return normalizeWebAuthConfig(webAuthConfig{}), nil
		}
		return webAuthConfig{}, err
	}
	var cfg webAuthConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return webAuthConfig{}, err
	}
	return normalizeWebAuthConfig(cfg), nil
}

func (s *webAuthStore) Save(cfg webAuthConfig) error {
	if s == nil || strings.TrimSpace(s.path) == "" {
		return fmt.Errorf("web auth store is unavailable")
	}
	cfg = normalizeWebAuthConfig(cfg)
	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(s.path, payload, 0o600); err != nil {
		return err
	}
	return nil
}

type pendingSetup struct {
	Token         string
	Secret        string
	RecoveryCodes []string
	Issuer        string
	AccountName   string
	CreatedAt     time.Time
}

type pendingSetupResponse struct {
	SetupToken           string   `json:"setupToken"`
	Secret               string   `json:"secret"`
	OtpauthURL           string   `json:"otpauthUrl"`
	QRCodeDataURL        string   `json:"qrCodeDataUrl,omitempty"`
	Issuer               string   `json:"issuer"`
	AccountName          string   `json:"accountName"`
	RecoveryCodes        []string `json:"recoveryCodes"`
	SessionIdleMinutes   int      `json:"sessionIdleMinutes"`
	SessionAbsoluteHours int      `json:"sessionAbsoluteHours"`
	SessionRememberDays  int      `json:"sessionRememberDays"`
}

type loginAttemptState struct {
	Failures     []time.Time
	BlockedUntil time.Time
}

type loginAttemptTracker struct {
	mu       sync.Mutex
	attempts map[string]loginAttemptState
}

func newLoginAttemptTracker() *loginAttemptTracker {
	return &loginAttemptTracker{attempts: make(map[string]loginAttemptState)}
}

func (t *loginAttemptTracker) allow(ip string, now time.Time) (time.Duration, bool) {
	normalized := strings.TrimSpace(ip)
	if normalized == "" {
		return 0, true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	state := t.attempts[normalized]
	if state.BlockedUntil.After(now) {
		return state.BlockedUntil.Sub(now), false
	}
	if len(state.Failures) == 0 {
		delete(t.attempts, normalized)
		return 0, true
	}
	kept := state.Failures[:0]
	for _, failureAt := range state.Failures {
		if now.Sub(failureAt) <= webLoginFailureWindow {
			kept = append(kept, failureAt)
		}
	}
	state.Failures = append([]time.Time(nil), kept...)
	if len(state.Failures) == 0 {
		delete(t.attempts, normalized)
		return 0, true
	}
	t.attempts[normalized] = state
	return 0, true
}

func (t *loginAttemptTracker) recordFailure(ip string, now time.Time) time.Duration {
	normalized := strings.TrimSpace(ip)
	if normalized == "" {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	state := t.attempts[normalized]
	kept := state.Failures[:0]
	for _, failureAt := range state.Failures {
		if now.Sub(failureAt) <= webLoginFailureWindow {
			kept = append(kept, failureAt)
		}
	}
	kept = append(kept, now)
	state.Failures = append([]time.Time(nil), kept...)
	if len(state.Failures) >= webLoginFailureLimit {
		state.Failures = nil
		state.BlockedUntil = now.Add(webLoginBlockDuration)
		t.attempts[normalized] = state
		t.sweepExpiredLocked(now)
		return webLoginBlockDuration
	}
	t.attempts[normalized] = state
	t.sweepExpiredLocked(now)
	return 0
}

// sweepExpiredLocked 在条目数超过上限时清理已失效的记录。
// 条目仅在登录成功或同一 key 再次进入 allow() 时才会被删除，
// 分布式来源（僵尸网络）下 map 会单向增长，故补一道容量触发的清扫。
// 调用方必须已持有 t.mu。
func (t *loginAttemptTracker) sweepExpiredLocked(now time.Time) {
	if len(t.attempts) <= webLoginAttemptTrackerMaxEntries {
		return
	}
	for key, state := range t.attempts {
		if state.BlockedUntil.After(now) {
			continue
		}
		fresh := false
		for _, failureAt := range state.Failures {
			if now.Sub(failureAt) <= webLoginFailureWindow {
				fresh = true
				break
			}
		}
		if !fresh {
			delete(t.attempts, key)
		}
	}
}

func (t *loginAttemptTracker) recordSuccess(ip string) {
	normalized := strings.TrimSpace(ip)
	if normalized == "" {
		return
	}
	t.mu.Lock()
	delete(t.attempts, normalized)
	t.mu.Unlock()
}

type webSession struct {
	ID               string
	CreatedAt        time.Time
	LastSeenAt       time.Time
	AbsoluteDeadline time.Time
}

type webSessionManager struct {
	mu       sync.Mutex
	sessions map[string]webSession
}

func newWebSessionManager() *webSessionManager {
	return &webSessionManager{sessions: make(map[string]webSession)}
}

func (m *webSessionManager) Create(cfg webAuthConfig, now time.Time) (string, error) {
	if m == nil {
		return "", fmt.Errorf("web session manager is unavailable")
	}
	sessionID, err := generateRandomToken(32)
	if err != nil {
		return "", err
	}
	session := webSession{
		ID:               sessionID,
		CreatedAt:        now,
		LastSeenAt:       now,
		AbsoluteDeadline: now.Add(cfg.AbsoluteTimeout()),
	}
	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()
	return sessionID, nil
}

func (m *webSessionManager) Authenticate(sessionID string, cfg webAuthConfig, now time.Time) bool {
	normalized := strings.TrimSpace(sessionID)
	if m == nil || normalized == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, session := range m.sessions {
		if now.After(session.AbsoluteDeadline) || now.Sub(session.LastSeenAt) > cfg.IdleTimeout() {
			delete(m.sessions, key)
		}
	}
	session, ok := m.sessions[normalized]
	if !ok {
		return false
	}
	session.LastSeenAt = now
	m.sessions[normalized] = session
	return true
}

func (m *webSessionManager) Destroy(sessionID string) {
	normalized := strings.TrimSpace(sessionID)
	if m == nil || normalized == "" {
		return
	}
	m.mu.Lock()
	delete(m.sessions, normalized)
	m.mu.Unlock()
}

func (m *webSessionManager) DestroyAll() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.sessions = make(map[string]webSession)
	m.mu.Unlock()
}

type webAuthManager struct {
	mu                           sync.RWMutex
	store                        *webAuthStore
	config                       webAuthConfig
	pending                      map[string]pendingSetup
	sessions                     *webSessionManager
	loginAttempts                *loginAttemptTracker
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
		if !validateTOTPCode(cfg.TOTPSecret, normalizedCode, now) {
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

func buildTOTPAccountName(host string) string {
	trimmed := strings.TrimSpace(host)
	if trimmed == "" {
		return "admin@gonavi"
	}
	if parsedHost, _, err := net.SplitHostPort(trimmed); err == nil && strings.TrimSpace(parsedHost) != "" {
		trimmed = parsedHost
	}
	trimmed = strings.TrimSpace(strings.Trim(trimmed, "[]"))
	if trimmed == "" {
		trimmed = "gonavi"
	}
	return "admin@" + trimmed
}

func buildOtpauthURL(issuer string, accountName string, secret string) string {
	normalizedIssuer := strings.TrimSpace(issuer)
	if normalizedIssuer == "" {
		normalizedIssuer = "GoNavi"
	}
	normalizedAccountName := strings.TrimSpace(accountName)
	if normalizedAccountName == "" {
		normalizedAccountName = "admin@gonavi"
	}
	query := url.Values{}
	query.Set("secret", strings.TrimSpace(secret))
	query.Set("issuer", normalizedIssuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", strconv.Itoa(webTOTPDigits))
	query.Set("period", strconv.Itoa(webTOTPPeriodSeconds))
	label := url.PathEscape(normalizedIssuer + ":" + normalizedAccountName)
	return "otpauth://totp/" + label + "?" + query.Encode()
}

func generateQRCodeDataURL(payload string) (string, error) {
	normalized := strings.TrimSpace(payload)
	if normalized == "" {
		return "", fmt.Errorf("qr payload is empty")
	}
	png, err := qrcode.Encode(normalized, qrcode.Medium, 256)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

func generateRandomToken(length int) (string, error) {
	if length <= 0 {
		return "", fmt.Errorf("invalid token length")
	}
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func generateTOTPSecret() (string, error) {
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base32NoPadding.EncodeToString(buf), nil
}

func generateRecoveryCodes(count int) ([]string, error) {
	if count <= 0 {
		return []string{}, nil
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	result := make([]string, 0, count)
	random := make([]byte, count*12)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	for index := 0; index < count; index++ {
		chunk := random[index*12 : (index+1)*12]
		var builder strings.Builder
		builder.Grow(14)
		for offset, value := range chunk {
			if offset == 4 || offset == 8 {
				builder.WriteByte('-')
			}
			builder.WriteByte(alphabet[int(value)%len(alphabet)])
		}
		result = append(result, builder.String())
	}
	return result, nil
}

func hashRecoveryCode(code string) string {
	sum := sha256.Sum256([]byte(normalizeUserCode(code)))
	return hex.EncodeToString(sum[:])
}

func consumeRecoveryCode(cfg webAuthConfig, code string) (webAuthConfig, bool) {
	if !cfg.TOTPEnabled || len(cfg.RecoveryCodeHashes) == 0 {
		return cfg, false
	}
	needle := hashRecoveryCode(code)
	next := cloneWebAuthConfig(cfg)
	next.RecoveryCodeHashes = next.RecoveryCodeHashes[:0]
	consumed := false
	for _, item := range cfg.RecoveryCodeHashes {
		if subtle.ConstantTimeCompare([]byte(item), []byte(needle)) == 1 && !consumed {
			consumed = true
			continue
		}
		next.RecoveryCodeHashes = append(next.RecoveryCodeHashes, item)
	}
	return next, consumed
}

func normalizeUserCode(code string) string {
	replacer := strings.NewReplacer(" ", "", "-", "", "\t", "", "\r", "", "\n", "")
	return strings.ToUpper(strings.TrimSpace(replacer.Replace(code)))
}

func validateTOTPCode(secret string, code string, now time.Time) bool {
	normalizedSecret := strings.ToUpper(strings.TrimSpace(secret))
	normalizedCode := normalizeUserCode(code)
	if normalizedSecret == "" || normalizedCode == "" {
		return false
	}
	for offset := -1; offset <= 1; offset++ {
		expected, err := generateTOTPCodeAt(normalizedSecret, now.Add(time.Duration(offset)*webTOTPPeriodSeconds*time.Second))
		if err != nil {
			return false
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(normalizedCode)) == 1 {
			return true
		}
	}
	return false
}

func generateTOTPCodeAt(secret string, now time.Time) (string, error) {
	key, err := base32NoPadding.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", err
	}
	counter := uint64(now.Unix() / webTOTPPeriodSeconds)
	var counterBytes [8]byte
	binary.BigEndian.PutUint64(counterBytes[:], counter)
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(counterBytes[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	binaryCode := (int(sum[offset])&0x7f)<<24 |
		(int(sum[offset+1])&0xff)<<16 |
		(int(sum[offset+2])&0xff)<<8 |
		(int(sum[offset+3]) & 0xff)
	code := binaryCode % 1000000
	return fmt.Sprintf("%06d", code), nil
}

func normalizeWebAuthPassword(password string) (string, error) {
	normalized := strings.TrimSpace(password)
	if normalized == "" {
		return "", fmt.Errorf("password is required")
	}
	if utf8.RuneCountInString(normalized) < webMinPasswordLength {
		return "", fmt.Errorf("password must be at least %d characters", webMinPasswordLength)
	}
	return normalized, nil
}

func hashPassword(password string) (string, error) {
	normalized, err := normalizeWebAuthPassword(password)
	if err != nil {
		return "", err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	const (
		timeCost    uint32 = 3
		memoryCost  uint32 = 64 * 1024
		parallelism uint8  = 2
		keyLen      uint32 = 32
	)
	key := argon2.IDKey([]byte(normalized), salt, timeCost, memoryCost, parallelism, keyLen)
	return fmt.Sprintf(
		"argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		memoryCost,
		timeCost,
		parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

func verifyPassword(encodedHash string, password string) bool {
	parts := strings.Split(strings.TrimSpace(encodedHash), "$")
	if len(parts) != 5 || parts[0] != "argon2id" || parts[1] != "v=19" {
		return false
	}
	params := strings.Split(parts[2], ",")
	if len(params) != 3 {
		return false
	}
	memoryText := strings.TrimPrefix(params[0], "m=")
	timeText := strings.TrimPrefix(params[1], "t=")
	parallelText := strings.TrimPrefix(params[2], "p=")
	memoryCost, err := strconv.ParseUint(memoryText, 10, 32)
	if err != nil {
		return false
	}
	timeCost, err := strconv.ParseUint(timeText, 10, 32)
	if err != nil {
		return false
	}
	parallelism, err := strconv.ParseUint(parallelText, 10, 8)
	if err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	expectedKey, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	derivedKey := argon2.IDKey(
		[]byte(strings.TrimSpace(password)),
		salt,
		uint32(timeCost),
		uint32(memoryCost),
		uint8(parallelism),
		uint32(len(expectedKey)),
	)
	return subtle.ConstantTimeCompare(derivedKey, expectedKey) == 1
}

func readSessionCookie(r *http.Request) (string, bool) {
	if r == nil {
		return "", false
	}
	cookie, err := r.Cookie(webSessionCookieName)
	if err != nil {
		return "", false
	}
	value := strings.TrimSpace(cookie.Value)
	return value, value != ""
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, sessionID string, cfg webAuthConfig, now time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     webSessionCookieName,
		Value:    sessionID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   isSecureRequest(r),
		Expires:  now.Add(cfg.RememberDuration()),
		MaxAge:   int(cfg.RememberDuration().Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     webSessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   isSecureRequest(r),
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

func isSecureRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Ssl")), "on")
}

// webTrustedProxiesEnvName 配置可信反向代理的 IP / CIDR 列表（逗号分隔）。
// 只有当直连对端命中该列表时，X-Forwarded-For 才会被采信。
const webTrustedProxiesEnvName = "GONAVI_WEB_TRUSTED_PROXIES"

var (
	trustedProxyOnce sync.Once
	trustedProxyNets []*net.IPNet
)

func loadTrustedProxyNets() []*net.IPNet {
	trustedProxyOnce.Do(func() {
		raw := strings.TrimSpace(os.Getenv(webTrustedProxiesEnvName))
		if raw == "" {
			return
		}
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if _, network, err := net.ParseCIDR(part); err == nil && network != nil {
				trustedProxyNets = append(trustedProxyNets, network)
				continue
			}
			if ip := net.ParseIP(part); ip != nil {
				bits := 32
				if ip.To4() == nil {
					bits = 128
				}
				trustedProxyNets = append(trustedProxyNets, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			}
		}
	})
	return trustedProxyNets
}

func isTrustedProxyAddr(text string) bool {
	ip := net.ParseIP(strings.TrimSpace(text))
	if ip == nil {
		return false
	}
	for _, network := range loadTrustedProxyNets() {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// peerIP 返回不可伪造的直连对端地址。
func peerIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && strings.TrimSpace(host) != "" {
		return strings.TrimSpace(host)
	}
	return strings.TrimSpace(r.RemoteAddr)
}

// clientIP 返回用于登录限流与锁定的客户端标识。
//
// 必须以不可伪造的对端地址为准：X-Forwarded-For 完全由客户端控制，原实现无条件采信其首值，
// 直连攻击者每次请求换一个值即可拿到全新的限流桶，从而彻底绕过 5 次失败锁定
// （口令下限仅 webMinPasswordLength=6，可在线爆破），并使 attempts map 无界增长；
// 同时每次尝试都会在校验路径上触发一次 64 MiB 的 Argon2id 推导，形成认证面的 CPU/内存 DoS。
//
// 仅当对端 IP 命中 GONAVI_WEB_TRUSTED_PROXIES 时，才从 X-Forwarded-For 里取「最右侧的
// 非可信跳」作为真实客户端——右侧是代理追加的、可信的部分，左侧可被客户端预先伪造。
func clientIP(r *http.Request) string {
	peer := peerIP(r)
	if peer == "" || !isTrustedProxyAddr(peer) {
		return peer
	}
	parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(parts) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(parts[i])
		if candidate == "" || isTrustedProxyAddr(candidate) {
			continue
		}
		if net.ParseIP(candidate) == nil {
			// 非法值不予采信，避免攻击者用任意字符串制造新的限流桶。
			continue
		}
		return candidate
	}
	return peer
}
