package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestNormalizeSchemaAndTable_SQLServerKeepsDatabaseAndQualifiedTable(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type:     "sqlserver",
		Database: "master",
	}, "biz_db", "dbo.users")

	if schemaOrDb != "biz_db" {
		t.Fatalf("expected sqlserver first return value as database name, got %q", schemaOrDb)
	}
	if table != "dbo.users" {
		t.Fatalf("expected sqlserver table name keep qualified form, got %q", table)
	}
}

func TestNormalizeSchemaAndTable_SQLServerFallbackToConfigDatabase(t *testing.T) {
	t.Parallel()

	schemaOrDb, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type:     "sqlserver",
		Database: "biz_db",
	}, "", "dbo.users")

	if schemaOrDb != "biz_db" {
		t.Fatalf("expected sqlserver fallback database from config, got %q", schemaOrDb)
	}
	if table != "dbo.users" {
		t.Fatalf("expected sqlserver table name keep qualified form, got %q", table)
	}
}

func TestNormalizeSchemaAndTable_PostgresStillSplitsQualifiedName(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTable(connection.ConnectionConfig{
		Type: "postgres",
	}, "demo_db", "public.orders")

	if schema != "public" || table != "orders" {
		t.Fatalf("expected postgres qualified split to public.orders, got %q.%q", schema, table)
	}
}
