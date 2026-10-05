package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestRegistryObjectStatementsQuoteIdentifiersByDeclaredRule(t *testing.T) {
	cases := []struct {
		action string
		names  map[string]string
		want   string
	}{
		{"renameTable", map[string]string{"old": "orders", "new": "Orders_2026"}, `RENAME TABLE orders TO "Orders_2026"`},
		{"dropTable", map[string]string{"table": `"customers"`}, "DROP TABLE customers"},
		{"dropRoutine", map[string]string{"name": "gn_proc", "type": "PROCEDURE"}, "DROP PROCEDURE gn_proc"},
		{"truncateTable", map[string]string{"table": "audit log"}, `TRUNCATE TABLE "audit log"`},
	}
	for _, testCase := range cases {
		got, ok := registryObjectStatement("gbase8s", testCase.action, testCase.names)
		if !ok || got != testCase.want {
			t.Errorf("%s: got %q (%v), want %q", testCase.action, got, ok, testCase.want)
		}
	}
	if _, ok := registryObjectStatement("tidb", "dropTable", map[string]string{"table": "t"}); ok {
		t.Fatal("types that borrow a dialect keep the historical statements")
	}
	if sql, err := buildTableDataClearSQL(connection.ConnectionConfig{Type: "gbase8s"}, "orders", tableDataClearModeTruncate); err != nil || sql != "TRUNCATE TABLE orders" {
		t.Fatalf("truncate sql %q %v", sql, err)
	}
	for quoting, want := range map[string]string{"pg": "orders", "double": `"orders"`, "backtick": "`orders`", "bracket": "[orders]"} {
		if got := registryQuoteIdent(quoting, "orders"); got != want {
			t.Errorf("quoting %s: got %s, want %s", quoting, got, want)
		}
	}
}
