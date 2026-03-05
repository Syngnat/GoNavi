//go:build gonavi_full_drivers

package db

import (
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestPostgresDSN_EscapesPassword(t *testing.T) {
	p := &PostgresDB{}
	cfg := connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "user",
		Password: "p@ss:wo/rd",
		Database: "db",
	}

	dsn := p.getDSN(cfg)
	if strings.Contains(dsn, cfg.Password) {
		t.Fatalf("dsn 包含原始密码：%s", dsn)
	}
	if !strings.Contains(dsn, "p%40ss%3Awo%2Frd") {
		t.Fatalf("dsn 未正确转义密码：%s", dsn)
	}
	if !strings.Contains(dsn, "sslmode=disable") {
		t.Fatalf("dsn 缺少 sslmode 参数：%s", dsn)
	}
}

func TestPostgresDSN_SSLModeRequireWhenEnabled(t *testing.T) {
	p := &PostgresDB{}
	cfg := connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "user",
		Password: "pass",
		Database: "db",
		UseSSL:   true,
		SSLMode:  "required",
	}

	dsn := p.getDSN(cfg)
	if !strings.Contains(dsn, "sslmode=require") {
		t.Fatalf("dsn 缺少 sslmode=require 参数：%s", dsn)
	}
}

func TestMySQLDSN_UsesTLSParamWhenSSLEnabled(t *testing.T) {
	m := &MySQLDB{}
	cfg := connection.ConnectionConfig{
		Type:     "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		User:     "root",
		Password: "pass",
		Database: "db",
		UseSSL:   true,
		SSLMode:  "required",
	}

	dsn := m.getDSN(cfg)
	if !strings.Contains(dsn, "tls=true") {
		t.Fatalf("dsn 缺少 tls=true 参数：%s", dsn)
	}
}

func TestOracleDSN_EscapesUserAndPassword(t *testing.T) {
	o := &OracleDB{}
	cfg := connection.ConnectionConfig{
		Type:     "oracle",
		Host:     "127.0.0.1",
		Port:     1521,
		User:     "u@ser",
		Password: "p@ss:wo/rd",
		Database: "svc/name",
	}

	dsn := o.getDSN(cfg)
	if strings.Contains(dsn, cfg.Password) {
		t.Fatalf("dsn 包含原始密码：%s", dsn)
	}
	if !strings.Contains(dsn, "u%40ser") || !strings.Contains(dsn, "p%40ss%3Awo%2Frd") {
		t.Fatalf("dsn 未正确转义 user/password：%s", dsn)
	}
	if !strings.Contains(dsn, "/svc%2Fname") {
		t.Fatalf("dsn 未正确转义 service：%s", dsn)
	}
}

func TestDamengDSN_EscapesPasswordAndEnablesEscapeProcess(t *testing.T) {
	d := &DamengDB{}
	cfg := connection.ConnectionConfig{
		Type:     "dameng",
		Host:     "127.0.0.1",
		Port:     5236,
		User:     "SYSDBA",
		Password: "p@ss:wo/rd",
		Database: "DBName",
	}

	dsn := d.getDSN(cfg)
	if strings.Contains(dsn, cfg.Password) {
		t.Fatalf("dsn 包含原始密码：%s", dsn)
	}
	if strings.Contains(dsn, "wo/rd") || !strings.Contains(dsn, "wo%2Frd") {
		t.Fatalf("dsn 未按达梦驱动要求转义密码（至少应转义 '/'）：%s", dsn)
	}
	if !strings.Contains(dsn, "escapeProcess=true") {
		t.Fatalf("dsn 缺少 escapeProcess=true：%s", dsn)
	}
	if !strings.Contains(dsn, "schema=DBName") {
		t.Fatalf("dsn 缺少 schema 参数：%s", dsn)
	}
}

func TestDamengDSN_AppendsSSLCertAndKeyParams(t *testing.T) {
	d := &DamengDB{}
	cfg := connection.ConnectionConfig{
		Type:        "dameng",
		Host:        "127.0.0.1",
		Port:        5236,
		User:        "SYSDBA",
		Password:    "pass",
		Database:    "DBName",
		UseSSL:      true,
		SSLMode:     "required",
		SSLCertPath: "C:\\certs\\client-cert.pem",
		SSLKeyPath:  "C:\\certs\\client-key.pem",
	}

	dsn := d.getDSN(cfg)
	if !strings.Contains(dsn, "SSL_CERT_PATH=") {
		t.Fatalf("dsn 缺少 SSL_CERT_PATH 参数：%s", dsn)
	}
	if !strings.Contains(dsn, "SSL_KEY_PATH=") {
		t.Fatalf("dsn 缺少 SSL_KEY_PATH 参数：%s", dsn)
	}
}

func TestKingbaseDSN_QuotesPasswordWithSpaces(t *testing.T) {
	k := &KingbaseDB{}
	cfg := connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "system",
		Password: "p@ss word",
		Database: "TEST",
	}

	dsn := k.getDSN(cfg)
	if !strings.Contains(dsn, "password='p@ss word'") {
		t.Fatalf("dsn 未对包含空格的密码进行引号包裹：%s", dsn)
	}
}

func TestTDengineDSN_UsesWebSocketFormat(t *testing.T) {
	td := &TDengineDB{}
	cfg := connection.ConnectionConfig{
		Type:     "tdengine",
		Host:     "127.0.0.1",
		Port:     6041,
		User:     "root",
		Password: "taosdata",
		Database: "power",
	}

	dsn := td.getDSN(cfg)
	if !strings.HasPrefix(dsn, "root:taosdata@ws(127.0.0.1:6041)/power") {
		t.Fatalf("tdengine dsn 格式不正确：%s", dsn)
	}
}

func TestTDengineDSN_UsesSecureWebSocketWhenSSLEnabled(t *testing.T) {
	td := &TDengineDB{}
	cfg := connection.ConnectionConfig{
		Type:     "tdengine",
		Host:     "127.0.0.1",
		Port:     6041,
		User:     "root",
		Password: "taosdata",
		Database: "power",
		UseSSL:   true,
		SSLMode:  "required",
	}

	dsn := td.getDSN(cfg)
	if !strings.HasPrefix(dsn, "root:taosdata@wss(127.0.0.1:6041)/power") {
		t.Fatalf("tdengine ssl dsn 格式不正确：%s", dsn)
	}
}

func TestSQLServerDSN_EncryptMapping(t *testing.T) {
	s := &SqlServerDB{}
	cfg := connection.ConnectionConfig{
		Type:     "sqlserver",
		Host:     "127.0.0.1",
		Port:     1433,
		User:     "sa",
		Password: "pass",
		Database: "master",
		UseSSL:   true,
		SSLMode:  "required",
	}

	dsn := s.getDSN(cfg)
	if !strings.Contains(strings.ToLower(dsn), "encrypt=true") {
		t.Fatalf("sqlserver dsn 缺少 encrypt=true：%s", dsn)
	}
	if !strings.Contains(strings.ToLower(dsn), "trustservercertificate=false") {
		t.Fatalf("sqlserver dsn 缺少 TrustServerCertificate=false：%s", dsn)
	}
}

func TestClickHouseOptions_UsesStructuredTimeoutAndAuth(t *testing.T) {
	c := &ClickHouseDB{}
	cfg := normalizeClickHouseConfig(connection.ConnectionConfig{
		Type:     "clickhouse",
		Host:     "127.0.0.1",
		Port:     9000,
		User:     "default",
		Password: "p@ss:wo/rd",
		Database: "analytics",
		Timeout:  15,
	})

	opts := c.buildClickHouseOptions(cfg)
	if opts == nil {
		t.Fatal("options 为空")
	}
	if len(opts.Addr) != 1 || opts.Addr[0] != "127.0.0.1:9000" {
		t.Fatalf("addr 不符合预期：%v", opts.Addr)
	}
	if opts.Auth.Username != "default" {
		t.Fatalf("username 不符合预期：%s", opts.Auth.Username)
	}
	if opts.Auth.Password != cfg.Password {
		t.Fatalf("password 不符合预期：%s", opts.Auth.Password)
	}
	if opts.Auth.Database != "analytics" {
		t.Fatalf("database 不符合预期：%s", opts.Auth.Database)
	}
	if opts.DialTimeout != 15*time.Second {
		t.Fatalf("dial timeout 不符合预期：%s", opts.DialTimeout)
	}
	if opts.ReadTimeout != minClickHouseReadTimeout {
		t.Fatalf("read timeout 不符合预期：%s", opts.ReadTimeout)
	}
	if _, ok := opts.Settings["write_timeout"]; ok {
		t.Fatalf("options 不应包含 write_timeout 设置：%v", opts.Settings)
	}
	if _, ok := opts.Settings["read_timeout"]; ok {
		t.Fatalf("options 不应通过 settings 传递 read_timeout：%v", opts.Settings)
	}
	if _, ok := opts.Settings["dial_timeout"]; ok {
		t.Fatalf("options 不应通过 settings 传递 dial_timeout：%v", opts.Settings)
	}
}

func TestClickHouseOptions_ReadTimeoutUsesLargerConfiguredTimeout(t *testing.T) {
	c := &ClickHouseDB{}
	cfg := normalizeClickHouseConfig(connection.ConnectionConfig{
		Type:     "clickhouse",
		Host:     "127.0.0.1",
		Port:     9000,
		User:     "default",
		Password: "secret",
		Database: "analytics",
		Timeout:  900,
	})

	opts := c.buildClickHouseOptions(cfg)
	if opts == nil {
		t.Fatal("options 为空")
	}
	if opts.DialTimeout != 900*time.Second {
		t.Fatalf("dial timeout 不符合预期：%s", opts.DialTimeout)
	}
	if opts.ReadTimeout != 900*time.Second {
		t.Fatalf("read timeout 不符合预期：%s", opts.ReadTimeout)
	}
}
