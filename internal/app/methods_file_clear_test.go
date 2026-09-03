package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestBuildTableDataClearSQL_TruncateUsesNativeStatementForSupportedDialect(t *testing.T) {
	t.Parallel()

	sql, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "mysql"}, "sales.orders", tableDataClearModeTruncate)
	if err != nil {
		t.Fatalf("buildTableDataClearSQL() unexpected error: %v", err)
	}

	if sql != "TRUNCATE TABLE `sales`.`orders`" {
		t.Fatalf("unexpected truncate sql: %s", sql)
	}
}

func TestBuildTableDataClearSQL_ClearUsesDeleteForCustomMySQLDriver(t *testing.T) {
	t.Parallel()

	sql, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "custom", Driver: "mysql"}, "orders", tableDataClearModeDeleteAll)
	if err != nil {
		t.Fatalf("buildTableDataClearSQL() unexpected error: %v", err)
	}

	if sql != "DELETE FROM `orders`" {
		t.Fatalf("unexpected delete sql for custom mysql driver: %s", sql)
	}
}

func TestBuildTableDataClearSQL_MySQLKeepsBracketCharactersLiteral(t *testing.T) {
	t.Parallel()

	sql, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "mysql"}, "[weird]]name]", tableDataClearModeDeleteAll)
	if err != nil {
		t.Fatalf("buildTableDataClearSQL() unexpected error: %v", err)
	}

	if sql != "DELETE FROM `[weird]]name]`" {
		t.Fatalf("unexpected MySQL bracket-literal delete sql: %s", sql)
	}
}

func TestBuildTableDataClearSQL_ClearUsesMongoDeleteCommand(t *testing.T) {
	t.Parallel()

	sql, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "mongodb"}, "logs", tableDataClearModeDeleteAll)
	if err != nil {
		t.Fatalf("buildTableDataClearSQL() unexpected error: %v", err)
	}

	if sql != `{"delete":"logs","deletes":[{"q":{},"limit":0}]}` {
		t.Fatalf("unexpected mongo clear command: %s", sql)
	}
}

func TestBuildTableDataClearSQL_KingbaseTruncateNormalizesQuotedQualifiedTable(t *testing.T) {
	t.Parallel()

	sql, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "kingbase"}, `\"Idf_server\".\"mes_bip_wip_finished\"`, tableDataClearModeTruncate)
	if err != nil {
		t.Fatalf("buildTableDataClearSQL() unexpected error: %v", err)
	}

	if sql != `TRUNCATE TABLE "Idf_server".mes_bip_wip_finished` {
		t.Fatalf("unexpected kingbase truncate sql: %s", sql)
	}
}

func TestBuildTableDataClearSQL_KingbaseTruncateLeavesLowercaseQualifiedTableUnquoted(t *testing.T) {
	t.Parallel()

	sql, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "kingbase"}, "ldf_server.andon_events", tableDataClearModeTruncate)
	if err != nil {
		t.Fatalf("buildTableDataClearSQL() unexpected error: %v", err)
	}

	if sql != "TRUNCATE TABLE ldf_server.andon_events" {
		t.Fatalf("unexpected kingbase truncate sql: %s", sql)
	}
}

func TestBuildTableDataClearSQL_KingbaseClearNormalizesQuotedQualifiedTable(t *testing.T) {
	t.Parallel()

	sql, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "kingbase"}, `\"Idf_server\".\"mes_bip_wip_finished\"`, tableDataClearModeDeleteAll)
	if err != nil {
		t.Fatalf("buildTableDataClearSQL() unexpected error: %v", err)
	}

	if sql != `DELETE FROM "Idf_server".mes_bip_wip_finished` {
		t.Fatalf("unexpected kingbase clear sql: %s", sql)
	}
}

func TestBuildTableDataClearSQL_IRISTruncateUsesNativeStatement(t *testing.T) {
	t.Parallel()

	sql, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "InterSystemsIRIS"}, "Sample.Person", tableDataClearModeTruncate)
	if err != nil {
		t.Fatalf("buildTableDataClearSQL() unexpected error: %v", err)
	}

	if sql != `TRUNCATE TABLE "Sample"."Person"` {
		t.Fatalf("unexpected iris truncate sql: %s", sql)
	}
}

func TestBuildTableDataClearSQL_TruncateRejectsUnsupportedDialect(t *testing.T) {
	t.Parallel()

	_, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "sqlite"}, "orders", tableDataClearModeTruncate)
	if err == nil {
		t.Fatal("expected truncate to reject sqlite")
	}
	if !strings.Contains(err.Error(), "file.backend.error.table_data_truncate_unsupported") {
		t.Fatalf("unexpected error: %v", err)
	}
}
