package app

import (
	"context"
	"errors"
	"reflect"
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
	tables           []string
	columns          []connection.ColumnDefinition
	allColumns       []connection.ColumnDefinitionWithTable
	allColumnsErr    error
	indexes          []connection.IndexDefinition
	createStatement  string
	tablesErr        error
	columnsErr       error
	indexesErr       error
	queryResults     []fakeMetadataQueryResult
	queryRows        []map[string]interface{}
	queryFields      []string
	queryErr         error
	queries          []string
	tableCalls       int
	tableSchema      string
	columnCalls      int
	allColumnCalls   int
	indexCalls       int
	foreignKeyCalls  int
	triggerCalls     int
	databaseFKCalls  int
	createCalls      int
	columnSchema     string
	columnTable      string
	allColumnSchema  string
	indexSchema      string
	indexTable       string
	foreignKeySchema string
	foreignKeyTable  string
	triggerSchema    string
	triggerTable     string
	databaseFKSchema string
	createSchema     string
	createTable      string
	connectCalls     int
	connectConfig    connection.ConnectionConfig
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
func (f *fakeMetadataRetryDB) ApplyChanges(string, connection.ChangeSet) error {
	return nil
}
func (f *fakeMetadataRetryDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return f.ApplyChanges(tableName, changes)
}
func (f *fakeMetadataRetryDB) GetDatabases() ([]string, error) { return nil, nil }
func (f *fakeMetadataRetryDB) GetTables(dbName string) ([]string, error) {
	f.tableCalls++
	f.tableSchema = dbName
	if f.tablesErr != nil {
		return nil, f.tablesErr
	}
	return f.tables, nil
}
func (f *fakeMetadataRetryDB) GetCreateStatement(dbName, tableName string) (string, error) {
	f.createCalls++
	f.createSchema = dbName
	f.createTable = tableName
	return f.createStatement, nil
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
	f.allColumnCalls++
	f.allColumnSchema = dbName
	return f.allColumns, f.allColumnsErr
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
	f.foreignKeyCalls++
	f.foreignKeySchema = dbName
	f.foreignKeyTable = tableName
	return nil, nil
}
func (f *fakeMetadataRetryDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	f.triggerCalls++
	f.triggerSchema = dbName
	f.triggerTable = tableName
	return nil, nil
}
func (f *fakeMetadataRetryDB) GetDatabaseForeignKeys(dbName string) (map[string][]connection.ForeignKeyDefinition, error) {
	f.databaseFKCalls++
	f.databaseFKSchema = dbName
	return map[string][]connection.ForeignKeyDefinition{}, nil
}

var _ db.Database = (*fakeMetadataRetryDB)(nil)
var _ db.DatabaseForeignKeyProvider = (*fakeMetadataRetryDB)(nil)

type oceanBaseOracleMetadataFixture struct {
	app      *App
	config   connection.ConnectionConfig
	database *fakeMetadataRetryDB
	created  int
}

func newOceanBaseOracleMetadataFixture(t *testing.T, database *fakeMetadataRetryDB) *oceanBaseOracleMetadataFixture {
	t.Helper()
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	fixture := &oceanBaseOracleMetadataFixture{
		config: connection.ConnectionConfig{
			Type:              "oceanbase",
			Host:              "127.0.0.1",
			Port:              2881,
			User:              "SYS@tenant",
			OceanBaseProtocol: "oracle",
			ConnectionParams:  "trace=true",
		},
		database: database,
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		fixture.created++
		return fixture.database, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}
	fixture.app = NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	if result := fixture.app.DBGetDatabases(fixture.config); !result.Success {
		t.Fatalf("expected DBGetDatabases success, got failure: %s", result.Message)
	}
	return fixture
}

func (fixture *oceanBaseOracleMetadataFixture) requireBaseConnectionReused(t *testing.T, operation string) {
	t.Helper()
	if fixture.created != 1 || fixture.database.connectCalls != 1 {
		t.Fatalf("expected %s to reuse one base connection, created=%d connected=%d last params=%q", operation, fixture.created, fixture.database.connectCalls, fixture.database.connectConfig.ConnectionParams)
	}
	if fixture.database.connectConfig.ConnectionParams != fixture.config.ConnectionParams {
		t.Fatalf("expected base connection params %q, got %q", fixture.config.ConnectionParams, fixture.database.connectConfig.ConnectionParams)
	}
}

func TestDBGetTablesReusesOceanBaseOracleBaseConnectionForSelectedSchema(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{tables: []string{"ORDERS"}}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetTables(fixture.config, "CRH_AC")
	if !result.Success {
		t.Fatalf("expected DBGetTables success, got failure: %s", result.Message)
	}
	fixture.requireBaseConnectionReused(t, "selected schema table metadata")
	if dbInst.tableCalls != 1 || dbInst.tableSchema != "CRH_AC" {
		t.Fatalf("expected table metadata for CRH_AC once, calls=%d schema=%q", dbInst.tableCalls, dbInst.tableSchema)
	}
}

func TestDBGetObjectsDeduplicatesExactTableMetadataNames(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{tables: []string{
		" ldf_server.ldf_application_type ",
		"ldf_server.ldf_application_type",
		"archive.ldf_application_type",
		"LDF_SERVER.LDF_APPLICATION_TYPE",
	}}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetObjects(fixture.config, "CRH_AC")
	if !result.Success {
		t.Fatalf("expected DBGetObjects success, got failure: %s", result.Message)
	}
	objects, ok := result.Data.([]connection.DatabaseObject)
	if !ok {
		t.Fatalf("DBGetObjects data type = %T, want []connection.DatabaseObject", result.Data)
	}
	tableNames := make([]string, 0, len(objects))
	for _, object := range objects {
		if object.Type == "table" {
			tableNames = append(tableNames, object.Schema+"."+object.Name)
		}
	}
	if len(tableNames) != 3 {
		t.Fatalf("DBGetObjects table count = %d, want 3: %v", len(tableNames), tableNames)
	}
	want := map[string]struct{}{
		"ldf_server.ldf_application_type": {},
		"archive.ldf_application_type":    {},
		"LDF_SERVER.LDF_APPLICATION_TYPE": {},
	}
	got := make(map[string]struct{}, len(tableNames))
	for _, tableName := range tableNames {
		got[tableName] = struct{}{}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DBGetObjects table names = %v, want %v", got, want)
	}
}

func TestDBGetObjectsStopsAfterMessageBrokerObjects(t *testing.T) {
	tests := []struct {
		name         string
		dbType       string
		dbName       string
		tables       []string
		queryResults []fakeMetadataQueryResult
		wantObjects  []string
		wantQueries  []string
	}{
		{
			name:        "mqtt topics preserve case",
			dbType:      "mqtt",
			dbName:      "topics",
			tables:      []string{"Orders", "orders"},
			wantObjects: []string{"topic:Orders", "topic:orders"},
		},
		{
			name:        "kafka topics preserve case",
			dbType:      "kafka",
			dbName:      "topics",
			tables:      []string{"Orders", "orders"},
			wantObjects: []string{"topic:Orders", "topic:orders"},
		},
		{
			name:        "rocketmq topics preserve case",
			dbType:      "rocketmq",
			dbName:      "topics",
			tables:      []string{"Orders", "orders"},
			wantObjects: []string{"topic:Orders", "topic:orders"},
		},
		{
			name:   "rabbitmq queues and exchanges preserve case",
			dbType: "rabbitmq",
			dbName: "/",
			tables: []string{"Orders", "orders"},
			queryResults: []fakeMetadataQueryResult{
				{
					match: "SHOW EXCHANGES",
					rows: []map[string]interface{}{
						{"exchange": "Orders", "type": "topic"},
						{"exchange": "orders", "type": "topic"},
					},
					fields: []string{"exchange", "type"},
				},
			},
			wantObjects: []string{
				"exchange:Orders",
				"exchange:orders",
				"queue:Orders",
				"queue:orders",
			},
			wantQueries: []string{"SHOW EXCHANGES"},
		},
	}

	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			installFakeOptionalDriverRuntime(t)
			originalNewDatabaseFunc := newDatabaseFunc
			originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
			t.Cleanup(func() {
				newDatabaseFunc = originalNewDatabaseFunc
				resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
			})

			database := &fakeMetadataRetryDB{
				tables:       test.tables,
				queryResults: test.queryResults,
				queryErr:     errors.New("unexpected relational metadata query"),
			}
			newDatabaseFunc = func(dbType string) (db.Database, error) {
				if dbType != test.dbType {
					t.Fatalf("newDatabaseFunc type = %q, want %q", dbType, test.dbType)
				}
				return database, nil
			}
			resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
				return raw, nil
			}

			application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
			config := connection.ConnectionConfig{
				Type: test.dbType,
				Host: "message-broker.test",
				Port: 19000 + index,
			}
			result := application.DBGetObjects(config, test.dbName)
			if !result.Success || result.Partial || result.Retryable {
				t.Fatalf("DBGetObjects(%s) = %#v, want complete success", test.dbType, result)
			}
			objects, ok := result.Data.([]connection.DatabaseObject)
			if !ok {
				t.Fatalf("DBGetObjects(%s) data type = %T, want []connection.DatabaseObject", test.dbType, result.Data)
			}
			gotObjects := make([]string, 0, len(objects))
			for _, object := range objects {
				gotObjects = append(gotObjects, object.Type+":"+object.Name)
			}
			if !reflect.DeepEqual(gotObjects, test.wantObjects) {
				t.Fatalf("DBGetObjects(%s) objects = %v, want %v", test.dbType, gotObjects, test.wantObjects)
			}
			if !reflect.DeepEqual(database.queries, test.wantQueries) {
				t.Fatalf("DBGetObjects(%s) queries = %v, want %v", test.dbType, database.queries, test.wantQueries)
			}
			for _, query := range database.queries {
				lowerQuery := strings.ToLower(query)
				if strings.Contains(lowerQuery, "information_schema") || strings.Contains(lowerQuery, "pg_catalog") || strings.Contains(lowerQuery, "sqlite_") {
					t.Fatalf("DBGetObjects(%s) executed relational metadata query %q", test.dbType, query)
				}
			}
		})
	}
}

func TestDBGetColumnsReusesOceanBaseOracleBaseConnectionForSelectedSchema(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "ID", Key: "PRI"}},
	}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetColumns(fixture.config, "CRH_AC", "CRH_AC.ORDERS")
	if !result.Success {
		t.Fatalf("expected DBGetColumns success, got failure: %s", result.Message)
	}
	fixture.requireBaseConnectionReused(t, "selected schema column metadata")
	if dbInst.columnCalls != 1 || dbInst.columnSchema != "CRH_AC" || dbInst.columnTable != "ORDERS" {
		t.Fatalf("expected column metadata for CRH_AC.ORDERS once, calls=%d schema=%q table=%q", dbInst.columnCalls, dbInst.columnSchema, dbInst.columnTable)
	}
}

func TestDBGetIndexesReusesOceanBaseOracleBaseConnectionForSelectedSchema(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{
		indexes: []connection.IndexDefinition{{Name: "ORDERS_PK", ColumnName: "ID", NonUnique: 0}},
	}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetIndexes(fixture.config, "CRH_AC", "CRH_AC.ORDERS")
	if !result.Success {
		t.Fatalf("expected DBGetIndexes success, got failure: %s", result.Message)
	}
	fixture.requireBaseConnectionReused(t, "selected schema index metadata")
	if dbInst.indexCalls != 1 || dbInst.indexSchema != "CRH_AC" || dbInst.indexTable != "ORDERS" {
		t.Fatalf("expected index metadata for CRH_AC.ORDERS once, calls=%d schema=%q table=%q", dbInst.indexCalls, dbInst.indexSchema, dbInst.indexTable)
	}
}

func TestDBGetTableDetailsReuseOceanBaseOracleBaseConnectionForSelectedSchema(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{
		columns:         []connection.ColumnDefinition{{Name: "ID", Key: "PRI"}},
		createStatement: `CREATE TABLE "CRH_AC"."ORDERS" ("ID" NUMBER PRIMARY KEY)`,
	}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	if result := fixture.app.DBGetForeignKeys(fixture.config, "CRH_AC", "CRH_AC.ORDERS"); !result.Success {
		t.Fatalf("expected DBGetForeignKeys success, got failure: %s", result.Message)
	}
	if result := fixture.app.DBGetTriggers(fixture.config, "CRH_AC", "CRH_AC.ORDERS"); !result.Success {
		t.Fatalf("expected DBGetTriggers success, got failure: %s", result.Message)
	}
	if result := fixture.app.DBShowCreateTable(fixture.config, "CRH_AC", "CRH_AC.ORDERS"); !result.Success {
		t.Fatalf("expected DBShowCreateTable success, got failure: %s", result.Message)
	}

	fixture.requireBaseConnectionReused(t, "selected schema table details")
	if dbInst.foreignKeyCalls != 1 || dbInst.foreignKeySchema != "CRH_AC" || dbInst.foreignKeyTable != "ORDERS" {
		t.Fatalf("unexpected foreign-key metadata target: calls=%d schema=%q table=%q", dbInst.foreignKeyCalls, dbInst.foreignKeySchema, dbInst.foreignKeyTable)
	}
	if dbInst.triggerCalls != 1 || dbInst.triggerSchema != "CRH_AC" || dbInst.triggerTable != "ORDERS" {
		t.Fatalf("unexpected trigger metadata target: calls=%d schema=%q table=%q", dbInst.triggerCalls, dbInst.triggerSchema, dbInst.triggerTable)
	}
	if dbInst.createCalls != 1 || dbInst.createSchema != "CRH_AC" || dbInst.createTable != "ORDERS" {
		t.Fatalf("unexpected create-statement metadata target: calls=%d schema=%q table=%q", dbInst.createCalls, dbInst.createSchema, dbInst.createTable)
	}
}

func TestDBGetAllColumnsReusesOceanBaseOracleBaseConnectionForSelectedSchema(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetAllColumns(fixture.config, "CRH_AC")
	if !result.Success {
		t.Fatalf("expected DBGetAllColumns success, got failure: %s", result.Message)
	}
	fixture.requireBaseConnectionReused(t, "selected schema all-column metadata")
	if dbInst.allColumnCalls != 1 || dbInst.allColumnSchema != "CRH_AC" {
		t.Fatalf("expected all-column metadata for CRH_AC once, calls=%d schema=%q", dbInst.allColumnCalls, dbInst.allColumnSchema)
	}
}

func TestDBGetAllColumnsPreservesPartialMetadataResult(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{
		allColumns: []connection.ColumnDefinitionWithTable{{TableName: "healthy", Name: "id", Type: "integer"}},
		allColumnsErr: db.NewPartialMetadataError([]db.MetadataObjectFailure{{
			ObjectName: "restricted",
			Err:        errors.New("metadata permission denied password=secret-token"),
		}}),
	}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetAllColumns(fixture.config, "CRH_AC")
	if !result.Success || !result.Partial {
		t.Fatalf("expected partial DBGetAllColumns success, got %#v", result)
	}
	columns, ok := result.Data.([]connection.ColumnDefinitionWithTable)
	if !ok || len(columns) != 1 || columns[0].TableName != "healthy" {
		t.Fatalf("expected successful columns to be preserved, got %#v", result.Data)
	}
	if len(result.Warnings) != 1 || !strings.Contains(result.Warnings[0], "restricted") {
		t.Fatalf("expected warning for restricted object, got %#v", result.Warnings)
	}
	if strings.Contains(result.Warnings[0], "secret-token") {
		t.Fatalf("partial result leaked sensitive detail: %#v", result.Warnings)
	}
}

func TestDBGetAllColumnsFailsWhenBaseMetadataReadFails(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{allColumnsErr: errors.New("base metadata permission denied")}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBGetAllColumns(fixture.config, "CRH_AC")
	if result.Success || result.Partial || result.Message != "base metadata permission denied" {
		t.Fatalf("expected ordinary metadata failure, got %#v", result)
	}
}

func TestDBTableExistsReusesOceanBaseOracleBaseConnectionForSelectedSchema(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{tables: []string{"CRH_AC.ORDERS"}}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	result := fixture.app.DBTableExists(fixture.config, "CRH_AC", "CRH_AC.ORDERS")
	if !result.Success {
		t.Fatalf("expected DBTableExists success, got failure: %s", result.Message)
	}
	exists, ok := result.Data.(map[string]bool)
	if !ok || !exists["exists"] {
		t.Fatalf("expected CRH_AC.ORDERS to exist, got %#v", result.Data)
	}
	fixture.requireBaseConnectionReused(t, "selected schema table lookup")
	if dbInst.tableCalls != 1 || dbInst.tableSchema != "CRH_AC" {
		t.Fatalf("expected table lookup in CRH_AC once, calls=%d schema=%q", dbInst.tableCalls, dbInst.tableSchema)
	}
}

func TestDBGetSchemaMetadataReusesOceanBaseOracleBaseConnectionForSelectedSchema(t *testing.T) {
	dbInst := &fakeMetadataRetryDB{
		queryResults: []fakeMetadataQueryResult{{
			match: "FROM all_views",
			rows: []map[string]interface{}{{
				"SCHEMA_NAME": "CRH_AC",
				"OBJECT_NAME": "ACTIVE_ORDERS",
			}},
		}},
	}
	fixture := newOceanBaseOracleMetadataFixture(t, dbInst)

	if result := fixture.app.DBGetViews(fixture.config, "CRH_AC"); !result.Success {
		t.Fatalf("expected DBGetViews success, got failure: %s", result.Message)
	}
	if result := fixture.app.DBGetDatabaseForeignKeys(fixture.config, "CRH_AC"); !result.Success {
		t.Fatalf("expected DBGetDatabaseForeignKeys success, got failure: %s", result.Message)
	}
	if result := fixture.app.DBGetObjects(fixture.config, "CRH_AC"); !result.Success {
		t.Fatalf("expected DBGetObjects success, got failure: %s", result.Message)
	}

	fixture.requireBaseConnectionReused(t, "selected schema metadata")
	if dbInst.databaseFKCalls != 1 || dbInst.databaseFKSchema != "CRH_AC" {
		t.Fatalf("expected database foreign-key metadata for CRH_AC once, calls=%d schema=%q", dbInst.databaseFKCalls, dbInst.databaseFKSchema)
	}
	if !strings.Contains(strings.Join(dbInst.queries, "\n"), "FROM all_views WHERE OWNER = 'CRH_AC'") {
		t.Fatalf("expected explicit CRH_AC owner view query, got %v", dbInst.queries)
	}
}
