package app

import (
	"strings"
	"testing"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

type fakeOracleMetadataDB struct {
	rows   []map[string]interface{}
	fields []string
	err    error
}

func (db *fakeOracleMetadataDB) Connect(config connection.ConnectionConfig) error { return nil }
func (db *fakeOracleMetadataDB) Close() error                                     { return nil }
func (db *fakeOracleMetadataDB) Ping() error                                      { return nil }
func (db *fakeOracleMetadataDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return db.rows, db.fields, db.err
}
func (db *fakeOracleMetadataDB) Exec(query string) (int64, error) { return 0, nil }
func (db *fakeOracleMetadataDB) GetDatabases() ([]string, error)  { return nil, nil }
func (db *fakeOracleMetadataDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}
func (db *fakeOracleMetadataDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (db *fakeOracleMetadataDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (db *fakeOracleMetadataDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (db *fakeOracleMetadataDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (db *fakeOracleMetadataDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (db *fakeOracleMetadataDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}


func TestMethodsDBOracleMetadataCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		if strings.TrimSpace(catalogs[language]["db.backend.error.column_definitions_missing"]) == "" {
			t.Fatalf("%s catalog missing Oracle metadata key %q", language, "db.backend.error.column_definitions_missing")
		}
	}
}

func TestMethodsDBOracleMetadataUsesEnglishMessages(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	t.Run("dictionary fallback missing columns", func(t *testing.T) {
		_, err := inferOracleColumnsFromDictionary(&fakeOracleMetadataDB{}, "APP", "ORDERS", app.appText)
		if err == nil {
			t.Fatal("expected inferOracleColumnsFromDictionary to fail")
		}
		if got, want := err.Error(), "No column definitions were returned"; got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})

	t.Run("empty select requires table name", func(t *testing.T) {
		_, err := inferOracleColumnsFromEmptySelect(&fakeOracleMetadataDB{}, "APP", " ", app.appText)
		if err == nil {
			t.Fatal("expected inferOracleColumnsFromEmptySelect to fail")
		}
		if got, want := err.Error(), "Table name is required"; got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})

	t.Run("empty select missing fields", func(t *testing.T) {
		_, err := inferOracleColumnsFromEmptySelect(&fakeOracleMetadataDB{}, "APP", "ORDERS", app.appText)
		if err == nil {
			t.Fatal("expected inferOracleColumnsFromEmptySelect to fail")
		}
		if got, want := err.Error(), "No column definitions were returned"; got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	})
}
