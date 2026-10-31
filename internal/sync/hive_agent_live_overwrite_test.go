package sync

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// TestHiveLiveAgentAutoCreateAndOverwrite proves the operator-installed Hive
// agent can drive real DDL and overwrite, not only constant SELECT streaming.
// It requires GONAVI_HIVE_LIVE_* plus GONAVI_HIVE_LIVE_AGENT_PATH and runs real
// MapReduce work, so it never enables itself.
func TestHiveLiveAgentAutoCreateAndOverwrite(t *testing.T) {
	agentPath := strings.TrimSpace(os.Getenv("GONAVI_HIVE_LIVE_AGENT_PATH"))
	if agentPath == "" {
		t.Skip("GONAVI_HIVE_LIVE_AGENT_PATH is not configured")
	}
	base := hiveSyncEnvironmentConfig(t)
	installHiveAgentPrivateFixture(t, agentPath)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	sourceSchema, targetSchema := "gonavi_agent_src_"+suffix, "gonavi_agent_dst_"+suffix
	admin := newHiveAgentAdmin(t, base)
	for _, schema := range []string{sourceSchema, targetSchema} {
		schema := schema
		t.Cleanup(func() {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cleanupCancel()
			_, _ = admin.ExecContext(cleanupCtx, "DROP DATABASE IF EXISTS "+quoteAgentIdent(schema)+" CASCADE")
		})
	}
	executeHiveAgent(t, ctx, admin, "CREATE DATABASE "+quoteAgentIdent(sourceSchema))
	executeHiveAgent(t, ctx, admin, "CREATE DATABASE "+quoteAgentIdent(targetSchema))
	executeHiveAgent(t, ctx, admin, "CREATE TABLE "+quoteAgentIdent(sourceSchema)+".events (id BIGINT, note STRING) STORED AS ORC")
	executeHiveAgent(t, ctx, admin, "INSERT INTO "+quoteAgentIdent(sourceSchema)+".events VALUES (1, 'a'), (2, 'b')")

	config := SyncConfig{
		SourceConfig: base, TargetConfig: base,
		Tables: []string{"events"}, Content: "both", Mode: "insert_only",
		TargetTableStrategy: "auto_create_if_missing", BatchSize: 2,
	}
	config.SourceConfig.Database, config.TargetConfig.Database = sourceSchema, targetSchema
	if result := runHiveAgentSync(t, config); result.RowsInserted != 2 {
		t.Fatalf("agent auto-create rows = %+v", result)
	}
	if tableType := hiveAgentTableType(t, ctx, admin, targetSchema, "events"); tableType != "MANAGED_TABLE" {
		t.Fatalf("agent-created Hive 4 target must be managed, got %q", tableType)
	}
	capabilities, err := admin.HiveTableWriteCapabilities(ctx, targetSchema+".events")
	if err != nil || !capabilities.Insert || !capabilities.Truncate {
		t.Fatalf("agent-created target is not overwrite-capable: %+v %v", capabilities, err)
	}

	config.Mode, config.TargetTableStrategy = "full_overwrite", "existing_only"
	if result := runHiveAgentSync(t, config); result.RowsInserted != 2 {
		t.Fatalf("agent overwrite rows = %+v", result)
	}
	if rows := hiveAgentRowCount(t, ctx, admin, targetSchema, "events"); rows != 2 {
		t.Fatalf("agent overwrite kept %d rows, want exactly 2", rows)
	}
}

func newHiveAgentAdmin(t *testing.T, config connection.ConnectionConfig) *db.OptionalDriverAgentDB {
	t.Helper()
	database, err := db.NewDatabase("hive")
	if err != nil {
		t.Fatal(err)
	}
	proxy, ok := database.(*db.OptionalDriverAgentDB)
	if !ok {
		t.Fatalf("Hive must run through the installed agent, got %T", database)
	}
	if err := proxy.Connect(config); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = proxy.Close() })
	return proxy
}

func runHiveAgentSync(t *testing.T, config SyncConfig) SyncResult {
	t.Helper()
	source, err := db.NewDatabase("hive")
	if err != nil {
		t.Fatal(err)
	}
	target, err := db.NewDatabase("hive")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := source.(*db.OptionalDriverAgentDB); !ok {
		t.Fatalf("sync source must use the agent, got %T", source)
	}
	if _, ok := target.(*db.OptionalDriverAgentDB); !ok {
		t.Fatalf("sync target must use the agent, got %T", target)
	}
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success {
		t.Fatalf("agent Hive sync failed: %+v", result)
	}
	return result
}

func executeHiveAgent(t *testing.T, ctx context.Context, database *db.OptionalDriverAgentDB, statement string) {
	t.Helper()
	if _, err := database.ExecContext(ctx, statement); err != nil {
		t.Fatalf("agent Hive statement failed (%s): %v", statement, err)
	}
}

func hiveAgentTableType(t *testing.T, ctx context.Context, database *db.OptionalDriverAgentDB, schema, table string) string {
	t.Helper()
	rows, fields, err := database.QueryContext(ctx, "DESCRIBE FORMATTED "+quoteAgentIdent(schema)+"."+quoteAgentIdent(table))
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		label := ""
		for _, field := range fields {
			label += strings.TrimSpace(fmt.Sprint(row[field]))
		}
		label = strings.ToUpper(label)
		if strings.Contains(label, "MANAGED_TABLE") {
			return "MANAGED_TABLE"
		}
		if strings.Contains(label, "EXTERNAL_TABLE") {
			return "EXTERNAL_TABLE"
		}
	}
	return ""
}

func hiveAgentRowCount(t *testing.T, ctx context.Context, database *db.OptionalDriverAgentDB, schema, table string) int {
	t.Helper()
	rows, _, err := database.QueryContext(ctx, "SELECT id FROM "+quoteAgentIdent(schema)+"."+quoteAgentIdent(table))
	if err != nil {
		t.Fatal(err)
	}
	return len(rows)
}

func quoteAgentIdent(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}
