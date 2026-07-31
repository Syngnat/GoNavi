package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
	"errors"
	"strings"
	"testing"
)

func baseRunSyncI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app", Host: "source-host"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app", Host: "target-host"},
		Tables:       []string{"users"},
		Content:      "schema",
		Mode:         "insert_update",
		JobID:        "sync-engine-i18n-job",
	}
}


func TestSyncEngineProgressAndFailureCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"data_sync.progress.stage.sync_started",
		"data_sync.progress.stage.connecting_source",
		"data_sync.progress.stage.connecting_target",
		"data_sync.progress.stage.syncing_table",
		"data_sync.progress.stage.table_completed",
		"data_sync.progress.stage.completed",
		"data_sync.progress.stage.failed",
		"data_sync.backend.error.init_source_driver_failed",
		"data_sync.backend.error.init_target_driver_failed",
		"data_sync.backend.error.connect_source_failed",
		"data_sync.backend.error.connect_target_failed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing sync engine key %q", language, key)
			}
		}
	}
}

func TestRunSyncUsesCurrentLanguageForInitAndConnectFailures(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	wantStart := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.sync_started", nil)
	wantConnectingSource := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.connecting_source", nil)
	wantConnectingTarget := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.connecting_target", nil)
	wantFailed := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.failed", nil)

	cases := []struct {
		name       string
		steps      []syncDatabaseFactoryStep
		wantKey    string
		wantParams map[string]any
		wantStages []string
	}{
		{
			name: "init source driver failed",
			steps: []syncDatabaseFactoryStep{
				{err: errors.New("source init boom")},
			},
			wantKey: "data_sync.backend.error.init_source_driver_failed",
			wantParams: map[string]any{
				"detail": "source init boom",
			},
			wantStages: []string{wantStart, wantFailed},
		},
		{
			name: "init target driver failed",
			steps: []syncDatabaseFactoryStep{
				{db: &fakeMigrationDB{}},
				{err: errors.New("target init boom")},
			},
			wantKey: "data_sync.backend.error.init_target_driver_failed",
			wantParams: map[string]any{
				"detail": "target init boom",
			},
			wantStages: []string{wantStart, wantFailed},
		},
		{
			name: "connect source failed",
			steps: []syncDatabaseFactoryStep{
				{db: &connectErrorMigrationDB{connectErr: errors.New("source connect boom")}},
				{db: &fakeMigrationDB{}},
			},
			wantKey: "data_sync.backend.error.connect_source_failed",
			wantParams: map[string]any{
				"detail": "source connect boom",
			},
			wantStages: []string{wantStart, wantConnectingSource, wantFailed},
		},
		{
			name: "connect target failed",
			steps: []syncDatabaseFactoryStep{
				{db: &fakeMigrationDB{}},
				{db: &connectErrorMigrationDB{connectErr: errors.New("target connect boom")}},
			},
			wantKey: "data_sync.backend.error.connect_target_failed",
			wantParams: map[string]any{
				"detail": "target connect boom",
			},
			wantStages: []string{wantStart, wantConnectingSource, wantConnectingTarget, wantFailed},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			useSyncDatabaseFactorySequence(t, tc.steps...)

			var stages []string
			engine := NewSyncEngine(Reporter{
				OnProgress: func(event SyncProgressEvent) {
					stages = append(stages, event.Stage)
				},
			})

			result := engine.RunSync(baseRunSyncI18nConfig())
			if result.Success {
				t.Fatalf("expected RunSync failure for %s, got %+v", tc.name, result)
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.wantKey, tc.wantParams)
			if result.Message != want {
				t.Fatalf("expected localized RunSync failure message %q, got %q", want, result.Message)
			}
			if !strings.EqualFold(strings.TrimSpace(stages[len(stages)-1]), strings.TrimSpace(wantFailed)) {
				t.Fatalf("expected final progress stage %q, got %v", wantFailed, stages)
			}
			if len(stages) != len(tc.wantStages) {
				t.Fatalf("unexpected progress stage count: got=%v want=%v", stages, tc.wantStages)
			}
			for idx, wantStage := range tc.wantStages {
				if stages[idx] != wantStage {
					t.Fatalf("stage[%d] = %q, want %q; all stages=%v", idx, stages[idx], wantStage, stages)
				}
			}
			for _, stage := range stages {
				assertNoLegacySourceQueryChinese(t, stage)
			}
		})
	}
}

func TestRunSyncUsesCurrentLanguageForOverallProgressStages(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.users": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(255)", Nullable: "YES"},
			},
		},
	}
	targetDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.users": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(255)", Nullable: "YES"},
			},
		},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	var stages []string
	engine := NewSyncEngine(Reporter{
		OnProgress: func(event SyncProgressEvent) {
			stages = append(stages, event.Stage)
		},
	})

	result := engine.RunSync(baseRunSyncI18nConfig())
	if !result.Success {
		t.Fatalf("expected RunSync success, got %+v", result)
	}
	if result.TablesSynced != 1 {
		t.Fatalf("expected TablesSynced=1, got %+v", result)
	}

	wantStages := []string{
		localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.sync_started", nil),
		localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.connecting_source", nil),
		localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.connecting_target", nil),
		localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.syncing_table", map[string]any{"current": 1, "total": 1}),
		localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.table_completed", nil),
		localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.completed", nil),
	}
	if len(stages) != len(wantStages) {
		t.Fatalf("unexpected progress stage count: got=%v want=%v", stages, wantStages)
	}
	for idx, wantStage := range wantStages {
		if stages[idx] != wantStage {
			t.Fatalf("stage[%d] = %q, want %q; all stages=%v", idx, stages[idx], wantStage, stages)
		}
		assertNoLegacySourceQueryChinese(t, stages[idx])
	}
}
