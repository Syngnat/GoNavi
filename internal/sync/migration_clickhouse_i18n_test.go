package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
	"errors"
	"strings"
	"testing"
)

func baseMySQLToClickHouseI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig: connection.ConnectionConfig{Type: "clickhouse", Database: "analytics"},
	}
}

func basePGLikeToClickHouseI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "postgres", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "clickhouse", Database: "analytics"},
	}
}

func baseClickHouseToMySQLI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "clickhouse", Database: "analytics"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "shop"},
	}
}

func baseClickHouseToPGLikeI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "clickhouse", Database: "analytics"},
		TargetConfig: connection.ConnectionConfig{Type: "kingbase", Database: "app"},
	}
}

func baseClickHouseToClickHouseI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "clickhouse", Database: "analytics"},
		TargetConfig: connection.ConnectionConfig{Type: "clickhouse", Database: "warehouse"},
	}
}

func assertNoLegacyClickHouseMigrationChinese(t *testing.T, text string) {
	t.Helper()

	legacyFragments := []string{
		"\u83b7\u53d6\u6e90\u8868\u5b57\u6bb5\u5931\u8d25",
		"\u6e90\u8868\u4e0d\u5b58\u5728\u6216\u65e0\u5217\u5b9a\u4e49",
		"\u83b7\u53d6\u76ee\u6807\u8868\u5b57\u6bb5\u5931\u8d25",
	}
	for _, fragment := range legacyFragments {
		if strings.Contains(text, fragment) {
			t.Fatalf("expected no legacy ClickHouse migration Chinese fragment %q in %q", fragment, text)
		}
	}
}


func TestClickHouseMigrationCatalogKeysExist(t *testing.T) {
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
				t.Fatalf("%s catalog missing ClickHouse migration key %q", language, key)
			}
		}
	}
}

func TestClickHouseMigrationUsesCurrentLanguageForStructuredErrors(t *testing.T) {
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
	clickHouseSourceCols := []connection.ColumnDefinition{
		{Name: "event_time", Type: "DateTime64(3)", Nullable: "NO"},
		{Name: "user_id", Type: "UInt64", Nullable: "NO"},
	}

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
				_, _, _, err := buildMySQLToClickHousePlan(
					baseMySQLToClickHouseI18nConfig(),
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
				_, _, _, err := buildPGLikeToClickHousePlan(
					basePGLikeToClickHouseI18nConfig(),
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
			name: "target table columns failed mysql to clickhouse",
			run: func() error {
				_, _, _, err := buildMySQLToClickHousePlan(
					baseMySQLToClickHouseI18nConfig(),
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
 			name: "target table columns failed pglike to clickhouse",
 			run: func() error {
 				_, _, _, err := buildPGLikeToClickHousePlan(
 					basePGLikeToClickHouseI18nConfig(),
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
			name: "target table columns failed clickhouse to mysql",
			run: func() error {
				_, _, _, err := buildClickHouseToMySQLPlan(
					baseClickHouseToMySQLI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"analytics.orders": clickHouseSourceCols,
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
			name: "target table columns failed clickhouse to pglike",
			run: func() error {
				_, _, _, err := buildClickHouseToPGLikePlan(
					baseClickHouseToPGLikeI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"analytics.orders": clickHouseSourceCols,
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
			name: "target table columns failed clickhouse to clickhouse",
			run: func() error {
				_, _, _, err := buildClickHouseToClickHousePlan(
					baseClickHouseToClickHouseI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"analytics.orders": clickHouseSourceCols,
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
				t.Fatalf("expected localized ClickHouse migration message %q, got %q", want, err.Error())
			}
			if tc.wantCause != nil && !errors.Is(err, tc.wantCause) {
				t.Fatalf("expected ClickHouse migration error to wrap %v, got %v", tc.wantCause, err)
			}
			assertNoLegacyClickHouseMigrationChinese(t, err.Error())
		})
	}
}
