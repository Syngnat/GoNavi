package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
	"errors"
	"strings"
	"testing"
)

func baseAnalyzeI18nConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"users"},
		Mode:         "insert_update",
		JobID:        "analyze-i18n-job",
	}
}

func assertNoLegacyAnalyzeChinese(t *testing.T, text string) {
	t.Helper()

	legacyFragments := []string{
		"差异分析开始",
		"分析表(",
		"差异分析完成",
		"已完成 1 张表的差异分析",
		"初始化源数据库驱动失败",
		"初始化目标数据库驱动失败",
		"源数据库连接失败",
		"目标数据库连接失败",
		"读取源表失败",
		"无主键，不支持差异对比同步",
		"复合主键（",
	}
	for _, fragment := range legacyFragments {
		if strings.Contains(text, fragment) {
			t.Fatalf("expected no legacy Analyze Chinese fragment %q in %q", fragment, text)
		}
	}
}

func TestAnalyzeCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"data_sync.progress.stage.analysis_started",
		"data_sync.progress.stage.analysis_completed",
		"data_sync.progress.stage.analyzing_table",
		"data_sync.backend.error.init_source_driver_failed",
		"data_sync.backend.error.init_target_driver_failed",
		"data_sync.backend.error.connect_source_failed",
		"data_sync.backend.error.connect_target_failed",
		"data_sync.backend.error.read_source_table_failed",
		"data_sync.backend.error.read_target_table_failed",
		"data_sync.backend.error.diff_pk_required",
		"data_sync.backend.error.diff_composite_pk_unsupported",
		"data_sync.backend.result.analyzed_tables",
		"data_sync.backend.summary.diff_completed",
		"data_sync.plan.target_missing_cannot_sync",
		"data_sync.plan.schema_changes_detected",
		"data_sync.plan.schema_only_no_data_diff",
		"data_sync.plan.target_missing_auto_create_all",
		"data_sync.plan.data_import_without_diff",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing Analyze key %q", language, key)
			}
		}
	}
}

func TestAnalyzeUsesCurrentLanguageForInitAndConnectFailures(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cases := []struct {
		name       string
		steps      []syncDatabaseFactoryStep
		wantKey    string
		wantParams map[string]any
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
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			useSyncDatabaseFactorySequence(t, tc.steps...)

			result := NewSyncEngine(Reporter{}).Analyze(baseAnalyzeI18nConfig())
			if result.Success {
				t.Fatalf("expected Analyze failure for %s, got %+v", tc.name, result)
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.wantKey, tc.wantParams)
			if result.Message != want {
				t.Fatalf("expected localized Analyze failure message %q, got %q", want, result.Message)
			}
			assertNoLegacyAnalyzeChinese(t, result.Message)
		})
	}
}

func TestAnalyzeUsesCurrentLanguageForResultAndProgressStages(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.users": cols,
		},
	}
	targetDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.users": cols,
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

	config := baseAnalyzeI18nConfig()
	config.Content = "schema"

	result := engine.Analyze(config)
	if !result.Success {
		t.Fatalf("expected Analyze success, got %+v", result)
	}

	wantResult := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.backend.result.analyzed_tables", map[string]any{
		"count": 1,
	})
	if result.Message != wantResult {
		t.Fatalf("expected localized Analyze result message %q, got %q", wantResult, result.Message)
	}
	assertNoLegacyAnalyzeChinese(t, result.Message)

	wantStages := []string{
		localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.analysis_started", nil),
		localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.analyzing_table", map[string]any{
			"current": 1,
			"total":   1,
		}),
		localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.analysis_completed", nil),
	}
	if len(stages) != len(wantStages) {
		t.Fatalf("unexpected progress stage count: got=%v want=%v", stages, wantStages)
	}
	for idx, wantStage := range wantStages {
		if stages[idx] != wantStage {
			t.Fatalf("stage[%d] = %q, want %q; all stages=%v", idx, stages[idx], wantStage, stages)
		}
		assertNoLegacyAnalyzeChinese(t, stages[idx])
	}
}

func TestAnalyzeUsesCurrentLanguageForReadAndPKMessages(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	countQuery := "SELECT COUNT(*) AS __gonavi_count__ FROM `app`.`users`"
	noPKCols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	singlePKCols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}

	cases := []struct {
		name       string
		sourceDB   db.Database
		targetDB   db.Database
		wantKey    string
		wantParams map[string]any
	}{
		{
			name: "read source table failed",
			sourceDB: &errorMigrationDB{
				fakeMigrationDB: fakeMigrationDB{
					columns: map[string][]connection.ColumnDefinition{
						"app.users": singlePKCols,
					},
				},
				queryErrors: map[string]error{
					countQuery: errors.New("source count boom"),
				},
			},
			targetDB: &fakeMigrationDB{
				columns: map[string][]connection.ColumnDefinition{
					"app.users": singlePKCols,
				},
			},
			wantKey: "data_sync.backend.error.read_source_table_failed",
			wantParams: map[string]any{
				"detail": "source count boom",
			},
		},
		{
			name: "no primary key",
			sourceDB: &fakeMigrationDB{
				columns: map[string][]connection.ColumnDefinition{
					"app.users": noPKCols,
				},
				queryData: map[string][]map[string]interface{}{
					countQuery: {
						{"__gonavi_count__": 2},
					},
				},
			},
			targetDB: &fakeMigrationDB{
				columns: map[string][]connection.ColumnDefinition{
					"app.users": noPKCols,
				},
			},
			wantKey: "data_sync.backend.error.diff_pk_required",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			useSyncDatabaseFactorySequence(t,
				syncDatabaseFactoryStep{db: tc.sourceDB},
				syncDatabaseFactoryStep{db: tc.targetDB},
			)

			result := NewSyncEngine(Reporter{}).Analyze(baseAnalyzeI18nConfig())
			if !result.Success {
				t.Fatalf("expected Analyze summary result for %s, got %+v", tc.name, result)
			}
			if len(result.Tables) != 1 {
				t.Fatalf("expected one table summary, got %d", len(result.Tables))
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.wantKey, tc.wantParams)
			if result.Tables[0].Message != want {
				t.Fatalf("expected localized Analyze table message %q, got %q", want, result.Tables[0].Message)
			}
			assertNoLegacyAnalyzeChinese(t, result.Tables[0].Message)
		})
	}
}
