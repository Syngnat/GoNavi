package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/shared/i18n"
)

func methodsDBFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("methods_db.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

type fakeShowCreateTableDB struct {
	createStatement string
	createErr       error
	columns         []connection.ColumnDefinition
	columnsErr      error
}

type fakeManagedTransactionFinisher struct {
	execQueries   []string
	execErr       error
	commitErr     error
	rollbackErr   error
	closeErr      error
	commitCalls   int
	rollbackCalls int
	closeCalls    int
}

func (f *fakeShowCreateTableDB) Connect(config connection.ConnectionConfig) error { return nil }
func (f *fakeShowCreateTableDB) Close() error                                     { return nil }
func (f *fakeShowCreateTableDB) Ping() error                                      { return nil }
func (f *fakeShowCreateTableDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, nil
}
func (f *fakeShowCreateTableDB) Exec(query string) (int64, error) { return 0, nil }
func (f *fakeShowCreateTableDB) GetDatabases() ([]string, error)  { return nil, nil }
func (f *fakeShowCreateTableDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}
func (f *fakeShowCreateTableDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return f.createStatement, f.createErr
}
func (f *fakeShowCreateTableDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return f.columns, f.columnsErr
}
func (f *fakeShowCreateTableDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *fakeShowCreateTableDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *fakeShowCreateTableDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *fakeShowCreateTableDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func (f *fakeManagedTransactionFinisher) Exec(query string) (int64, error) {
	return f.ExecContext(context.Background(), query)
}

func (f *fakeManagedTransactionFinisher) ExecContext(ctx context.Context, query string) (int64, error) {
	f.execQueries = append(f.execQueries, query)
	if f.execErr != nil {
		return 0, f.execErr
	}
	return 1, nil
}

func (f *fakeManagedTransactionFinisher) Close() error {
	f.closeCalls++
	return f.closeErr
}

func (f *fakeManagedTransactionFinisher) Commit() error {
	f.commitCalls++
	return f.commitErr
}

func (f *fakeManagedTransactionFinisher) Rollback() error {
	f.rollbackCalls++
	return f.rollbackErr
}

var _ db.Database = (*fakeShowCreateTableDB)(nil)
var _ db.TransactionExecer = (*fakeManagedTransactionFinisher)(nil)

type fakeManagedExecOnlyDB struct {
	*fakeShowCreateTableDB
	session *fakeManagedTransactionFinisher
}

func (f *fakeManagedExecOnlyDB) OpenSessionExecer(ctx context.Context) (db.StatementExecer, error) {
	if f.session == nil {
		f.session = &fakeManagedTransactionFinisher{}
	}
	return f.session, nil
}

var _ db.SessionExecerProvider = (*fakeManagedExecOnlyDB)(nil)

func TestMethodsDBConnectionAndMongoCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.data_source_type_required",
		"db.backend.error.clickhouse_address_required",
		"db.backend.error.mongo_member_discovery_unsupported",
		"db.backend.message.connect_success",
		"db.backend.error.test_connection_close_failed",
		"db.backend.message.release_success",
		"db.backend.message.mongo_members_discovered",
		"db.backend.error.schema_name_required",
		"db.backend.error.schema_create_unsupported",
		"db.backend.error.schema_same_name",
		"db.backend.error.schema_rename_unsupported",
		"db.backend.error.schema_drop_unsupported",
		"db.backend.error.target_database_required",
		"db.backend.message.schema_created",
		"db.backend.message.schema_renamed",
		"db.backend.message.schema_dropped",
		"db.backend.error.database_name_required",
		"db.backend.error.database_create_sphinx_unsupported",
		"db.backend.error.database_create_user_schema_unsupported",
		"db.backend.error.database_same_name",
		"db.backend.error.database_rename_direct_unsupported",
		"db.backend.error.database_rename_unsupported",
		"db.backend.error.database_drop_unsupported",
		"db.backend.message.database_created",
		"db.backend.message.database_renamed",
		"db.backend.message.database_dropped",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing DB backend connection key %q", language, key)
			}
		}
	}
}

func TestMethodsDBConnectionValidationAndReleaseUseEnglishMessages(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	missingType := app.TestConnection(connection.ConnectionConfig{})
	if missingType.Success {
		t.Fatalf("TestConnection(empty type) returned success: %+v", missingType)
	}
	if missingType.Message != "Select a data source type first" {
		t.Fatalf("expected localized missing type message, got %q", missingType.Message)
	}

	missingClickHouseAddress := app.DBConnect(connection.ConnectionConfig{Type: "clickhouse"})
	if missingClickHouseAddress.Success {
		t.Fatalf("DBConnect(clickhouse without address) returned success: %+v", missingClickHouseAddress)
	}
	if missingClickHouseAddress.Message != "Enter a ClickHouse host address or connection URI" {
		t.Fatalf("expected localized ClickHouse address message, got %q", missingClickHouseAddress.Message)
	}

	released := app.DBReleaseConnection(connection.ConnectionConfig{Type: "mysql", Host: "db.local", Port: 3306})
	if !released.Success {
		t.Fatalf("DBReleaseConnection returned failure: %+v", released)
	}
	if released.Message != "Connection released" {
		t.Fatalf("expected localized release message, got %q", released.Message)
	}
}

func TestMethodsDBConnectUsesCurrentLanguageForDriverRuntimeReason(t *testing.T) {
	tmpDir := t.TempDir()
	db.SetExternalDriverDownloadDirectory(tmpDir)
	t.Cleanup(func() {
		db.SetExternalDriverDownloadDirectory("")
	})

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = tmpDir
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	result := app.DBConnect(connection.ConnectionConfig{Type: "mariadb"})
	if result.Success {
		t.Fatalf("DBConnect(mariadb without runtime support) returned success: %+v", result)
	}

	if !db.IsOptionalGoDriverBuildIncluded("mariadb") {
		want := "MariaDB is not included in the current slim build. Install the Full edition to use this driver."
		if result.Message != want {
			t.Fatalf("expected localized slim-build message %q, got %q", want, result.Message)
		}
		return
	}

	want := "MariaDB Go driver is not enabled; install and enable it in Driver Manager."
	logPath := strings.TrimSpace(logger.Path())
	if logPath != "" {
		if info, err := os.Stat(logPath); err == nil && !info.IsDir() && info.Size() > 0 {
			want += app.appText("driver_manager.backend.message.log_hint", map[string]any{"path": logPath})
		}
	}
	if result.Message != want {
		t.Fatalf("expected localized disabled-driver message %q, got %q", want, result.Message)
	}
}

func TestMethodsDBSchemaDDLUsesEnglishMessages(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	missingTargetDatabase := app.CreateSchema(connection.ConnectionConfig{Type: "postgres"}, "", "sales")
	if missingTargetDatabase.Success {
		t.Fatalf("CreateSchema without target database returned success: %+v", missingTargetDatabase)
	}
	if missingTargetDatabase.Message != "Target database is required" {
		t.Fatalf("expected localized target database message, got %q", missingTargetDatabase.Message)
	}

	missingSchemaName := app.CreateSchema(connection.ConnectionConfig{Type: "postgres", Database: "tenant"}, "", " ")
	if missingSchemaName.Success {
		t.Fatalf("CreateSchema without schema name returned success: %+v", missingSchemaName)
	}
	if missingSchemaName.Message != "Schema name is required" {
		t.Fatalf("expected localized schema name message, got %q", missingSchemaName.Message)
	}

	sameSchemaName := app.RenameSchema(connection.ConnectionConfig{Type: "postgres", Database: "tenant"}, "", "sales", "sales")
	if sameSchemaName.Success {
		t.Fatalf("RenameSchema with same names returned success: %+v", sameSchemaName)
	}
	if sameSchemaName.Message != "The old and new schema names must be different" {
		t.Fatalf("expected localized same schema message, got %q", sameSchemaName.Message)
	}

	unsupportedDrop := app.DropSchema(connection.ConnectionConfig{Type: "mysql", Database: "tenant"}, "", "sales")
	if unsupportedDrop.Success {
		t.Fatalf("DropSchema for unsupported type returned success: %+v", unsupportedDrop)
	}
	if unsupportedDrop.Message != "The current data source (mysql) does not support dropping schemas from this entry point" {
		t.Fatalf("expected localized unsupported drop message, got %q", unsupportedDrop.Message)
	}
}

func TestMethodsDBDatabaseDDLUsesEnglishMessages(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	missingDatabaseName := app.CreateDatabase(connection.ConnectionConfig{Type: "mysql"}, " ")
	if missingDatabaseName.Success {
		t.Fatalf("CreateDatabase without name returned success: %+v", missingDatabaseName)
	}
	if missingDatabaseName.Message != "Database name is required" {
		t.Fatalf("expected localized database name message, got %q", missingDatabaseName.Message)
	}

	sameDatabaseName := app.RenameDatabase(connection.ConnectionConfig{Type: "postgres"}, "sales", "SALES")
	if sameDatabaseName.Success {
		t.Fatalf("RenameDatabase with same names returned success: %+v", sameDatabaseName)
	}
	if sameDatabaseName.Message != "The old and new database names must be different" {
		t.Fatalf("expected localized same database message, got %q", sameDatabaseName.Message)
	}

	directRenameUnsupported := app.RenameDatabase(connection.ConnectionConfig{Type: "mysql"}, "old_db", "new_db")
	if directRenameUnsupported.Success {
		t.Fatalf("RenameDatabase for MySQL returned success: %+v", directRenameUnsupported)
	}
	if directRenameUnsupported.Message != "MySQL/MariaDB/OceanBase/StarRocks/Sphinx does not support direct database renaming. Create a new database and migrate the data instead" {
		t.Fatalf("expected localized direct rename message, got %q", directRenameUnsupported.Message)
	}

	unsupportedDrop := app.DropDatabase(connection.ConnectionConfig{Type: "oracle"}, "sales")
	if unsupportedDrop.Success {
		t.Fatalf("DropDatabase for Oracle returned success: %+v", unsupportedDrop)
	}
	if unsupportedDrop.Message != "The current data source (oracle) does not support dropping databases" {
		t.Fatalf("expected localized unsupported drop database message, got %q", unsupportedDrop.Message)
	}
}

func TestMethodsDBDatabaseDDLSuccessUsesEnglishMessages(t *testing.T) {
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

	fakeDB := &fakeCreateDatabaseDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
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

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	created := app.CreateDatabase(connection.ConnectionConfig{Type: "sqlserver"}, "sales")
	if !created.Success {
		t.Fatalf("CreateDatabase returned failure: %+v", created)
	}
	if created.Message != "Database created" {
		t.Fatalf("expected localized create success message, got %q", created.Message)
	}

	fakeDB.execQueries = nil
	renamed := app.RenameDatabase(connection.ConnectionConfig{Type: "postgres", Database: "postgres"}, "sales", "sales_2026")
	if !renamed.Success {
		t.Fatalf("RenameDatabase returned failure: %+v", renamed)
	}
	if renamed.Message != "Database renamed" {
		t.Fatalf("expected localized rename success message, got %q", renamed.Message)
	}

	fakeDB.execQueries = nil
	dropped := app.DropDatabase(connection.ConnectionConfig{Type: "mysql"}, "sales_2026")
	if !dropped.Success {
		t.Fatalf("DropDatabase returned failure: %+v", dropped)
	}
	if dropped.Message != "Database dropped" {
		t.Fatalf("expected localized drop success message, got %q", dropped.Message)
	}
}

func TestMethodsDBQueryMultiCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.multi_statement_execution_failed",
		"db.backend.error.multi_statement_previous_success",
		"db.backend.message.multi_statement_sequential_fallback",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing DBQueryMulti key %q", language, key)
			}
		}
	}
}

func TestMethodsDBQueryMultiFailureUsesEnglishMessages(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE assets SET enabled = 1"
	secondStmt := "UPDATE jobs SET enabled = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			firstStmt: 1,
		},
		execErr: map[string]error{
			secondStmt: errors.New("boom"),
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	result := app.DBQueryMulti(connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306}, "main", firstStmt+";\n"+secondStmt+";", "dbquerymulti-i18n-failure-test")
	if result.Success {
		t.Fatalf("expected DBQueryMulti failure, got success: %+v", result)
	}
	if result.Message != "Statement 2 failed: boom (1 previous statements succeeded)" {
		t.Fatalf("expected localized multi-statement failure message, got %q", result.Message)
	}
}

func TestMethodsDBQueryMultiSequentialFallbackUsesEnglishMessages(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE assets SET enabled = 1"
	secondStmt := "UPDATE jobs SET enabled = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			firstStmt:  1,
			secondStmt: 2,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	result := app.DBQueryMulti(connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306}, "main", firstStmt+";\n"+secondStmt+";", "dbquerymulti-i18n-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %+v", result)
	}
	if result.Message != "The current data source (mysql) did not use the native multi-statement result path for this execution. It was automatically split into 2 statements and executed sequentially." {
		t.Fatalf("expected localized sequential fallback message, got %q", result.Message)
	}
}

func TestMethodsDBManagedTransactionCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.transaction_id_required",
		"db.backend.error.transaction_not_found",
		"db.backend.error.transaction_commit_failed",
		"db.backend.error.transaction_rollback_failed",
		"db.backend.error.transaction_commit_close_failed",
		"db.backend.error.transaction_rollback_close_failed",
		"db.backend.message.transaction_committed",
		"db.backend.message.transaction_rolled_back",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing DB managed transaction key %q", language, key)
			}
		}
	}
}

func TestMethodsDBManagedTransactionExecutionCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.managed_transaction_unsupported",
		"db.backend.error.transaction_query_unsupported",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing DB managed transaction execution key %q", language, key)
			}
		}
	}
}

func TestMethodsDBManagedTransactionUsesEnglishMessages(t *testing.T) {
	newEnglishApp := func() *App {
		app := NewAppWithSecretStore(newFakeAppSecretStore())
		app.configDir = t.TempDir()
		app.SetLanguage(string(i18n.LanguageEnUS))
		return app
	}

	t.Run("validates empty transaction id", func(t *testing.T) {
		app := newEnglishApp()
		result := app.DBCommitTransaction(" ")
		if result.Success {
			t.Fatalf("DBCommitTransaction(empty id) returned success: %+v", result)
		}
		if result.Message != "Transaction ID is required" {
			t.Fatalf("expected localized empty transaction id message, got %q", result.Message)
		}
	})

	t.Run("returns localized missing transaction message", func(t *testing.T) {
		app := newEnglishApp()
		result := app.DBRollbackTransaction("tx-missing")
		if result.Success {
			t.Fatalf("DBRollbackTransaction(missing id) returned success: %+v", result)
		}
		if result.Message != "Transaction not found or already finished" {
			t.Fatalf("expected localized missing transaction message, got %q", result.Message)
		}
	})

	t.Run("keeps raw commit failure detail", func(t *testing.T) {
		app := newEnglishApp()
		finisher := &fakeManagedTransactionFinisher{commitErr: errors.New("deadlock detected")}
		app.sqlTransactions["tx-commit-fail"] = &managedSQLTransaction{
			id:         "tx-commit-fail",
			execer:     finisher,
			transactor: finisher,
			dbType:     "oracle",
		}

		result := app.DBCommitTransaction("tx-commit-fail")
		if result.Success {
			t.Fatalf("DBCommitTransaction(commit fail) returned success: %+v", result)
		}
		if result.Message != "Transaction commit failed: deadlock detected" {
			t.Fatalf("expected localized commit failure message, got %q", result.Message)
		}
		if finisher.commitCalls != 1 || finisher.closeCalls != 1 {
			t.Fatalf("expected one commit and one close call, got commit=%d close=%d", finisher.commitCalls, finisher.closeCalls)
		}
	})

	t.Run("keeps raw rollback failure detail", func(t *testing.T) {
		app := newEnglishApp()
		finisher := &fakeManagedTransactionFinisher{rollbackErr: errors.New("session timeout")}
		app.sqlTransactions["tx-rollback-fail"] = &managedSQLTransaction{
			id:         "tx-rollback-fail",
			execer:     finisher,
			transactor: finisher,
			dbType:     "oracle",
		}

		result := app.DBRollbackTransaction("tx-rollback-fail")
		if result.Success {
			t.Fatalf("DBRollbackTransaction(rollback fail) returned success: %+v", result)
		}
		if result.Message != "Transaction rollback failed: session timeout" {
			t.Fatalf("expected localized rollback failure message, got %q", result.Message)
		}
		if finisher.rollbackCalls != 1 || finisher.closeCalls != 1 {
			t.Fatalf("expected one rollback and one close call, got rollback=%d close=%d", finisher.rollbackCalls, finisher.closeCalls)
		}
	})

	t.Run("uses localized close failure wrapper after commit", func(t *testing.T) {
		app := newEnglishApp()
		finisher := &fakeManagedTransactionFinisher{closeErr: errors.New("close failed")}
		app.sqlTransactions["tx-commit-close-fail"] = &managedSQLTransaction{
			id:         "tx-commit-close-fail",
			execer:     finisher,
			transactor: finisher,
			dbType:     "oracle",
		}

		result := app.DBCommitTransaction("tx-commit-close-fail")
		if result.Success {
			t.Fatalf("DBCommitTransaction(commit close fail) returned success: %+v", result)
		}
		if result.Message != "Transaction committed, but closing the session failed: close failed" {
			t.Fatalf("expected localized commit close failure message, got %q", result.Message)
		}
	})

	t.Run("uses localized close failure wrapper after rollback text path", func(t *testing.T) {
		app := newEnglishApp()
		finisher := &fakeManagedTransactionFinisher{closeErr: errors.New("close failed")}
		app.sqlTransactions["tx-rollback-close-fail"] = &managedSQLTransaction{
			id:          "tx-rollback-close-fail",
			execer:      finisher,
			dbType:      "oracle",
			rollbackSQL: "ROLLBACK",
		}

		result := app.DBRollbackTransaction("tx-rollback-close-fail")
		if result.Success {
			t.Fatalf("DBRollbackTransaction(rollback close fail) returned success: %+v", result)
		}
		if result.Message != "Transaction rolled back, but closing the session failed: close failed" {
			t.Fatalf("expected localized rollback close failure message, got %q", result.Message)
		}
		if len(finisher.execQueries) != 1 || finisher.execQueries[0] != "ROLLBACK" {
			t.Fatalf("expected rollback SQL execution, got %#v", finisher.execQueries)
		}
	})

	t.Run("uses localized success messages", func(t *testing.T) {
		app := newEnglishApp()
		commitFinisher := &fakeManagedTransactionFinisher{}
		app.sqlTransactions["tx-commit-success"] = &managedSQLTransaction{
			id:         "tx-commit-success",
			execer:     commitFinisher,
			transactor: commitFinisher,
			dbType:     "oracle",
		}

		commitResult := app.DBCommitTransaction("tx-commit-success")
		if !commitResult.Success {
			t.Fatalf("DBCommitTransaction(commit success) returned failure: %+v", commitResult)
		}
		if commitResult.Message != "Transaction committed" {
			t.Fatalf("expected localized commit success message, got %q", commitResult.Message)
		}

		rollbackFinisher := &fakeManagedTransactionFinisher{}
		app.sqlTransactions["tx-rollback-success"] = &managedSQLTransaction{
			id:          "tx-rollback-success",
			execer:      rollbackFinisher,
			dbType:      "oracle",
			rollbackSQL: "ROLLBACK",
		}

		rollbackResult := app.DBRollbackTransaction("tx-rollback-success")
		if !rollbackResult.Success {
			t.Fatalf("DBRollbackTransaction(rollback success) returned failure: %+v", rollbackResult)
		}
		if rollbackResult.Message != "Transaction rolled back" {
			t.Fatalf("expected localized rollback success message, got %q", rollbackResult.Message)
		}
		if len(rollbackFinisher.execQueries) != 1 || rollbackFinisher.execQueries[0] != "ROLLBACK" {
			t.Fatalf("expected rollback SQL execution, got %#v", rollbackFinisher.execQueries)
		}
	})
}

func TestMethodsDBManagedTransactionExecutionUsesEnglishMessages(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	newEnglishApp := func() *App {
		app := NewAppWithSecretStore(newFakeAppSecretStore())
		app.configDir = t.TempDir()
		app.SetLanguage(string(i18n.LanguageEnUS))
		return app
	}

	t.Run("returns localized unsupported managed transaction message", func(t *testing.T) {
		newDatabaseFunc = func(dbType string) (db.Database, error) {
			return &fakeShowCreateTableDB{}, nil
		}

		app := newEnglishApp()
		result := app.DBQueryMultiTransactional(
			connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432},
			"main",
			"UPDATE users SET enabled = 1",
			"managed-tx-unsupported-i18n-test",
		)
		if result.Success {
			t.Fatalf("expected managed transaction unsupported failure, got success: %+v", result)
		}
		if result.Message != "The current data source (postgres) does not support SQL editor managed transactions" {
			t.Fatalf("expected localized managed transaction unsupported message, got %q", result.Message)
		}
	})

	t.Run("wraps statement execution failure and keeps raw detail", func(t *testing.T) {
		firstStmt := "UPDATE assets SET enabled = 1"
		secondStmt := "UPDATE jobs SET enabled = 1"
		fakeDB := &fakeBatchWriteDB{
			execAffected: map[string]int64{
				firstStmt: 1,
			},
			execErr: map[string]error{
				secondStmt: errors.New("boom"),
			},
		}
		newDatabaseFunc = func(dbType string) (db.Database, error) {
			return fakeDB, nil
		}

		app := newEnglishApp()
		result := app.DBQueryMultiTransactional(
			connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432},
			"main",
			firstStmt+";\n"+secondStmt+";",
			"managed-tx-exec-failure-i18n-test",
		)
		if result.Success {
			t.Fatalf("expected managed transaction execution failure, got success: %+v", result)
		}
		if result.Message != "Statement 2 failed: boom" {
			t.Fatalf("expected localized managed transaction execution failure message, got %q", result.Message)
		}
		if fakeDB.session == nil || !fakeDB.session.closed {
			t.Fatal("expected failed managed transaction session to close")
		}
	})

	t.Run("localizes rollback failure after statement error", func(t *testing.T) {
		firstStmt := "UPDATE assets SET enabled = 1"
		secondStmt := "UPDATE jobs SET enabled = 1"
		fakeDB := &fakeBatchWriteDB{
			execAffected: map[string]int64{
				firstStmt: 1,
			},
			execErr: map[string]error{
				secondStmt: errors.New("boom"),
				"ROLLBACK": errors.New("rollback refused"),
			},
		}
		newDatabaseFunc = func(dbType string) (db.Database, error) {
			return fakeDB, nil
		}

		app := newEnglishApp()
		result := app.DBQueryMultiTransactional(
			connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432},
			"main",
			firstStmt+";\n"+secondStmt+";",
			"managed-tx-rollback-failure-i18n-test",
		)
		if result.Success {
			t.Fatalf("expected managed transaction rollback failure, got success: %+v", result)
		}
		if result.Message != "Statement 2 failed: boom; Transaction rollback failed: rollback refused" {
			t.Fatalf("expected localized rollback failure wrapper message, got %q", result.Message)
		}
	})

	t.Run("wraps unsupported query session message", func(t *testing.T) {
		writeStmt := "UPDATE assets SET enabled = 1"
		readStmt := "SELECT 1"
		fakeDB := &fakeManagedExecOnlyDB{
			fakeShowCreateTableDB: &fakeShowCreateTableDB{},
			session:               &fakeManagedTransactionFinisher{},
		}
		newDatabaseFunc = func(dbType string) (db.Database, error) {
			return fakeDB, nil
		}

		app := newEnglishApp()
		result := app.DBQueryMultiTransactional(
			connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432},
			"main",
			writeStmt+";\n"+readStmt+";",
			"managed-tx-query-unsupported-i18n-test",
		)
		if result.Success {
			t.Fatalf("expected managed transaction query unsupported failure, got success: %+v", result)
		}
		if result.Message != "Statement 2 failed: The current transaction session does not support query statements" {
			t.Fatalf("expected localized transaction query unsupported message, got %q", result.Message)
		}
		if fakeDB.session.closeCalls != 1 {
			t.Fatalf("expected managed exec-only session to close once, got %d", fakeDB.session.closeCalls)
		}
	})
}

func TestMethodsDBTableDDLCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.table_name_required",
		"db.backend.error.table_columns_missing_for_ddl",
		"db.backend.error.table_columns_empty_for_ddl",
		"db.backend.error.table_same_name",
		"db.backend.error.table_new_name_no_qualifier",
		"db.backend.error.table_rename_unsupported",
		"db.backend.error.old_table_name_required",
		"db.backend.error.table_drop_unsupported",
		"db.backend.message.table_renamed",
		"db.backend.message.table_dropped",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing DB table key %q", language, key)
			}
		}
	}
}

func TestMethodsDBTableDDLUsesEnglishMessages(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	missingTableName := app.RenameTable(connection.ConnectionConfig{Type: "postgres"}, "tenant", " ", "orders_next")
	if missingTableName.Success {
		t.Fatalf("RenameTable without old name returned success: %+v", missingTableName)
	}
	if missingTableName.Message != "Table name is required" {
		t.Fatalf("expected localized table name message, got %q", missingTableName.Message)
	}

	sameTableName := app.RenameTable(connection.ConnectionConfig{Type: "postgres"}, "tenant", "orders", "ORDERS")
	if sameTableName.Success {
		t.Fatalf("RenameTable with same names returned success: %+v", sameTableName)
	}
	if sameTableName.Message != "The old and new table names must be different" {
		t.Fatalf("expected localized same table name message, got %q", sameTableName.Message)
	}

	qualifiedNewTable := app.RenameTable(connection.ConnectionConfig{Type: "postgres"}, "tenant", "orders", "public.orders_next")
	if qualifiedNewTable.Success {
		t.Fatalf("RenameTable with qualified new name returned success: %+v", qualifiedNewTable)
	}
	if qualifiedNewTable.Message != "The new table name must not include a schema or database prefix" {
		t.Fatalf("expected localized table qualifier message, got %q", qualifiedNewTable.Message)
	}

	unsupportedRename := app.RenameTable(connection.ConnectionConfig{Type: "redis"}, "tenant", "orders", "orders_next")
	if unsupportedRename.Success {
		t.Fatalf("RenameTable for redis returned success: %+v", unsupportedRename)
	}
	if unsupportedRename.Message != "The current data source (redis) does not support renaming tables" {
		t.Fatalf("expected localized unsupported rename table message, got %q", unsupportedRename.Message)
	}

	missingDropTableName := app.DropTable(connection.ConnectionConfig{Type: "postgres"}, "tenant", " ")
	if missingDropTableName.Success {
		t.Fatalf("DropTable without name returned success: %+v", missingDropTableName)
	}
	if missingDropTableName.Message != "Table name is required" {
		t.Fatalf("expected localized drop table name message, got %q", missingDropTableName.Message)
	}

	unsupportedDrop := app.DropTable(connection.ConnectionConfig{Type: "redis"}, "tenant", "orders")
	if unsupportedDrop.Success {
		t.Fatalf("DropTable for redis returned success: %+v", unsupportedDrop)
	}
	if unsupportedDrop.Message != "The current data source (redis) does not support dropping tables" {
		t.Fatalf("expected localized unsupported drop table message, got %q", unsupportedDrop.Message)
	}
}

func TestMethodsDBTableDDLSuccessUsesEnglishMessages(t *testing.T) {
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

	fakeDB := &fakeCreateDatabaseDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
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

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	renamed := app.RenameTable(connection.ConnectionConfig{Type: "postgres", Database: "tenant"}, "tenant", "orders", "orders_2026")
	if !renamed.Success {
		t.Fatalf("RenameTable returned failure: %+v", renamed)
	}
	if renamed.Message != "Table renamed" {
		t.Fatalf("expected localized rename table success message, got %q", renamed.Message)
	}

	fakeDB.execQueries = nil
	dropped := app.DropTable(connection.ConnectionConfig{Type: "mysql", Database: "tenant"}, "tenant", "orders_2026")
	if !dropped.Success {
		t.Fatalf("DropTable returned failure: %+v", dropped)
	}
	if dropped.Message != "Table dropped" {
		t.Fatalf("expected localized drop table success message, got %q", dropped.Message)
	}
}

func TestMethodsDBShowCreateTableFallbackUsesEnglishMessages(t *testing.T) {
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

	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}
	driverRuntimeSupportStatusFunc = func(driverType string) (bool, string) {
		return true, ""
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		return nil
	}

	t.Run("missing column definitions", func(t *testing.T) {
		newDatabaseFunc = func(dbType string) (db.Database, error) {
			return &fakeShowCreateTableDB{
				createStatement: "",
				columns:         nil,
			}, nil
		}

		app := NewAppWithSecretStore(newFakeAppSecretStore())
		app.configDir = t.TempDir()
		app.SetLanguage(string(i18n.LanguageEnUS))

		baseConfig := connection.ConnectionConfig{
			Type:     "postgres",
			Host:     "127.0.0.1",
			Port:     5432,
			Database: "tenant",
		}

		result := app.DBShowCreateTable(baseConfig, "tenant", "orders")
		if result.Success {
			t.Fatalf("DBShowCreateTable returned success: %+v", result)
		}
		if result.Message != "No column definitions were retrieved, so the CREATE TABLE statement could not be generated" {
			t.Fatalf("expected localized missing columns message, got %q", result.Message)
		}
	})

	t.Run("empty column definitions", func(t *testing.T) {
		newDatabaseFunc = func(dbType string) (db.Database, error) {
			return &fakeShowCreateTableDB{
				createStatement: "",
				columns: []connection.ColumnDefinition{
					{Name: "   ", Type: "text"},
				},
			}, nil
		}

		app := NewAppWithSecretStore(newFakeAppSecretStore())
		app.configDir = t.TempDir()
		app.SetLanguage(string(i18n.LanguageEnUS))

		baseConfig := connection.ConnectionConfig{
			Type:     "postgres",
			Host:     "127.0.0.2",
			Port:     5432,
			Database: "tenant",
		}

		result := app.DBShowCreateTable(baseConfig, "tenant", "orders")
		if result.Success {
			t.Fatalf("DBShowCreateTable returned success: %+v", result)
		}
		if result.Message != "The retrieved column definitions were empty, so the CREATE TABLE statement could not be generated" {
			t.Fatalf("expected localized empty columns message, got %q", result.Message)
		}
	})
}

func TestMethodsDBViewDDLCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.view_name_required",
		"db.backend.error.view_drop_unsupported",
		"db.backend.error.view_same_name",
		"db.backend.error.view_new_name_no_qualifier",
		"db.backend.error.old_view_name_required",
		"db.backend.error.view_rename_unsupported",
		"db.backend.message.view_dropped",
		"db.backend.message.view_renamed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing DB view key %q", language, key)
			}
		}
	}
}

func TestMethodsDBViewDDLUsesEnglishMessages(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	missingViewName := app.DropView(connection.ConnectionConfig{Type: "postgres"}, "tenant", " ")
	if missingViewName.Success {
		t.Fatalf("DropView without name returned success: %+v", missingViewName)
	}
	if missingViewName.Message != "View name is required" {
		t.Fatalf("expected localized view name message, got %q", missingViewName.Message)
	}

	unsupportedDrop := app.DropView(connection.ConnectionConfig{Type: "redis"}, "tenant", "active_users")
	if unsupportedDrop.Success {
		t.Fatalf("DropView for redis returned success: %+v", unsupportedDrop)
	}
	if unsupportedDrop.Message != "The current data source (redis) does not support dropping views" {
		t.Fatalf("expected localized unsupported drop view message, got %q", unsupportedDrop.Message)
	}

	sameViewName := app.RenameView(connection.ConnectionConfig{Type: "postgres"}, "tenant", "active_users", "ACTIVE_USERS")
	if sameViewName.Success {
		t.Fatalf("RenameView with same names returned success: %+v", sameViewName)
	}
	if sameViewName.Message != "The old and new view names must be different" {
		t.Fatalf("expected localized same view name message, got %q", sameViewName.Message)
	}

	qualifiedNewView := app.RenameView(connection.ConnectionConfig{Type: "postgres"}, "tenant", "active_users", "public.active_users_next")
	if qualifiedNewView.Success {
		t.Fatalf("RenameView with qualified new name returned success: %+v", qualifiedNewView)
	}
	if qualifiedNewView.Message != "The new view name must not include a schema or database prefix" {
		t.Fatalf("expected localized view qualifier message, got %q", qualifiedNewView.Message)
	}

	missingOldViewName := app.RenameView(connection.ConnectionConfig{Type: "postgres"}, "tenant", "public.", "active_users_next")
	if missingOldViewName.Success {
		t.Fatalf("RenameView with empty normalized old name returned success: %+v", missingOldViewName)
	}
	if missingOldViewName.Message != "Old view name is required" {
		t.Fatalf("expected localized old view name message, got %q", missingOldViewName.Message)
	}

	unsupportedRename := app.RenameView(connection.ConnectionConfig{Type: "redis"}, "tenant", "active_users", "active_users_next")
	if unsupportedRename.Success {
		t.Fatalf("RenameView for redis returned success: %+v", unsupportedRename)
	}
	if unsupportedRename.Message != "The current data source (redis) does not support renaming views" {
		t.Fatalf("expected localized unsupported rename view message, got %q", unsupportedRename.Message)
	}
}

func TestMethodsDBViewDDLSuccessUsesEnglishMessages(t *testing.T) {
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

	fakeDB := &fakeCreateDatabaseDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
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

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	renamed := app.RenameView(connection.ConnectionConfig{Type: "postgres", Database: "tenant"}, "tenant", "active_users", "active_users_2026")
	if !renamed.Success {
		t.Fatalf("RenameView returned failure: %+v", renamed)
	}
	if renamed.Message != "View renamed" {
		t.Fatalf("expected localized rename view success message, got %q", renamed.Message)
	}

	fakeDB.execQueries = nil
	dropped := app.DropView(connection.ConnectionConfig{Type: "mysql", Database: "tenant"}, "tenant", "active_users_2026")
	if !dropped.Success {
		t.Fatalf("DropView returned failure: %+v", dropped)
	}
	if dropped.Message != "View dropped" {
		t.Fatalf("expected localized drop view success message, got %q", dropped.Message)
	}
}

func TestMethodsDBRoutineDDLCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.routine_name_required",
		"db.backend.error.routine_drop_unsupported",
		"db.backend.error.duckdb_procedure_drop_unsupported",
		"db.backend.message.function_dropped",
		"db.backend.message.procedure_dropped",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing DB routine key %q", language, key)
			}
		}
	}
}

func TestMethodsDBRoutineDDLUsesEnglishMessages(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	missingRoutineName := app.DropFunction(connection.ConnectionConfig{Type: "postgres"}, "tenant", " ", "FUNCTION")
	if missingRoutineName.Success {
		t.Fatalf("DropFunction without name returned success: %+v", missingRoutineName)
	}
	if missingRoutineName.Message != "Function or procedure name is required" {
		t.Fatalf("expected localized routine name message, got %q", missingRoutineName.Message)
	}

	unsupportedDrop := app.DropFunction(connection.ConnectionConfig{Type: "redis"}, "tenant", "refresh_cache", "FUNCTION")
	if unsupportedDrop.Success {
		t.Fatalf("DropFunction for redis returned success: %+v", unsupportedDrop)
	}
	if unsupportedDrop.Message != "The current data source (redis) does not support dropping functions or procedures" {
		t.Fatalf("expected localized unsupported routine drop message, got %q", unsupportedDrop.Message)
	}

	duckdbProcedure := app.DropFunction(connection.ConnectionConfig{Type: "duckdb"}, "tenant", "refresh_cache", "PROCEDURE")
	if duckdbProcedure.Success {
		t.Fatalf("DropFunction for DuckDB procedure returned success: %+v", duckdbProcedure)
	}
	if duckdbProcedure.Message != "DuckDB does not support stored procedures yet" {
		t.Fatalf("expected localized DuckDB procedure message, got %q", duckdbProcedure.Message)
	}
}

func TestMethodsDBRoutineDDLSuccessUsesEnglishMessages(t *testing.T) {
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

	fakeDB := &fakeCreateDatabaseDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
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

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	functionDropped := app.DropFunction(connection.ConnectionConfig{Type: "postgres", Database: "tenant"}, "tenant", "refresh_cache", "FUNCTION")
	if !functionDropped.Success {
		t.Fatalf("DropFunction for function returned failure: %+v", functionDropped)
	}
	if functionDropped.Message != "Function dropped" {
		t.Fatalf("expected localized function drop success message, got %q", functionDropped.Message)
	}

	fakeDB.execQueries = nil
	procedureDropped := app.DropFunction(connection.ConnectionConfig{Type: "mysql", Database: "tenant"}, "tenant", "refresh_cache", "PROCEDURE")
	if !procedureDropped.Success {
		t.Fatalf("DropFunction for procedure returned failure: %+v", procedureDropped)
	}
	if procedureDropped.Message != "Stored procedure dropped" {
		t.Fatalf("expected localized procedure drop success message, got %q", procedureDropped.Message)
	}
}
