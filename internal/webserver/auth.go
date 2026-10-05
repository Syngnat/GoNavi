package webserver

import (
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
