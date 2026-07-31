package app

import (
	"context"
	"strings"
	"testing"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

func methodsExplainFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("methods source missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

type fakeExplainDatabase struct {
	explainRaw    string
	explainFormat connection.ExplainFormat
}

func (db *fakeExplainDatabase) Connect(config connection.ConnectionConfig) error { return nil }
func (db *fakeExplainDatabase) Close() error                                     { return nil }
func (db *fakeExplainDatabase) Ping() error                                      { return nil }
func (db *fakeExplainDatabase) Query(query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, nil
}
func (db *fakeExplainDatabase) Exec(query string) (int64, error) { return 0, nil }
func (db *fakeExplainDatabase) GetDatabases() ([]string, error)  { return nil, nil }
func (db *fakeExplainDatabase) GetTables(dbName string) ([]string, error) {
	return nil, nil
}
func (db *fakeExplainDatabase) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (db *fakeExplainDatabase) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (db *fakeExplainDatabase) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (db *fakeExplainDatabase) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (db *fakeExplainDatabase) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (db *fakeExplainDatabase) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}
func (db *fakeExplainDatabase) Explain(ctx context.Context, query string) (string, connection.ExplainFormat, error) {
	return db.explainRaw, db.explainFormat, nil
}


func TestMethodsExplainAndQueryHistoryCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"sql_analysis.backend.error.query_required",
		"sql_analysis.backend.error.select_only",
		"sql_analysis.backend.error.unsupported_db_type",
		"sql_analysis.backend.message.completed",
		"query_history.backend.error.connection_fingerprint_invalid",
		"query_history.backend.message.loaded",
		"query_history.backend.message.cleared",
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing explain/query-history key %q", language, key)
			}
		}
	}
}

func TestDiagnoseQueryUsesCurrentLanguageForValidationAndSuccessMessages(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	}()

	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &fakeExplainDatabase{
			explainRaw: "id\tparent\tnotused\tdetail\n2\t0\t0\tSCAN TABLE users\n",
			explainFormat: connection.ExplainFormatTable,
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}
	driverRuntimeSupportStatusFunc = func(string) (bool, string) {
		return true, ""
	}
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error {
		return nil
	}

	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	app.configDir = t.TempDir()
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageEnUS))
	})

	empty := app.DiagnoseQuery(connection.ConnectionConfig{}, "", "   ")
	if expected := app.appText("sql_analysis.backend.error.query_required", nil); empty.Message != expected {
		t.Fatalf("expected localized empty-query message %q, got %q", expected, empty.Message)
	}
	if strings.Contains(empty.Message, "查询语句不能为空") {
		t.Fatalf("expected no raw Chinese empty-query message, got %q", empty.Message)
	}

	nonSelect := app.DiagnoseQuery(connection.ConnectionConfig{}, "", "update users set active = 1")
	if expected := app.appText("sql_analysis.backend.error.select_only", nil); nonSelect.Message != expected {
		t.Fatalf("expected localized non-select message %q, got %q", expected, nonSelect.Message)
	}

	for _, unsafeQuery := range []string{
		"WITH removed AS (DELETE FROM users RETURNING id) SELECT * FROM removed",
		"SELECT 1; DELETE FROM users",
	} {
		result := app.DiagnoseQuery(connection.ConnectionConfig{Type: "postgres"}, "", unsafeQuery)
		if expected := app.appText("sql_analysis.backend.error.select_only", nil); result.Message != expected {
			t.Fatalf("expected unsafe query %q to be rejected with %q, got %q", unsafeQuery, expected, result.Message)
		}
	}

	unsupported := app.DiagnoseQuery(connection.ConnectionConfig{Type: "redis", Host: "127.0.0.1"}, "", "select 1")
	if expected := app.appText("sql_analysis.backend.error.unsupported_db_type", map[string]any{"dbType": "redis"}); unsupported.Message != expected {
		t.Fatalf("expected localized unsupported-db message %q, got %q", expected, unsupported.Message)
	}

	success := app.DiagnoseQuery(connection.ConnectionConfig{Type: "sqlite", Database: ":memory:"}, "", "select 1")
	if !success.Success {
		t.Fatalf("expected DiagnoseQuery success, got %+v", success)
	}
	if expected := app.appText("sql_analysis.backend.message.completed", nil); success.Message != expected {
		t.Fatalf("expected localized diagnose success message %q, got %q", expected, success.Message)
	}
}

func TestQueryHistoryUsesCurrentLanguageForMessages(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	app.configDir = t.TempDir()
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageEnUS))
	})

	invalid := connection.ConnectionConfig{}
	loadedInvalid := app.GetSlowQueries(invalid, "", "recent", 20)
	if expected := app.appText("query_history.backend.error.connection_fingerprint_invalid", nil); loadedInvalid.Message != expected {
		t.Fatalf("expected localized invalid-fingerprint load message %q, got %q", expected, loadedInvalid.Message)
	}
	clearedInvalid := app.ClearSlowQueries(invalid, "")
	if expected := app.appText("query_history.backend.error.connection_fingerprint_invalid", nil); clearedInvalid.Message != expected {
		t.Fatalf("expected localized invalid-fingerprint clear message %q, got %q", expected, clearedInvalid.Message)
	}

	valid := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "app"}
	loaded := app.GetSlowQueries(valid, "analytics", "recent", 20)
	if !loaded.Success {
		t.Fatalf("expected GetSlowQueries success, got %+v", loaded)
	}
	if expected := app.appText("query_history.backend.message.loaded", nil); loaded.Message != expected {
		t.Fatalf("expected localized load message %q, got %q", expected, loaded.Message)
	}

	cleared := app.ClearSlowQueries(valid, "analytics")
	if !cleared.Success {
		t.Fatalf("expected ClearSlowQueries success, got %+v", cleared)
	}
	if expected := app.appText("query_history.backend.message.cleared", nil); cleared.Message != expected {
		t.Fatalf("expected localized clear message %q, got %q", expected, cleared.Message)
	}
}
