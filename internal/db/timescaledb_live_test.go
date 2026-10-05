//go:build gonavi_full_drivers || gonavi_timescaledb_driver

package db

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestTimescaleDBLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_TIMESCALEDB_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			config := liveConfig(t, "timescaledb", addr, "postgres", "postgres")
			config.Password = "gonavi"
			client := &TimescaleDB{}
			if err := client.Connect(config); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("extension %s resolved to variant %s", version, variant)
			if variant == "" || version == "" {
				t.Fatal("variant must be resolved from pg_extension")
			}
			rows, _, err := client.Query("SELECT current_schema() AS schema_name")
			if err != nil || fmt.Sprint(rows[0]["schema_name"]) != "public" {
				t.Fatalf("current schema %v: %v", rows, err)
			}

			_, _ = client.Exec("DROP VIEW IF EXISTS gonavi_ts_hourly CASCADE")
			_, _ = client.Exec("DROP MATERIALIZED VIEW IF EXISTS gonavi_ts_hourly CASCADE")
			_, _ = client.Exec("DROP TABLE IF EXISTS gonavi_ts_conditions CASCADE")
			mustExec(t, client, "CREATE TABLE gonavi_ts_conditions (time TIMESTAMPTZ NOT NULL, device TEXT NOT NULL, temperature DOUBLE PRECISION)")
			defer func() { _, _ = client.Exec("DROP TABLE IF EXISTS gonavi_ts_conditions CASCADE") }()
			mustExec(t, client, "SELECT create_hypertable('gonavi_ts_conditions', 'time', chunk_time_interval => INTERVAL '1 day')")
			mustExec(t, client, "INSERT INTO gonavi_ts_conditions VALUES ('2026-10-03 08:00+00', 'dev-1', 21.5), ('2026-10-04 08:00+00', 'dev-2', 19.0)")
			cagg := "CREATE MATERIALIZED VIEW gonavi_ts_hourly WITH (timescaledb.continuous) AS SELECT time_bucket('1 hour', time) AS bucket, device, avg(temperature) AS avg_temp FROM gonavi_ts_conditions GROUP BY bucket, device WITH NO DATA"
			if !client.atLeast("2.0") {
				cagg = "CREATE VIEW gonavi_ts_hourly WITH (timescaledb.continuous) AS SELECT time_bucket('1 hour', time) AS bucket, device, avg(temperature) AS avg_temp FROM gonavi_ts_conditions GROUP BY bucket, device"
			}
			mustExec(t, client, cagg)

			tables, err := client.GetTables("postgres")
			if err != nil || !slices.Contains(tables, "public.gonavi_ts_conditions") {
				t.Fatalf("tables %v: %v", tables, err)
			}
			for _, table := range tables {
				if IsTimescaleDBInternalSchema(timescaleQualifiedNameSchema(table)) {
					t.Fatalf("internal table leaked: %s", table)
				}
			}
			columns, err := client.GetAllColumns("postgres")
			if err != nil {
				t.Fatalf("all columns: %v", err)
			}
			for _, column := range columns {
				if IsTimescaleDBInternalSchema(timescaleQualifiedNameSchema(column.TableName)) {
					t.Fatalf("internal column leaked: %s", column.TableName)
				}
			}
			ddl, err := client.GetCreateStatement("public", "gonavi_ts_hourly")
			if err != nil || !strings.Contains(ddl, "timescaledb.continuous") || !strings.Contains(ddl, "time_bucket") {
				t.Fatalf("continuous aggregate ddl %q: %v", ddl, err)
			}
		})
	}
}
