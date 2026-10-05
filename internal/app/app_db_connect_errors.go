package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

func (a *App) invalidateCachedDatabase(config connection.ConnectionConfig, reason error) bool {
	if effectiveConfig, err := a.resolveEffectiveConnectionConfig(config); err == nil {
		config = effectiveConfig
	}
	effectiveConfig := config
	key := getCacheKey(effectiveConfig)
	shortKey := shortCacheKey(key)

	a.mu.Lock()
	groupKeys := a.cancelDatabaseConnectFlightsLocked(func(flight *databaseConnectFlight) bool {
		return flight.cacheKey == key
	}, errDatabaseConnectionReleased, 0)
	groupKeys = append(groupKeys, key)
	entry, exists := a.dbCache[key]
	if !exists || entry.inst == nil {
		a.forgetDatabaseConnectGroupsLocked(groupKeys)
		a.mu.Unlock()
		return false
	}
	delete(a.dbCache, key)
	a.forgetDatabaseConnectGroupsLocked(groupKeys)
	a.mu.Unlock()

	if closeErr := entry.inst.Close(); closeErr != nil {
		logger.Error(closeErr, "关闭失效缓存连接失败：缓存Key=%s", shortKey)
	}
	if reason != nil {
		logger.Errorf("检测到连接失效，已清理缓存连接：%s 缓存Key=%s 原因=%s", formatConnSummary(effectiveConfig), shortKey, normalizeErrorMessage(reason))
	} else {
		logger.Infof("已清理缓存连接：%s 缓存Key=%s", formatConnSummary(effectiveConfig), shortKey)
	}
	return true
}

func wrapConnectError(config connection.ConnectionConfig, err error) error {
	if err == nil {
		return nil
	}
	err = sanitizeMongoConnectErrorLabel(config, err)

	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		dbName := config.Database
		if dbName == "" {
			dbName = "(default)"
		}
		err = errorMessageOverride{
			message: defaultAppText("db.backend.message.connect_timeout_detail", map[string]any{
				"dbType":   config.Type,
				"host":     config.Host,
				"port":     config.Port,
				"database": dbName,
				"detail":   normalizeErrorMessage(err),
			}),
			cause: err,
		}
	}

	return withLogHint{err: err, logPath: logger.Path()}
}

type errorMessageOverride struct {
	message string
	cause   error
}

type mongoConnectErrorLabelRewrite struct {
	legacy string
	key    string
}

var mongoConnectErrorLabelRewrites = []mongoConnectErrorLabelRewrite{
	{legacy: "SSL \u4e3b\u5e93\u51ed\u636e", key: "db.backend.message.mongo_primary_credentials_label"},
	{legacy: "SSL \u4ece\u5e93\u51ed\u636e", key: "db.backend.message.mongo_replica_credentials_label"},
}

func (e errorMessageOverride) Error() string {
	return e.message
}

func (e errorMessageOverride) Unwrap() error {
	return e.cause
}

func sanitizeMongoConnectErrorLabel(config connection.ConnectionConfig, err error) error {
	if err == nil {
		return nil
	}
	if strings.ToLower(strings.TrimSpace(config.Type)) != "mongodb" {
		return err
	}
	if mongoConnectUsesTLS(config) {
		return err
	}
	original := err.Error()
	rewritten := original
	for _, candidate := range mongoConnectErrorLabelRewrites {
		replacement := defaultAppText(candidate.key, nil)
		if replacement == "" || replacement == candidate.key {
			continue
		}
		rewritten = strings.ReplaceAll(rewritten, candidate.legacy, replacement)
	}
	if rewritten == original {
		return err
	}
	return errorMessageOverride{
		message: rewritten,
		cause:   err,
	}
}

func mongoConnectUsesTLS(config connection.ConnectionConfig) bool {
	if config.UseSSL {
		return true
	}
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return false
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return false
	}
	for _, key := range []string{"tls", "ssl"} {
		if enabled, known := parseMongoBool(parsed.Query().Get(key)); known {
			return enabled
		}
	}
	return strings.EqualFold(strings.TrimSpace(parsed.Scheme), "mongodb+srv")
}

func parseMongoBool(raw string) (enabled bool, known bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	switch value {
	case "1", "true", "t", "yes", "y", "on", "required":
		return true, true
	case "0", "false", "f", "no", "n", "off", "disable", "disabled":
		return false, true
	default:
		return false, false
	}
}

type withLogHint struct {
	err     error
	logPath string
}

func unwrapLogHintError(err error) error {
	if err == nil {
		return nil
	}
	var hinted withLogHint
	if errors.As(err, &hinted) && hinted.err != nil {
		return hinted.err
	}
	return err
}

func (e withLogHint) Error() string {
	message := normalizeErrorMessage(e.err)
	path := strings.TrimSpace(e.logPath)
	if path == "" {
		return message
	}
	info, statErr := os.Stat(path)
	if statErr != nil || info.IsDir() || info.Size() <= 0 {
		return message
	}
	return message + defaultAppText("driver_manager.backend.message.log_hint", map[string]any{"path": path})
}

func (e withLogHint) Unwrap() error {
	return e.err
}

func formatConnSummary(config connection.ConnectionConfig) string {
	timeoutSeconds := config.Timeout
	if timeoutSeconds <= 0 {
		timeoutSeconds = 30
	}

	dbName := config.Database
	if strings.TrimSpace(dbName) == "" {
		dbName = "(default)"
	}

	var b strings.Builder
	normalizedType := strings.ToLower(strings.TrimSpace(config.Type))
	if normalizedType == "sqlite" || normalizedType == "duckdb" {
		path := strings.TrimSpace(config.Host)
		if path == "" {
			path = "(未配置)"
		}
		b.WriteString(fmt.Sprintf("类型=%s 路径=%s 超时=%ds", config.Type, path, timeoutSeconds))
	} else {
		b.WriteString(fmt.Sprintf("类型=%s 地址=%s:%d 数据库=%s 用户=%s 超时=%ds",
			config.Type, config.Host, config.Port, dbName, config.User, timeoutSeconds))
	}

	if len(config.Hosts) > 0 {
		b.WriteString(fmt.Sprintf(" 节点数=%d", len(config.Hosts)))
	}
	if strings.TrimSpace(config.Topology) != "" {
		b.WriteString(fmt.Sprintf(" 拓扑=%s", strings.TrimSpace(config.Topology)))
	}
	if strings.TrimSpace(config.URI) != "" {
		b.WriteString(fmt.Sprintf(" URI=已配置(长度=%d)", len(config.URI)))
	}
	if strings.TrimSpace(config.ConnectionParams) != "" {
		b.WriteString(fmt.Sprintf(" 连接参数=已配置(长度=%d)", len(config.ConnectionParams)))
	}
	if strings.TrimSpace(config.MySQLReplicaUser) != "" {
		b.WriteString(" MySQL从库凭据=已配置")
	}
	if strings.EqualFold(strings.TrimSpace(config.Type), "mongodb") {
		if strings.TrimSpace(config.MongoReplicaUser) != "" {
			b.WriteString(" Mongo从库凭据=已配置")
		}
		if strings.TrimSpace(config.ReplicaSet) != "" {
			b.WriteString(fmt.Sprintf(" 副本集=%s", strings.TrimSpace(config.ReplicaSet)))
		}
		if strings.TrimSpace(config.ReadPreference) != "" {
			b.WriteString(fmt.Sprintf(" 读偏好=%s", strings.TrimSpace(config.ReadPreference)))
		}
		if strings.TrimSpace(config.AuthSource) != "" {
			b.WriteString(fmt.Sprintf(" 认证库=%s", strings.TrimSpace(config.AuthSource)))
		}
	}
	if strings.EqualFold(strings.TrimSpace(config.Type), "clickhouse") {
		protocol := strings.ToLower(strings.TrimSpace(config.ClickHouseProtocol))
		if protocol == "" {
			protocol = "auto"
		}
		b.WriteString(fmt.Sprintf(" ClickHouse协议=%s", protocol))
	}
	if strings.EqualFold(strings.TrimSpace(config.Type), "oceanbase") {
		protocol := "mysql"
		if isOceanBaseOracleProtocol(config) {
			protocol = "oracle"
		}
		b.WriteString(fmt.Sprintf(" OceanBase协议=%s", protocol))
	}

	if config.UseSSH {
		b.WriteString(fmt.Sprintf(" SSH=%s:%d 用户=%s", config.SSH.Host, config.SSH.Port, config.SSH.User))
	}
	if config.UseProxy {
		b.WriteString(fmt.Sprintf(" 代理=%s://%s:%d", strings.ToLower(strings.TrimSpace(config.Proxy.Type)), config.Proxy.Host, config.Proxy.Port))
		if strings.TrimSpace(config.Proxy.User) != "" {
			b.WriteString(" 代理认证=已配置")
		}
	}
	if config.UseHTTPTunnel {
		b.WriteString(fmt.Sprintf(" HTTP隧道=%s", formatHTTPTunnelEndpointForLog(config.HTTPTunnel)))
		if strings.TrimSpace(config.HTTPTunnel.User) != "" {
			b.WriteString(" HTTP隧道认证=已配置")
		}
	}

	if config.Type == "custom" {
		driver := strings.TrimSpace(config.Driver)
		if driver == "" {
			driver = "(未配置)"
		}
		dsnState := "未配置"
		if strings.TrimSpace(config.DSN) != "" {
			dsnState = fmt.Sprintf("已配置(长度=%d)", len(config.DSN))
		}
		b.WriteString(fmt.Sprintf(" 驱动=%s DSN=%s", driver, dsnState))
	}

	return b.String()
}

func formatHTTPTunnelEndpointForLog(config connection.HTTPTunnelConfig) string {
	raw := strings.TrimSpace(config.Host)
	parsed, err := url.Parse(raw)
	if err == nil && parsed.Host != "" && (strings.EqualFold(parsed.Scheme, "http") || strings.EqualFold(parsed.Scheme, "https")) {
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.ForceQuery = false
		parsed.Fragment = ""
		return parsed.String()
	}
	return fmt.Sprintf("%s:%d", raw, config.Port)
}
