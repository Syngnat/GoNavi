//go:build gonavi_hive_driver

package sync

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

// TestHiveLiveSync is opt-in and uses only unique gonavi_sync_* databases.
// The caller supplies an isolated Hive endpoint; no service is provisioned here.
func TestHiveLiveSync(t *testing.T) {
	base := hiveLiveConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	admin := &db.HiveDB{}
	if err := admin.Connect(base); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := admin.Close(); err != nil {
			t.Errorf("close live Hive: %v", err)
		}
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	sourceSchema, targetSchema := "gonavi_sync_src_"+suffix, "gonavi_sync_dst_"+suffix
	for _, schema := range []string{sourceSchema, targetSchema} {
		hiveLiveExec(t, ctx, admin, "CREATE DATABASE "+hivesql.QuoteIdentifier(schema))
		name := schema
		t.Cleanup(func() {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), time.Minute)
			defer cleanupCancel()
			if !strings.HasPrefix(name, "gonavi_sync_") {
				t.Errorf("unsafe fixture cleanup identity %q", name)
				return
			}
			if _, err := admin.ExecContext(cleanupCtx, "DROP DATABASE "+hivesql.QuoteIdentifier(name)+" CASCADE"); err != nil {
				t.Errorf("cleanup live fixture %s: %v", name, err)
			}
		})
	}
	t.Run("managed_partitioned_full_append_overwrite", func(t *testing.T) {
		hiveLivePartitionCopy(t, ctx, admin, base, sourceSchema, targetSchema)
	})
	t.Run("acid_logical_key_delta", func(t *testing.T) {
		if os.Getenv("GONAVI_HIVE_LIVE_ACID") != "1" {
			t.Skip("set GONAVI_HIVE_LIVE_ACID=1 on an ACID-enabled isolated Hive")
		}
		hiveLiveACIDDelta(t, ctx, admin, base, sourceSchema, targetSchema)
	})
	t.Run("nested_binary_read_is_explicitly_rejected", func(t *testing.T) {
		hiveLiveNestedBinaryConstraint(t, ctx, admin, base, sourceSchema, targetSchema)
	})
}

func hiveLiveConfig(t *testing.T) connection.ConnectionConfig {
	t.Helper()
	return hiveSyncEnvironmentConfig(t)
}

func hiveLiveExec(t *testing.T, ctx context.Context, database *db.HiveDB, statement string) {
	t.Helper()
	if _, err := database.ExecContext(ctx, statement); err != nil {
		t.Fatalf("live Hive fixture SQL failed: %v", err)
	}
}

func hiveLiveRun(t *testing.T, ctx context.Context, config SyncConfig) SyncResult {
	t.Helper()
	useHiveSyncTestDBs(t, &db.HiveDB{}, &db.HiveDB{})
	result := NewSyncEngine(Reporter{}).RunSyncContext(ctx, config)
	if !result.Success {
		t.Fatalf("live Hive sync failed: %+v", result)
	}
	return result
}

func hiveLivePartitionCopy(t *testing.T, ctx context.Context, admin *db.HiveDB, base connection.ConnectionConfig, sourceSchema, targetSchema string) {
	sourceTable := hivesql.QuoteTable(sourceSchema + ".events")
	targetTable := hivesql.QuoteTable(targetSchema + ".events")
	hiveLiveExec(t, ctx, admin, "CREATE TABLE "+sourceTable+" (id BIGINT, name STRING, amount DECIMAL(38,18), stamp TIMESTAMP, payload ARRAY<INT>, bytes BINARY) PARTITIONED BY (day STRING) STORED AS ORC")
	for i := 1; i <= 2; i++ {
		statement := fmt.Sprintf("INSERT INTO TABLE %s PARTITION(day='2026-10-25') SELECT CAST(%d AS BIGINT), 'hive-copy', CAST('12345678901234567890.123456789012345678' AS DECIMAL(38,18)), CAST('2026-10-25 01:02:03.123456789' AS TIMESTAMP), array(1,2), unhex('00ff')", sourceTable, i)
		hiveLiveExec(t, ctx, admin, statement)
	}
	config := SyncConfig{SourceConfig: base, TargetConfig: base, Tables: []string{"events"}, Content: "both", Mode: "insert_only", TargetTableStrategy: "auto_create_if_missing", BatchSize: 1}
	config.SourceConfig.Database, config.TargetConfig.Database = sourceSchema, targetSchema
	if result := hiveLiveRun(t, ctx, config); result.RowsInserted != 2 {
		t.Fatalf("initial copy rows = %+v", result)
	}
	config.Content, config.TargetTableStrategy = "data", "existing_only"
	if result := hiveLiveRun(t, ctx, config); result.RowsInserted != 2 {
		t.Fatalf("append rows = %+v", result)
	}
	rows, _, err := admin.QueryContext(ctx, "SELECT id FROM "+targetTable)
	if err != nil || len(rows) != 4 {
		t.Fatalf("append target count = %d, %v", len(rows), err)
	}
	config.Mode = "full_overwrite"
	if result := hiveLiveRun(t, ctx, config); result.RowsInserted != 2 {
		t.Fatalf("overwrite rows = %+v", result)
	}
	config.SourceQuery = "SELECT * FROM " + sourceTable + " WHERE id >= 1"
	if result := hiveLiveRun(t, ctx, config); result.RowsInserted != 2 {
		t.Fatalf("SQL-source overwrite rows = %+v", result)
	}
	rows, _, err = admin.QueryContext(ctx, "SELECT id AS verified_id, amount AS verified_amount, day AS verified_day, hex(bytes) AS verified_hex, CAST(stamp AS STRING) AS verified_stamp, payload AS verified_payload FROM "+targetTable+" ORDER BY id")
	if err != nil || len(rows) != 2 {
		t.Fatalf("overwrite target count = %d, %v", len(rows), err)
	}
	for _, row := range rows {
		if fmt.Sprint(row["verified_hex"]) != "00FF" {
			t.Fatalf("binary bytes changed: %v", row["verified_hex"])
		}
		if fmt.Sprint(row["verified_stamp"]) != "2026-10-25 01:02:03.123456789" {
			t.Fatalf("timestamp nanoseconds changed: %v", row["verified_stamp"])
		}
		literal, err := hivesql.Value("ARRAY<INT>", row["verified_payload"])
		expected, expectedErr := hivesql.Value("ARRAY<INT>", []int{1, 2})
		if err != nil || expectedErr != nil || literal != expected {
			t.Fatalf("complex value changed: %v (%v)", row["verified_payload"], err)
		}
		if fmt.Sprint(row["verified_amount"]) != "12345678901234567890.123456789012345678" {
			t.Fatalf("decimal precision changed: %v", row["verified_amount"])
		}
		if fmt.Sprint(row["verified_day"]) != "2026-10-25" {
			t.Fatalf("partition value changed: %v", row["verified_day"])
		}
	}
}

func hiveLiveNestedBinaryConstraint(t *testing.T, ctx context.Context, admin *db.HiveDB, base connection.ConnectionConfig, sourceSchema, targetSchema string) {
	sourceTable := hivesql.QuoteTable(sourceSchema + ".nested_binary")
	hiveLiveExec(t, ctx, admin, "CREATE TABLE "+sourceTable+" (payload MAP<STRING,BINARY>) STORED AS ORC")
	hiveLiveExec(t, ctx, admin, "INSERT INTO TABLE "+sourceTable+" SELECT map('bytes', unhex('00ff'))")
	config := SyncConfig{SourceConfig: base, TargetConfig: base, Tables: []string{"nested_binary"}, Content: "both", Mode: "insert_only", TargetTableStrategy: "auto_create_if_missing"}
	config.SourceConfig.Database, config.TargetConfig.Database = sourceSchema, targetSchema
	useHiveSyncTestDBs(t, &db.HiveDB{}, &db.HiveDB{})
	result := NewSyncEngine(Reporter{}).RunSyncContext(ctx, config)
	if result.Success || !strings.Contains(strings.ToUpper(result.Message), "HEX/BASE64") {
		t.Fatalf("nested binary must be explicitly rejected, not repaired: %+v", result)
	}
	exists, err := admin.TableExists(targetSchema, "nested_binary")
	if err != nil || exists {
		t.Fatalf("unreadable nested binary source created target: exists=%t err=%v", exists, err)
	}
}

func hiveLiveACIDDelta(t *testing.T, ctx context.Context, admin *db.HiveDB, base connection.ConnectionConfig, sourceSchema, targetSchema string) {
	sourceTable, targetTable := hivesql.QuoteTable(sourceSchema+".acid_events"), hivesql.QuoteTable(targetSchema+".acid_events")
	hiveLiveExec(t, ctx, admin, "CREATE TABLE "+sourceTable+" (id BIGINT, name STRING) STORED AS ORC")
	hiveLiveExec(t, ctx, admin, "CREATE TABLE "+targetTable+" (id BIGINT, name STRING) STORED AS ORC TBLPROPERTIES ('transactional'='true')")
	hiveLiveExec(t, ctx, admin, "INSERT INTO TABLE "+sourceTable+" SELECT CAST(1 AS BIGINT), 'new' UNION ALL SELECT CAST(2 AS BIGINT), 'added'")
	hiveLiveExec(t, ctx, admin, "INSERT INTO TABLE "+targetTable+" SELECT CAST(1 AS BIGINT), 'old' UNION ALL SELECT CAST(3 AS BIGINT), 'removed'")
	config := SyncConfig{SourceConfig: base, TargetConfig: base, Tables: []string{"acid_events"}, Content: "data", Mode: "insert_update", BatchSize: 2,
		Mappings:     []SyncObjectMapping{{Source: SyncObjectRef{Name: "acid_events"}, Target: SyncObjectRef{Name: "acid_events"}, KeyColumns: []string{"id"}}},
		TableOptions: map[string]TableOptions{"acid_events": {Insert: true, Update: true, Delete: true}}}
	config.SourceConfig.Database, config.TargetConfig.Database = sourceSchema, targetSchema
	result := hiveLiveRun(t, ctx, config)
	if result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("ACID delta = %+v", result)
	}
	rows, _, err := admin.QueryContext(ctx, "SELECT id AS verified_id, name AS verified_name FROM "+targetTable+" ORDER BY id")
	if err != nil || len(rows) != 2 || fmt.Sprint(rows[0]["verified_name"]) != "new" || fmt.Sprint(rows[1]["verified_name"]) != "added" {
		t.Fatalf("ACID target = %v, %v", rows, err)
	}
}
