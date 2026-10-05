//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

// TestInfluxDBLiveSmoke 连真实 InfluxDB：1.x 用户名密码、2.x token、3.x 免认证或 token，地址与凭据来自环境变量
// GONAVI_INFLUXDB{1,2,3}_TEST_ADDR / _USER / _PASSWORD / _TOKEN，库统一用 telemetry（2.x 为同名 bucket）。
func TestInfluxDBLiveSmoke(t *testing.T) {
	ran := false
	for _, major := range []string{"1", "2", "3"} {
		prefix := "GONAVI_INFLUXDB" + major + "_TEST_"
		addr := strings.TrimSpace(os.Getenv(prefix + "ADDR"))
		if addr == "" {
			continue
		}
		ran = true
		t.Run("v"+major+"@"+addr, func(t *testing.T) {
			config := liveConfig(t, "influxdb", addr, os.Getenv(prefix+"USER"), "telemetry")
			config.Password = os.Getenv(prefix + "PASSWORD")
			if token := os.Getenv(prefix + "TOKEN"); token != "" {
				config.ConnectionParams = "token=" + token
			}
			client := &InfluxDB{}
			if err := client.Connect(config); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s (org %q)", version, variant, client.org)
			if variant != "v"+major {
				t.Fatalf("variant = %q, want v%s", variant, major)
			}
			liveInfluxScenario(t, client, major)
		})
	}
	if !ran {
		t.Skip("set GONAVI_INFLUXDB{1,2,3}_TEST_ADDR to run live smoke tests")
	}
}

func liveInfluxScenario(t *testing.T, client *InfluxDB, major string) {
	t.Helper()
	measurement := fmt.Sprintf("gonavi_cpu_%d", time.Now().UnixNano())
	if affected, err := client.Exec(fmt.Sprintf("INSERT %s,host=a,region=us usage=0.5,count=3i,ok=true,label=\"x\" 1700000000000000000\n%s,host=b,region=eu usage=0.75,count=5i,ok=false,label=\"y\" 1700000060000000000", measurement, measurement)); err != nil || affected != 2 {
		t.Fatalf("insert line protocol = %d, %v", affected, err)
	}
	if databases, err := client.GetDatabases(); err != nil || !slices.Contains(databases, "telemetry") {
		t.Fatalf("databases %v: %v", databases, err)
	}
	if tables, err := client.GetTables("telemetry"); err != nil || !slices.Contains(tables, measurement) {
		t.Fatalf("measurements %v: %v", tables, err)
	}
	columns, err := client.GetColumns("telemetry", measurement)
	if err != nil {
		t.Fatalf("columns: %v", err)
	}
	types := map[string]string{}
	for _, column := range columns {
		types[column.Name] = column.Type + "/" + column.Key
	}
	if types["time"] != "timestamp/PRI" || types["host"] != "tag/PRI" || types["usage"] != "float/" || types["count"] != "integer/" || types["ok"] != "boolean/" {
		t.Fatalf("column types = %v", types)
	}

	quoted := `"` + measurement + `"`
	rows, _, err := client.Query(`SELECT * FROM ` + quoted + ` WHERE ("usage" > '0.6') ORDER BY "time" ASC, "host" ASC LIMIT 10 OFFSET 0`)
	if err != nil || len(rows) != 1 || rows[0]["host"] != "b" {
		t.Fatalf("grid filter rows %v: %v", rows, err)
	}
	for query, want := range map[string]int64{
		`SELECT COUNT(*) FROM ` + quoted:                                          2,
		`SELECT COUNT(*) FROM ` + quoted + ` WHERE ("host" LIKE 'a%')`:            1,
		`SELECT COUNT(*) FROM ` + quoted + ` WHERE ("host" IN ('a', 'b'))`:        2,
		`SELECT COUNT(*) FROM ` + quoted + ` WHERE ("count" BETWEEN '4' AND '9')`: 1,
	} {
		rows, _, err := client.Query(query)
		if err != nil || len(rows) != 1 || influxLiveCount(rows[0]) != want {
			t.Fatalf("%s = %v: %v", query, rows, err)
		}
	}

	rows, _, err = client.Query(`SELECT * FROM ` + quoted + ` WHERE "host" = 'a'`)
	if err != nil || len(rows) != 1 {
		t.Fatalf("point a %v: %v", rows, err)
	}
	keyTime := rows[0]["time"]
	gridChanges := connection.ChangeSet{
		Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"time": keyTime, "host": "a", "region": "us"}, Values: map[string]interface{}{"usage": "0.9"}}},
		Inserts: []map[string]interface{}{{"time": "2023-11-14T22:15:20Z", "host": "c", "region": "ap", "usage": "1.5", "count": "7", "ok": "true", "label": "z"}},
	}
	_, previewUpdates, previewInserts := client.PreviewChanges(measurement, gridChanges)
	if len(previewUpdates) != 1 || previewUpdates[0] != "INSERT "+measurement+",host=a,region=us usage=0.9 1700000000000000000" ||
		len(previewInserts) != 1 || !strings.HasPrefix(previewInserts[0], "INSERT "+measurement+",host=c,region=ap ") || !strings.HasSuffix(previewInserts[0], " 1700000120000000000") {
		t.Fatalf("preview updates=%q inserts=%q", previewUpdates, previewInserts)
	}
	if err := client.ApplyChanges(measurement, gridChanges); err != nil {
		t.Fatalf("grid update + insert: %v", err)
	}
	rows, _, err = client.Query(`SELECT * FROM ` + quoted + ` WHERE "host" = 'a'`)
	if err != nil || len(rows) != 1 || rows[0]["usage"] != 0.9 || rows[0]["count"] != int64(3) {
		t.Fatalf("updated point a %v: %v", rows, err)
	}
	if rows, _, err := client.Query(`SELECT COUNT(*) FROM ` + quoted); err != nil || influxLiveCount(rows[0]) != 3 {
		t.Fatalf("count after insert %v: %v", rows, err)
	}

	deleteChanges := connection.ChangeSet{Deletes: []map[string]interface{}{{"time": "2023-11-14T22:15:20Z", "host": "c", "region": "ap"}}}
	previewDeletes, _, _ := client.PreviewChanges(measurement, deleteChanges)
	wantDeletePrefix := map[string]string{"1": "DELETE FROM", "2": "POST /api/v2/delete?", "3": "# "}[major]
	if len(previewDeletes) != 1 || !strings.HasPrefix(previewDeletes[0], wantDeletePrefix) {
		t.Fatalf("preview deletes = %q", previewDeletes)
	}
	deleteErr := client.ApplyChanges(measurement, deleteChanges)
	if major == "3" {
		if deleteErr == nil {
			t.Fatal("InfluxDB 3 must refuse point deletes")
		}
	} else {
		if deleteErr != nil {
			t.Fatalf("grid delete: %v", deleteErr)
		}
		if rows, _, err := client.Query(`SELECT COUNT(*) FROM ` + quoted); err != nil || influxLiveCount(rows[0]) != 2 {
			t.Fatalf("count after delete %v: %v", rows, err)
		}
	}

	switch major {
	case "2":
		rows, columns, err := client.Query(`from(bucket: "telemetry") |> range(start: 0) |> filter(fn: (r) => r._measurement == "` + measurement + `" and r._field == "usage")`)
		if err != nil || len(rows) < 2 || !slices.Contains(columns, "_value") {
			t.Fatalf("flux rows %v columns %v: %v", rows, columns, err)
		}
	case "3":
		rows, columns, err := client.Query(`SELECT host, usage FROM ` + quoted + ` ORDER BY time`)
		if err != nil || len(rows) < 2 || !slices.Equal(columns, []string{"host", "usage"}) {
			t.Fatalf("sql rows %v columns %v: %v", rows, columns, err)
		}
		if tables, _, err := client.Query("SHOW MEASUREMENTS"); err != nil || len(tables) == 0 {
			t.Fatalf("influxql on v3 %v: %v", tables, err)
		}
	}
	if ddl, err := client.GetCreateStatement("telemetry", measurement); err != nil || !strings.Contains(ddl, "INSERT "+measurement+",host=<host>") {
		t.Fatalf("ddl %q: %v", ddl, err)
	}
}

func influxLiveCount(row map[string]interface{}) int64 {
	for _, key := range []string{"total", "count(*)", "COUNT(*)"} {
		if value, ok := row[key].(int64); ok {
			return value
		}
	}
	return -1
}
