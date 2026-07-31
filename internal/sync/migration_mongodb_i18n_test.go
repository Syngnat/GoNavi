package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
	"errors"
	"strings"
	"testing"
)

type tableErrorMigrationDB struct {
	fakeMigrationDB
	getTablesErr error
}

func (f *tableErrorMigrationDB) GetTables(dbName string) ([]string, error) {
	if f.getTablesErr != nil {
		return nil, f.getTablesErr
	}
	return f.fakeMigrationDB.GetTables(dbName)
}

var _ db.Database = (*tableErrorMigrationDB)(nil)

func baseTabularToMongoI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mongodb", Database: "archive"},
	}
}

func baseMongoToMongoI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mongodb", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mongodb", Database: "archive"},
	}
}

func baseMongoToMySQLI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mongodb", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "archive"},
	}
}

func assertNoLegacyMongoMigrationChinese(t *testing.T, text string) {
	t.Helper()

	legacyFragments := []string{
		"\u83b7\u53d6\u6e90\u8868\u5b57\u6bb5\u5931\u8d25",
		"\u6e90\u8868\u4e0d\u5b58\u5728\u6216\u65e0\u5217\u5b9a\u4e49",
		"\u68c0\u67e5\u76ee\u6807\u96c6\u5408\u5931\u8d25",
		"\u6e90\u96c6\u5408\u672a\u63a8\u65ad\u51fa\u53ef\u8fc1\u79fb\u5b57\u6bb5",
		"\u83b7\u53d6\u76ee\u6807\u8868\u5b57\u6bb5\u5931\u8d25",
		"\u8bfb\u53d6\u6e90\u96c6\u5408\u6837\u672c\u5931\u8d25",
	}
	for _, fragment := range legacyFragments {
		if strings.Contains(text, fragment) {
			t.Fatalf("expected no legacy Mongo migration Chinese fragment %q in %q", fragment, text)
		}
	}
}


func TestMongoMigrationCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"data_sync.backend.error.source_table_columns_failed",
		"data_sync.backend.error.source_table_missing_or_no_columns",
		"data_sync.backend.error.target_collection_check_failed",
		"data_sync.backend.error.source_collection_no_migratable_fields",
		"data_sync.backend.error.target_table_columns_failed",
		"data_sync.backend.error.mongo_read_source_samples_failed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing Mongo migration key %q", language, key)
			}
		}
	}
}

func TestMongoMigrationUsesCurrentLanguageForStructuredErrors(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	tableName := "users"
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceMongoQuery := `{"find":"users","filter":{},"limit":200}`
	sourceColumnsErr := errors.New("source columns boom")
	targetCollectionErr := errors.New("target collection boom")
	targetColumnsErr := errors.New("target columns boom")
	sampleReadErr := errors.New("sample read boom")

	cases := []struct {
		name       string
		run        func() error
		wantKey    string
		wantParams map[string]any
		wantCause  error
	}{
		{
			name: "source table columns failed",
			run: func() error {
				_, _, _, err := buildTabularToMongoPlan(
					baseTabularToMongoI18nConfig(),
					tableName,
					&errorMigrationDB{getColumnsErr: sourceColumnsErr},
					&fakeMigrationDB{},
				)
				return err
			},
			wantKey: "data_sync.backend.error.source_table_columns_failed",
			wantParams: map[string]any{
				"detail": "source columns boom",
			},
			wantCause: sourceColumnsErr,
		},
		{
			name: "source table missing or no columns",
			run: func() error {
				_, _, _, err := buildTabularToMongoPlan(
					baseTabularToMongoI18nConfig(),
					tableName,
					&fakeMigrationDB{},
					&fakeMigrationDB{},
				)
				return err
			},
			wantKey: "data_sync.backend.error.source_table_missing_or_no_columns",
			wantParams: map[string]any{
				"table": tableName,
			},
		},
		{
			name: "target collection check failed",
			run: func() error {
				_, _, _, err := buildTabularToMongoPlan(
					baseTabularToMongoI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"app.users": sourceCols,
						},
					},
					&tableErrorMigrationDB{getTablesErr: targetCollectionErr},
				)
				return err
			},
			wantKey: "data_sync.backend.error.target_collection_check_failed",
			wantParams: map[string]any{
				"detail": "target collection boom",
			},
			wantCause: targetCollectionErr,
		},
		{
			name: "source collection no migratable fields",
			run: func() error {
				_, _, _, err := buildMongoToMongoPlan(
					baseMongoToMongoI18nConfig(),
					tableName,
					&fakeMigrationDB{
						queryData: map[string][]map[string]interface{}{
							sourceMongoQuery: {{}},
						},
					},
					&fakeMigrationDB{tables: map[string][]string{"archive": {}}},
				)
				return err
			},
			wantKey: "data_sync.backend.error.source_collection_no_migratable_fields",
			wantParams: map[string]any{
				"collection": tableName,
			},
		},
		{
			name: "target table columns failed",
			run: func() error {
				_, _, _, err := buildMongoToMySQLPlan(
					baseMongoToMySQLI18nConfig(),
					tableName,
					&fakeMigrationDB{
						queryData: map[string][]map[string]interface{}{
							sourceMongoQuery: {
								{"_id": "u1", "name": "Ada"},
							},
						},
					},
					&errorMigrationDB{getColumnsErr: targetColumnsErr},
				)
				return err
			},
			wantKey: "data_sync.backend.error.target_table_columns_failed",
			wantParams: map[string]any{
				"detail": "target columns boom",
			},
			wantCause: targetColumnsErr,
		},
		{
			name: "read source samples failed",
			run: func() error {
				_, _, err := inferMongoCollectionColumns(
					&errorMigrationDB{
						queryErrors: map[string]error{
							sourceMongoQuery: sampleReadErr,
						},
					},
					tableName,
				)
				return err
			},
			wantKey: "data_sync.backend.error.mongo_read_source_samples_failed",
			wantParams: map[string]any{
				"detail": "sample read boom",
			},
			wantCause: sampleReadErr,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			if err == nil {
				t.Fatalf("expected error for %s", tc.name)
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.wantKey, tc.wantParams)
			if err.Error() != want {
				t.Fatalf("expected localized Mongo migration message %q, got %q", want, err.Error())
			}
			if tc.wantCause != nil && !errors.Is(err, tc.wantCause) {
				t.Fatalf("expected Mongo migration error to wrap %v, got %v", tc.wantCause, err)
			}
			assertNoLegacyMongoMigrationChinese(t, err.Error())
		})
	}
}
