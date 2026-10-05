package app

import (
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

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

func TestDBGetForeignKeysAndTriggersUseSearchPathForPostgresPureTableMetadata(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "postgres",
		Database: "demo_db",
	}

	if result := app.DBGetForeignKeys(config, "demo_db", "users"); !result.Success {
		t.Fatalf("expected DBGetForeignKeys success, got failure: %s", result.Message)
	}
	if dbInst.foreignKeySchema != "" || dbInst.foreignKeyTable != "users" {
		t.Fatalf("expected postgres pure table foreign-key metadata to pass empty schema/users, got %q.%q", dbInst.foreignKeySchema, dbInst.foreignKeyTable)
	}

	if result := app.DBGetTriggers(config, "demo_db", "users"); !result.Success {
		t.Fatalf("expected DBGetTriggers success, got failure: %s", result.Message)
	}
	if dbInst.triggerSchema != "" || dbInst.triggerTable != "users" {
		t.Fatalf("expected postgres pure table trigger metadata to pass empty schema/users, got %q.%q", dbInst.triggerSchema, dbInst.triggerTable)
	}
}

func TestDBGetForeignKeysAndTriggersKeepExplicitPostgresSchema(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres", Database: "demo_db"}

	if result := app.DBGetForeignKeys(config, "demo_db", "public.users"); !result.Success {
		t.Fatalf("expected DBGetForeignKeys success, got failure: %s", result.Message)
	}
	if dbInst.foreignKeySchema != "public" || dbInst.foreignKeyTable != "users" {
		t.Fatalf("expected explicit postgres foreign-key metadata to pass public/users, got %q.%q", dbInst.foreignKeySchema, dbInst.foreignKeyTable)
	}

	if result := app.DBGetTriggers(config, "demo_db", "public.users"); !result.Success {
		t.Fatalf("expected DBGetTriggers success, got failure: %s", result.Message)
	}
	if dbInst.triggerSchema != "public" || dbInst.triggerTable != "users" {
		t.Fatalf("expected explicit postgres trigger metadata to pass public/users, got %q.%q", dbInst.triggerSchema, dbInst.triggerTable)
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

func TestDBTableExistsNormalizesQualifiedMySQLTableMetadata(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{tables: []string{"users", "order.items"}}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	for _, tableName := range []string{"demo_db.users", "`order.items`"} {
		result := app.DBTableExists(connection.ConnectionConfig{
			Type: "mysql",
			Host: "127.0.0.1",
			Port: 3306,
			User: "root",
		}, "demo_db", tableName)

		if !result.Success {
			t.Fatalf("DBTableExists(%q) returned failure: %s", tableName, result.Message)
		}
		exists, ok := result.Data.(map[string]bool)
		if !ok || !exists["exists"] {
			t.Fatalf("expected MySQL table %q to exist, got %#v", tableName, result.Data)
		}
		if dbInst.tableSchema != "demo_db" {
			t.Fatalf("expected MySQL table lookup database demo_db, got %q", dbInst.tableSchema)
		}
	}
}

func TestDBTableExistsNormalizesQuotedDottedBareCatalogNames(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{tables: []string{"order.items"}}
	newDatabaseFunc = func(string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	for _, test := range []struct {
		name      string
		dbType    string
		dbName    string
		tableName string
	}{
		{name: "mysql", dbType: "mysql", dbName: "app", tableName: "`order.items`"},
		{name: "mariadb", dbType: "mariadb", dbName: "app", tableName: "`order.items`"},
		{name: "oceanbase mysql", dbType: "oceanbase", dbName: "app", tableName: "`order.items`"},
		{name: "doris", dbType: "diros", dbName: "app", tableName: "`order.items`"},
		{name: "starrocks", dbType: "starrocks", dbName: "app", tableName: "`order.items`"},
		{name: "sphinx", dbType: "sphinx", dbName: "app", tableName: "`order.items`"},
		{name: "tidb", dbType: "tidb", dbName: "app", tableName: "`order.items`"},
		{name: "sqlite", dbType: "sqlite", dbName: "main", tableName: "[order.items]"},
		{name: "clickhouse", dbType: "clickhouse", dbName: "app", tableName: "`order.items`"},
		{name: "tdengine", dbType: "tdengine", dbName: "app", tableName: "`order.items`"},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := app.DBTableExists(connection.ConnectionConfig{
				Type: test.dbType,
				Host: "127.0.0.1",
				Port: 1,
				User: "test",
			}, test.dbName, test.tableName)
			if !result.Success {
				t.Fatalf("DBTableExists(%q) returned failure: %s", test.tableName, result.Message)
			}
			exists, ok := result.Data.(map[string]bool)
			if !ok || !exists["exists"] {
				t.Fatalf("expected %s table %q to exist, got %#v", test.dbType, test.tableName, result.Data)
			}
			if dbInst.tableSchema != test.dbName || dbInst.tableCalls == 0 {
				t.Fatalf("catalog lookup for %s = %q, calls=%d, want database %q", test.dbType, dbInst.tableSchema, dbInst.tableCalls, test.dbName)
			}
		})
	}
}

func TestDBTableExistsNormalizesSQLServerQuotedDottedTableMetadata(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	dbInst := &fakeMetadataRetryDB{tables: []string{"[dbo].[order.items]", "[sales].[order.items]"}}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return dbInst, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	for _, tableName := range []string{"[order.items]", "sales.[order.items]"} {
		result := app.DBTableExists(connection.ConnectionConfig{
			Type: "sqlserver",
			Host: "127.0.0.1",
			Port: 1433,
			User: "sa",
		}, "app", tableName)
		if !result.Success {
			t.Fatalf("DBTableExists(%q) returned failure: %s", tableName, result.Message)
		}
		exists, ok := result.Data.(map[string]bool)
		if !ok || !exists["exists"] {
			t.Fatalf("expected SQL Server quoted dotted table %q to exist, got %#v", tableName, result.Data)
		}
		if dbInst.tableSchema != "app" {
			t.Fatalf("expected SQL Server table lookup database app, got %q", dbInst.tableSchema)
		}
	}
}
