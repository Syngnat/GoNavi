package db

import (
	"crypto/tls"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const (
	sslModeDisable    = "disable"
	sslModePreferred  = "preferred"
	sslModeRequired   = "required"
	sslModeSkipVerify = "skip-verify"
)

func normalizeSSLModeValue(raw string) string {
	mode := strings.ToLower(strings.TrimSpace(raw))
	switch mode {
	case "", sslModePreferred, "prefer":
		return sslModePreferred
	case sslModeRequired, "require", "on", "true", "mandatory", "strict":
		return sslModeRequired
	case sslModeSkipVerify, "insecure", "skipverify", "skip_verify", "insecure-skip-verify":
		return sslModeSkipVerify
	case sslModeDisable, "disabled", "off", "false", "none":
		return sslModeDisable
	default:
		return sslModePreferred
	}
}

func normalizedSSLMode(config connection.ConnectionConfig) string {
	if !config.UseSSL {
		return sslModeDisable
	}
	return normalizeSSLModeValue(config.SSLMode)
}

func shouldTrySSLPreferredFallback(config connection.ConnectionConfig) bool {
	return config.UseSSL && normalizeSSLModeValue(config.SSLMode) == sslModePreferred
}

func withSSLDisabled(config connection.ConnectionConfig) connection.ConnectionConfig {
	next := config
	next.UseSSL = false
	next.SSLMode = sslModeDisable
	return next
}

func resolveMySQLTLSMode(config connection.ConnectionConfig) string {
	switch normalizedSSLMode(config) {
	case sslModeDisable:
		return "false"
	case sslModeRequired:
		return "true"
	case sslModeSkipVerify:
		return "skip-verify"
	default:
		return "preferred"
	}
}

func resolvePostgresSSLMode(config connection.ConnectionConfig) string {
	switch normalizedSSLMode(config) {
	case sslModeDisable:
		return "disable"
	case sslModeRequired:
		return "require"
	case sslModeSkipVerify:
		return "require"
	default:
		return "require"
	}
}

func resolveSQLServerTLSSettings(config connection.ConnectionConfig) (encrypt string, trustServerCertificate string) {
	switch normalizedSSLMode(config) {
	case sslModeDisable:
		return "disable", "true"
	case sslModeRequired:
		return "true", "false"
	case sslModeSkipVerify:
		return "true", "true"
	default:
		return "false", "true"
	}
}

func resolveGenericTLSConfig(config connection.ConnectionConfig) *tls.Config {
	switch normalizedSSLMode(config) {
	case sslModeDisable:
		return nil
	case sslModeRequired:
		return &tls.Config{MinVersion: tls.VersionTLS12}
	case sslModeSkipVerify:
		return &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}
	default:
		// Preferred: 先尝试 TLS（为提升兼容性默认跳过证书校验），失败时由调用方按需回退明文。
		return &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}
	}
}

func resolveMongoTLSSettings(config connection.ConnectionConfig) (enabled bool, insecure bool) {
	switch normalizedSSLMode(config) {
	case sslModeDisable:
		return false, false
	case sslModeRequired:
		return true, false
	case sslModeSkipVerify:
		return true, true
	default:
		return true, true
	}
}

func resolveTDengineNet(config connection.ConnectionConfig) string {
	if normalizedSSLMode(config) == sslModeDisable {
		return "ws"
	}
	return "wss"
}
