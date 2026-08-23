package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
	"errors"
	"strings"
	"testing"
)

func basePreviewI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "shop"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
	}
}

func assertNoLegacyPreviewChinese(t *testing.T, text string) {
	t.Helper()

	legacyFragments := []string{
		"\u521d\u59cb\u5316\u6e90\u6570\u636e\u5e93\u9a71\u52a8\u5931\u8d25",
		"\u521d\u59cb\u5316\u76ee\u6807\u6570\u636e\u5e93\u9a71\u52a8\u5931\u8d25",
		"\u6e90\u6570\u636e\u5e93\u8fde\u63a5\u5931\u8d25",
		"\u76ee\u6807\u6570\u636e\u5e93\u8fde\u63a5\u5931\u8d25",
		"\u76ee\u6807\u8868\u4e0d\u5b58\u5728\uff0c\u65e0\u6cd5\u9884\u89c8\u5dee\u5f02",
		"\u65e0\u4e3b\u952e\uff0c\u4e0d\u652f\u6301\u6570\u636e\u9884\u89c8",
		"\u590d\u5408\u4e3b\u952e",
	}
	for _, fragment := range legacyFragments {
		if strings.Contains(text, fragment) {
			t.Fatalf("expected no legacy preview Chinese fragment %q in %q", fragment, text)
		}
	}
}

func TestPreviewCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"data_sync.backend.error.init_source_driver_failed",
		"data_sync.backend.error.init_target_driver_failed",
		"data_sync.backend.error.connect_source_failed",
		"data_sync.backend.error.connect_target_failed",
		"data_sync.plan.target_missing_preview_unavailable",
		"data_sync.backend.error.preview_pk_required",
		"data_sync.backend.error.preview_composite_pk_unsupported",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing preview key %q", language, key)
			}
		}
	}
}

func TestPreviewUsesCurrentLanguageForPreflightErrors(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	tableName := "users"
	sourceDriverErr := errors.New("source driver boom")
	targetDriverErr := errors.New("target driver boom")
	sourceConnectErr := errors.New("source connect boom")
	targetConnectErr := errors.New("target connect boom")

	cases := []struct {
		name       string
		run        func(t *testing.T) error
		wantKey    string
		wantParams map[string]any
		wantCause  error
	}{
		{
			name: "init source driver failed",
			run: func(t *testing.T) error {
				useSyncDatabaseFactorySequence(t, syncDatabaseFactoryStep{err: sourceDriverErr})
				_, err := NewSyncEngine(Reporter{}).Preview(basePreviewI18nConfig(), tableName, 20)
				return err
			},
			wantKey: "data_sync.backend.error.init_source_driver_failed",
			wantParams: map[string]any{
				"detail": sourceDriverErr.Error(),
			},
			wantCause: sourceDriverErr,
		},
		{
			name: "init target driver failed",
			run: func(t *testing.T) error {
				useSyncDatabaseFactorySequence(t,
					syncDatabaseFactoryStep{db: &fakeMigrationDB{}},
					syncDatabaseFactoryStep{err: targetDriverErr},
				)
				_, err := NewSyncEngine(Reporter{}).Preview(basePreviewI18nConfig(), tableName, 20)
				return err
			},
			wantKey: "data_sync.backend.error.init_target_driver_failed",
			wantParams: map[string]any{
				"detail": targetDriverErr.Error(),
			},
			wantCause: targetDriverErr,
		},
		{
			name: "connect source failed",
			run: func(t *testing.T) error {
				useSyncDatabaseFactorySequence(t,
					syncDatabaseFactoryStep{db: &connectErrorMigrationDB{connectErr: sourceConnectErr}},
					syncDatabaseFactoryStep{db: &fakeMigrationDB{}},
				)
				_, err := NewSyncEngine(Reporter{}).Preview(basePreviewI18nConfig(), tableName, 20)
				return err
			},
			wantKey: "data_sync.backend.error.connect_source_failed",
			wantParams: map[string]any{
				"detail": sourceConnectErr.Error(),
			},
			wantCause: sourceConnectErr,
		},
		{
			name: "connect target failed",
			run: func(t *testing.T) error {
				useSyncDatabaseFactorySequence(t,
					syncDatabaseFactoryStep{db: &fakeMigrationDB{}},
					syncDatabaseFactoryStep{db: &connectErrorMigrationDB{connectErr: targetConnectErr}},
				)
				_, err := NewSyncEngine(Reporter{}).Preview(basePreviewI18nConfig(), tableName, 20)
				return err
			},
			wantKey: "data_sync.backend.error.connect_target_failed",
			wantParams: map[string]any{
				"detail": targetConnectErr.Error(),
			},
			wantCause: targetConnectErr,
		},
		{
			name: "target missing preview unavailable",
			run: func(t *testing.T) error {
				config := basePreviewI18nConfig()
				config.TargetTableStrategy = "existing_only"
				useSyncDatabaseFactorySequence(t,
					syncDatabaseFactoryStep{db: &fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"shop.users": {
								{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
							},
						},
					}},
					syncDatabaseFactoryStep{db: &fakeMigrationDB{}},
				)
				_, err := NewSyncEngine(Reporter{}).Preview(config, tableName, 20)
				return err
			},
			wantKey: "data_sync.plan.target_missing_preview_unavailable",
		},
		{
			name: "preview primary key required",
			run: func(t *testing.T) error {
				useSyncDatabaseFactorySequence(t,
					syncDatabaseFactoryStep{db: &fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"shop.users": {
								{Name: "name", Type: "varchar(64)", Nullable: "YES"},
							},
						},
					}},
					syncDatabaseFactoryStep{db: &fakeMigrationDB{
						columns: map[string][]connection.ColumnDefinition{
							"app.users": {
								{Name: "name", Type: "varchar(64)", Nullable: "YES"},
							},
						},
					}},
				)
				_, err := NewSyncEngine(Reporter{}).Preview(basePreviewI18nConfig(), tableName, 20)
				return err
			},
			wantKey: "data_sync.backend.error.preview_pk_required",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run(t)
			if err == nil {
				t.Fatalf("expected preview error for %s", tc.name)
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.wantKey, tc.wantParams)
			if err.Error() != want {
				t.Fatalf("expected localized preview error %q, got %q", want, err.Error())
			}
			if tc.wantCause != nil && !errors.Is(err, tc.wantCause) {
				t.Fatalf("expected preview error to wrap %v, got %v", tc.wantCause, err)
			}
			assertNoLegacyPreviewChinese(t, err.Error())
		})
	}
}
