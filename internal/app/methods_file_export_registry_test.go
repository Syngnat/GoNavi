package app

import (
	"bufio"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestFirebirdDropPreambleIsOneAtomicBlock(t *testing.T) {
	var out strings.Builder
	w := bufio.NewWriter(&out)
	err := writeSQLDropIfExistsPreambleWithDatabaseContext(w, connection.ConnectionConfig{Type: "firebird"}, "/data/app.fdb",
		[]string{"ORDERS", "CUSTOMERS"}, map[string]string{}, true, ExportFileOptions{IncludeDropIfExists: true}, true)
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Flush()
	text := out.String()
	if strings.Count(text, "EXECUTE BLOCK") != 1 || strings.Count(text, "EXECUTE STATEMENT") != 2 {
		t.Fatalf("Firebird drops must share one block:\n%s", text)
	}
	if strings.Index(text, `DROP TABLE "CUSTOMERS"`) > strings.Index(text, `DROP TABLE "ORDERS"`) {
		t.Fatalf("drops must run in reverse dump order:\n%s", text)
	}
	if strings.Contains(text, "IF EXISTS") {
		t.Fatalf("Firebird has no DROP IF EXISTS:\n%s", text)
	}
}

func TestOracleDropGuardUsesDialectMissingObjectCode(t *testing.T) {
	oracle := buildSQLDropIfExistsStatement(connection.ConnectionConfig{Type: "oracle"}, "APP", "ORDERS", false)
	yashan := buildSQLDropIfExistsStatement(connection.ConnectionConfig{Type: "yashandb"}, "APP", "ORDERS", false)
	if !strings.Contains(oracle, "SQLCODE != -942") || !strings.Contains(yashan, "SQLCODE != 2012") {
		t.Fatalf("unexpected guards:\n%s\n%s", oracle, yashan)
	}
}

func TestRegistrySQLExportDialectRules(t *testing.T) {
	for _, kind := range []string{"mysql", "tidb", "gbase8a"} {
		if !supportsMySQLDatabaseContext(connection.ConnectionConfig{Type: kind}) {
			t.Errorf("%s should write USE / CREATE DATABASE", kind)
		}
	}
	if supportsMySQLDatabaseContext(connection.ConnectionConfig{Type: "greptimedb"}) {
		t.Error("GreptimeDB does not borrow the MySQL dialect")
	}
	if got := normalizeInsertSQLDialect(" TiDB "); got != "mysql" {
		t.Errorf("tidb INSERT dialect = %q", got)
	}
	if got := normalizeInsertSQLDialect("cockroachdb"); got != "postgres" {
		t.Errorf("cockroachdb INSERT dialect = %q", got)
	}
	for _, kind := range []string{"questdb", "greptimedb", "firebird"} {
		if !isPgLikeBooleanDBType(kind) {
			t.Errorf("%s needs TRUE / FALSE literals", kind)
		}
	}
	if !dialectEscapesBackslashInStringLiteral("greptimedb") {
		t.Error("GreptimeDB string literals treat backslash as an escape")
	}
	if schema, table := normalizeSchemaAndTableByType("firebird", "/data/app.fdb", "ORDERS"); schema != "" || table != "ORDERS" {
		t.Errorf("Firebird tables are not schema-qualified: %q %q", schema, table)
	}
	if got := quoteQualifiedIdentByType("etcd", "/app/config.v1"); got != `"/app/config.v1"` {
		t.Errorf("etcd key paths keep dots: %s", got)
	}
}
