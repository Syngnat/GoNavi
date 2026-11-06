package webserver

import (
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/webidentity"
)

// webTOTPSetupResponse 是普通账号自助绑定 TOTP 的返回体。
type webTOTPSetupResponse struct {
	SetupToken    string   `json:"setupToken"`
	Secret        string   `json:"secret"`
	OtpauthURL    string   `json:"otpauthUrl"`
	QRCodeDataURL string   `json:"qrCodeDataUrl"`
	RecoveryCodes []string `json:"recoveryCodes"`
}

// UserTOTPEnabled 返回账号当前的 TOTP 状态。
func (m *webAuthManager) UserTOTPEnabled(username string) bool {
	if m == nil {
		return false
	}
	m.refreshConfigFromDisk()
	m.mu.RLock()
	defer m.mu.RUnlock()
	user, ok := findWebAuthUser(m.config, username)
	return ok && user.TOTPEnabled
}

// BeginTOTPSetup 校验当前密码后生成一次性绑定信息。
func (m *webAuthManager) BeginTOTPSetup(username string, password string, host string) (webTOTPSetupResponse, error) {
	m.refreshConfigFromDisk()
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()

	cfg := cloneWebAuthConfig(m.config)
	if !cfg.IsConfigured() {
		return webTOTPSetupResponse{}, errWebAuthNotConfigured
	}
	username = webidentity.NormalizeUsername(username)
	user, ok := findWebAuthUser(cfg, username)
	if !ok || user.Disabled {
		return webTOTPSetupResponse{}, errWebAuthInvalidCredentials
	}
	if !verifyPassword(user.PasswordHash, strings.TrimSpace(password)) {
		return webTOTPSetupResponse{}, errWebAuthInvalidCredentials
	}
	if user.TOTPEnabled {
		return webTOTPSetupResponse{}, errWebAuthTOTPAlreadyEnabled
	}

	token, err := generateRandomToken(24)
	if err != nil {
		return webTOTPSetupResponse{}, err
	}
	secret, err := generateTOTPSecret()
	if err != nil {
		return webTOTPSetupResponse{}, err
	}
	recoveryCodes, err := generateRecoveryCodes(8)
	if err != nil {
		return webTOTPSetupResponse{}, err
	}
	accountName := buildUserTOTPAccountName(username, host)
	otpauthURL := buildOtpauthURL("GoNavi", accountName, secret)
	qrCodeDataURL, err := generateQRCodeDataURL(otpauthURL)
	if err != nil {
		return webTOTPSetupResponse{}, err
	}

	m.cleanupPendingTOTPLocked(now)
	m.pendingTOTP[token] = pendingSetup{
		Token:         token,
		Username:      username,
		Secret:        secret,
		RecoveryCodes: recoveryCodes,
		Issuer:        "GoNavi",
		AccountName:   accountName,
		CreatedAt:     now,
	}
	return webTOTPSetupResponse{
		SetupToken:    token,
		Secret:        secret,
		OtpauthURL:    otpauthURL,
		QRCodeDataURL: qrCodeDataURL,
		RecoveryCodes: append([]string(nil), recoveryCodes...),
	}, nil
}

// CompleteTOTPSetup 校验一次动态码后把密钥与恢复码写入账号。
func (m *webAuthManager) CompleteTOTPSetup(username string, token string, code string) (webAuthConfig, error) {
	m.refreshConfigFromDisk()
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()

	cfg := cloneWebAuthConfig(m.config)
	if !cfg.IsConfigured() {
		return webAuthConfig{}, errWebAuthNotConfigured
	}
	username = webidentity.NormalizeUsername(username)
	token = strings.TrimSpace(token)
	setup, ok := m.pendingTOTP[token]
	if !ok || setup.Username != username {
		return webAuthConfig{}, errWebAuthInvalidSetup
	}
	if now.Sub(setup.CreatedAt) > webSetupTokenTTL {
		delete(m.pendingTOTP, token)
		return webAuthConfig{}, errWebAuthSetupExpired
	}
	if !validateTOTPCode(setup.Secret, code, now) {
		return webAuthConfig{}, fmt.Errorf("invalid google authenticator code")
	}
	index, ok := findWebAuthUserIndex(cfg, username)
	if !ok {
		return webAuthConfig{}, errWebAuthInvalidCredentials
	}
	if cfg.Users[index].TOTPEnabled {
		return webAuthConfig{}, errWebAuthTOTPAlreadyEnabled
	}
	cfg.Users[index].TOTPEnabled = true
	cfg.Users[index].TOTPSecret = setup.Secret
	cfg.Users[index].RecoveryCodeHashes = make([]string, 0, len(setup.RecoveryCodes))
	for _, item := range setup.RecoveryCodes {
		cfg.Users[index].RecoveryCodeHashes = append(cfg.Users[index].RecoveryCodeHashes, hashRecoveryCode(item))
	}
	cfg.Users[index].UpdatedAt = now.UTC().Format(time.RFC3339)
	cfg.UpdatedAt = now.UTC().Format(time.RFC3339)
	if err := m.saveConfigLocked(cfg); err != nil {
		return webAuthConfig{}, err
	}
	m.config = cfg
	delete(m.pendingTOTP, token)
	return cloneWebAuthConfig(cfg), nil
}

// DisableTOTP 校验密码与当前动态码/恢复码后关闭两步验证。
func (m *webAuthManager) DisableTOTP(username string, password string, code string) (webAuthConfig, error) {
	m.refreshConfigFromDisk()
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()

	cfg := cloneWebAuthConfig(m.config)
	if !cfg.IsConfigured() {
		return webAuthConfig{}, errWebAuthNotConfigured
	}
	username = webidentity.NormalizeUsername(username)
	user, ok := findWebAuthUser(cfg, username)
	if !ok || user.Disabled {
		return webAuthConfig{}, errWebAuthInvalidCredentials
	}
	if !verifyPassword(user.PasswordHash, strings.TrimSpace(password)) {
		return webAuthConfig{}, errWebAuthInvalidCredentials
	}
	if !user.TOTPEnabled {
		return webAuthConfig{}, errWebAuthTOTPNotEnabled
	}
	normalizedCode := normalizeUserCode(code)
	if !validateTOTPCode(user.TOTPSecret, normalizedCode, now) {
		nextCfg, consumed := consumeUserRecoveryCode(cfg, username, normalizedCode)
		if !consumed {
			return webAuthConfig{}, errWebAuthInvalidCredentials
		}
		cfg = nextCfg
	}
	index, ok := findWebAuthUserIndex(cfg, username)
	if !ok {
		return webAuthConfig{}, errWebAuthInvalidCredentials
	}
	cfg.Users[index].TOTPEnabled = false
	cfg.Users[index].TOTPSecret = ""
	cfg.Users[index].RecoveryCodeHashes = nil
	cfg.Users[index].UpdatedAt = now.UTC().Format(time.RFC3339)
	cfg.UpdatedAt = now.UTC().Format(time.RFC3339)
	if err := m.saveConfigLocked(cfg); err != nil {
		return webAuthConfig{}, err
	}
	m.config = cfg
	return cloneWebAuthConfig(cfg), nil
}

func (m *webAuthManager) cleanupPendingTOTPLocked(now time.Time) {
	for key, item := range m.pendingTOTP {
		if now.Sub(item.CreatedAt) > webSetupTokenTTL {
			delete(m.pendingTOTP, key)
		}
	}
}

// buildUserTOTPAccountName 把账号名写进 otpauth URL，避免多个账号共用 admin@host。
func buildUserTOTPAccountName(username string, host string) string {
	base := buildTOTPAccountName(host)
	if at := strings.LastIndex(base, "@"); at >= 0 {
		return username + base[at:]
	}
	return username + "@gonavi"
}
