package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
	"errors"
	"strings"
	"testing"
)

func baseLegacySchemaMigrationI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig: connection.ConnectionConfig{Type: "oracle", Database: "analytics"},
	}
}

func baseMySQLToMySQLSchemaMigrationI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "analytics"},
	}
}

func basePGLikeToPGLikeSchemaMigrationI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "postgres", Database: "public"},
		TargetConfig: connection.ConnectionConfig{Type: "kingbase", Database: "demo"},
	}
}

func basePGLikeToMySQLSchemaMigrationI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "postgres", Database: "public"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
	}
}

func baseMySQLToPGLikeSchemaMigrationI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig: connection.ConnectionConfig{Type: "postgres", Database: "app"},
	}
}

func assertNoLegacySchemaMigrationChinese(t *testing.T, text string) {
	t.Helper()

	legacyFragments := []string{
		"\u83b7\u53d6\u6e90\u8868\u5b57\u6bb5\u5931\u8d25",
		"\u6e90\u8868\u4e0d\u5b58\u5728\u6216\u65e0\u5217\u5b9a\u4e49",
		"\u83b7\u53d6\u76ee\u6807\u8868\u5b57\u6bb5\u5931\u8d25",
	}
	for _, fragment := range legacyFragments {
		if strings.Contains(text, fragment) {
			t.Fatalf("expected no legacy schema migration Chinese fragment %q in %q", fragment, text)
		}
	}
}


func TestSchemaMigrationCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"data_sync.backend.error.source_table_columns_failed",
		"data_sync.backend.error.source_table_missing_or_no_columns",
		"data_sync.backend.error.target_table_columns_failed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing schema migration key %q", language, key)
			}
		}
	}
}

func TestSchemaMigrationUsesCurrentLanguageForStructuredErrors(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	tableName := "orders"
	sourceColumnsErr := errors.New("source columns boom")
	targetColumnsErr := errors.New("target columns boom")
	mysqlSourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO"},
		{Name: "created_at", Type: "datetime", Nullable: "NO"},
	}
	pgSourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO"},
		{Name: "payload", Type: "jsonb", Nullable: "YES"},
	}

	cases := []struct {
		name       string
		run        func() error
		wantKey    string
		wantParams map[string]any
		wantCause  error
	}{
		{
			name: "legacy planner source table columns failed",
			run: func() error {
				_, _, _, err := buildSchemaMigrationPlanLegacy(
					baseLegacySchemaMigrationI18nConfig(),
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
			name: "legacy planner source table missing or no columns",
			run: func() error {
				_, _, _, err := buildSchemaMigrationPlanLegacy(
					baseLegacySchemaMigrationI18nConfig(),
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
			name: "legacy planner target table columns failed",
			run: func() error {
				_, _, _, err := buildSchemaMigrationPlanLegacy(
					baseLegacySchemaMigrationI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"shop.orders": mysqlSourceCols,
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
			name: "mysql to mysql source table columns failed",
			run: func() error {
				_, _, _, err := buildMySQLToMySQLPlan(
					baseMySQLToMySQLSchemaMigrationI18nConfig(),
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
			name: "mysql to mysql source table missing or no columns",
			run: func() error {
				_, _, _, err := buildMySQLToMySQLPlan(
					baseMySQLToMySQLSchemaMigrationI18nConfig(),
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
			name: "mysql to mysql target table columns failed",
			run: func() error {
				_, _, _, err := buildMySQLToMySQLPlan(
					baseMySQLToMySQLSchemaMigrationI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"shop.orders": mysqlSourceCols,
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
			name: "pglike to pglike source table columns failed",
			run: func() error {
				_, _, _, err := buildPGLikeToPGLikePlan(
					basePGLikeToPGLikeSchemaMigrationI18nConfig(),
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
			name: "pglike to pglike source table missing or no columns",
			run: func() error {
				_, _, _, err := buildPGLikeToPGLikePlan(
					basePGLikeToPGLikeSchemaMigrationI18nConfig(),
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
			name: "pglike to pglike target table columns failed",
			run: func() error {
				_, _, _, err := buildPGLikeToPGLikePlan(
					basePGLikeToPGLikeSchemaMigrationI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"public.orders": pgSourceCols,
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
			name: "pglike to mysql source table columns failed",
			run: func() error {
				_, _, _, err := buildPGLikeToMySQLPlan(
					basePGLikeToMySQLSchemaMigrationI18nConfig(),
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
			name: "pglike to mysql source table missing or no columns",
			run: func() error {
				_, _, _, err := buildPGLikeToMySQLPlan(
					basePGLikeToMySQLSchemaMigrationI18nConfig(),
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
			name: "pglike to mysql target table columns failed",
			run: func() error {
				_, _, _, err := buildPGLikeToMySQLPlan(
					basePGLikeToMySQLSchemaMigrationI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"public.orders": pgSourceCols,
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
			name: "mysql to pglike source table columns failed",
			run: func() error {
				_, _, _, err := buildMySQLToPGLikePlan(
					baseMySQLToPGLikeSchemaMigrationI18nConfig(),
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
			name: "mysql to pglike source table missing or no columns",
			run: func() error {
				_, _, _, err := buildMySQLToPGLikePlan(
					baseMySQLToPGLikeSchemaMigrationI18nConfig(),
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
			name: "mysql to pglike target table columns failed",
			run: func() error {
				_, _, _, err := buildMySQLToPGLikePlan(
					baseMySQLToPGLikeSchemaMigrationI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"shop.orders": mysqlSourceCols,
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
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			if err == nil {
				t.Fatalf("expected error for %s", tc.name)
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.wantKey, tc.wantParams)
			if err.Error() != want {
				t.Fatalf("expected localized schema migration message %q, got %q", want, err.Error())
			}
			if tc.wantCause != nil && !errors.Is(err, tc.wantCause) {
				t.Fatalf("expected schema migration error to wrap %v, got %v", tc.wantCause, err)
			}
			assertNoLegacySchemaMigrationChinese(t, err.Error())
		})
	}
}
