package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestBuildSchemaMigrationPlan_TDengineTargetWarnsInsertOnlyBoundary(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"shop.metrics": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "ts", Type: "datetime", Nullable: "NO"},
				{Name: "value", Type: "double", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"taos.metrics": {
				{Name: "id", Type: "bigint", Nullable: "NO"},
				{Name: "ts", Type: "timestamp", Nullable: "NO"},
				{Name: "value", Type: "double", Nullable: "YES"},
			},
		},
	}
	cfg := SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig: connection.ConnectionConfig{Type: "tdengine", Database: "taos"},
		Mode:         "insert_update",
	}

	plan, _, _, err := buildSchemaMigrationPlan(cfg, "metrics", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildSchemaMigrationPlan returned error: %v", err)
	}
	warnings := strings.Join(plan.Warnings, " ")
	if !strings.Contains(warnings, "仅支持 INSERT 写入") {
		t.Fatalf("expected TDengine target warning, got: %v", plan.Warnings)
	}
}

func TestBuildSchemaMigrationPlan_IoTDBTargetWarnsInsertOnlyBoundary(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"shop.metrics": {
				{Name: "Time", Type: "timestamp", Nullable: "NO", Key: "PRI"},
				{Name: "value", Type: "double", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"root.sg.metrics": {
				{Name: "Time", Type: "timestamp", Nullable: "NO", Key: "PRI"},
				{Name: "value", Type: "double", Nullable: "YES"},
			},
		},
	}
	cfg := SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig: connection.ConnectionConfig{Type: "iotdb", Database: "root.sg"},
		Mode:         "insert_update",
	}

	plan, _, _, err := buildSchemaMigrationPlan(cfg, "metrics", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildSchemaMigrationPlan returned error: %v", err)
	}
	warnings := strings.Join(plan.Warnings, " ")
	if !strings.Contains(warnings, "仅支持 INSERT 写入") {
		t.Fatalf("expected IoTDB target warning, got: %v", plan.Warnings)
	}
}

func TestBuildMySQLLikeToTDenginePlan_AutoCreateWhenTargetMissing(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"shop.metrics": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI", Extra: "auto_increment"},
				{Name: "ts", Type: "datetime", Nullable: "NO"},
				{Name: "payload", Type: "json", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig:        connection.ConnectionConfig{Type: "tdengine", Database: "taos"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildMySQLLikeToTDenginePlan(cfg, "metrics", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildMySQLLikeToTDenginePlan returned error: %v", err)
	}
	if len(sourceCols) != 3 || len(targetCols) != 0 {
		t.Fatalf("unexpected columns lengths: source=%d target=%d", len(sourceCols), len(targetCols))
	}
	if !plan.AutoCreate {
		t.Fatalf("expected auto create enabled")
	}
	if !strings.Contains(plan.CreateTableSQL, "CREATE TABLE `taos`.`metrics`") {
		t.Fatalf("unexpected create sql: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`ts` TIMESTAMP") {
		t.Fatalf("expected ts first column mapped to TIMESTAMP, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`payload` VARCHAR(") {
		t.Fatalf("expected json degrade to VARCHAR, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(strings.Join(plan.Warnings, " "), "insert-only") && !strings.Contains(strings.Join(plan.Warnings, " "), "INSERT") {
		t.Fatalf("expected tdengine target warning, got: %v", plan.Warnings)
	}
}

func TestBuildPGLikeToTDenginePlan_AutoCreateWhenTargetMissing(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"public.metrics": {
				{Name: "event_time", Type: "timestamp without time zone", Nullable: "NO"},
				{Name: "name", Type: "character varying(64)", Nullable: "YES"},
				{Name: "meta", Type: "jsonb", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "postgres", Database: "ignored"},
		TargetConfig:        connection.ConnectionConfig{Type: "tdengine", Database: "taos"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildPGLikeToTDenginePlan(cfg, "metrics", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildPGLikeToTDenginePlan returned error: %v", err)
	}
	if len(sourceCols) != 3 || len(targetCols) != 0 {
		t.Fatalf("unexpected columns lengths: source=%d target=%d", len(sourceCols), len(targetCols))
	}
	if !plan.AutoCreate {
		t.Fatalf("expected auto create enabled")
	}
	if !strings.Contains(plan.CreateTableSQL, "CREATE TABLE `taos`.`metrics`") {
		t.Fatalf("unexpected create sql: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`event_time` TIMESTAMP") {
		t.Fatalf("expected timestamp mapping, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`meta` VARCHAR(") {
		t.Fatalf("expected jsonb degrade to VARCHAR, got: %s", plan.CreateTableSQL)
	}
}

func TestBuildMySQLLikeToTDenginePlan_RejectsAutoCreateWithoutTimestampColumn(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"shop.metrics": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(64)", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig:        connection.ConnectionConfig{Type: "tdengine", Database: "taos"},
		TargetTableStrategy: "smart",
	}
	plan, _, _, err := buildMySQLLikeToTDenginePlan(cfg, "metrics", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildMySQLLikeToTDenginePlan returned error: %v", err)
	}
	if plan.AutoCreate {
		t.Fatalf("expected auto create disabled when source has no timestamp column")
	}
	if !strings.Contains(plan.PlannedAction, "时间列") {
		t.Fatalf("unexpected planned action: %s", plan.PlannedAction)
	}
	if !strings.Contains(strings.Join(plan.Warnings, " "), "时间列") {
		t.Fatalf("expected missing timestamp warning, got: %v", plan.Warnings)
	}
}

func TestBuildClickHouseToTDenginePlan_AutoCreateWhenTargetMissing(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"analytics.metrics": {
				{Name: "event_time", Type: "DateTime64(3)", Nullable: "NO"},
				{Name: "host", Type: "FixedString(64)", Nullable: "YES"},
				{Name: "payload", Type: "Map(String,String)", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "clickhouse", Database: "analytics"},
		TargetConfig:        connection.ConnectionConfig{Type: "tdengine", Database: "taos"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildClickHouseToTDenginePlan(cfg, "metrics", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildClickHouseToTDenginePlan returned error: %v", err)
	}
	if len(sourceCols) != 3 || len(targetCols) != 0 {
		t.Fatalf("unexpected columns lengths: source=%d target=%d", len(sourceCols), len(targetCols))
	}
	if !plan.AutoCreate {
		t.Fatalf("expected auto create enabled")
	}
	if !strings.Contains(plan.CreateTableSQL, "CREATE TABLE `taos`.`metrics`") {
		t.Fatalf("unexpected create sql: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`event_time` TIMESTAMP") {
		t.Fatalf("expected datetime64 mapping, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`host` VARCHAR(64)") {
		t.Fatalf("expected fixedstring mapping, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`payload` VARCHAR(") {
		t.Fatalf("expected complex type degrade to VARCHAR, got: %s", plan.CreateTableSQL)
	}
}

func TestBuildClickHouseToPGLikePlan_AutoCreateWhenTargetMissing(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"analytics.metrics": {
				{Name: "id", Type: "UInt64", Nullable: "NO", Key: "PRI"},
				{Name: "event_time", Type: "DateTime64(3)", Nullable: "NO"},
				{Name: "host", Type: "FixedString(64)", Nullable: "YES"},
				{Name: "payload", Type: "Map(String,String)", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "clickhouse", Database: "analytics"},
		TargetConfig:        connection.ConnectionConfig{Type: "postgres", Database: "public"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildClickHouseToPGLikePlan(cfg, "metrics", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildClickHouseToPGLikePlan returned error: %v", err)
	}
	if len(sourceCols) != 4 || len(targetCols) != 0 {
		t.Fatalf("unexpected columns lengths: source=%d target=%d", len(sourceCols), len(targetCols))
	}
	if !plan.AutoCreate {
		t.Fatalf("expected auto create enabled")
	}
	if !strings.Contains(plan.CreateTableSQL, `CREATE TABLE "public"."metrics"`) {
		t.Fatalf("unexpected create sql: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, `"id" numeric(20,0)`) {
		t.Fatalf("expected uint64 safeguard mapping, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, `"event_time" timestamp`) {
		t.Fatalf("expected datetime64 mapping, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, `"host" varchar(64)`) {
		t.Fatalf("expected fixedstring mapping, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, `"payload" jsonb`) {
		t.Fatalf("expected complex type degrade to jsonb, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, `PRIMARY KEY ("id")`) {
		t.Fatalf("expected primary key preservation, got: %s", plan.CreateTableSQL)
	}
}

func TestBuildPGLikeToClickHousePlan_AutoCreateWhenTargetMissing(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"public.orders": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "created_at", Type: "timestamp without time zone", Nullable: "NO"},
				{Name: "profile", Type: "jsonb", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "postgres", Database: "public"},
		TargetConfig:        connection.ConnectionConfig{Type: "clickhouse", Database: "analytics"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildPGLikeToClickHousePlan(cfg, "orders", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildPGLikeToClickHousePlan returned error: %v", err)
	}
	if len(sourceCols) != 3 || len(targetCols) != 0 {
		t.Fatalf("unexpected columns lengths: source=%d target=%d", len(sourceCols), len(targetCols))
	}
	if !plan.AutoCreate {
		t.Fatalf("expected auto create enabled")
	}
	if !strings.Contains(plan.CreateTableSQL, "CREATE TABLE `analytics`.`orders`") {
		t.Fatalf("unexpected create sql: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`created_at` DateTime") {
		t.Fatalf("expected timestamp mapping, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`profile` Nullable(String)") {
		t.Fatalf("expected jsonb degrade to Nullable(String), got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "ORDER BY (`id`)") {
		t.Fatalf("expected primary key order by, got: %s", plan.CreateTableSQL)
	}
}

func TestBuildTDengineToTDenginePlan_AutoCreateWhenTargetMissing(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"src.cpu": {
				{Name: "ts", Type: "TIMESTAMP", Nullable: "NO"},
				{Name: "host", Type: "NCHAR(64)", Nullable: "YES"},
				{Name: "region", Type: "NCHAR(32)", Nullable: "YES", Key: "TAG"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "tdengine", Database: "src"},
		TargetConfig:        connection.ConnectionConfig{Type: "tdengine", Database: "dst"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildTDengineToTDenginePlan(cfg, "cpu", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildTDengineToTDenginePlan returned error: %v", err)
	}
	if len(sourceCols) != 3 || len(targetCols) != 0 {
		t.Fatalf("unexpected columns lengths: source=%d target=%d", len(sourceCols), len(targetCols))
	}
	if !plan.AutoCreate {
		t.Fatalf("expected auto create enabled")
	}
	if !strings.Contains(plan.CreateTableSQL, "CREATE TABLE `dst`.`cpu`") {
		t.Fatalf("unexpected create sql: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`ts` TIMESTAMP") {
		t.Fatalf("expected timestamp preserved, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`region` NCHAR(32)") {
		t.Fatalf("expected tag degrade to regular nchar column, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(strings.Join(plan.Warnings, " "), "TAG") {
		t.Fatalf("expected TAG degrade warning, got: %v", plan.Warnings)
	}
}

// TestMySQLToDamengSmartStrategyAutoCreates 锁住一次性迁移 mysql->dameng 的
// smart 策略链路：目标表缺失时 plan 必须给出自动建表与可执行的达梦 DDL。
// 前端工作台曾在能力快照返回前把映射错定为 existing_only（见前端
// model.capability-timing.test.ts），后端本身必须对 smart 策略放行。
func TestMySQLToDamengSmartStrategyAutoCreates(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"shop.orders": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI", Extra: "auto_increment"},
				{Name: "name", Type: "varchar(128)", Nullable: "YES"},
			},
		},
		indexes: map[string][]connection.IndexDefinition{},
	}
	targetDB := &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{}}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig:        connection.ConnectionConfig{Type: "dameng", Database: "demo"},
		TargetTableStrategy: "smart",
		CreateIndexes:       true,
	}
	capability := ResolveMigrationCapability(cfg.SourceConfig, cfg.TargetConfig)
	if !capability.CanExecute || !capability.SupportsAutoCreate {
		t.Fatalf("mysql->dameng capability must allow auto-create: %+v", capability)
	}
	plan, sourceCols, targetCols, err := buildSchemaMigrationPlan(cfg, "orders", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildSchemaMigrationPlan returned error: %v", err)
	}
	if len(sourceCols) != 2 || len(targetCols) != 0 {
		t.Fatalf("unexpected columns lengths: source=%d target=%d", len(sourceCols), len(targetCols))
	}
	if plan.TargetTableExists {
		t.Fatalf("expected target table missing")
	}
	if !plan.AutoCreate {
		t.Fatalf("smart strategy must auto-create the missing dameng table")
	}
	if !strings.Contains(plan.CreateTableSQL, "IDENTITY(1,1)") {
		t.Fatalf("dameng identity clause missing: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, `"id" BIGINT IDENTITY(1,1) NOT NULL`) {
		t.Fatalf("dameng identity must use BIGINT rather than NUMBER: %s", plan.CreateTableSQL)
	}
	if strings.Contains(plan.CreateTableSQL, "GENERATED BY DEFAULT AS IDENTITY") {
		t.Fatalf("dameng DDL must not use Oracle identity syntax: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "NVARCHAR(128)") &&
		!strings.Contains(plan.CreateTableSQL, "VARCHAR(128)") {
		t.Fatalf("dameng column definition missing: %s", plan.CreateTableSQL)
	}
}
