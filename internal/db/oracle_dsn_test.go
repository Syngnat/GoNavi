package db

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestOracleGetDSNIncludesQueryPerformanceOptions(t *testing.T) {
	t.Parallel()

	dsn := (&OracleDB{}).getDSN(connection.ConnectionConfig{
		Host:     "db.example.com",
		Port:     1521,
		User:     "scott",
		Password: "tiger",
		Database: "ORCLPDB1",
	})

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("解析 Oracle DSN 失败: %v", err)
	}
	query := parsed.Query()
	if got := query.Get("PREFETCH_ROWS"); got != "25" {
		t.Fatalf("PREFETCH_ROWS = %q, want 25", got)
	}
	if got := query.Get("LOB FETCH"); got != "POST" {
		t.Fatalf("LOB FETCH = %q, want POST", got)
	}
}

func TestOracleGetDSNIncludesTimeoutDefaults(t *testing.T) {
	t.Parallel()

	dsn := (&OracleDB{}).getDSN(connection.ConnectionConfig{
		Host:     "db.example.com",
		Port:     1521,
		User:     "scott",
		Password: "tiger",
		Database: "ORCLPDB1",
		Timeout:  12,
	})

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("解析 Oracle DSN 失败: %v", err)
	}
	query := parsed.Query()
	if got := query.Get("CONNECT TIMEOUT"); got != "12" {
		t.Fatalf("CONNECT TIMEOUT = %q, want 12", got)
	}
	if got := query.Get("READ TIMEOUT"); got != "" {
		t.Fatalf("READ TIMEOUT leaked from connect timeout: %q", got)
	}
}

func TestOracleGetDSNMergesConnectionParams(t *testing.T) {
	t.Parallel()

	dsn := (&OracleDB{}).getDSN(connection.ConnectionConfig{
		Host:             "db.example.com",
		Port:             1521,
		User:             "scott",
		Password:         "tiger",
		Database:         "ORCLPDB1",
		ConnectionParams: "PREFETCH_ROWS=5000&TRACE FILE=/tmp/go-ora.trc&connect_timeout=10&read_timeout=7&FAILOVER=3&unknown=bad",
	})

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("解析 Oracle DSN 失败: %v", err)
	}
	query := parsed.Query()
	if got := query.Get("PREFETCH_ROWS"); got != "5000" {
		t.Fatalf("PREFETCH_ROWS = %q, want 5000", got)
	}
	if got := query.Get("TRACE FILE"); got != "/tmp/go-ora.trc" {
		t.Fatalf("TRACE FILE = %q, want /tmp/go-ora.trc", got)
	}
	if got := query.Get("CONNECT TIMEOUT"); got != "10" {
		t.Fatalf("CONNECT TIMEOUT = %q, want 10", got)
	}
	if got := query.Get("READ TIMEOUT"); got != "7" {
		t.Fatalf("READ TIMEOUT = %q, want 7", got)
	}
	if got := query.Get("FAILOVER"); got != "" {
		t.Fatalf("FAILOVER should be filtered because go-ora no longer supports it, got %q", got)
	}
	if got := query.Get("unknown"); got != "" {
		t.Fatalf("unknown should be filtered, got %q", got)
	}
}

func TestOracleDSNLogSummaryDoesNotExposePassword(t *testing.T) {
	t.Parallel()

	dsn := (&OracleDB{}).getDSN(connection.ConnectionConfig{
		Host:             "db.example.com",
		Port:             1521,
		User:             "sys@tenant",
		Password:         "top-secret",
		Database:         "ORCLPDB1",
		ConnectionParams: "DBA_PRIVILEGE=SYSDBA&AUTH_TYPE=NORMAL",
	})

	got := oracleDSNLogSummary(connection.ConnectionConfig{Database: "ORCLPDB1"}, dsn)
	if strings.Contains(got, "top-secret") || strings.Contains(got, "sys@tenant") {
		t.Fatalf("summary should not expose credentials, got %q", got)
	}
	for _, want := range []string{"连接模式=服务名", "服务名=ORCLPDB1", "DBA_PRIVILEGE=SYSDBA", "AUTH_TYPE=NORMAL"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected summary to contain %q, got %q", want, got)
		}
	}
}

func TestOracleDSNLogSummaryUsesEffectiveSIDOverLegacyDatabase(t *testing.T) {
	dsn := "oracle://sys:top-secret@127.0.0.1:1521?SID=ORCL&DBA+PRIVILEGE=SYSDBA"
	got := oracleDSNLogSummary(connection.ConnectionConfig{Database: "OLD_SERVICE"}, dsn)

	for _, want := range []string{"连接模式=SID", "SID=ORCL", "DBA_PRIVILEGE=SYSDBA"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected summary to contain %q, got %q", want, got)
		}
	}
	if strings.Contains(got, "OLD_SERVICE") || strings.Contains(got, "top-secret") {
		t.Fatalf("summary should use the effective SID without exposing stale or secret values, got %q", got)
	}
}

func TestAnnotateOracleValidationErrorAddsClosedConnectionHint(t *testing.T) {
	t.Parallel()

	err := annotateOracleValidationError(errors.New("read tcp 127.0.0.1:1->127.0.0.1:2: use of closed network connection"))
	if err == nil || !strings.Contains(err.Error(), "Service Name") {
		t.Fatalf("expected closed connection hint, got %v", err)
	}
}

func TestAnnotateOracleValidationErrorAddsEOFHint(t *testing.T) {
	t.Parallel()

	for _, message := range []string{"EOF", "unexpected EOF", "read tcp: EOF"} {
		err := annotateOracleValidationError(errors.New(message))
		if err == nil || !strings.Contains(err.Error(), "握手阶段") {
			t.Fatalf("expected handshake hint for %q, got %v", message, err)
		}
	}
}

// 回归：以前用 strings.Contains(message, "eof") 判断，主机名或用户名里含 "eof"
// 的无关错误会被误判成握手失败，附加一段误导性的排查提示。
func TestAnnotateOracleValidationErrorIgnoresEOFSubstring(t *testing.T) {
	t.Parallel()

	const message = "dial tcp: lookup eoffice-db.internal: no such host"
	err := annotateOracleValidationError(errors.New(message))
	if err == nil {
		t.Fatal("expected the original error back")
	}
	if strings.Contains(err.Error(), "握手阶段") {
		t.Fatalf("substring \"eof\" in host must not trigger the handshake hint, got %v", err)
	}
}
