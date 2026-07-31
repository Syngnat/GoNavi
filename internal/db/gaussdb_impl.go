//go:build gonavi_full_drivers || gonavi_gaussdb_driver

package db

import (
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/internal/utils"

	_ "github.com/HuaweiCloudDeveloper/gaussdb-go/stdlib"
)

const defaultGaussDBPort = 5432

// GaussDB 使用独立 gaussdb:// URI 与官方 database/sql 驱动，
// 元数据与大多数 SQL 行为按 PG-like 路径复用。
type GaussDB struct {
	PostgresDB
}

func applyGaussDBURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return config
	}
	parsed, ok := parseConnectionURI(uriText, "gaussdb", "postgres", "postgresql")
	if !ok {
		return config
	}

	if parsed.User != nil {
		if config.User == "" {
			config.User = parsed.User.Username()
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}

	if dbName := strings.TrimPrefix(parsed.Path, "/"); dbName != "" && config.Database == "" {
		config.Database = dbName
	}

	defaultPort := config.Port
	if defaultPort <= 0 {
		defaultPort = defaultGaussDBPort
	}
	if strings.TrimSpace(config.Host) == "" && strings.TrimSpace(parsed.Host) != "" {
		host, port, ok := parseHostPortWithDefault(parsed.Host, defaultPort)
		if ok {
			config.Host = host
			config.Port = port
		}
	}
	if config.Port <= 0 {
		config.Port = defaultGaussDBPort
	}

	return config
}

func (g *GaussDB) getDSN(config connection.ConnectionConfig) string {
	runConfig := applyGaussDBURI(config)
	dbname := runConfig.Database
	if dbname == "" {
		dbname = "postgres"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultGaussDBPort
	}
	if strings.TrimSpace(runConfig.Host) != "" {
		if host, port, err := net.SplitHostPort(runConfig.Host); err == nil {
			runConfig.Host = host
			if p, convErr := strconv.Atoi(port); convErr == nil && p > 0 {
				runConfig.Port = p
			}
		}
	}

	u := &url.URL{
		Scheme: "gaussdb",
		Host:   net.JoinHostPort(runConfig.Host, strconv.Itoa(runConfig.Port)),
		Path:   "/" + dbname,
	}
	u.User = url.UserPassword(runConfig.User, runConfig.Password)
	q := url.Values{}
	q.Set("sslmode", resolvePostgresSSLMode(runConfig))
	applyPostgresSSLPathParams(q, runConfig)
	q.Set("connect_timeout", strconv.Itoa(getConnectTimeoutSeconds(runConfig)))
	mergeConnectionParamsFromConfigWithAllowlist(q, runConfig, postgresConnectionParamNames, "gaussdb", "postgres", "postgresql")
	u.RawQuery = q.Encode()

	return u.String()
}

func (g *GaussDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = g.Close()
	defer func() {
		if err != nil {
			_ = g.Close()
		}
	}()

	if supported, reason := DriverRuntimeSupportStatus("gaussdb"); !supported {
		if strings.TrimSpace(reason) == "" {
			reason = localizedDriverRuntimeText("driver_manager.backend.status.optional_disabled", map[string]any{"name": "GaussDB"})
		}
		return fmt.Errorf("%s", reason)
	}

	runConfig := applyGaussDBURI(config)
	g.pingTimeout = getConnectTimeout(runConfig)

	if runConfig.UseSSH {
		logger.Infof("GaussDB 使用 SSH 连接：地址=%s:%d 用户=%s", runConfig.Host, runConfig.Port, runConfig.User)

		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		g.forwarder = forwarder

		host, portStr, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}

		port, err := strconv.Atoi(portStr)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}

		localConfig := runConfig
		localConfig.Host = host
		localConfig.Port = port
		localConfig.UseSSH = false

		runConfig = localConfig
		logger.Infof("GaussDB 通过本地端口转发连接：%s -> %s:%d", forwarder.LocalAddr, config.Host, config.Port)
	}

	sslAttempts := []connection.ConnectionConfig{runConfig}
	if shouldTrySSLPreferredFallback(runConfig) {
		sslAttempts = append(sslAttempts, withSSLDisabled(runConfig))
	}

	var failures []string
	for sslIndex, sslConfig := range sslAttempts {
		sslLabel := "SSL"
		if sslIndex > 0 {
			sslLabel = "明文回退"
		}

		attemptDBs := resolvePostgresConnectDatabases(sslConfig)
		for _, dbName := range attemptDBs {
			attemptConfig := sslConfig
			attemptConfig.Database = dbName
			dsn := g.getDSN(attemptConfig)

			dbConn, err := sql.Open("gaussdb", dsn)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s 数据库=%s 打开连接失败: %v", sslLabel, dbName, err))
				continue
			}
			configureSQLConnectionPool(dbConn, "gaussdb")
			g.conn = dbConn

			if err := g.Ping(); err != nil {
				failures = append(failures, fmt.Sprintf("%s 数据库=%s 验证失败: %v", sslLabel, dbName, err))
				_ = dbConn.Close()
				g.conn = nil
				continue
			}

			if sslIndex > 0 {
				logger.Warnf("GaussDB SSL 优先连接失败，已回退至明文连接")
			}
			if strings.TrimSpace(config.Database) == "" && !strings.EqualFold(dbName, "postgres") {
				logger.Infof("GaussDB 自动选择连接数据库：%s", dbName)
			}

			g.ensureSearchPath(dsn)

			return nil
		}
	}

	if len(failures) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的连接数据库")
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (g *GaussDB) ensureSearchPath(baseDSN string) {
	if g.conn == nil {
		return
	}

	rawSchemas := g.queryUserSchemas()
	if len(rawSchemas) == 0 {
		return
	}

	searchPathSQL, normalizedSchemas := buildKingbaseSearchPathCommon(rawSchemas)
	if strings.TrimSpace(searchPathSQL) == "" {
		return
	}

	searchPathDSNVal := strings.Join(normalizedSchemas, ",")
	u, parseErr := url.Parse(baseDSN)
	if parseErr == nil {
		q := u.Query()
		q.Set("search_path", searchPathDSNVal)
		u.RawQuery = q.Encode()
		newDSN := u.String()

		newDB, err := sql.Open("gaussdb", newDSN)
		if err == nil {
			configureSQLConnectionPool(newDB, "gaussdb")
			newDB.SetConnMaxLifetime(5 * time.Minute)
			oldConn := g.conn
			g.conn = newDB
			if err := g.Ping(); err == nil {
				_ = oldConn.Close()
				logger.Infof("GaussDB 已通过 DSN 配置 search_path：%s", searchPathDSNVal)
				return
			}
			_ = newDB.Close()
			g.conn = oldConn
			logger.Warnf("GaussDB DSN search_path 验证失败，回退至 SET 方式")
		}
	}

	timeout := g.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()

	if _, err := g.conn.ExecContext(ctx, fmt.Sprintf("SET search_path TO %s", searchPathSQL)); err != nil {
		logger.Warnf("GaussDB 设置 search_path 失败：%v", err)
		return
	}
	logger.Infof("GaussDB 已通过 SET 设置 search_path：%s", searchPathSQL)
}
