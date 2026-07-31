package app

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func requireDuckDBOptionalDriverRuntime(t *testing.T) {
	t.Helper()

	if !db.IsOptionalGoDriverBuildIncluded("duckdb") {
		t.Skip("当前构建未包含 DuckDB 可选驱动")
	}
	if ready, reason := db.DriverRuntimeSupportStatus("duckdb"); !ready {
		t.Skipf("DuckDB runtime 未就绪，跳过集成测试: %s", reason)
	}
}

type fakeMetadataRetryDB struct {
	columns       []connection.ColumnDefinition
	indexes       []connection.IndexDefinition
	columnsErr    error
	indexesErr    error
	queryResults  []fakeMetadataQueryResult
	queryRows     []map[string]interface{}
	queryFields   []string
	queryErr      error
	queries       []string
	columnCalls   int
	indexCalls    int
	columnSchema  string
	columnTable   string
	indexSchema   string
	indexTable    string
	connectCalls  int
	connectConfig connection.ConnectionConfig
}

type fakeMetadataQueryResult struct {
	match  string
	rows   []map[string]interface{}
	fields []string
	err    error
}

func (f *fakeMetadataRetryDB) Connect(config connection.ConnectionConfig) error {
	f.connectCalls++
	f.connectConfig = config
	return nil
}
func (f *fakeMetadataRetryDB) Close() error { return nil }
func (f *fakeMetadataRetryDB) Ping() error  { return nil }
func (f *fakeMetadataRetryDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queries = append(f.queries, query)
	for _, result := range f.queryResults {
		if result.match == "" || strings.Contains(query, result.match) {
			return result.rows, result.fields, result.err
		}
	}
	if f.queryErr != nil {
		return nil, nil, f.queryErr
	}
	return f.queryRows, f.queryFields, nil
}
func (f *fakeMetadataRetryDB) Exec(query string) (int64, error) { return 0, nil }
func (f *fakeMetadataRetryDB) GetDatabases() ([]string, error)  { return nil, nil }
func (f *fakeMetadataRetryDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}
func (f *fakeMetadataRetryDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (f *fakeMetadataRetryDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	f.columnCalls++
	f.columnSchema = dbName
	f.columnTable = tableName
	if f.columnsErr != nil {
		return nil, f.columnsErr
	}
	return f.columns, nil
}
func (f *fakeMetadataRetryDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *fakeMetadataRetryDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	f.indexCalls++
	f.indexSchema = dbName
	f.indexTable = tableName
	if f.indexesErr != nil {
		return nil, f.indexesErr
	}
	return f.indexes, nil
}
func (f *fakeMetadataRetryDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *fakeMetadataRetryDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

var _ db.Database = (*fakeMetadataRetryDB)(nil)

func TestDBGetColumnsRetriesAfterCachedConnectionRefresh(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	first := &fakeMetadataRetryDB{
		columnsErr: errors.New("invalid connection"),
	}
	second := &fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{
			{Name: "ID", Key: "PRI"},
			{Name: "username", Key: ""},
		},
	}
	instances := []*fakeMetadataRetryDB{first, second}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		next := instances[0]
		instances = instances[1:]
		return next, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetColumns(connection.ConnectionConfig{
		Type: "mysql",
		Host: "127.0.0.1",
		Port: 3306,
		User: "root",
	}, "mkefu_test_new", "uk_user")

	if !result.Success {
		t.Fatalf("expected DBGetColumns success after retry, got failure: %s", result.Message)
	}
	if first.columnCalls != 1 {
		t.Fatalf("expected first metadata call once, got %d", first.columnCalls)
	}
	if second.columnCalls != 1 {
		t.Fatalf("expected retried metadata call once, got %d", second.columnCalls)
	}

	columns, ok := result.Data.([]connection.ColumnDefinition)
	if !ok {
		t.Fatalf("expected []connection.ColumnDefinition, got %T", result.Data)
	}
	if len(columns) != 2 || columns[0].Key != "PRI" {
		t.Fatalf("unexpected columns after retry: %#v", columns)
	}
}

func TestDBGetColumnsUsesSearchPathForPostgresPureTableMetadata(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Key: "PRI"}},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetColumns(connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "postgres",
		Database: "demo_db",
	}, "demo_db", "users")

	if !result.Success {
		t.Fatalf("expected DBGetColumns success, got failure: %s", result.Message)
	}
	if dbInst.columnSchema != "" || dbInst.columnTable != "users" {
		t.Fatalf("expected postgres pure table metadata to pass empty schema/users, got %q.%q", dbInst.columnSchema, dbInst.columnTable)
	}
}

func TestDBGetIndexesUsesSearchPathForPostgresPureTableMetadata(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{
		indexes: []connection.IndexDefinition{{Name: "users_email_key", ColumnName: "email", NonUnique: 0}},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetIndexes(connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "postgres",
		Database: "demo_db",
	}, "demo_db", "users")

	if !result.Success {
		t.Fatalf("expected DBGetIndexes success, got failure: %s", result.Message)
	}
	if dbInst.indexSchema != "" || dbInst.indexTable != "users" {
		t.Fatalf("expected postgres pure table index metadata to pass empty schema/users, got %q.%q", dbInst.indexSchema, dbInst.indexTable)
	}
}

func TestDBGetColumnsKeepsCurrentDatabaseForKingbaseQualifiedTableMetadata(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Key: "PRI"}},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetColumns(connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "system",
		Database: "ldf_server_dbs_dev",
	}, "ldf_server_dbs_dev", "ldf_server.mes_work_order")

	if !result.Success {
		t.Fatalf("expected DBGetColumns success, got failure: %s", result.Message)
	}
	if dbInst.connectConfig.Database != "ldf_server_dbs_dev" {
		t.Fatalf("expected kingbase metadata connection to keep current database, got %q", dbInst.connectConfig.Database)
	}
	if dbInst.columnSchema != "ldf_server" || dbInst.columnTable != "mes_work_order" {
		t.Fatalf("expected kingbase qualified column metadata to pass ldf_server/mes_work_order, got %q.%q", dbInst.columnSchema, dbInst.columnTable)
	}
}

func TestDBGetIndexesKeepsCurrentDatabaseForKingbaseQualifiedTableMetadata(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{
		indexes: []connection.IndexDefinition{{Name: "mes_work_order_pkey", ColumnName: "id", NonUnique: 0}},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetIndexes(connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "system",
		Database: "ldf_server_dbs_dev",
	}, "ldf_server_dbs_dev", "ldf_server.mes_work_order")

	if !result.Success {
		t.Fatalf("expected DBGetIndexes success, got failure: %s", result.Message)
	}
	if dbInst.connectConfig.Database != "ldf_server_dbs_dev" {
		t.Fatalf("expected kingbase metadata connection to keep current database, got %q", dbInst.connectConfig.Database)
	}
	if dbInst.indexSchema != "ldf_server" || dbInst.indexTable != "mes_work_order" {
		t.Fatalf("expected kingbase qualified index metadata to pass ldf_server/mes_work_order, got %q.%q", dbInst.indexSchema, dbInst.indexTable)
	}
}

func TestDBGetColumnsKeepsDatabaseForMySQLMetadata(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Key: "PRI"}},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetColumns(connection.ConnectionConfig{
		Type: "mysql",
		Host: "127.0.0.1",
		Port: 3306,
		User: "root",
	}, "demo_db", "users")

	if !result.Success {
		t.Fatalf("expected DBGetColumns success, got failure: %s", result.Message)
	}
	if dbInst.columnSchema != "demo_db" || dbInst.columnTable != "users" {
		t.Fatalf("expected mysql metadata to pass database/table, got %q.%q", dbInst.columnSchema, dbInst.columnTable)
	}
}

func TestDBGetColumnsInfersOceanBaseOracleFieldsWhenAgentMetadataIsEmpty(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{},
		queryResults: []fakeMetadataQueryResult{
			{
				match: "FROM all_tab_columns c",
				rows: []map[string]interface{}{
					{
						"COLUMN_NAME":    "id",
						"DATA_TYPE":      "NUMBER",
						"NULLABLE":       "N",
						"DATA_DEFAULT":   "SEQUENCE.NEXTVAL",
						"COLUMN_KEY":     "PRI",
						"COMMENT":        "",
						"DATA_PRECISION": nil,
						"DATA_SCALE":     nil,
					},
					{
						"COLUMN_NAME": "new_col_1",
						"DATA_TYPE":   "VARCHAR2",
						"CHAR_LENGTH": 255,
						"NULLABLE":    "Y",
						"COLUMN_KEY":  "",
						"COMMENT":     "",
					},
				},
				fields: []string{"COLUMN_NAME", "DATA_TYPE", "DATA_LENGTH", "CHAR_LENGTH", "DATA_PRECISION", "DATA_SCALE", "NULLABLE", "DATA_DEFAULT", "COLUMN_KEY", "COMMENT"},
			},
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetColumns(connection.ConnectionConfig{
		Type:             "oceanbase",
		Host:             "127.0.0.1",
		Port:             12881,
		User:             "SYS",
		ConnectionParams: "protocol=oracle",
	}, "SYS", "SYS.test")

	if !result.Success {
		t.Fatalf("expected DBGetColumns success, got failure: %s", result.Message)
	}
	if dbInst.columnSchema != "SYS" || dbInst.columnTable != "test" {
		t.Fatalf("expected OceanBase Oracle metadata to split schema/table, got %q.%q", dbInst.columnSchema, dbInst.columnTable)
	}
	if len(dbInst.queries) != 1 || !strings.Contains(dbInst.queries[0], "FROM all_tab_columns c") {
		t.Fatalf("expected dictionary metadata fallback query, got %v", dbInst.queries)
	}
	columns, ok := result.Data.([]connection.ColumnDefinition)
	if !ok {
		t.Fatalf("expected []connection.ColumnDefinition, got %T", result.Data)
	}
	if len(columns) != 2 || columns[0].Name != "id" || columns[1].Name != "new_col_1" {
		t.Fatalf("unexpected inferred columns: %#v", columns)
	}
	if columns[0].Type != "NUMBER" || columns[0].Nullable != "NO" || columns[0].Key != "PRI" || columns[0].Extra != "auto_increment" {
		t.Fatalf("expected id to keep type/not-null/primary-key/auto-increment metadata, got %#v", columns[0])
	}
	if columns[0].Default == nil || *columns[0].Default != "SEQUENCE.NEXTVAL" {
		t.Fatalf("expected id default to keep sequence nextval, got %#v", columns[0].Default)
	}
	if columns[1].Type != "VARCHAR2(255)" || columns[1].Nullable != "YES" || columns[1].Key != "" {
		t.Fatalf("expected new_col_1 to keep varchar nullable metadata, got %#v", columns[1])
	}
}

func TestDBGetColumnsFallsBackToEmptySelectWhenOceanBaseOracleDictionaryIsEmpty(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{},
		queryResults: []fakeMetadataQueryResult{
			{match: "FROM all_tab_columns c", rows: []map[string]interface{}{}},
			{match: `SELECT * FROM "SYS"."test" WHERE 1 = 0`, fields: []string{"id", "new_col_1"}},
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetColumns(connection.ConnectionConfig{
		Type:             "oceanbase",
		Host:             "127.0.0.1",
		Port:             12881,
		User:             "SYS",
		ConnectionParams: "protocol=oracle",
	}, "SYS", "SYS.test")

	if !result.Success {
		t.Fatalf("expected DBGetColumns success, got failure: %s", result.Message)
	}
	if len(dbInst.queries) < 2 {
		t.Fatalf("expected dictionary and empty-select fallback queries, got %v", dbInst.queries)
	}
	columns, ok := result.Data.([]connection.ColumnDefinition)
	if !ok {
		t.Fatalf("expected []connection.ColumnDefinition, got %T", result.Data)
	}
	if len(columns) != 2 || columns[0].Name != "id" || columns[1].Name != "new_col_1" {
		t.Fatalf("unexpected inferred columns: %#v", columns)
	}
}

func TestDBGetColumnsKeepsDuckDBQualifiedTableMetadata(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})

	dbInst := &fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Key: "PRI"}},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}
	driverRuntimeSupportStatusFunc = func(driverType string) (bool, string) {
		return true, ""
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		return nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetColumns(connection.ConnectionConfig{
		Type: "duckdb",
		Host: "D:/tmp/demo.duckdb",
	}, "main", "main.events")

	if !result.Success {
		t.Fatalf("expected DBGetColumns success, got failure: %s", result.Message)
	}
	if dbInst.columnSchema != "main" || dbInst.columnTable != "main.events" {
		t.Fatalf("expected duckdb metadata to preserve main/main.events, got %q.%q", dbInst.columnSchema, dbInst.columnTable)
	}
}

func TestDBGetIndexesRetriesAfterCachedConnectionRefresh(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	first := &fakeMetadataRetryDB{
		indexesErr: errors.New("server has gone away"),
	}
	second := &fakeMetadataRetryDB{
		indexes: []connection.IndexDefinition{
			{Name: "PRIMARY", ColumnName: "ID", NonUnique: 0, SeqInIndex: 1, IndexType: "BTREE"},
		},
	}
	instances := []*fakeMetadataRetryDB{first, second}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		next := instances[0]
		instances = instances[1:]
		return next, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetIndexes(connection.ConnectionConfig{
		Type: "mysql",
		Host: "127.0.0.1",
		Port: 3306,
		User: "root",
	}, "mkefu_test_new", "uk_user")

	if !result.Success {
		t.Fatalf("expected DBGetIndexes success after retry, got failure: %s", result.Message)
	}
	if first.indexCalls != 1 {
		t.Fatalf("expected first index metadata call once, got %d", first.indexCalls)
	}
	if second.indexCalls != 1 {
		t.Fatalf("expected retried index metadata call once, got %d", second.indexCalls)
	}

	indexes, ok := result.Data.([]connection.IndexDefinition)
	if !ok {
		t.Fatalf("expected []connection.IndexDefinition, got %T", result.Data)
	}
	if len(indexes) != 1 || indexes[0].Name != "PRIMARY" {
		t.Fatalf("unexpected indexes after retry: %#v", indexes)
	}
}

func TestDBGetIndexesKeepsDuckDBQualifiedTableMetadata(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})

	dbInst := &fakeMetadataRetryDB{
		indexes: []connection.IndexDefinition{{Name: "events_id_pkey", ColumnName: "id", NonUnique: 0}},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}
	driverRuntimeSupportStatusFunc = func(driverType string) (bool, string) {
		return true, ""
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		return nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBGetIndexes(connection.ConnectionConfig{
		Type: "duckdb",
		Host: "D:/tmp/demo.duckdb",
	}, "main", "main.events")

	if !result.Success {
		t.Fatalf("expected DBGetIndexes success, got failure: %s", result.Message)
	}
	if dbInst.indexSchema != "main" || dbInst.indexTable != "main.events" {
		t.Fatalf("expected duckdb index metadata to preserve main/main.events, got %q.%q", dbInst.indexSchema, dbInst.indexTable)
	}
}

func TestDuckDBMetadataEndpointsReturnPrimaryKeyForQualifiedTableName(t *testing.T) {
	requireDuckDBOptionalDriverRuntime(t)

	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	dbPath := filepath.Join(t.TempDir(), "duckdb-primary-key.duckdb")
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "duckdb",
		Host: dbPath,
	}
	t.Cleanup(func() {
		app.invalidateCachedDatabase(config, nil)
	})

	createResult := app.DBQuery(config, "main", `
CREATE TABLE main.events (
	id BIGINT PRIMARY KEY,
	name VARCHAR
);
CREATE UNIQUE INDEX idx_events_name ON main.events(name);
`)
	if !createResult.Success {
		t.Fatalf("expected DuckDB setup success, got failure: %s", createResult.Message)
	}

	columnResult := app.DBGetColumns(config, "main", "main.events")
	if !columnResult.Success {
		t.Fatalf("expected DBGetColumns success, got failure: %s", columnResult.Message)
	}
	columns, ok := columnResult.Data.([]connection.ColumnDefinition)
	if !ok {
		t.Fatalf("expected []connection.ColumnDefinition, got %T", columnResult.Data)
	}
	if len(columns) == 0 {
		t.Fatalf("expected DuckDB columns, got %#v", columns)
	}
	if columns[0].Name != "id" || columns[0].Key != "PRI" {
		t.Fatalf("expected primary key metadata on first column, got %#v", columns)
	}

	indexResult := app.DBGetIndexes(config, "main", "main.events")
	if !indexResult.Success {
		t.Fatalf("expected DBGetIndexes success, got failure: %s", indexResult.Message)
	}
	indexes, ok := indexResult.Data.([]connection.IndexDefinition)
	if !ok {
		t.Fatalf("expected []connection.IndexDefinition, got %T", indexResult.Data)
	}
	if len(indexes) == 0 {
		t.Fatalf("expected DuckDB indexes, got %#v", indexes)
	}
	foundPrimary := false
	for _, index := range indexes {
		if index.ColumnName == "id" && index.NonUnique == 0 {
			foundPrimary = true
			break
		}
	}
	if !foundPrimary {
		t.Fatalf("expected DuckDB primary key index metadata, got %#v", indexes)
	}
}

func TestDuckDBDefinitionQueriesReloadLatestDDLForObjectEditFlow(t *testing.T) {
	requireDuckDBOptionalDriverRuntime(t)

	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	dbPath := filepath.Join(t.TempDir(), "duckdb-definition-reload.duckdb")
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "duckdb",
		Host: dbPath,
	}
	t.Cleanup(func() {
		app.invalidateCachedDatabase(config, nil)
	})

	createResult := app.DBQuery(config, "main", `
CREATE VIEW main.active_users AS
SELECT id FROM (VALUES (1), (2)) AS users(id);

CREATE OR REPLACE MACRO main.add_one(x) AS x + 1;
`)
	if !createResult.Success {
		t.Fatalf("expected DuckDB setup success, got failure: %s", createResult.Message)
	}

	viewDefinitionBefore := app.DBQuery(config, "main", `
SELECT view_definition
FROM information_schema.views
WHERE table_schema = 'main' AND table_name = 'active_users'
LIMIT 1`)
	if !viewDefinitionBefore.Success {
		t.Fatalf("expected initial view definition query success, got failure: %s", viewDefinitionBefore.Message)
	}
	viewRowsBefore, ok := viewDefinitionBefore.Data.([]map[string]interface{})
	if !ok || len(viewRowsBefore) != 1 {
		t.Fatalf("expected one initial view definition row, got %#v", viewDefinitionBefore.Data)
	}
	viewTextBefore := strings.TrimSpace(stringValueIgnoreCase(viewRowsBefore[0], "view_definition"))
	if !strings.Contains(viewTextBefore, "SELECT id FROM") || !strings.Contains(viewTextBefore, "VALUES (1), (2)") {
		t.Fatalf("unexpected initial view definition: %q", viewTextBefore)
	}

	routineDefinitionBefore := app.DBQuery(config, "main", `
SELECT schema_name, function_name, parameters, macro_definition
FROM duckdb_functions()
WHERE internal = false
  AND lower(function_type) = 'macro'
  AND schema_name = 'main'
  AND function_name = 'add_one'
LIMIT 1`)
	if !routineDefinitionBefore.Success {
		t.Fatalf("expected initial routine definition query success, got failure: %s", routineDefinitionBefore.Message)
	}
	routineRowsBefore, ok := routineDefinitionBefore.Data.([]map[string]interface{})
	if !ok || len(routineRowsBefore) != 1 {
		t.Fatalf("expected one initial routine definition row, got %#v", routineDefinitionBefore.Data)
	}
	routineTextBefore := strings.TrimSpace(stringValueIgnoreCase(routineRowsBefore[0], "macro_definition"))
	if !strings.Contains(routineTextBefore, "x + 1") {
		t.Fatalf("unexpected initial routine definition: %q", routineTextBefore)
	}

	replaceResult := app.DBQuery(config, "main", `
CREATE OR REPLACE VIEW main.active_users AS
SELECT id, id * 10 AS score FROM (VALUES (1), (2)) AS users(id);

CREATE OR REPLACE MACRO main.add_one(x) AS x + 2;
`)
	if !replaceResult.Success {
		t.Fatalf("expected DuckDB replace success, got failure: %s", replaceResult.Message)
	}

	viewDefinitionAfter := app.DBQuery(config, "main", `
SELECT view_definition
FROM information_schema.views
WHERE table_schema = 'main' AND table_name = 'active_users'
LIMIT 1`)
	if !viewDefinitionAfter.Success {
		t.Fatalf("expected latest view definition query success, got failure: %s", viewDefinitionAfter.Message)
	}
	viewRowsAfter, ok := viewDefinitionAfter.Data.([]map[string]interface{})
	if !ok || len(viewRowsAfter) != 1 {
		t.Fatalf("expected one latest view definition row, got %#v", viewDefinitionAfter.Data)
	}
	viewTextAfter := strings.TrimSpace(stringValueIgnoreCase(viewRowsAfter[0], "view_definition"))
	if !strings.Contains(viewTextAfter, "score") || !strings.Contains(viewTextAfter, "10") {
		t.Fatalf("expected latest view definition, got %q", viewTextAfter)
	}
	if viewTextAfter == viewTextBefore {
		t.Fatalf("expected latest view definition to differ from initial definition, got %q", viewTextAfter)
	}

	routineDefinitionAfter := app.DBQuery(config, "main", `
SELECT schema_name, function_name, parameters, macro_definition
FROM duckdb_functions()
WHERE internal = false
  AND lower(function_type) = 'macro'
  AND schema_name = 'main'
  AND function_name = 'add_one'
LIMIT 1`)
	if !routineDefinitionAfter.Success {
		t.Fatalf("expected latest routine definition query success, got failure: %s", routineDefinitionAfter.Message)
	}
	routineRowsAfter, ok := routineDefinitionAfter.Data.([]map[string]interface{})
	if !ok || len(routineRowsAfter) != 1 {
		t.Fatalf("expected one latest routine definition row, got %#v", routineDefinitionAfter.Data)
	}
	routineTextAfter := strings.TrimSpace(stringValueIgnoreCase(routineRowsAfter[0], "macro_definition"))
	if !strings.Contains(routineTextAfter, "x + 2") {
		t.Fatalf("expected latest routine definition, got %q", routineTextAfter)
	}
	if routineTextAfter == routineTextBefore {
		t.Fatalf("expected latest routine definition to differ from initial definition, got %q", routineTextAfter)
	}
}

func stringValueIgnoreCase(row map[string]interface{}, key string) string {
	for candidate, value := range row {
		if strings.EqualFold(strings.TrimSpace(candidate), strings.TrimSpace(key)) {
			return toStringValue(value)
		}
	}
	return ""
}

func toStringValue(value interface{}) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		if value == nil {
			return ""
		}
		return fmt.Sprint(value)
	}
}
