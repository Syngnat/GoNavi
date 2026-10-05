package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestBuildMySQLToClickHouseCreateTableSQL_GeneratesMergeTree(t *testing.T) {
	t.Parallel()

	cols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint unsigned", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(128)", Nullable: "YES"},
		{Name: "payload", Type: "json", Nullable: "YES"},
	}
	createSQL, warnings, unsupported := buildMySQLToClickHouseCreateTableSQL("analytics.orders", cols)
	if !strings.Contains(createSQL, "ENGINE = MergeTree()") {
		t.Fatalf("unexpected create SQL: %s", createSQL)
	}
	if !strings.Contains(createSQL, "ORDER BY (`id`)") {
		t.Fatalf("unexpected order by: %s", createSQL)
	}
	if !strings.Contains(createSQL, "`payload` Nullable(String)") {
		t.Fatalf("unexpected json mapping: %s", createSQL)
	}
	if len(warnings) == 0 {
		t.Fatalf("expected warnings for clickhouse semantics")
	}
	if len(unsupported) != 0 {
		t.Fatalf("unexpected unsupported: %v", unsupported)
	}
}

func TestBuildClickHouseToMySQLCreateTableSQL_GeneratesMySQLDDL(t *testing.T) {
	t.Parallel()

	cols := []connection.ColumnDefinition{
		{Name: "id", Type: "UInt64", Nullable: "NO", Key: "PRI"},
		{Name: "event_time", Type: "DateTime", Nullable: "NO"},
		{Name: "payload", Type: "Map(String, String)", Nullable: "YES"},
	}
	createSQL, warnings := buildClickHouseToMySQLCreateTableSQL("app.metrics", cols)
	if !strings.Contains(createSQL, "CREATE TABLE `app`.`metrics`") {
		t.Fatalf("unexpected create SQL: %s", createSQL)
	}
	if !strings.Contains(createSQL, "`id` bigint unsigned NOT NULL") {
		t.Fatalf("unexpected uint64 mapping: %s", createSQL)
	}
	if !strings.Contains(createSQL, "`payload` json") {
		t.Fatalf("unexpected complex type mapping: %s", createSQL)
	}
	if len(warnings) == 0 {
		t.Fatalf("expected warning for limited clickhouse reverse semantics")
	}
}

func TestBuildMySQLToMongoPlan_AutoCreateCollection(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"shop.users": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(64)", Nullable: "YES"},
			},
		},
		indexes: map[string][]connection.IndexDefinition{
			"shop.users": {
				{Name: "idx_users_name", ColumnName: "name", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig:        connection.ConnectionConfig{Type: "mongodb", Database: "app"},
		TargetTableStrategy: "smart",
		CreateIndexes:       true,
	}
	plan, sourceCols, targetCols, err := buildMySQLToMongoPlan(cfg, "users", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildMySQLToMongoPlan returned error: %v", err)
	}
	if len(sourceCols) != 2 || targetCols != nil {
		t.Fatalf("unexpected source/target columns: %d / %v", len(sourceCols), targetCols)
	}
	if !plan.AutoCreate || len(plan.PreDataSQL) == 0 {
		t.Fatalf("expected auto create collection command: %+v", plan)
	}
	if !strings.Contains(plan.PreDataSQL[0], `"create":"users"`) {
		t.Fatalf("unexpected create collection command: %v", plan.PreDataSQL)
	}
	if len(plan.PostDataSQL) != 1 || !strings.Contains(plan.PostDataSQL[0], `"createIndexes":"users"`) {
		t.Fatalf("unexpected index commands: %v", plan.PostDataSQL)
	}
}

func TestBuildPGLikeToMongoPlan_AutoCreateCollection(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"public.orders": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(64)", Nullable: "YES"},
			},
		},
		indexes: map[string][]connection.IndexDefinition{
			"public.orders": {
				{Name: "idx_orders_name", ColumnName: "name", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "postgres", Database: "public"},
		TargetConfig:        connection.ConnectionConfig{Type: "mongodb", Database: "app"},
		TargetTableStrategy: "smart",
		CreateIndexes:       true,
	}
	plan, sourceCols, targetCols, err := buildPGLikeToMongoPlan(cfg, "orders", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildPGLikeToMongoPlan returned error: %v", err)
	}
	if len(sourceCols) != 2 || targetCols != nil {
		t.Fatalf("unexpected source/target columns: %d / %v", len(sourceCols), targetCols)
	}
	if !plan.AutoCreate || len(plan.PreDataSQL) == 0 {
		t.Fatalf("expected auto create collection command: %+v", plan)
	}
	if !strings.Contains(plan.PreDataSQL[0], `"create":"orders"`) {
		t.Fatalf("unexpected create collection command: %v", plan.PreDataSQL)
	}
	if len(plan.PostDataSQL) != 1 || !strings.Contains(plan.PostDataSQL[0], `"createIndexes":"orders"`) {
		t.Fatalf("unexpected index commands: %v", plan.PostDataSQL)
	}
}

func TestBuildClickHouseToMongoPlan_AutoCreateCollection(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"analytics.metrics": {
				{Name: "id", Type: "UInt64", Nullable: "NO", Key: "PRI"},
				{Name: "host", Type: "String", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "clickhouse", Database: "analytics"},
		TargetConfig:        connection.ConnectionConfig{Type: "mongodb", Database: "app"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildClickHouseToMongoPlan(cfg, "metrics", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildClickHouseToMongoPlan returned error: %v", err)
	}
	if len(sourceCols) != 2 || targetCols != nil {
		t.Fatalf("unexpected source/target columns: %d / %v", len(sourceCols), targetCols)
	}
	if !plan.AutoCreate || len(plan.PreDataSQL) == 0 {
		t.Fatalf("expected auto create collection command: %+v", plan)
	}
	if !strings.Contains(plan.PreDataSQL[0], `"create":"metrics"`) {
		t.Fatalf("unexpected create collection command: %v", plan.PreDataSQL)
	}
}

func TestBuildTDengineToMongoPlan_AutoCreateCollection(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"src.cpu": {
				{Name: "ts", Type: "TIMESTAMP", Nullable: "NO"},
				{Name: "host", Type: "NCHAR(64)", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "tdengine", Database: "src"},
		TargetConfig:        connection.ConnectionConfig{Type: "mongodb", Database: "app"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildTDengineToMongoPlan(cfg, "cpu", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildTDengineToMongoPlan returned error: %v", err)
	}
	if len(sourceCols) != 2 || targetCols != nil {
		t.Fatalf("unexpected source/target columns: %d / %v", len(sourceCols), targetCols)
	}
	if !plan.AutoCreate || len(plan.PreDataSQL) == 0 {
		t.Fatalf("expected auto create collection command: %+v", plan)
	}
	if !strings.Contains(plan.PreDataSQL[0], `"create":"cpu"`) {
		t.Fatalf("unexpected create collection command: %v", plan.PreDataSQL)
	}
}

func TestBuildMongoToMySQLPlan_InfersColumnsAndCreatesTable(t *testing.T) {
	t.Parallel()

	query := `{"find":"users","filter":{},"limit":200}`
	sourceDB := &fakeMigrationDB{
		queryData: map[string][]map[string]interface{}{
			query: {
				{"_id": "a1", "name": "alice", "age": int64(18), "profile": map[string]interface{}{"city": "shanghai"}},
				{"_id": "b2", "name": "bob", "profile": map[string]interface{}{"city": "beijing"}},
			},
		},
		queryCols: map[string][]string{query: {"_id", "name", "age", "profile"}},
		indexes: map[string][]connection.IndexDefinition{
			"crm.users": {{Name: "email_1", ColumnName: "name", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"}},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mongodb", Database: "crm"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetTableStrategy: "smart",
		CreateIndexes:       true,
	}
	plan, sourceCols, _, err := buildMongoToMySQLPlan(cfg, "users", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildMongoToMySQLPlan returned error: %v", err)
	}
	if len(sourceCols) == 0 {
		t.Fatalf("expected inferred source cols")
	}
	if !plan.AutoCreate || !strings.Contains(plan.CreateTableSQL, "CREATE TABLE `app`.`users`") {
		t.Fatalf("unexpected create table sql: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`_id` text NOT NULL") && !strings.Contains(plan.CreateTableSQL, "`_id` varchar") {
		t.Fatalf("missing inferred _id column: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`profile` json") {
		t.Fatalf("expected nested field degrade to json: %s", plan.CreateTableSQL)
	}
	if len(plan.PostDataSQL) != 1 {
		t.Fatalf("expected one post index sql, got=%v", plan.PostDataSQL)
	}
}

func TestBuildTDengineToMySQLPlan_AutoCreateWhenTargetMissing(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"metrics.cpu": {
				{Name: "ts", Type: "TIMESTAMP", Nullable: "NO"},
				{Name: "host", Type: "NCHAR(64)", Nullable: "YES", Key: "TAG", Extra: "TAG"},
				{Name: "usage", Type: "DOUBLE", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "tdengine", Database: "metrics"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildTDengineToMySQLPlan(cfg, "cpu", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildTDengineToMySQLPlan returned error: %v", err)
	}
	if len(sourceCols) != 3 || len(targetCols) != 0 {
		t.Fatalf("unexpected columns lengths: source=%d target=%d", len(sourceCols), len(targetCols))
	}
	if !plan.AutoCreate {
		t.Fatalf("expected auto create enabled")
	}
	if !strings.Contains(plan.CreateTableSQL, "CREATE TABLE `app`.`cpu`") {
		t.Fatalf("unexpected create table sql: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`ts` datetime") {
		t.Fatalf("expected timestamp mapping, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, "`host` varchar(64)") {
		t.Fatalf("expected nchar mapping, got: %s", plan.CreateTableSQL)
	}
	if len(plan.Warnings) == 0 || !strings.Contains(strings.Join(plan.Warnings, " "), "TAG") {
		t.Fatalf("expected TAG warning, got: %v", plan.Warnings)
	}
}

func TestBuildTDengineToPGLikePlan_AutoCreateWhenTargetMissing(t *testing.T) {
	t.Parallel()

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"metrics.cpu": {
				{Name: "ts", Type: "TIMESTAMP", Nullable: "NO"},
				{Name: "payload", Type: "JSON", Nullable: "YES"},
				{Name: "host", Type: "BINARY(32)", Nullable: "YES", Key: "TAG", Extra: "TAG"},
			},
		},
	}
	targetDB := &fakeMigrationDB{}
	cfg := SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "tdengine", Database: "metrics"},
		TargetConfig:        connection.ConnectionConfig{Type: "kingbase", Database: "ignored"},
		TargetTableStrategy: "smart",
	}
	plan, sourceCols, targetCols, err := buildTDengineToPGLikePlan(cfg, "cpu", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildTDengineToPGLikePlan returned error: %v", err)
	}
	if len(sourceCols) != 3 || len(targetCols) != 0 {
		t.Fatalf("unexpected columns lengths: source=%d target=%d", len(sourceCols), len(targetCols))
	}
	if !plan.AutoCreate {
		t.Fatalf("expected auto create enabled")
	}
	if !strings.Contains(plan.CreateTableSQL, `CREATE TABLE public.cpu`) {
		t.Fatalf("unexpected create table sql: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, `ts timestamp`) {
		t.Fatalf("expected timestamp mapping, got: %s", plan.CreateTableSQL)
	}
	if !strings.Contains(plan.CreateTableSQL, `payload jsonb`) {
		t.Fatalf("expected json mapping, got: %s", plan.CreateTableSQL)
	}
	if len(plan.Warnings) == 0 || !strings.Contains(strings.Join(plan.Warnings, " "), "TAG") {
		t.Fatalf("expected TAG warning, got: %v", plan.Warnings)
	}
}
