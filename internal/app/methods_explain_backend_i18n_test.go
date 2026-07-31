package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

type fakeExplainErrorDatabase struct {
	explainErr error
}

func (db *fakeExplainErrorDatabase) Connect(config connection.ConnectionConfig) error { return nil }
func (db *fakeExplainErrorDatabase) Close() error                                     { return nil }
func (db *fakeExplainErrorDatabase) Ping() error                                      { return nil }
func (db *fakeExplainErrorDatabase) Query(query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, nil
}
func (db *fakeExplainErrorDatabase) Exec(query string) (int64, error) { return 0, nil }
func (db *fakeExplainErrorDatabase) GetDatabases() ([]string, error)  { return nil, nil }
func (db *fakeExplainErrorDatabase) GetTables(dbName string) ([]string, error) {
	return nil, nil
}
func (db *fakeExplainErrorDatabase) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (db *fakeExplainErrorDatabase) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (db *fakeExplainErrorDatabase) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (db *fakeExplainErrorDatabase) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (db *fakeExplainErrorDatabase) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (db *fakeExplainErrorDatabase) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}
func (db *fakeExplainErrorDatabase) Explain(ctx context.Context, query string) (string, connection.ExplainFormat, error) {
	return "", connection.ExplainFormatJSON, db.explainErr
}


func TestMethodsExplainBackendErrorCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"sql_analysis.backend.error.driver_explain_failed",
		"sql_analysis.backend.error.explain_execution_failed",
		"sql_analysis.backend.error.explain_result_missing",
		"sql_analysis.backend.error.explain_result_empty",
		"sql_analysis.backend.error.explain_dialect_unsupported",
		"sql_analysis.backend.error.explain_query_not_implemented",
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing explain backend key %q", language, key)
			}
		}
	}
}

func TestMethodsExplainBackendErrorsUseEnglishMessages(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	t.Run("driver explain failure", func(t *testing.T) {
		_, err := app.executeExplain(&fakeExplainErrorDatabase{explainErr: errors.New("driver exploded")}, connection.ConnectionConfig{}, "mysql", "select 1")
		if err == nil {
			t.Fatal("expected executeExplain to fail")
		}
		if got, want := err.Error(), "Driver EXPLAIN execution failed: driver exploded"; got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})

	t.Run("missing explain result", func(t *testing.T) {
		_, _, err := collectExplainRawWithText(nil, connection.ExplainFormatJSON, app.appText)
		if err == nil {
			t.Fatal("expected collectExplainRawWithText to fail")
		}
		if got, want := err.Error(), "No EXPLAIN result set was returned"; got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})

	t.Run("unsupported explain query generation", func(t *testing.T) {
		_, _, _, _, err := buildExplainQueryWithText("redis", "select 1", app.appText)
		if err == nil {
			t.Fatal("expected buildExplainQueryWithText to fail")
		}
		if got, want := err.Error(), "EXPLAIN query generation is not implemented for redis"; got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})
}
