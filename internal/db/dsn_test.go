//go:build gonavi_full_drivers

package db

import (
	"net/url"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
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

func TestPostgresDSN_AppendsSSLPathParams(t *testing.T) {
	p := &PostgresDB{}
	cfg := connection.ConnectionConfig{
		Type:        "postgres",
		Host:        "127.0.0.1",
		Port:        5432,
		User:        "user",
		Password:    "pass",
		Database:    "db",
		UseSSL:      true,
		SSLMode:     "required",
		SSLCAPath:   "C:\\certs\\ca.pem",
		SSLCertPath: "C:\\certs\\client-cert.pem",
		SSLKeyPath:  "C:\\certs\\client-key.pem",
	}

	dsn := p.getDSN(cfg)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse postgres dsn: %v", err)
	}
	query := parsed.Query()
	if got := query.Get("sslmode"); got != "verify-ca" {
		t.Fatalf("sslmode = %q, want verify-ca", got)
	}
	if got := query.Get("sslrootcert"); got != cfg.SSLCAPath {
		t.Fatalf("sslrootcert = %q, want %q", got, cfg.SSLCAPath)
	}
	if got := query.Get("sslcert"); got != cfg.SSLCertPath {
		t.Fatalf("sslcert = %q, want %q", got, cfg.SSLCertPath)
	}
	if got := query.Get("sslkey"); got != cfg.SSLKeyPath {
		t.Fatalf("sslkey = %q, want %q", got, cfg.SSLKeyPath)
	}
}

func TestPostgresDSN_SkipVerifyOmitsSSLRootCert(t *testing.T) {
	p := &PostgresDB{}
	cfg := connection.ConnectionConfig{
		Type:        "postgres",
		Host:        "127.0.0.1",
		Port:        5432,
		User:        "user",
		Password:    "pass",
		Database:    "db",
		UseSSL:      true,
		SSLMode:     "skip-verify",
		SSLCAPath:   "C:\\certs\\ca.pem",
		SSLCertPath: "C:\\certs\\client-cert.pem",
		SSLKeyPath:  "C:\\certs\\client-key.pem",
	}

	dsn := p.getDSN(cfg)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse postgres dsn: %v", err)
	}
	query := parsed.Query()
	if got := query.Get("sslmode"); got != "require" {
		t.Fatalf("sslmode = %q, want require", got)
	}
	if got := query.Get("sslrootcert"); got != "" {
		t.Fatalf("sslrootcert should be omitted for skip-verify, got %q", got)
	}
	if got := query.Get("sslcert"); got != cfg.SSLCertPath {
		t.Fatalf("sslcert = %q, want %q", got, cfg.SSLCertPath)
	}
	if got := query.Get("sslkey"); got != cfg.SSLKeyPath {
		t.Fatalf("sslkey = %q, want %q", got, cfg.SSLKeyPath)
	}
}

func TestPostgresDSN_MergesConnectionParams(t *testing.T) {
	p := &PostgresDB{}
	cfg := connection.ConnectionConfig{
		Type:             "postgres",
		Host:             "127.0.0.1",
		Port:             5432,
		User:             "user",
		Password:         "pass",
		Database:         "db",
		ConnectionParams: "application_name=GoNavi&connect_timeout=9&statement_timeout=3000&allowPublicKeyRetrieval=true",
	}

	dsn := p.getDSN(cfg)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse postgres dsn: %v", err)
	}
	query := parsed.Query()
	if got := query.Get("application_name"); got != "GoNavi" {
		t.Fatalf("application_name = %q, want GoNavi", got)
	}
	if got := query.Get("connect_timeout"); got != "9" {
		t.Fatalf("connect_timeout = %q, want 9", got)
	}
	if got := query.Get("statement_timeout"); got != "3000" {
		t.Fatalf("statement_timeout = %q, want 3000", got)
	}
	if got := query.Get("allowPublicKeyRetrieval"); got != "" {
		t.Fatalf("unsupported postgres param should be filtered, got %q", got)
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

	dsn, err := m.getDSN(cfg)
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}
	if !strings.Contains(dsn, "tls=true") {
		t.Fatalf("dsn 缺少 tls=true 参数：%s", dsn)
	}
}

func TestMySQLDSN_UsesCustomTLSConfigWhenCertificatePathsAreConfigured(t *testing.T) {
	m := &MySQLDB{}
	cfg := connection.ConnectionConfig{
		Type:        "mysql",
		Host:        "127.0.0.1",
		Port:        3306,
		User:        "root",
		Password:    "pass",
		Database:    "db",
		UseSSL:      true,
		SSLMode:     "required",
		SSLCAPath:   "../../third_party/highgo-pq/certs/root.crt",
		SSLCertPath: "../../third_party/highgo-pq/certs/postgresql.crt",
		SSLKeyPath:  "../../third_party/highgo-pq/certs/postgresql.key",
	}

	dsn, err := m.getDSN(cfg)
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}
	if strings.Contains(dsn, "tls=true") {
		t.Fatalf("dsn 应使用自定义 TLS 配置名而不是 tls=true：%s", dsn)
	}
	if !strings.Contains(dsn, "tls=gonavi-") {
		t.Fatalf("dsn 缺少自定义 TLS 配置名：%s", dsn)
	}
	if strings.Contains(dsn, "allowFallbackToPlaintext=true") {
		t.Fatalf("required 模式不应启用明文回退：%s", dsn)
	}
}

func TestMySQLDSN_PreservesPreferredFallbackWithCustomTLSConfig(t *testing.T) {
	m := &MySQLDB{}
	cfg := connection.ConnectionConfig{
		Type:        "mysql",
		Host:        "127.0.0.1",
		Port:        3306,
		User:        "root",
		Password:    "pass",
		Database:    "db",
		UseSSL:      true,
		SSLMode:     "preferred",
		SSLCAPath:   "../../third_party/highgo-pq/certs/root.crt",
		SSLCertPath: "../../third_party/highgo-pq/certs/postgresql.crt",
		SSLKeyPath:  "../../third_party/highgo-pq/certs/postgresql.key",
	}

	dsn, err := m.getDSN(cfg)
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}
	if !strings.Contains(dsn, "tls=gonavi-") {
		t.Fatalf("dsn 缺少自定义 TLS 配置名：%s", dsn)
	}
	if !strings.Contains(dsn, "allowFallbackToPlaintext=true") {
		t.Fatalf("preferred 自定义 TLS 配置应保留明文回退：%s", dsn)
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

func TestOracleDSN_SIDModeOmitsPathAndCarriesSIDParam(t *testing.T) {
	o := &OracleDB{}
	cfg := connection.ConnectionConfig{
		Type:             "oracle",
		Host:             "127.0.0.1",
		Port:             1521,
		User:             "system",
		Password:         "secret",
		ConnectionParams: "SID=ORCL",
	}

	if !isOracleSIDMode(cfg) {
		t.Fatal("expected isOracleSIDMode to be true when SID param present")
	}
	if got := oracleConnectionSID(cfg); got != "ORCL" {
		t.Fatalf("oracleConnectionSID = %q, want ORCL", got)
	}

	dsn := o.getDSN(cfg)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse dsn failed: %v", err)
	}
	if strings.Trim(parsed.EscapedPath(), "/") != "" {
		t.Fatalf("SID 模式不应在 URL path 携带服务名，path=%q dsn=%s", parsed.EscapedPath(), dsn)
	}
	if got := parsed.Query().Get("SID"); got != "ORCL" {
		t.Fatalf("SID 参数 = %q, want ORCL（dsn=%s）", got, dsn)
	}
	if parsed.Query().Get("PREFETCH_ROWS") == "" {
		t.Fatalf("SID 模式应保留默认驱动参数，dsn=%s", dsn)
	}
}

func TestOracleDSN_SIDModeOverridesLegacyDatabaseField(t *testing.T) {
	o := &OracleDB{}
	// 兼容历史数据：Navicat 导入的旧 SID 连接同时存在 Database 与 SID 参数，
	// SID 优先且 path 不携带服务名，避免冗余与日志误读。
	cfg := connection.ConnectionConfig{
		Type:             "oracle",
		Host:             "db.example.com",
		Port:             1521,
		User:             "system",
		Password:         "secret",
		Database:         "ORCL",
		ConnectionParams: "SID=ORCL",
	}

	dsn := o.getDSN(cfg)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse dsn failed: %v", err)
	}
	if strings.Trim(parsed.EscapedPath(), "/") != "" {
		t.Fatalf("SID 模式不应在 URL path 携带 Database，path=%q dsn=%s", parsed.EscapedPath(), dsn)
	}
	if got := parsed.Query().Get("SID"); got != "ORCL" {
		t.Fatalf("SID 参数 = %q, want ORCL（dsn=%s）", got, dsn)
	}
}

func TestOracleSIDParamParsingIsCaseInsensitive(t *testing.T) {
	for _, raw := range []string{"sid=ORCL", "Sid=ORCL", "SID=ORCL", "SID =ORCL"} {
		cfg := connection.ConnectionConfig{
			Type:             "oracle",
			ConnectionParams: raw,
		}
		if got := oracleConnectionSID(cfg); got != "ORCL" {
			t.Fatalf("oracleConnectionSID(%q) = %q, want ORCL", raw, got)
		}
	}
}

func TestDamengDSN_KeepsRawPasswordForDriverParser(t *testing.T) {
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
	if !strings.Contains(dsn, "SYSDBA:p@ss:wo/rd@127.0.0.1:5236") {
		t.Fatalf("dsn 未保留达梦驱动可识别的原始认证信息：%s", dsn)
	}
	if strings.Contains(dsn, "p%40ss") || strings.Contains(dsn, "wo%2Frd") {
		t.Fatalf("dsn 不应转义达梦密码，驱动不会反解码认证信息：%s", dsn)
	}
	if strings.Contains(dsn, "escapeProcess=true") {
		t.Fatalf("dsn 不应自动添加 escapeProcess=true：%s", dsn)
	}
	if !strings.Contains(dsn, "schema=DBName") {
		t.Fatalf("dsn 缺少 schema 参数：%s", dsn)
	}
}

func TestDamengDSN_AppendsQuerySentinelForQuestionMarkInPassword(t *testing.T) {
	d := &DamengDB{}
	cfg := connection.ConnectionConfig{
		Type:     "dameng",
		Host:     "127.0.0.1",
		Port:     5236,
		User:     "SYSDBA",
		Password: "p?ss",
	}

	dsn := d.getDSN(cfg)
	if dsn != "dm://SYSDBA:p?ss@127.0.0.1:5236?" {
		t.Fatalf("dsn = %q, want raw password with trailing query sentinel", dsn)
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
	if !strings.Contains(dsn, "sslCertPath=") {
		t.Fatalf("dsn 缺少 sslCertPath 参数：%s", dsn)
	}
	if !strings.Contains(dsn, "sslKeyPath=") {
		t.Fatalf("dsn 缺少 sslKeyPath 参数：%s", dsn)
	}
}

func TestDamengDSN_FiltersUnsupportedConnectionParams(t *testing.T) {
	d := &DamengDB{}
	cfg := connection.ConnectionConfig{
		Type:             "dameng",
		Host:             "127.0.0.1",
		Port:             5236,
		User:             "SYSDBA",
		Password:         "pass",
		Database:         "DBName",
		ConnectionParams: "SSL_CERT_PATH=/cert.pem&CONNECT_TIMEOUT=5000&unknown=bad",
	}

	dsn := d.getDSN(cfg)
	if !strings.Contains(dsn, "sslCertPath=%2Fcert.pem") {
		t.Fatalf("dsn 缺少规范化 sslCertPath 参数：%s", dsn)
	}
	if !strings.Contains(dsn, "connectTimeout=5000") {
		t.Fatalf("dsn 缺少规范化 connectTimeout 参数：%s", dsn)
	}
	if strings.Contains(dsn, "SSL_CERT_PATH") || strings.Contains(dsn, "unknown=bad") {
		t.Fatalf("dsn 不应透传达梦未知或非规范参数：%s", dsn)
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

func TestKingbaseDSN_MergesConnectionParams(t *testing.T) {
	k := &KingbaseDB{}
	cfg := connection.ConnectionConfig{
		Type:             "kingbase",
		Host:             "127.0.0.1",
		Port:             54321,
		User:             "system",
		Password:         "pass",
		Database:         "TEST",
		ConnectionParams: "application_name=GoNavi&connect_timeout=12&statement_timeout=3000&unknown=bad",
	}

	dsn := k.getDSN(cfg)
	if !strings.Contains(dsn, "application_name=GoNavi") {
		t.Fatalf("dsn 缺少 application_name：%s", dsn)
	}
	if !strings.Contains(dsn, "connect_timeout=12") {
		t.Fatalf("dsn 缺少自定义 connect_timeout：%s", dsn)
	}
	if !strings.Contains(dsn, "statement_timeout=3000") {
		t.Fatalf("dsn 缺少允许的 runtime 参数：%s", dsn)
	}
	if strings.Contains(dsn, "unknown=bad") {
		t.Fatalf("dsn 不应透传未知 Kingbase 参数：%s", dsn)
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

func TestTDengineDSN_MergesConnectionParams(t *testing.T) {
	td := &TDengineDB{}
	cfg := connection.ConnectionConfig{
		Type:             "tdengine",
		Host:             "127.0.0.1",
		Port:             6041,
		User:             "root",
		Password:         "taosdata",
		Database:         "power",
		ConnectionParams: "timezone=Asia%2FShanghai&protocol=wss&readTimeout=10s&unknown=bad",
	}

	dsn := td.getDSN(cfg)
	if !strings.Contains(dsn, "timezone=Asia%2FShanghai") {
		t.Fatalf("tdengine dsn 缺少自定义参数或错误透传 protocol：%s", dsn)
	}
	if !strings.Contains(dsn, "readTimeout=10s") {
		t.Fatalf("tdengine dsn 缺少 readTimeout 参数：%s", dsn)
	}
	if strings.Contains(dsn, "protocol=wss") || strings.Contains(dsn, "unknown=bad") {
		t.Fatalf("tdengine dsn 不应透传协议控制项或未知参数：%s", dsn)
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

func TestSQLServerDSN_MergesConnectionParams(t *testing.T) {
	s := &SqlServerDB{}
	cfg := connection.ConnectionConfig{
		Type:             "sqlserver",
		Host:             "127.0.0.1",
		Port:             1433,
		User:             "sa",
		Password:         "pass",
		Database:         "master",
		ConnectionParams: "Application Name=GoNavi&Initial Catalog=appdb&packet size=32767&unknown=bad",
	}

	dsn := s.getDSN(cfg)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse sqlserver dsn: %v", err)
	}
	query := parsed.Query()
	if got := query.Get("app name"); got != "GoNavi" {
		t.Fatalf("app name = %q, want GoNavi", got)
	}
	if got := query.Get("database"); got != "appdb" {
		t.Fatalf("database = %q, want appdb", got)
	}
	if got := query.Get("packet size"); got != "32767" {
		t.Fatalf("packet size = %q, want 32767", got)
	}
	if got := query.Get("unknown"); got != "" {
		t.Fatalf("unknown should be filtered, got %q", got)
	}
}

func TestSQLServerDSN_AppendsCertificateParam(t *testing.T) {
	s := &SqlServerDB{}
	cfg := connection.ConnectionConfig{
		Type:      "sqlserver",
		Host:      "127.0.0.1",
		Port:      1433,
		User:      "sa",
		Password:  "pass",
		Database:  "master",
		UseSSL:    true,
		SSLMode:   "required",
		SSLCAPath: "C:\\certs\\sqlserver-ca.pem",
	}

	dsn := s.getDSN(cfg)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse sqlserver dsn: %v", err)
	}
	if got := parsed.Query().Get("certificate"); got != cfg.SSLCAPath {
		t.Fatalf("certificate = %q, want %q", got, cfg.SSLCAPath)
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

	opts, err := c.buildClickHouseOptions(cfg)
	if err != nil {
		t.Fatalf("buildClickHouseOptions failed: %v", err)
	}
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
	if opts.ReadTimeout != clickHouseNoAutomaticReadTimeout {
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

func TestClickHouseOptions_MergesConnectionParamsIntoOptionsAndSettings(t *testing.T) {
	c := &ClickHouseDB{}
	cfg := normalizeClickHouseConfig(connection.ConnectionConfig{
		Type:             "clickhouse",
		Host:             "127.0.0.1",
		Port:             9000,
		User:             "default",
		Password:         "secret",
		Database:         "analytics",
		Timeout:          15,
		ConnectionParams: "max_execution_time=60&compress=lz4&read_timeout=10s",
	})

	opts, err := c.buildClickHouseOptions(cfg)
	if err != nil {
		t.Fatalf("buildClickHouseOptions failed: %v", err)
	}
	if opts == nil {
		t.Fatal("options 为空")
	}
	if opts.ReadTimeout != 10*time.Second {
		t.Fatalf("read timeout 不符合预期：%s", opts.ReadTimeout)
	}
	if opts.Compression == nil || opts.Compression.Method != clickhouse.CompressionLZ4 {
		t.Fatalf("compression 不符合预期：%v", opts.Compression)
	}
	if got := opts.Settings["max_execution_time"]; got != 60 {
		t.Fatalf("max_execution_time = %#v, want 60", got)
	}
}

func TestClickHouseOptions_ConnectionTimeoutDoesNotBecomeReadTimeout(t *testing.T) {
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

	opts, err := c.buildClickHouseOptions(cfg)
	if err != nil {
		t.Fatalf("buildClickHouseOptions failed: %v", err)
	}
	if opts == nil {
		t.Fatal("options 为空")
	}
	if opts.DialTimeout != 900*time.Second {
		t.Fatalf("dial timeout 不符合预期：%s", opts.DialTimeout)
	}
	if opts.ReadTimeout != clickHouseNoAutomaticReadTimeout {
		t.Fatalf("read timeout 不符合预期：%s", opts.ReadTimeout)
	}
}
