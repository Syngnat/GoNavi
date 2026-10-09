//go:build gonavi_full_drivers || gonavi_gbase8c_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"

	_ "github.com/HuaweiCloudDeveloper/gaussdb-go/stdlib"
)

const defaultGBase8cPort = 15400

// GBase8cDB 接入 GBase 8c（南大通用，openGauss 内核）。服务端默认只接受 sha256 / sm3 口令认证，
// lib/pq 无法登录，连接池改用 gaussdb-go；查询、网格编辑与触发器等元数据复用 PostgresDB，
// 列、索引、表清单与建表语句换成 PostgreSQL 9.2 内核可执行的写法（gbase8c_metadata.go）。
type GBase8cDB struct {
	PostgresDB
	driverVariantState
}

var (
	_ Database              = (*GBase8cDB)(nil)
	_ DriverVariantReporter = (*GBase8cDB)(nil)
)

var openGBase8cPool = sql.Open

func (g *GBase8cDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&g.PostgresDB, ctx)
}

func (g *GBase8cDB) clearMetadataContext() {
	ClearMetadataContext(&g.PostgresDB)
}

// Connect 按 PostgreSQL 的连接链路（SSH、SSL 优先回退明文、未指定库时依次尝试 postgres / template1 / 用户同名库）
// 建立 gaussdb-go 连接池，识别版本后把用户 schema 写进 search_path。
func (g *GBase8cDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = g.Close()
	defer func() {
		if err != nil {
			_ = g.Close()
		}
	}()

	runConfig := rewriteURIScheme(config, "postgresql", "gbase8c")
	if runConfig.Port <= 0 {
		runConfig.Port = defaultGBase8cPort
	}
	g.pingTimeout = getConnectTimeout(runConfig)
	if runConfig.UseSSH {
		forwarder, err := ssh.AcquireLocalForwarder(runConfig.SSH, runConfig.Host, runConfig.Port)
		if err != nil {
			return fmt.Errorf("创建 SSH 隧道失败：%w", err)
		}
		g.forwarder = forwarder
		host, portText, err := net.SplitHostPort(forwarder.LocalAddr)
		if err != nil {
			return fmt.Errorf("解析本地转发地址失败：%w", err)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return fmt.Errorf("解析本地端口失败：%w", err)
		}
		runConfig.Host, runConfig.Port, runConfig.UseSSH = host, port, false
	}

	dsn, err := g.openPool(runConfig)
	if err != nil {
		return err
	}
	version := g.queryVersion()
	if err := g.resolve("gbase8c", config, version); err != nil {
		return err
	}
	if err := g.applySearchPath(config, dsn); err != nil {
		logger.Warnf("GBase 8c 配置 search_path 失败，沿用服务端默认值：%v", err)
	}
	return nil
}

// openPool 逐个尝试 SSL / 明文与候选库，返回成功连接所用的 DSN。
func (g *GBase8cDB) openPool(config connection.ConnectionConfig) (string, error) {
	attempts := []connection.ConnectionConfig{config}
	if shouldTrySSLPreferredFallback(config) {
		attempts = append(attempts, withSSLDisabled(config))
	}
	var failures []string
	for _, attempt := range attempts {
		for _, database := range resolvePostgresConnectDatabases(attempt) {
			candidate := attempt
			candidate.Database = database
			dsn := gbase8cDSN(candidate)
			pool, err := openGBase8cPool("gaussdb", dsn)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s: %v", database, err))
				continue
			}
			configureSQLConnectionPool(pool, "gbase8c", candidate)
			g.conn = pool
			if err := g.Ping(); err != nil {
				failures = append(failures, fmt.Sprintf("%s [sslmode=%s]: %v", database, resolvePostgresSSLMode(candidate), err))
				_ = pool.Close()
				g.conn = nil
				continue
			}
			return dsn, nil
		}
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.gbase8c_connect_failed", map[string]any{"detail": strings.Join(failures, "; ")})
}

// gbase8cDSN 生成 gaussdb-go 的连接串；连接参数沿用 PostgreSQL 的白名单（search_path、application_name 等）。
func gbase8cDSN(config connection.ConnectionConfig) string {
	database := config.Database
	if database == "" {
		database = "postgres"
	}
	u := &url.URL{
		Scheme: "gaussdb",
		Host:   net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		Path:   "/" + database,
		User:   url.UserPassword(config.User, config.Password),
	}
	q := url.Values{}
	q.Set("sslmode", resolvePostgresSSLMode(config))
	applyPostgresSSLPathParams(q, config)
	q.Set("connect_timeout", strconv.Itoa(getConnectTimeoutSeconds(config)))
	mergeConnectionParamsFromConfigWithAllowlist(q, config, postgresConnectionParamNames, "postgresql", "postgres", "gbase8c")
	u.RawQuery = q.Encode()
	return u.String()
}

// gbase8cVersionPattern 匹配 version() 里的产品版本，例如 "(single_node GBase8cV5 S5.0.0B28 build 51dce1ce)"、
// "GBase8cV5 S3.0.0B76"、"GBase 8c V5 3.0.0"。
var gbase8cVersionPattern = regexp.MustCompile(`(?i)GBase\s*8c\s*(?:V\d+)?\s*S?(\d+(?:\.\d+)+)(?:B(\d+))?`)

// parseGBase8cVersion 返回产品版本号（如 "5.0.0"）；识别不到时返回空串。
func parseGBase8cVersion(banner string) string {
	match := gbase8cVersionPattern.FindStringSubmatch(banner)
	if match == nil {
		return ""
	}
	return match[1]
}

func (g *GBase8cDB) queryVersion() string {
	rows, _, err := g.PostgresDB.Query("SELECT version() AS version")
	if err != nil {
		logger.Warnf("GBase 8c 版本识别失败：%v", err)
		return ""
	}
	return parseGBase8cVersion(fmt.Sprint(FirstQueryRowValue(rows)))
}

// applySearchPath 把用户 schema 追加在服务端默认的 "$user", public 之后写进 DSN，让连接池里每条连接都能直接引用
// 各 schema 下的表；内部 schema（dbe_perf、blockchain、Oracle 兼容扩展带入的 dbms_* 等）不加入，避免
// current_schema 落到内部 schema 上。用户在连接参数里写了 search_path 时不改动。
func (g *GBase8cDB) applySearchPath(config connection.ConnectionConfig, dsn string) error {
	if postgresDSNHasExplicitSearchPath(dsn) {
		return nil
	}
	rows, _, err := g.PostgresDB.Query(gbase8cUserSchemasQuery)
	if err != nil {
		return err
	}
	schemas := make([]string, 0, len(rows))
	for _, row := range rows {
		if name := strings.TrimSpace(fmt.Sprint(row["nspname"])); name != "" && name != "public" {
			schemas = append(schemas, name)
		}
	}
	if len(schemas) == 0 {
		return nil
	}
	searchPathDSN, err := postgresDSNWithSearchPath(dsn, gbase8cSearchPath(schemas))
	if err != nil {
		return err
	}
	pool, err := openGBase8cPool("gaussdb", searchPathDSN)
	if err != nil {
		return err
	}
	configureSQLConnectionPool(pool, "gbase8c", config)
	applySQLSearchPathPoolLifetimeCap(pool, config)
	previous := g.conn
	g.conn = pool
	if err := g.Ping(); err != nil {
		_ = pool.Close()
		g.conn = previous
		return err
	}
	_ = previous.Close()
	return nil
}

// gbase8cSearchPath 生成 "$user", public, "s1", "s2" 形式的 search_path。
func gbase8cSearchPath(schemas []string) string {
	parts := []string{`"$user"`, "public"}
	for _, schema := range schemas {
		parts = append(parts, `"`+strings.ReplaceAll(schema, `"`, `""`)+`"`)
	}
	return strings.Join(parts, ", ")
}
