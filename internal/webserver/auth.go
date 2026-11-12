package webserver

import (
	"crypto/subtle"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
)

const (
	webAuthConfigFileName            = "web_auth.json"
	webAuthSchemaVersion             = 2
	webDefaultAdminUsername          = "admin"
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
	webAuthSetupTokenEnvName         = "GONAVI_WEB_SETUP_TOKEN"
	webTOTPPeriodSeconds             = 30
	webTOTPDigits                    = 6
	// webUsedTOTPCodeCap bounds the replay cache: entries live for the ±1-step
	// validation window, so a cap far above any honest concurrent login volume
	// only sweeps expired entries and never turns away a first-use code.
	webUsedTOTPCodeCap = 128
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
	errWebAuthSetupGateRequired  = errors.New("setup gate token is required")
	errWebAuthTOTPAlreadyEnabled = errors.New("two-factor authentication is already enabled")
	errWebAuthTOTPNotEnabled     = errors.New("two-factor authentication is not enabled")
)

type webAuthConfig struct {
	SchemaVersion int  `json:"schemaVersion,omitempty"`
	Enabled       bool `json:"enabled"`
	// Users 是 v2 起的账号列表。v1 的单密码字段保留在下面，仅用于读取旧文件；
	// normalizeWebAuthConfig 会把它们迁移进 Users 并清空，保存时不再落回旧字段。
	Users                []webAuthUser `json:"users,omitempty"`
	PasswordHash         string        `json:"passwordHash,omitempty"`
	TOTPEnabled          bool          `json:"totpEnabled,omitempty"`
	TOTPSecret           string        `json:"totpSecret,omitempty"`
	RecoveryCodeHashes   []string      `json:"recoveryCodeHashes,omitempty"`
	SessionIdleMinutes   int           `json:"sessionIdleMinutes,omitempty"`
	SessionAbsoluteHours int           `json:"sessionAbsoluteHours,omitempty"`
	SessionRememberDays  int           `json:"sessionRememberDays,omitempty"`
	UpdatedAt            string        `json:"updatedAt,omitempty"`
}

// resolveWebSetupGateToken 决定首次初始化的门禁令牌。
// 环境变量优先；未设置时每次启动生成随机值，由启动横幅打印到终端/容器日志。
// 这样即使 0.0.0.0 暴露且尚未配置密码，第一个访问者也无法直接抢注管理员。
// 只监听回环地址时，本机打开根地址的跳转会带上令牌；非回环监听仍然只出现在启动输出里。
func resolveWebSetupGateToken() string {
	if configured := strings.TrimSpace(os.Getenv(webAuthSetupTokenEnvName)); configured != "" {
		return configured
	}
	token, err := generateRandomToken(24)
	if err != nil {
		return ""
	}
	return token
}

// SetupToken 返回首次初始化门禁令牌，供启动横幅打印。
func (m *webAuthManager) SetupToken() string {
	if m == nil {
		return ""
	}
	return m.setupGateToken
}

func (m *webAuthManager) verifySetupGateToken(token string) bool {
	if m == nil {
		return false
	}
	expected := strings.TrimSpace(m.setupGateToken)
	if expected == "" {
		// 令牌生成失败时不能把初始化彻底锁死，退化为旧行为。
		return true
	}
	provided := strings.TrimSpace(token)
	return subtle.ConstantTimeCompare([]byte(expected), []byte(provided)) == 1
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
	cfg.Users = migrateLegacyWebAuthUser(cfg)
	cfg.Users = normalizeWebAuthUsers(cfg.Users)
	cfg.PasswordHash = ""
	cfg.TOTPEnabled = false
	cfg.TOTPSecret = ""
	cfg.RecoveryCodeHashes = nil
	return cfg
}

func (cfg webAuthConfig) IsConfigured() bool {
	if !cfg.Enabled {
		return false
	}
	for _, user := range cfg.Users {
		if !user.Disabled && strings.TrimSpace(user.PasswordHash) != "" {
			return true
		}
	}
	return false
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

func (s *webAuthStore) ModTime() time.Time {
	if s == nil || strings.TrimSpace(s.path) == "" {
		return time.Time{}
	}
	info, err := os.Stat(s.path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
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
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	lock, err := appdata.AcquireFileLock(s.path + ".lock")
	if err != nil {
		return err
	}
	defer func() { _ = lock.Close() }()
	temporary, err := os.CreateTemp(dir, ".web-auth-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temporary.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, s.path)
}

type pendingSetup struct {
	Token         string
	Username      string
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
