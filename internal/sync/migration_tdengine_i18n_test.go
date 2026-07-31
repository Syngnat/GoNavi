package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
	"errors"
	"strings"
	"testing"
)

func baseTDengineToMySQLI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "tdengine", Database: "metrics"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
	}
}

func baseTDengineToPGLikeI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "tdengine", Database: "metrics"},
		TargetConfig: connection.ConnectionConfig{Type: "kingbase", Database: "ignored"},
	}
}

func assertNoLegacyTDengineMigrationChinese(t *testing.T, text string) {
	t.Helper()

	legacyFragments := []string{
		"\u83b7\u53d6\u6e90\u8868\u5b57\u6bb5\u5931\u8d25",
		"\u6e90\u8868\u4e0d\u5b58\u5728\u6216\u65e0\u5217\u5b9a\u4e49",
		"\u83b7\u53d6\u76ee\u6807\u8868\u5b57\u6bb5\u5931\u8d25",
	}
	for _, fragment := range legacyFragments {
		if strings.Contains(text, fragment) {
			t.Fatalf("expected no legacy TDengine migration Chinese fragment %q in %q", fragment, text)
		}
	}
}


func TestTDengineMigrationCatalogKeysExist(t *testing.T) {
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
				t.Fatalf("%s catalog missing TDengine migration key %q", language, key)
			}
		}
	}
}

func TestTDengineMigrationUsesCurrentLanguageForStructuredErrors(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	tableName := "cpu"
	sourceCols := []connection.ColumnDefinition{
		{Name: "ts", Type: "TIMESTAMP", Nullable: "NO"},
		{Name: "host", Type: "NCHAR(64)", Nullable: "YES", Key: "TAG", Extra: "TAG"},
		{Name: "usage", Type: "DOUBLE", Nullable: "YES"},
	}
	sourceColumnsErr := errors.New("source columns boom")
	targetColumnsErr := errors.New("target columns boom")

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
				_, _, _, err := buildTDengineToMySQLPlan(
					baseTDengineToMySQLI18nConfig(),
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
				_, _, _, err := buildTDengineToMySQLPlan(
					baseTDengineToMySQLI18nConfig(),
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
			name: "target table columns failed mysql",
			run: func() error {
				_, _, _, err := buildTDengineToMySQLPlan(
					baseTDengineToMySQLI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"metrics.cpu": sourceCols,
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
			name: "target table columns failed pglike",
			run: func() error {
				_, _, _, err := buildTDengineToPGLikePlan(
					baseTDengineToPGLikeI18nConfig(),
					tableName,
					&fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"metrics.cpu": sourceCols,
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
				t.Fatalf("expected localized TDengine migration message %q, got %q", want, err.Error())
			}
			if tc.wantCause != nil && !errors.Is(err, tc.wantCause) {
				t.Fatalf("expected TDengine migration error to wrap %v, got %v", tc.wantCause, err)
			}
			assertNoLegacyTDengineMigrationChinese(t, err.Error())
		})
	}
}
