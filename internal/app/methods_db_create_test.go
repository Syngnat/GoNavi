package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

type fakeCreateDatabaseDB struct {
	connectConfig    connection.ConnectionConfig
	execQueries      []string
	applyChanges     connection.ChangeSet
	applyTableName   string
	previewTableName string
	previewDeletes   []string
	previewUpdates   []string
	previewInserts   []string
}

func (f *fakeCreateDatabaseDB) Connect(config connection.ConnectionConfig) error {
	f.connectConfig = config
	return nil
}
func (f *fakeCreateDatabaseDB) Close() error { return nil }
func (f *fakeCreateDatabaseDB) Ping() error  { return nil }
func (f *fakeCreateDatabaseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, nil
}
func (f *fakeCreateDatabaseDB) Exec(query string) (int64, error) {
	f.execQueries = append(f.execQueries, query)
	return 0, nil
}
func (f *fakeCreateDatabaseDB) GetDatabases() ([]string, error) { return nil, nil }
func (f *fakeCreateDatabaseDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}
func (f *fakeCreateDatabaseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (f *fakeCreateDatabaseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (f *fakeCreateDatabaseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *fakeCreateDatabaseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *fakeCreateDatabaseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *fakeCreateDatabaseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}
func (f *fakeCreateDatabaseDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	f.applyTableName = tableName
	f.applyChanges = changes
	return nil
}
func (f *fakeCreateDatabaseDB) PreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string) {
	f.previewTableName = tableName
	return f.previewDeletes, f.previewUpdates, f.previewInserts
}

var _ db.Database = (*fakeCreateDatabaseDB)(nil)
var _ db.BatchApplier = (*fakeCreateDatabaseDB)(nil)
var _ db.ChangePreviewer = (*fakeCreateDatabaseDB)(nil)

func TestResolveDDLDBType_SQLServerAliases(t *testing.T) {
	tests := []connection.ConnectionConfig{
		{Type: "sqlserver"},
		{Type: "mssql"},
		{Type: "sql_server"},
		{Type: "custom", Driver: "mssql"},
		{Type: "custom", Driver: "sql-server"},
	}

	for _, cfg := range tests {
		if got := resolveDDLDBType(cfg); got != "sqlserver" {
			t.Fatalf("resolveDDLDBType(%+v) = %q, want sqlserver", cfg, got)
		}
	}
}

func TestBuildRunConfigForDDL_CustomSQLServerUsesDatabase(t *testing.T) {
	got := buildRunConfigForDDL(connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "mssql",
		Database: "master",
	}, "sqlserver", "target_db")
	if got.Database != "target_db" {
		t.Fatalf("expected custom SQL Server DDL database target_db, got %q", got.Database)
	}
}

func TestCreateDatabase_SQLServerUsesBracketIdentifiers(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	fakeDB := &fakeCreateDatabaseDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.CreateDatabase(connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "mssql",
		Database: "master",
	}, "lg", "", "")

	if !result.Success {
		t.Fatalf("expected SQL Server create database success, got failure: %s", result.Message)
	}
	if fakeDB.connectConfig.Database != "" {
		t.Fatalf("expected create database connection to clear database and use default master, got %q", fakeDB.connectConfig.Database)
	}
	if len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one create database statement, got %d: %#v", len(fakeDB.execQueries), fakeDB.execQueries)
	}
	const want = "CREATE DATABASE [lg]"
	if fakeDB.execQueries[0] != want {
		t.Fatalf("unexpected SQL Server create database SQL, want %q got %q", want, fakeDB.execQueries[0])
	}
}

func TestBuildCreateSchemaSQL_PostgresQuotesSchemaName(t *testing.T) {
	got, err := buildCreateSchemaSQL("postgresql", `sales"Ops`)
	if err != nil {
		t.Fatalf("expected postgres create schema SQL, got error: %v", err)
	}
	const want = `CREATE SCHEMA "sales""Ops"`
	if got != want {
		t.Fatalf("unexpected create schema SQL, want %q got %q", want, got)
	}
}

func TestBuildCreateSchemaSQL_RejectsUnsupportedDatabaseType(t *testing.T) {
	if _, err := buildCreateSchemaSQL("mysql", "sales"); err == nil {
		t.Fatalf("expected unsupported database type error")
	}
}

func TestCreateSchema_CustomPostgresUsesSelectedDatabase(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	fakeDB := &fakeCreateDatabaseDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.CreateSchema(connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "pgx",
		Database: "postgres",
	}, "tenant_db", `tenant"schema`)

	if !result.Success {
		t.Fatalf("expected create schema success, got failure: %s", result.Message)
	}
	if fakeDB.connectConfig.Database != "tenant_db" {
		t.Fatalf("expected create schema connection to use selected database tenant_db, got %q", fakeDB.connectConfig.Database)
	}
	if len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one create schema statement, got %d: %#v", len(fakeDB.execQueries), fakeDB.execQueries)
	}
	const want = `CREATE SCHEMA "tenant""schema"`
	if fakeDB.execQueries[0] != want {
		t.Fatalf("unexpected create schema SQL, want %q got %q", want, fakeDB.execQueries[0])
	}
}

func TestBuildCreateDatabaseQuery_MySQLCharsetAndCollation(t *testing.T) {
	tests := []struct {
		name      string
		dbType    string
		dbName    string
		charset   string
		collation string
		want      string
		wantErr   bool
	}{
		{
			name:   "mysql with charset and collation",
			dbType: "mysql", dbName: "app", charset: "utf8mb4", collation: "utf8mb4_unicode_ci",
			want: "CREATE DATABASE `app` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		},
		{
			name:   "mysql charset only",
			dbType: "mysql", dbName: "app", charset: "latin1",
			want: "CREATE DATABASE `app` CHARACTER SET latin1",
		},
		{
			name:   "mysql collation only",
			dbType: "mysql", dbName: "app", collation: "utf8mb4_general_ci",
			want: "CREATE DATABASE `app` COLLATE utf8mb4_general_ci",
		},
		{
			name:   "mysql no options uses server default",
			dbType: "mysql", dbName: "app",
			want: "CREATE DATABASE `app`",
		},
		{
			name:   "mariadb dialect",
			dbType: "mariadb", dbName: "app", charset: "utf8mb4",
			want: "CREATE DATABASE `app` CHARACTER SET utf8mb4",
		},
		{
			name:   "backtick escaping",
			dbType: "mysql", dbName: "we`ird",
			want: "CREATE DATABASE `we``ird`",
		},
		{
			name:   "postgres quotes identifiers",
			dbType: "postgres", dbName: `sa"les`,
			want: `CREATE DATABASE "sa""les"`,
		},
		{
			name:   "sqlserver brackets",
			dbType: "sqlserver", dbName: "sales",
			want: "CREATE DATABASE [sales]",
		},
		{
			name:   "clickhouse if not exists",
			dbType: "clickhouse", dbName: "reporting",
			want: "CREATE DATABASE IF NOT EXISTS `reporting`",
		},
		{
			name:    "invalid charset rejected",
			dbType:  "mysql", dbName: "app", charset: "utf8mb4; DROP TABLE x",
			wantErr: true,
		},
		{
			name:    "invalid collation rejected",
			dbType:  "mysql", dbName: "app", collation: "ci` --",
			wantErr: true,
		},
		{
			name:    "sphinx unsupported",
			dbType:  "sphinx", dbName: "app",
			wantErr: true,
		},
		{
			name:    "oracle unsupported",
			dbType:  "oracle", dbName: "app",
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := buildCreateDatabaseQuery(tt.dbType, tt.dbName, tt.charset, tt.collation)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got query %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("query = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestIsSafeDatabaseOption(t *testing.T) {
	for _, value := range []string{"utf8mb4", "utf8mb4_unicode_ci", "latin1", "a1_b2"} {
		if !isSafeDatabaseOption(value) {
			t.Fatalf("expected %q to be safe", value)
		}
	}
	for _, value := range []string{"", "utf8mb4;", "a b", "a`b", "a-b", "中文"} {
		if isSafeDatabaseOption(value) {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}

func TestSupportsDatabaseCharsetOptions(t *testing.T) {
	for _, dbType := range []string{"mysql", "mariadb", "diros", "oceanbase"} {
		if !supportsDatabaseCharsetOptions(dbType) {
			t.Fatalf("expected %q to support charset options", dbType)
		}
	}
	for _, dbType := range []string{"postgres", "sqlserver", "clickhouse", "starrocks", "sphinx", "oracle", "tdengine"} {
		if supportsDatabaseCharsetOptions(dbType) {
			t.Fatalf("expected %q to not support charset options", dbType)
		}
	}
}

func TestRowValueHelpers(t *testing.T) {
	row := map[string]interface{}{
		"Charset":          "utf8mb4",
		"Description":      "UTF-8 Unicode",
		"Default collation": "utf8mb4_0900_ai_ci",
		"Maxlen":           int64(4),
	}
	if got := rowStringValue(row, "Charset"); got != "utf8mb4" {
		t.Fatalf("rowStringValue Charset = %q", got)
	}
	if got := rowStringValue(row, "Missing"); got != "" {
		t.Fatalf("rowStringValue missing = %q", got)
	}
	if got := rowIntValue(row, "Maxlen"); got != 4 {
		t.Fatalf("rowIntValue Maxlen = %d", got)
	}
	if got := rowIntValue(row, "Missing"); got != 0 {
		t.Fatalf("rowIntValue missing = %d", got)
	}
}
