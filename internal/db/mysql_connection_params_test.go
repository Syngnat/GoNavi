package db

import (
	"database/sql"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"

	mysql "github.com/go-sql-driver/mysql"
)

func parseMySQLDSNQueryForTest(t *testing.T, dsn string) url.Values {
	t.Helper()
	parts := strings.SplitN(dsn, "?", 2)
	if len(parts) != 2 {
		t.Fatalf("dsn missing query: %s", dsn)
	}
	values, err := url.ParseQuery(parts[1])
	if err != nil {
		t.Fatalf("parse dsn query: %v", err)
	}
	return values
}

func parseMySQLDriverCharsetsForTest(t *testing.T, dsn string) []string {
	t.Helper()

	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("mysql ParseDSN failed: %v", err)
	}

	field := reflect.ValueOf(cfg).Elem().FieldByName("charsets")
	if !field.IsValid() {
		t.Fatal("mysql.Config missing internal charsets field")
	}

	charsets := make([]string, field.Len())
	for i := 0; i < field.Len(); i++ {
		charsets[i] = field.Index(i).String()
	}
	return charsets
}

func TestConfigureSQLConnectionPoolCapsOpenConnections(t *testing.T) {
	dbConn, err := sql.Open("mysql", "root@tcp(127.0.0.1:1)/test")
	if err != nil {
		t.Fatalf("sql.Open failed: %v", err)
	}
	defer dbConn.Close()

	configureSQLConnectionPool(dbConn, "mysql")

	stats := dbConn.Stats()
	if stats.MaxOpenConnections != defaultSQLMaxOpenConns {
		t.Fatalf("expected max open connections %d, got %d", defaultSQLMaxOpenConns, stats.MaxOpenConnections)
	}
}

func TestMySQLDSN_MergesConnectionParamsWithDefaults(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:             "db.local",
		Port:             3306,
		User:             "root",
		Password:         "secret",
		Database:         "app",
		Timeout:          30,
		ConnectionParams: "charset=utf8&readTimeout=10&columnsWithAlias=true",
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	if got := query.Get("charset"); got != "utf8" {
		t.Fatalf("charset should be overridden by connectionParams, got=%q", got)
	}
	if got := query.Get("readTimeout"); got != "10s" {
		t.Fatalf("numeric readTimeout should be converted to duration, got=%q", got)
	}
	if got := query.Get("columnsWithAlias"); got != "true" {
		t.Fatalf("driver-specific parameter should be preserved, got=%q", got)
	}
	if got := query.Get("multiStatements"); got != "true" {
		t.Fatalf("default multiStatements should remain enabled, got=%q", got)
	}
}

func TestMySQLDSN_EmptyDatabaseUsesCompatibilityDefaults(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:     "gdb.local",
		Port:     1523,
		User:     "glzc",
		Password: "secret",
		Timeout:  30,
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}
	if !strings.Contains(dsn, "@tcp(gdb.local:1523)/?") {
		t.Fatalf("empty database should still keep DSN slash separator, got=%q", dsn)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	if got := query.Get("charset"); got != "utf8mb4,utf8" {
		t.Fatalf("default charset should fall back from utf8mb4 to utf8, got=%q", got)
	}
	if got := query.Get("multiStatements"); got != "true" {
		t.Fatalf("default multiStatements should remain enabled, got=%q", got)
	}
}

func TestMySQLDSN_MapsCommonJDBCParamsWithoutLeakingUnsupportedKeys(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:     "192.168.1.1",
		Port:     3306,
		User:     "root",
		Database: "app",
		ConnectionParams: "useUnicode=true&characterEncoding=utf8&autoReconnect=true&" +
			"allowPublicKeyRetrieval=true&useSSL=false&verifyServerCertificate=false&useOldAliasMetadataBehavior=true",
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	if got := query.Get("charset"); got != "utf8" {
		t.Fatalf("characterEncoding should map to charset, got=%q", got)
	}
	if got := query.Get("tls"); got != "false" {
		t.Fatalf("useSSL=false should map to tls=false, got=%q", got)
	}
	for _, forbidden := range []string{
		"useUnicode",
		"characterEncoding",
		"autoReconnect",
		"allowPublicKeyRetrieval",
		"useSSL",
		"verifyServerCertificate",
		"useOldAliasMetadataBehavior",
	} {
		if _, exists := query[forbidden]; exists {
			t.Fatalf("JDBC-only parameter %s should not be passed to Go MySQL driver: %v", forbidden, query)
		}
	}
}

func TestMySQLDSN_MapsJDBCUTF8EncodingToMySQLCharset(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:     "192.168.1.240",
		Port:     3306,
		User:     "root",
		Database: "mkefu_location_dev_local",
		URI: "jdbc:mysql://192.168.1.240:3306/mkefu_location_dev_local?" +
			"useUnicode=true&characterEncoding=UTF-8&serverTimezone=GMT%2B8",
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	if got := query.Get("charset"); got != "utf8mb4" {
		t.Fatalf("JDBC characterEncoding=UTF-8 should map to MySQL charset utf8mb4, got=%q", got)
	}
	if got := query.Get("characterEncoding"); got != "" {
		t.Fatalf("JDBC characterEncoding should not be passed to Go MySQL driver, got=%q", got)
	}
	if got := query.Get("serverTimezone"); got != "" {
		t.Fatalf("JDBC serverTimezone should not be passed to Go MySQL driver, got=%q", got)
	}
	if got := query.Get("loc"); got != "Asia%2FShanghai" && got != "Asia/Shanghai" {
		t.Fatalf("serverTimezone=GMT+8 should map to loc=Asia/Shanghai, got=%q", got)
	}
}

func TestMySQLDSN_DropsJDBCAllowPublicKeyRetrievalParam(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:             "db.local",
		Port:             3306,
		User:             "root",
		Database:         "app",
		URI:              "jdbc:mysql://db.local:3306/app?allowPublicKeyRetrieval=true&useSSL=false",
		ConnectionParams: "allowPublicKeyRetrieval=true&readtimeout=10&writetimeout=11",
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	if _, exists := query["allowPublicKeyRetrieval"]; exists {
		t.Fatalf("JDBC allowPublicKeyRetrieval should not be passed to Go MySQL driver: %v", query)
	}
	if got := query.Get("tls"); got != "false" {
		t.Fatalf("useSSL=false should still map to tls=false, got=%q", got)
	}
	if got := query.Get("readTimeout"); got != "10s" {
		t.Fatalf("readtimeout should canonicalize to readTimeout duration, got=%q", got)
	}
	if got := query.Get("writeTimeout"); got != "11s" {
		t.Fatalf("writetimeout should canonicalize to writeTimeout duration, got=%q", got)
	}
}

func TestMySQLDSN_PreservesSupportedGoDriverParamsAndDropsUnknownParams(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:     "db.local",
		Port:     3306,
		User:     "root",
		Database: "app",
		ConnectionParams: strings.Join([]string{
			"allowAllFiles=true",
			"allowCleartextPasswords=true",
			"allowFallbackToPlaintext=true",
			"allowNativePasswords=false",
			"allowOldPasswords=true",
			"checkConnLiveness=false",
			"clientFoundRows=true",
			"charset=latin1",
			"collation=utf8mb4_unicode_ci",
			"columnsWithAlias=true",
			"compress=true",
			"connectionAttributes=program_name:GoNavi",
			"interpolateParams=true",
			"loc=UTC",
			"maxAllowedPacket=1048576",
			"multiStatements=false",
			"parseTime=false",
			"readtimeout=7",
			"rejectReadOnly=true",
			"serverPubKey=testKey",
			"timeTruncate=2",
			"timeout=8",
			"tls=preferred",
			"writetimeout=9",
			"strict=true",
			"unsupportedJdbcParam=true",
		}, "&"),
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	want := map[string]string{
		"allowAllFiles":            "true",
		"allowCleartextPasswords":  "true",
		"allowFallbackToPlaintext": "true",
		"allowNativePasswords":     "false",
		"allowOldPasswords":        "true",
		"checkConnLiveness":        "false",
		"clientFoundRows":          "true",
		"charset":                  "latin1",
		"collation":                "utf8mb4_unicode_ci",
		"columnsWithAlias":         "true",
		"compress":                 "true",
		"connectionAttributes":     "program_name:GoNavi",
		"interpolateParams":        "true",
		"loc":                      "UTC",
		"maxAllowedPacket":         "1048576",
		"multiStatements":          "false",
		"parseTime":                "false",
		"readTimeout":              "7s",
		"rejectReadOnly":           "true",
		"serverPubKey":             "testKey",
		"timeTruncate":             "2s",
		"timeout":                  "8s",
		"tls":                      "preferred",
		"writeTimeout":             "9s",
	}
	for key, value := range want {
		if got := query.Get(key); got != value {
			t.Fatalf("%s should be %q, got %q; query=%v", key, value, got, query)
		}
	}
	for _, forbidden := range []string{"strict", "unsupportedJdbcParam"} {
		if _, exists := query[forbidden]; exists {
			t.Fatalf("unsupported parameter %s should not be passed to Go MySQL driver: %v", forbidden, query)
		}
	}
}

func TestMySQLDSN_MapsAdditionalJDBCAliases(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:     "db.local",
		Port:     3306,
		User:     "root",
		Database: "app",
		ConnectionParams: strings.Join([]string{
			"sslMode=required",
			"allowMultiQueries=false",
			"useCompression=true",
			"connectionCollation=utf8mb4_bin",
		}, "&"),
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	if got := query.Get("tls"); got != "true" {
		t.Fatalf("sslMode=required should map to tls=true, got=%q", got)
	}
	if got := query.Get("multiStatements"); got != "false" {
		t.Fatalf("allowMultiQueries=false should map to multiStatements=false, got=%q", got)
	}
	if got := query.Get("compress"); got != "true" {
		t.Fatalf("useCompression=true should map to compress=true, got=%q", got)
	}
	if got := query.Get("collation"); got != "utf8mb4_bin" {
		t.Fatalf("connectionCollation should map to collation, got=%q", got)
	}
}

func TestMySQLDSN_MapsAllowMultiQueriesTrueWithoutLeakingKey(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:             "db.local",
		Port:             3306,
		User:             "root",
		Database:         "app",
		ConnectionParams: "allowMultiQueries=true",
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	if got := query.Get("multiStatements"); got != "true" {
		t.Fatalf("allowMultiQueries=true should map to multiStatements=true, got=%q; query=%v", got, query)
	}
	if _, exists := query["allowMultiQueries"]; exists {
		t.Fatalf("allowMultiQueries should not be passed to Go MySQL driver: %v", query)
	}
}

func TestBuildMySQLCompatibleConnectPlans_AddsHandshakeFallbackWhenMultiStatementsImplicit(t *testing.T) {
	t.Parallel()

	plans, err := buildMySQLCompatibleConnectPlans(connection.ConnectionConfig{
		Host:    "gdb.local",
		Port:    1523,
		User:    "glzc",
		Timeout: 30,
	}, "tcp", "gdb.local:1523", "")
	if err != nil {
		t.Fatalf("buildMySQLCompatibleConnectPlans failed: %v", err)
	}
	if len(plans) != 2 {
		t.Fatalf("expected default plan plus compatibility fallback, got %d", len(plans))
	}

	defaultQuery := parseMySQLDSNQueryForTest(t, plans[0].dsn)
	if got := defaultQuery.Get("multiStatements"); got != "true" {
		t.Fatalf("default plan should keep multiStatements enabled, got=%q", got)
	}
	if got := defaultQuery.Get("charset"); got != "utf8mb4,utf8" {
		t.Fatalf("default plan should use utf8 fallback charset, got=%q", got)
	}
	if !mysqlDSNSupportsBatchWrites(plans[0].dsn) {
		t.Fatal("default multiStatements plan should advertise batch-write support")
	}

	fallbackQuery := parseMySQLDSNQueryForTest(t, plans[1].dsn)
	if got := fallbackQuery.Get("multiStatements"); got != "false" {
		t.Fatalf("fallback plan should disable multiStatements, got=%q", got)
	}
	if got := fallbackQuery.Get("charset"); got != "utf8mb4,utf8" {
		t.Fatalf("fallback plan should preserve charset fallback, got=%q", got)
	}
	if mysqlDSNSupportsBatchWrites(plans[1].dsn) {
		t.Fatal("multiStatements=false fallback must disable batch-write support")
	}
}

func TestBuildMySQLCompatibleConnectPlans_RespectsExplicitMultiStatementsChoice(t *testing.T) {
	t.Parallel()

	plans, err := buildMySQLCompatibleConnectPlans(connection.ConnectionConfig{
		Host:             "db.local",
		Port:             3306,
		User:             "root",
		ConnectionParams: "allowMultiQueries=false",
	}, "tcp", "db.local:3306", "app")
	if err != nil {
		t.Fatalf("buildMySQLCompatibleConnectPlans failed: %v", err)
	}
	if len(plans) != 1 {
		t.Fatalf("explicit multiStatements choice should skip compatibility fallback, got %d plans", len(plans))
	}

	query := parseMySQLDSNQueryForTest(t, plans[0].dsn)
	if got := query.Get("multiStatements"); got != "false" {
		t.Fatalf("explicit allowMultiQueries=false should be preserved, got=%q", got)
	}
	if mysqlDSNSupportsBatchWrites(plans[0].dsn) {
		t.Fatal("explicit multiStatements=false plan must disable batch-write support")
	}
}

func TestMySQLDSN_AsiaShanghaiLocationAcceptedByDriver(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:             "127.0.0.1",
		Port:             3306,
		User:             "root",
		Database:         "app",
		ConnectionParams: "serverTimezone=GMT%2B8",
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("mysql driver should accept loc=Asia/Shanghai: %v", err)
	}
	_ = db.Close()
}

func TestMySQLDSN_DefaultCharsetFallbackListRemainsDriverCompatible(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:     "127.0.0.1",
		Port:     3306,
		User:     "root",
		Database: "app",
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	got := parseMySQLDriverCharsetsForTest(t, dsn)
	want := []string{"utf8mb4", "utf8"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("driver should parse charset fallback list, got=%v want=%v dsn=%q", got, want, dsn)
	}
}

func TestMySQLDSN_URIParamsAndExplicitParamsPrecedence(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Host:             "db.local",
		Port:             3306,
		User:             "root",
		Database:         "app",
		URI:              "jdbc:mysql://db.local:3306/app?characterEncoding=utf8&timeout=15&topology=replica&useSSL=false",
		ConnectionParams: "charset=utf8mb4&timeout=5s&socketTimeout=45000",
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	if got := query.Get("charset"); got != "utf8mb4" {
		t.Fatalf("connectionParams should override URI charset, got=%q", got)
	}
	if got := query.Get("timeout"); got != "5s" {
		t.Fatalf("connectionParams should override URI timeout, got=%q", got)
	}
	if got := query.Get("readTimeout"); got != "45s" {
		t.Fatalf("socketTimeout should map to readTimeout duration, got=%q", got)
	}
	if _, exists := query["topology"]; exists {
		t.Fatalf("internal topology parameter should not be passed to driver: %v", query)
	}
}

func TestApplyMySQLURI_GoldenDBSchemeUsesDefaultPort(t *testing.T) {
	t.Parallel()

	config := applyMySQLURI(connection.ConnectionConfig{
		Type: "goldendb",
		URI:  "goldendb://glzc:secret@gdb.local/core_ledger?characterEncoding=utf8",
	})

	if config.Host != "gdb.local" {
		t.Fatalf("expected goldendb host from URI, got %q", config.Host)
	}
	if config.Port != 1523 {
		t.Fatalf("expected goldendb default port 1523, got %d", config.Port)
	}
	if config.Database != "core_ledger" {
		t.Fatalf("expected goldendb database from URI, got %q", config.Database)
	}
	if config.User != "glzc" {
		t.Fatalf("expected goldendb user from URI, got %q", config.User)
	}
	if config.Password != "secret" {
		t.Fatalf("expected goldendb password from URI, got %q", config.Password)
	}
}

func TestMySQLDSN_AcceptsGoldenDBURICompatibilityParams(t *testing.T) {
	t.Parallel()

	m := &MySQLDB{}
	dsn, err := m.getDSN(connection.ConnectionConfig{
		Type:     "goldendb",
		Host:     "gdb.local",
		Port:     1523,
		User:     "glzc",
		Password: "secret",
		Database: "core_ledger",
		URI:      "goldendb://glzc:secret@gdb.local/core_ledger?characterEncoding=utf8&useSSL=false",
	})
	if err != nil {
		t.Fatalf("getDSN failed: %v", err)
	}

	query := parseMySQLDSNQueryForTest(t, dsn)
	if got := query.Get("charset"); got != "utf8" {
		t.Fatalf("goldendb URI characterEncoding should map to charset=utf8, got=%q", got)
	}
	if got := query.Get("tls"); got != "false" {
		t.Fatalf("goldendb URI useSSL=false should map to tls=false, got=%q", got)
	}
}
