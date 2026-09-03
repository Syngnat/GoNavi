package app

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

type fakeCreateStatementDB struct {
	createSQL  string
	createErr  error
	columns    []connection.ColumnDefinition
	columnsErr error
	indexes    []connection.IndexDefinition
	indexesErr error
	queryRows  []map[string]interface{}
	queryErr   error

	createSchema string
	createTable  string
	colsSchema   string
	colsTable    string
	indexSchema  string
	indexTable   string
	columnsCalls int
	indexCalls   int
	queries      []string
}

func (f *fakeCreateStatementDB) Connect(config connection.ConnectionConfig) error { return nil }
func (f *fakeCreateStatementDB) Close() error                                     { return nil }
func (f *fakeCreateStatementDB) Ping() error                                      { return nil }
func (f *fakeCreateStatementDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queries = append(f.queries, query)
	return f.queryRows, []string{"ddl"}, f.queryErr
}
func (f *fakeCreateStatementDB) Exec(query string) (int64, error)          { return 0, nil }
func (f *fakeCreateStatementDB) GetDatabases() ([]string, error)           { return nil, nil }
func (f *fakeCreateStatementDB) GetTables(dbName string) ([]string, error) { return nil, nil }
func (f *fakeCreateStatementDB) GetCreateStatement(dbName, tableName string) (string, error) {
	f.createSchema = dbName
	f.createTable = tableName
	return f.createSQL, f.createErr
}
func (f *fakeCreateStatementDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	f.columnsCalls++
	f.colsSchema = dbName
	f.colsTable = tableName
	return f.columns, f.columnsErr
}
func (f *fakeCreateStatementDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *fakeCreateStatementDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	f.indexCalls++
	f.indexSchema = dbName
	f.indexTable = tableName
	return f.indexes, f.indexesErr
}
func (f *fakeCreateStatementDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *fakeCreateStatementDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func TestDBShowCreateTableSQLiteNormalizesBracketedDottedTable(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	database := &fakeCreateStatementDB{createSQL: `CREATE TABLE "order.items" (id INTEGER)`}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		if dbType != "sqlite" {
			t.Fatalf("newDatabaseFunc type = %q, want sqlite", dbType)
		}
		return database, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	for _, tableName := range []string{"[order.items]", "order.[order.items]"} {
		result := app.DBShowCreateTable(
			connection.ConnectionConfig{Type: "sqlite", Host: "sqlite-bracketed-ddl-test.db"},
			"main",
			tableName,
		)
		if !result.Success {
			t.Fatalf("DBShowCreateTable(%q) returned failure: %#v", tableName, result)
		}
		if database.createSchema != "main" || database.createTable != "order.items" {
			t.Fatalf("SQLite metadata target for %q = %q.%q, want main.order.items", tableName, database.createSchema, database.createTable)
		}
	}
}

func TestDBShowCreateTableMySQLPreservesQuotedDottedTable(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	database := &fakeCreateStatementDB{createSQL: "CREATE TABLE `order.items` (id INT)"}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		if dbType != "mysql" {
			t.Fatalf("newDatabaseFunc type = %q, want mysql", dbType)
		}
		return database, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBShowCreateTable(
		connection.ConnectionConfig{Type: "mysql", Host: "mysql-quoted-ddl-test"},
		"app",
		"`order.items`",
	)
	if !result.Success {
		t.Fatalf("DBShowCreateTable returned failure: %#v", result)
	}
	if database.createSchema != "app" || database.createTable != "`order.items`" {
		t.Fatalf("MySQL metadata target = %q.%q, want app.`order.items`", database.createSchema, database.createTable)
	}
}

func TestResolveDDLDBType_CustomDriverAlias(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		driver string
		want   string
	}{
		{name: "postgresql alias", driver: "postgresql", want: "postgres"},
		{name: "pgx alias", driver: "pgx", want: "postgres"},
		{name: "kingbase8 alias", driver: "kingbase8", want: "kingbase"},
		{name: "kingbase contains alias", driver: "kingbasees", want: "kingbase"},
		{name: "dm alias", driver: "dm8", want: "dameng"},
		{name: "sqlite alias", driver: "sqlite3", want: "sqlite"},
		{name: "iris alias", driver: "InterSystems IRIS", want: "iris"},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cfg := connection.ConnectionConfig{Type: "custom", Driver: tc.driver}
			if got := resolveDDLDBType(cfg); got != tc.want {
				t.Fatalf("resolveDDLDBType() mismatch, want=%q got=%q", tc.want, got)
			}
		})
	}
}

func TestResolveDDLDBType_OceanBaseOracleProtocol(t *testing.T) {
	t.Parallel()

	cfg := connection.ConnectionConfig{
		Type:              "oceanbase",
		OceanBaseProtocol: "oracle",
	}
	if got := resolveDDLDBType(cfg); got != "oracle" {
		t.Fatalf("expected OceanBase Oracle protocol to use oracle DDL dialect, got %q", got)
	}
}

func TestResolveDDLDBType_KingbaseTypeAlias(t *testing.T) {
	t.Parallel()

	if got := resolveDDLDBType(connection.ConnectionConfig{Type: "kingbase8"}); got != "kingbase" {
		t.Fatalf("expected kingbase8 type alias to resolve to kingbase, got %q", got)
	}
}

func TestResolveDDLDBType_IRISTypeAlias(t *testing.T) {
	t.Parallel()

	if got := resolveDDLDBType(connection.ConnectionConfig{Type: "InterSystemsIRIS"}); got != "iris" {
		t.Fatalf("expected InterSystemsIRIS type alias to resolve to iris, got %q", got)
	}
}

func TestResolveDDLDBType_GoldenDBUsesMySQLDialect(t *testing.T) {
	t.Parallel()

	if got := resolveDDLDBType(connection.ConnectionConfig{Type: "goldendb"}); got != "mysql" {
		t.Fatalf("expected goldendb type to resolve to mysql, got %q", got)
	}
	if got := resolveDDLDBType(connection.ConnectionConfig{Type: "custom", Driver: "greatdb"}); got != "mysql" {
		t.Fatalf("expected greatdb custom driver to resolve to mysql, got %q", got)
	}
	if got := resolveDDLDBType(connection.ConnectionConfig{Type: "custom", Driver: "gdb"}); got != "mysql" {
		t.Fatalf("expected gdb custom driver to resolve to mysql, got %q", got)
	}
}

func TestNormalizeSchemaAndTableByType_PGLikeQuotedQualifiedName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		dbType     string
		tableName  string
		wantSchema string
		wantTable  string
	}{
		{name: "postgres quoted dots", dbType: "postgres", tableName: `"sales.schema"."order.items"`, wantSchema: "sales.schema", wantTable: "order.items"},
		{name: "kingbase escaped lowercase", dbType: "kingbase", tableName: `\"ldf_server\".\"andon_events\"`, wantSchema: "ldf_server", wantTable: "andon_events"},
		{name: "highgo escaped quoted", dbType: "highgo", tableName: `\"sales\".\"orders\"`, wantSchema: "sales", wantTable: "orders"},
		{name: "vastbase quoted table only", dbType: "vastbase", tableName: `"order.items"`, wantSchema: "public", wantTable: "order.items"},
		{name: "mysql quoted dotted table only", dbType: "mysql", tableName: "`order.items`", wantSchema: "", wantTable: "`order.items`"},
		{name: "mysql qualified quoted dotted table", dbType: "mysql", tableName: "main.`order.items`", wantSchema: "main", wantTable: "`order.items`"},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			gotSchema, gotTable := normalizeSchemaAndTableByType(tt.dbType, "", tt.tableName)
			if gotSchema != tt.wantSchema || gotTable != tt.wantTable {
				t.Fatalf("normalizeSchemaAndTableByType(%q,%q)=(%q,%q),want=(%q,%q)", tt.dbType, tt.tableName, gotSchema, gotTable, tt.wantSchema, tt.wantTable)
			}
		})
	}
}

func TestNormalizeSchemaAndTableByType_SQLitePreservesPlainDottedTable(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTableByType("sqlite", "main", "order.items")
	if schema != "main" || table != "order.items" {
		t.Fatalf("expected plain dotted SQLite table to stay intact, got %q.%q", schema, table)
	}

	schema, table = normalizeSchemaAndTableByType("sqlite", "main", "main.`order.items`")
	if schema != "main" || table != "order.items" {
		t.Fatalf("expected explicit SQLite database prefix to normalize, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTableByType_SQLiteKeepsUnquotedDottedTableAfterKnownDatabase(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTableByType("sqlite", "main", "main.order.items")
	if schema != "main" || table != "order.items" {
		t.Fatalf("expected known SQLite database prefix to preserve dotted table, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTableByType_KafkaPreservesDottedTopicName(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTableByType("kafka", "topics", "orders.events.v1")
	if schema != "topics" || table != "orders.events.v1" {
		t.Fatalf("expected kafka topic to stay intact, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTableByType_MQTTPreservesTopicFilter(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTableByType("mqtt", "topics", "devices/floor1.sensor.v1")
	if schema != "topics" || table != "devices/floor1.sensor.v1" {
		t.Fatalf("expected mqtt topic filter to stay intact, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTableByType_RocketMQPreservesTopicName(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTableByType("rocketmq", "topics", "orders.events.v1")
	if schema != "topics" || table != "orders.events.v1" {
		t.Fatalf("expected rocketmq topic name to stay intact, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTableByType_RabbitMQPreservesDottedQueueName(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTableByType("rabbitmq", "/", "orders.events.v1")
	if schema != "/" || table != "orders.events.v1" {
		t.Fatalf("expected rabbitmq queue to stay intact, got %q.%q", schema, table)
	}
}

func TestNormalizeSchemaAndTableByType_TrinoPreservesDottedTableName(t *testing.T) {
	t.Parallel()

	schema, table := normalizeSchemaAndTableByType("trino", "hive.default", "orders.events.v1")
	if schema != "hive.default" || table != "orders.events.v1" {
		t.Fatalf("expected trino table name to stay intact, got %q.%q", schema, table)
	}
}

func TestQuoteTableIdentByType_TrinoKeepsCatalogSchemaAndDottedTable(t *testing.T) {
	t.Parallel()

	got := quoteTableIdentByType("trino", "hive.default", "orders.events.v1")
	if got != `"hive"."default"."orders.events.v1"` {
		t.Fatalf("unexpected trino quoted table: %s", got)
	}
}

func TestBuildRunConfigForDDL_CustomHighGoUsesDatabase(t *testing.T) {
	t.Parallel()

	got := buildRunConfigForDDL(connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "highgo",
		Database: "default_db",
	}, "highgo", "target_db")
	if got.Database != "target_db" {
		t.Fatalf("expected custom highgo DDL database target_db, got %q", got.Database)
	}
}

func TestResolveCreateStatementWithFallback_CustomKingbaseUsesPublicSchema(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL: "SHOW CREATE TABLE not directly supported in Kingbase/Postgres via SQL",
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type:   "custom",
		Driver: "kingbase8",
	}, "demo_db", "orders")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if dbInst.createSchema != "public" || dbInst.colsSchema != "public" {
		t.Fatalf("expected fallback schema public, got create=%q columns=%q", dbInst.createSchema, dbInst.colsSchema)
	}
	if !strings.Contains(ddl, `CREATE TABLE public.orders`) {
		t.Fatalf("expected fallback DDL with public schema, got: %s", ddl)
	}
}

func TestResolveCreateStatementWithFallback_KingbaseIncludesColumnComments(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL: "SHOW CREATE TABLE not directly supported in Kingbase/Postgres via SQL",
		columns: []connection.ColumnDefinition{
			{Name: "mes_third_sys_log_id", Type: "bigint", Nullable: "NO", Key: "PRI", Comment: "主键"},
			{Name: "api_name", Type: "character varying(100 char)", Nullable: "YES", Comment: "接口名称"},
			{Name: "request_param", Type: "longtext", Nullable: "YES", Comment: "请求参数's"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type: "kingbase",
	}, "demo_db", "ldf_server.mes_third_sys_log")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	for _, want := range []string{
		`COMMENT ON COLUMN ldf_server.mes_third_sys_log.mes_third_sys_log_id IS '主键';`,
		`COMMENT ON COLUMN ldf_server.mes_third_sys_log.api_name IS '接口名称';`,
		`COMMENT ON COLUMN ldf_server.mes_third_sys_log.request_param IS '请求参数''s';`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("expected fallback DDL to contain %q, got: %s", want, ddl)
		}
	}
}

func TestResolveCreateStatementWithFallback_DamengAppendsColumnComments(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL: `CREATE TABLE "APP"."ORDERS" ("ID" NUMBER NOT NULL, "STATUS" VARCHAR2(32));`,
		columns: []connection.ColumnDefinition{
			{Name: "ID", Type: "NUMBER", Nullable: "NO", Key: "PRI", Comment: "主键"},
			{Name: "STATUS", Type: "VARCHAR2(32)", Nullable: "YES", Comment: "状态"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type: "dameng",
	}, "APP", "ORDERS")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if !strings.Contains(ddl, dbInst.createSQL) {
		t.Fatalf("expected original dameng create SQL to be preserved, got: %s", ddl)
	}
	for _, want := range []string{
		`COMMENT ON COLUMN "APP"."ORDERS"."ID" IS '主键';`,
		`COMMENT ON COLUMN "APP"."ORDERS"."STATUS" IS '状态';`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("expected dameng DDL to contain %q, got: %s", want, ddl)
		}
	}
	if dbInst.columnsCalls != 1 {
		t.Fatalf("expected dameng path to load column metadata once, got %d", dbInst.columnsCalls)
	}
}

func TestResolveCreateStatementWithFallback_KingbaseIncludesSecondaryIndexes(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL: "SHOW CREATE TABLE not directly supported in Kingbase/Postgres via SQL",
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
			{Name: "tenant_id", Type: "bigint", Nullable: "NO"},
			{Name: "api_name", Type: "character varying(100 char)", Nullable: "YES"},
		},
		indexes: []connection.IndexDefinition{
			{Name: "mes_third_sys_log_pkey", ColumnName: "id", NonUnique: 0, SeqInIndex: 1, IndexType: "BTREE"},
			{Name: "idx_mes_third_sys_log_tenant_api", ColumnName: "tenant_id", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"},
			{Name: "idx_mes_third_sys_log_tenant_api", ColumnName: "api_name", NonUnique: 1, SeqInIndex: 2, IndexType: "BTREE"},
			{Name: "uk_mes_third_sys_log_api", ColumnName: "api_name", NonUnique: 0, SeqInIndex: 1, IndexType: "BTREE"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type: "kingbase",
	}, "demo_db", "ldf_server.mes_third_sys_log")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if dbInst.indexCalls != 1 {
		t.Fatalf("expected one GetIndexes call, got %d", dbInst.indexCalls)
	}
	if dbInst.indexSchema != "ldf_server" || dbInst.indexTable != "mes_third_sys_log" {
		t.Fatalf("expected index target ldf_server.mes_third_sys_log, got %q.%q", dbInst.indexSchema, dbInst.indexTable)
	}
	for _, want := range []string{
		`CREATE INDEX idx_mes_third_sys_log_tenant_api ON ldf_server.mes_third_sys_log (tenant_id, api_name);`,
		`CREATE UNIQUE INDEX uk_mes_third_sys_log_api ON ldf_server.mes_third_sys_log (api_name);`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("expected fallback DDL to contain %q, got: %s", want, ddl)
		}
	}
	if strings.Contains(ddl, `CREATE UNIQUE INDEX mes_third_sys_log_pkey`) {
		t.Fatalf("primary key index should not be emitted separately, got: %s", ddl)
	}
}

func TestResolveCreateStatementWithFallback_KeepQualifiedSchema(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL: "-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.",
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "integer", Nullable: "NO", Key: "PRI"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type:   "custom",
		Driver: "postgresql",
	}, "demo_db", "sales.orders")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if dbInst.createSchema != "sales" || dbInst.colsSchema != "sales" {
		t.Fatalf("expected schema sales, got create=%q columns=%q", dbInst.createSchema, dbInst.colsSchema)
	}
	if !strings.Contains(ddl, `CREATE TABLE "sales"."orders"`) {
		t.Fatalf("expected fallback DDL with sales schema, got: %s", ddl)
	}
}

func TestResolveCreateStatementWithFallback_PGLikeQuotedQualifiedName(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL: "-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.",
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "integer", Nullable: "NO", Key: "PRI"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type: "postgres",
	}, "", `"sales.schema"."order.items"`)
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if dbInst.createSchema != "sales.schema" || dbInst.createTable != `"order.items"` {
		t.Fatalf("expected create target sales.schema.order.items, got %q.%q", dbInst.createSchema, dbInst.createTable)
	}
	if dbInst.colsSchema != "sales.schema" || dbInst.colsTable != `"order.items"` {
		t.Fatalf("expected column target sales.schema.order.items, got %q.%q", dbInst.colsSchema, dbInst.colsTable)
	}
	if !strings.Contains(ddl, `CREATE TABLE "sales.schema"."order.items"`) {
		t.Fatalf("expected fallback DDL with quoted dotted identifiers, got: %s", ddl)
	}
}

func TestResolveCreateStatementWithFallback_ReturnsCreateViewDirectly(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL:  "CREATE VIEW sales.orders_v AS SELECT 1;",
		columnsErr: errors.New("should not be called"),
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{Type: "postgres"}, "", "sales.orders_v")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if ddl != dbInst.createSQL {
		t.Fatalf("expected original create view DDL, got: %s", ddl)
	}
	if dbInst.columnsCalls != 0 {
		t.Fatalf("CREATE VIEW path should not call GetColumns, calls=%d", dbInst.columnsCalls)
	}
}

func TestResolveCreateStatementWithFallback_OceanBaseOracleUsesShowCreateWhenAgentDDLIsEmpty(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL: "",
		queryRows: []map[string]interface{}{
			{"Create Table": `CREATE TABLE "SYS"."test" ("id" NUMBER)`},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type:             "oceanbase",
		ConnectionParams: "protocol=oracle",
	}, "SYS", "SYS.test")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if ddl != `CREATE TABLE "SYS"."test" ("id" NUMBER)` {
		t.Fatalf("expected SHOW CREATE TABLE fallback DDL, got: %s", ddl)
	}
	if dbInst.createSchema != "SYS" || dbInst.createTable != "test" {
		t.Fatalf("expected metadata target SYS.test, got %q.%q", dbInst.createSchema, dbInst.createTable)
	}
	if len(dbInst.queries) != 1 || dbInst.queries[0] != `SHOW CREATE TABLE "SYS"."test"` {
		t.Fatalf("expected SHOW CREATE TABLE query, got: %v", dbInst.queries)
	}
	if dbInst.columnsCalls != 0 {
		t.Fatalf("OceanBase Oracle SHOW CREATE fallback should not call GetColumns, calls=%d", dbInst.columnsCalls)
	}
}

func TestResolveCreateStatementWithFallback_PGLikeViewHelperBeforeColumnFallback(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL:  "SHOW CREATE TABLE not directly supported in PostgreSQL",
		columnsErr: errors.New("should not be called"),
		queryRows: []map[string]interface{}{
			{"ddl": "SELECT id FROM sales.orders"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{Type: "postgres"}, "", "sales.orders_v")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if !strings.Contains(ddl, `CREATE VIEW "sales"."orders_v" AS SELECT id FROM sales.orders`) {
		t.Fatalf("expected CREATE VIEW DDL from view helper, got: %s", ddl)
	}
	if dbInst.columnsCalls != 0 {
		t.Fatalf("view helper path should not call GetColumns, calls=%d", dbInst.columnsCalls)
	}
	if len(dbInst.queries) == 0 || !strings.Contains(dbInst.queries[0], "pg_get_viewdef") {
		t.Fatalf("expected pg_get_viewdef query, got: %v", dbInst.queries)
	}
}

func TestTryGetViewCreateStatement_OracleUsesUnboundedStreamForCLOB(t *testing.T) {
	t.Parallel()

	fullDDL := `CREATE OR REPLACE VIEW "H2"."CV_GD_YNCRM_SALESDTLLIST" AS SELECT '` +
		strings.Repeat("完整视图定义", 900) +
		`' AS payload FROM DUAL`
	dbInst := &fakeStreamExportDB{
		fakeExportQueryDB: fakeExportQueryDB{
			data: []map[string]interface{}{
				{"ddl": "[CLOB preview: 4096/9362 bytes] " + fullDDL[:128]},
			},
			cols: []string{"ddl"},
		},
		streamData: []map[string]interface{}{
			{"ddl": fullDDL},
		},
		streamCols: []string{"ddl"},
	}

	ddl, ok := tryGetViewCreateStatement(
		dbInst,
		connection.ConnectionConfig{Type: "oracle"},
		"H2",
		"H2",
		"CV_GD_YNCRM_SALESDTLLIST",
	)
	if !ok {
		t.Fatal("expected Oracle view DDL lookup to succeed")
	}
	if ddl != fullDDL+";" {
		t.Fatalf("expected complete Oracle CLOB DDL, got length=%d prefix=%q", len(ddl), ddl[:min(len(ddl), 80)])
	}
	if strings.Contains(ddl, "[CLOB preview:") {
		t.Fatalf("Oracle view DDL must not contain an interactive CLOB preview marker: %q", ddl[:80])
	}
	if dbInst.streamHits != 1 || dbInst.queryHits != 0 {
		t.Fatalf("expected unbounded stream query only, streamHits=%d queryHits=%d", dbInst.streamHits, dbInst.queryHits)
	}
}

func TestBuildViewCreateQueries_OracleFallsBackToCatalogText(t *testing.T) {
	t.Parallel()

	queries := buildViewCreateQueries(
		connection.ConnectionConfig{Type: "oracle"},
		"H2",
		"H2",
		"CV_GD_YNCRM_SALESDTLLIST",
	)
	if len(queries) != 2 {
		t.Fatalf("expected DBMS_METADATA and ALL_VIEWS fallback queries, got %v", queries)
	}
	if !strings.Contains(queries[0], "DBMS_METADATA.GET_DDL('VIEW'") {
		t.Fatalf("expected DBMS_METADATA query first, got %q", queries[0])
	}
	if !strings.Contains(queries[1], "FROM ALL_VIEWS") || !strings.Contains(queries[1], "TEXT AS ddl") {
		t.Fatalf("expected ALL_VIEWS text fallback, got %q", queries[1])
	}
}

func TestResolveCreateStatementWithFallback_PGLikeViewHelperKeepsQuotedDottedName(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL:  "SHOW CREATE TABLE not directly supported in PostgreSQL",
		columnsErr: errors.New("should not be called"),
		queryRows: []map[string]interface{}{
			{"ddl": "SELECT 1"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{Type: "postgres"}, "", `"sales.schema"."order.items"`)
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if !strings.Contains(ddl, `CREATE VIEW "sales.schema"."order.items" AS SELECT 1`) {
		t.Fatalf("expected CREATE VIEW DDL to keep quoted dotted identifiers, got: %s", ddl)
	}
	if dbInst.columnsCalls != 0 {
		t.Fatalf("view helper path should not call GetColumns, calls=%d", dbInst.columnsCalls)
	}
}

func TestResolveCreateStatementWithFallback_PGLikeViewHelperMissFallsBackToColumns(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL: "SHOW CREATE TABLE not directly supported in PostgreSQL",
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{Type: "postgres"}, "", "sales.orders")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if !strings.Contains(ddl, `CREATE TABLE "sales"."orders"`) {
		t.Fatalf("expected CREATE TABLE fallback after view helper miss, got: %s", ddl)
	}
	if dbInst.columnsCalls != 1 {
		t.Fatalf("expected one GetColumns call after view helper miss, calls=%d", dbInst.columnsCalls)
	}
}

func TestResolveCreateStatementWithFallback_NoFallbackForMySQL(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL:  "SHOW CREATE TABLE not directly supported in Kingbase/Postgres via SQL",
		columnsErr: errors.New("should not be called"),
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type: "mysql",
	}, "demo_db", "orders")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if ddl != dbInst.createSQL {
		t.Fatalf("expected original ddl for mysql, got: %s", ddl)
	}
	if dbInst.colsTable != "" {
		t.Fatalf("mysql path should not call GetColumns, got table=%q", dbInst.colsTable)
	}
}

func TestResolveCreateStatementWithFallback_SQLServerBuildsFallbackDDL(t *testing.T) {
	t.Parallel()

	defaultValue := "((0))"
	dbInst := &fakeCreateStatementDB{
		createErr: errors.New("SQL Server DDL unsupported"),
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "int", Nullable: "NO", Key: "PRI", Extra: "auto_increment", Comment: "主键"},
			{Name: "display_name", Type: "nvarchar(128)", Nullable: "YES", Default: &defaultValue, Comment: "显示名's"},
		},
		indexes: []connection.IndexDefinition{
			{Name: "IX_Users_DisplayName", ColumnName: "display_name", SeqInIndex: 1, NonUnique: 1},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type:     "sqlserver",
		Database: "default_db",
	}, "appdb", "dbo.Users")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if dbInst.createSchema != "appdb" || dbInst.createTable != "dbo.Users" {
		t.Fatalf("expected SQL Server create lookup to use database and raw table, got %q.%q", dbInst.createSchema, dbInst.createTable)
	}
	if dbInst.colsSchema != "appdb" || dbInst.colsTable != "dbo.Users" {
		t.Fatalf("expected SQL Server column lookup to use database and raw table, got %q.%q", dbInst.colsSchema, dbInst.colsTable)
	}
	if dbInst.indexSchema != "appdb" || dbInst.indexTable != "dbo.Users" {
		t.Fatalf("expected SQL Server index lookup to use database and raw table, got %q.%q", dbInst.indexSchema, dbInst.indexTable)
	}
	for _, want := range []string{
		`CREATE TABLE [dbo].[Users]`,
		`[id] int IDENTITY(1,1) NOT NULL`,
		`[display_name] nvarchar(128) DEFAULT ((0))`,
		`PRIMARY KEY ([id])`,
		`CREATE INDEX [IX_Users_DisplayName] ON [dbo].[Users] ([display_name]);`,
		`EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'主键', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Users', @level2type = N'COLUMN', @level2name = N'id';`,
		`@value = N'显示名''s'`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("expected SQL Server fallback DDL to contain %q, got: %s", want, ddl)
		}
	}
	if strings.Contains(ddl, "SHOW CREATE TABLE not supported") {
		t.Fatalf("expected fallback DDL instead of unsupported placeholder, got: %s", ddl)
	}
}

func TestResolveCreateStatementWithFallback_SQLServerDefaultsToDboSchema(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createSQL: "-- SHOW CREATE TABLE not supported for SQL Server in this version.",
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "int", Nullable: "NO"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{Type: "sqlserver"}, "appdb", "Users")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if !strings.Contains(ddl, `CREATE TABLE [dbo].[Users]`) {
		t.Fatalf("expected SQL Server fallback DDL to default to dbo schema, got: %s", ddl)
	}
}

func TestResolveCreateStatementWithFallback_FallbackWhenCreateStatementError(t *testing.T) {
	t.Parallel()

	dbInst := &fakeCreateStatementDB{
		createErr: errors.New("statement unsupported"),
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		},
	}

	ddl, err := resolveCreateStatementWithFallback(dbInst, connection.ConnectionConfig{
		Type: "postgres",
	}, "demo_db", "orders")
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback() unexpected error: %v", err)
	}
	if !strings.Contains(ddl, `CREATE TABLE "public"."orders"`) {
		t.Fatalf("expected fallback DDL for postgres error path, got: %s", ddl)
	}
}
