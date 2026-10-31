package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveNativeObjectActionsUseProtectedHiveDDL(t *testing.T) {
	quote := func(name string) string { return string(rune(96)) + name + string(rune(96)) }
	table := quote("warehouse") + "." + quote("orders")
	view := quote("warehouse") + "." + quote("orders_view")
	cases := []struct {
		name string
		run  func(*App, connection.ConnectionConfig) connection.QueryResult
		want string
	}{
		{"rename table", func(app *App, config connection.ConnectionConfig) connection.QueryResult {
			return app.RenameTable(config, "warehouse", "orders", "orders_archive")
		}, "ALTER TABLE " + table + " RENAME TO " + quote("orders_archive")},
		{"drop table", func(app *App, config connection.ConnectionConfig) connection.QueryResult {
			return app.DropTable(config, "warehouse", "orders")
		}, "DROP TABLE " + table},
		{"rename view", func(app *App, config connection.ConnectionConfig) connection.QueryResult {
			return app.RenameView(config, "warehouse", "orders_view", "orders_archive")
		}, "ALTER VIEW " + view + " RENAME TO " + quote("orders_archive")},
		{"drop view", func(app *App, config connection.ConnectionConfig) connection.QueryResult {
			return app.DropView(config, "warehouse", "orders_view")
		}, "DROP VIEW " + view},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
			probe := &ddlProbeDB{}
			app := installDDLProbeApp(t, probe)
			config := connection.ConnectionConfig{Type: "hive", Host: "warehouse.example", Port: 10000, User: "analyst"}
			protected := config
			protected.ReadOnly = true
			if result := test.run(app, protected); result.Success || len(probe.executed) != 0 {
				t.Fatalf("Hive protected action dispatched a write: %+v, %v", result, probe.executed)
			}
			result := test.run(app, config)
			if !result.Success || len(probe.executed) != 1 || probe.executed[0] != test.want {
				t.Fatalf("Hive native DDL mismatch: %+v, queries=%v, want=%s", result, probe.executed, test.want)
			}
		})
	}
}
