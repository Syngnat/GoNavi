//go:build gonavi_full_drivers || gonavi_greptimedb_driver

package db

import (
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestGreptimeDBLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_GREPTIMEDB_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			client := &GreptimeDB{}
			if err := client.Connect(liveConfig(t, "greptimedb", addr, "", "")); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s", version, variant)
			if variant == "" || version == "" {
				t.Fatal("variant must be resolved from version()")
			}
			_, _ = client.Exec("DROP VIEW IF EXISTS gonavi_gt_busy")
			_, _ = client.Exec("DROP TABLE IF EXISTS gonavi_gt_monitor")
			mustExec(t, client, "CREATE TABLE gonavi_gt_monitor (host STRING, idc STRING, cpu DOUBLE, ts TIMESTAMP TIME INDEX, PRIMARY KEY (host, idc))")
			defer func() { _, _ = client.Exec("DROP TABLE IF EXISTS gonavi_gt_monitor") }()
			mustExec(t, client, "INSERT INTO gonavi_gt_monitor (host, idc, cpu, ts) VALUES ('h1', 'bj', 0.5, '2026-10-03 08:00:00'), ('h2', 'sh', 0.7, '2026-10-03 08:01:00')")
			mustExec(t, client, "CREATE VIEW gonavi_gt_busy AS SELECT * FROM gonavi_gt_monitor WHERE cpu > 0.6")
			defer func() { _, _ = client.Exec("DROP VIEW IF EXISTS gonavi_gt_busy") }()

			tables, err := client.GetTables("public")
			if err != nil || !slices.Contains(tables, "gonavi_gt_monitor") || slices.Contains(tables, "gonavi_gt_busy") {
				t.Fatalf("tables %v: %v", tables, err)
			}
			columns, err := client.GetColumns("public", "gonavi_gt_monitor")
			if err != nil || len(columns) != 4 || columns[0].Key != "PRI" || !strings.Contains(columns[0].Extra, "TAG") || !strings.Contains(columns[3].Extra, "TIME INDEX") {
				t.Fatalf("columns %#v: %v", columns, err)
			}
			indexes, err := client.GetIndexes("public", "gonavi_gt_monitor")
			if err != nil || len(indexes) < 3 {
				t.Fatalf("indexes %#v: %v", indexes, err)
			}
			ddl, err := client.GetCreateStatement("public", "gonavi_gt_monitor")
			if err != nil || !strings.Contains(ddl, "TIME INDEX") {
				t.Fatalf("ddl %q: %v", ddl, err)
			}
			viewDDL, err := client.GetCreateStatement("public", "gonavi_gt_busy")
			if err != nil || !strings.Contains(strings.ToUpper(viewDDL), "CREATE VIEW") {
				t.Fatalf("view ddl %q: %v", viewDDL, err)
			}
			if triggers, err := client.GetTriggers("public", "gonavi_gt_monitor"); err != nil || len(triggers) != 0 {
				t.Fatalf("triggers %v: %v", triggers, err)
			}
			rows, _, err := client.Query("SELECT host FROM gonavi_gt_monitor ORDER BY ts LIMIT 1 OFFSET 1")
			if err != nil || len(rows) != 1 || rows[0]["host"] != "h2" {
				t.Fatalf("page rows %v: %v", rows, err)
			}
			if err := client.ApplyChanges("gonavi_gt_monitor", connection.ChangeSet{Deletes: []map[string]interface{}{{"host": "h1"}}}); err == nil {
				t.Fatal("row edits must be rejected for GreptimeDB")
			}
		})
	}
}
