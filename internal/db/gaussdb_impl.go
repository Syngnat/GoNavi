//go:build gonavi_full_drivers || gonavi_gaussdb_driver

package db

import (
	"context"
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

	_ "github.com/HuaweiCloudDeveloper/gaussdb-go/stdlib"
)

const defaultGaussDBPort = 5432

// GaussDB 使用独立 gaussdb:// URI 与官方 database/sql 驱动，
// 元数据与大多数 SQL 行为按 PG-like 路径复用。
type GaussDB struct {
	PostgresDB
}

var (
	openGaussDB                 = sql.Open
	gaussDBRuntimeSupportStatus = DriverRuntimeSupportStatus
)

func (g *GaussDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&g.PostgresDB, ctx)
}

func (g *GaussDB) clearMetadataContext() {
	ClearMetadataContext(&g.PostgresDB)
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

	if supported, reason := gaussDBRuntimeSupportStatus("gaussdb"); !supported {
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

			dbConn, err := openGaussDB("gaussdb", dsn)
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

			if err := g.ensureSearchPath(dsn); err != nil {
				failures = append(failures, fmt.Sprintf("%s 数据库=%s 配置 search_path 失败: %v", sslLabel, dbName, err))
				if g.conn != nil {
					_ = g.conn.Close()
					g.conn = nil
				}
				continue
			}

			return nil
		}
	}

	if len(failures) == 0 {
		return fmt.Errorf("连接建立后验证失败：未找到可用的连接数据库")
	}
	return fmt.Errorf("连接建立后验证失败：%s", strings.Join(failures, "；"))
}

func (g *GaussDB) ensureSearchPath(baseDSN string) error {
	if g.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	if postgresDSNHasExplicitSearchPath(baseDSN) {
		return nil
	}

	rawSchemas, err := g.queryUserSchemas()
	if err != nil {
		return fmt.Errorf("查询用户 schema 失败：%w", err)
	}
	if len(rawSchemas) == 0 {
		return nil
	}

	searchPathSQL, _ := buildKingbaseSearchPathCommon(rawSchemas)
	if strings.TrimSpace(searchPathSQL) == "" {
		return nil
	}

	newDSN, err := postgresDSNWithSearchPath(baseDSN, searchPathSQL)
	if err != nil {
		return err
	}

	newDB, err := openGaussDB("gaussdb", newDSN)
	if err != nil {
		return fmt.Errorf("打开带 search_path 的连接失败: %w", err)
	}
	configureSQLConnectionPool(newDB, "gaussdb")
	newDB.SetConnMaxLifetime(5 * time.Minute)
	oldConn := g.conn
	g.conn = newDB
	if err := g.Ping(); err != nil {
		_ = newDB.Close()
		g.conn = oldConn
		return fmt.Errorf("验证带 search_path 的连接失败: %w", err)
	}

	_ = oldConn.Close()
	logger.Infof("GaussDB 已通过 DSN 配置 search_path：%s", searchPathSQL)
	return nil
}
