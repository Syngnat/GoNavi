//go:build gonavi_full_drivers || gonavi_kwdb_driver

package db

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestKWDBLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_KWDB_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			admin := &KWDB{}
			if err := admin.Connect(liveConfig(t, "kwdb", addr, "root", "defaultdb")); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer admin.Close()
			variant, version := admin.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s", version, variant)
			seedPGWireRelational(t, admin, "gonavi_kwdb_smoke")
			defer func() { _, _ = admin.Exec("DROP DATABASE IF EXISTS gonavi_kwdb_smoke CASCADE") }()
			_, _ = admin.Exec("DROP DATABASE IF EXISTS gonavi_kwdb_ts CASCADE")
			mustExec(t, admin, "CREATE TS DATABASE gonavi_kwdb_ts")
			defer func() { _, _ = admin.Exec("DROP DATABASE IF EXISTS gonavi_kwdb_ts CASCADE") }()
			mustExec(t, admin, "CREATE TABLE gonavi_kwdb_ts.sensor (k_timestamp TIMESTAMPTZ NOT NULL, temperature FLOAT) TAGS (location VARCHAR(64) NOT NULL, device INT) PRIMARY TAGS (location)")
			mustExec(t, admin, "INSERT INTO gonavi_kwdb_ts.sensor VALUES (now(), 21.5, 'room1', 7)")

			client := &KWDB{}
			if err := client.Connect(liveConfig(t, "kwdb", addr, "root", "gonavi_kwdb_smoke")); err != nil {
				t.Fatalf("connect database: %v", err)
			}
			defer client.Close()
			assertPGWireRelationalMetadata(t, client, "kwdb_internal")

			ts := &KWDB{}
			if err := ts.Connect(liveConfig(t, "kwdb", addr, "root", "gonavi_kwdb_ts")); err != nil {
				t.Fatalf("connect ts database: %v", err)
			}
			defer ts.Close()
			tables, err := ts.GetTables("")
			if err != nil || strings.Join(tables, ",") != "public.sensor" {
				t.Fatalf("ts tables %v: %v", tables, err)
			}
			columns, err := ts.GetColumns("public", "sensor")
			if err != nil || len(columns) != 4 || columns[0].Key != "PRI" || columns[2].Extra != "PRIMARY TAG" || columns[3].Extra != "TAG" {
				t.Fatalf("ts columns %#v: %v", columns, err)
			}
			ddl, err := ts.GetCreateStatement("public", "sensor")
			if err != nil || !strings.Contains(strings.ToUpper(ddl), "PRIMARY TAGS") {
				t.Fatalf("ts ddl %q: %v", ddl, err)
			}
			err = ts.ApplyChangesContext(context.Background(), "public.sensor", connection.ChangeSet{
				Deletes: []map[string]interface{}{{"location": "room1"}},
			})
			if err == nil || !strings.Contains(err.Error(), "KWDB") {
				t.Fatalf("time-series row edits must be rejected with guidance, got %v", err)
			}
		})
	}
}
