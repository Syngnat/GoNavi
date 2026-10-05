package sync

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

func TestSourceQuerySyncCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"data_sync.backend.validation.source_query_required",
		"data_sync.backend.validation.query_mode_data_only",
		"data_sync.backend.validation.single_target_table_required",
		"data_sync.backend.validation.target_table_required",
		"data_sync.backend.error.target_pk_required_for_query_diff",
		"data_sync.backend.error.target_composite_pk_query_diff_unsupported",
		"data_sync.backend.error.load_target_columns_failed",
		"data_sync.backend.error.target_table_columns_missing",
		"data_sync.backend.error.execute_source_query_failed",
		"data_sync.backend.error.read_target_table_failed",
		"data_sync.backend.error.init_source_driver_failed",
		"data_sync.backend.error.init_target_driver_failed",
		"data_sync.backend.error.connect_source_failed",
		"data_sync.backend.error.connect_target_failed",
		"data_sync.backend.result.analyzed_target_tables",
		"data_sync.backend.summary.source_query_diff_completed",
		"data_sync.plan.source_query_preview",
		"data_sync.progress.stage.analysis_started",
		"data_sync.progress.stage.analysis_completed",
		"data_sync.progress.stage.sync_started",
		"data_sync.backend.log.source_query_sync_source",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing source query sync key %q", language, key)
			}
		}
	}
}

func TestValidateSourceQuerySyncConfigUsesCurrentLanguageForValidationErrors(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cases := []struct {
		name   string
		config SyncConfig
		key    string
		params map[string]any
	}{
		{
			name: "source query required",
			config: SyncConfig{
				SourceQuery: "   ",
				Tables:      []string{"users"},
			},
			key: "data_sync.backend.validation.source_query_required",
		},
		{
			name: "query mode data only",
			config: SyncConfig{
				SourceQuery: "SELECT id FROM active_users",
				Content:     "schema",
				Tables:      []string{"users"},
			},
			key: "data_sync.backend.validation.query_mode_data_only",
		},
		{
			name: "single target table required",
			config: SyncConfig{
				SourceQuery: "SELECT id FROM active_users",
				Tables:      []string{"users", "orders"},
			},
			key: "data_sync.backend.validation.single_target_table_required",
		},
		{
			name: "target table required",
			config: SyncConfig{
				SourceQuery: "SELECT id FROM active_users",
				Tables:      []string{"   "},
			},
			key: "data_sync.backend.validation.target_table_required",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validateSourceQuerySyncConfig(tc.config)
			if err == nil {
				t.Fatalf("expected validation error for %s", tc.name)
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.key, tc.params)
			if err.Error() != want {
				t.Fatalf("expected localized validation message %q, got %q", want, err.Error())
			}
			assertNoLegacySourceQueryChinese(t, err.Error())
		})
	}
}

func TestResolvePKColumnsUsesCurrentLanguageForQueryDiffErrors(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	t.Run("target primary key required", func(t *testing.T) {
		_, err := resolvePKColumns([]connection.ColumnDefinition{
			{Name: "id", Type: "bigint", Nullable: "NO"},
		})
		if err == nil {
			t.Fatal("expected missing primary key error")
		}

		want := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.backend.error.target_pk_required_for_query_diff", nil)
		if err.Error() != want {
			t.Fatalf("expected localized PK required message %q, got %q", want, err.Error())
		}
		assertNoLegacySourceQueryChinese(t, err.Error())
	})

	t.Run("composite primary key preserves column order", func(t *testing.T) {
		keys, err := resolvePKColumns([]connection.ColumnDefinition{
			{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
			{Name: "tenant_id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		})
		if err != nil {
			t.Fatalf("resolvePKColumns() error = %v", err)
		}
		want := []string{"id", "tenant_id"}
		if !reflect.DeepEqual(keys, want) {
			t.Fatalf("resolvePKColumns() = %#v, want %#v", keys, want)
		}
	})

	t.Run("sqlite composite primary key includes every PRI member", func(t *testing.T) {
		// Mirrors SQLite GetColumns for PRIMARY KEY(a,b): every pk>0 column is PRI.
		keys, err := resolvePKColumns([]connection.ColumnDefinition{
			{Name: "name", Type: "TEXT"},
			{Name: "a", Type: "INTEGER", Nullable: "NO", Key: "PRI"},
			{Name: "b", Type: "INTEGER", Nullable: "NO", Key: "PRI"},
		})
		if err != nil {
			t.Fatalf("resolvePKColumns() error = %v", err)
		}
		want := []string{"a", "b"}
		if !reflect.DeepEqual(keys, want) {
			t.Fatalf("resolvePKColumns() = %#v, want %#v", keys, want)
		}
	})

	t.Run("PK key alias is treated as primary", func(t *testing.T) {
		keys, err := resolvePKColumns([]connection.ColumnDefinition{
			{Name: "a", Type: "INTEGER", Key: "PK"},
			{Name: "b", Type: "INTEGER", Key: "PRI"},
		})
		if err != nil {
			t.Fatalf("resolvePKColumns() error = %v", err)
		}
		want := []string{"a", "b"}
		if !reflect.DeepEqual(keys, want) {
			t.Fatalf("resolvePKColumns() = %#v, want %#v", keys, want)
		}
	})
}

func TestLoadSourceQuerySyncContextUsesCurrentLanguageForStructuredErrors(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	baseConfig := SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  "SELECT id, name FROM active_users",
		Tables:       []string{"users"},
	}
	targetColumns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	targetType, _, _, targetQueryTable := resolveTargetQueryTable(baseConfig, "users")
	targetQuery := fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(targetType, targetQueryTable))

	t.Run("load target columns failed", func(t *testing.T) {
		loadErr := errors.New("target columns boom")
		_, err := loadSourceQuerySyncContext(
			baseConfig,
			&errorMigrationDB{},
			&errorMigrationDB{getColumnsErr: loadErr},
			false,
			false,
			false,
		)
		if err == nil {
			t.Fatal("expected target columns load error")
		}

		want := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.backend.error.load_target_columns_failed", map[string]any{
			"detail": loadErr.Error(),
		})
		if err.Error() != want {
			t.Fatalf("expected localized load target columns message %q, got %q", want, err.Error())
		}
		assertNoLegacySourceQueryChinese(t, err.Error())
	})

	t.Run("target table columns missing", func(t *testing.T) {
		_, err := loadSourceQuerySyncContext(
			baseConfig,
			&errorMigrationDB{},
			&errorMigrationDB{},
			false,
			false,
			false,
		)
		if err == nil {
			t.Fatal("expected target table columns missing error")
		}

		want := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.backend.error.target_table_columns_missing", map[string]any{
			"table": "users",
		})
		if err.Error() != want {
			t.Fatalf("expected localized missing target columns message %q, got %q", want, err.Error())
		}
		assertNoLegacySourceQueryChinese(t, err.Error())
	})

	t.Run("execute source query failed", func(t *testing.T) {
		queryErr := errors.New("source query boom")
		_, err := loadSourceQuerySyncContext(
			baseConfig,
			&errorMigrationDB{
				queryErrors: map[string]error{
					"SELECT id, name FROM active_users": queryErr,
				},
			},
			&errorMigrationDB{
				fakeMigrationDB: fakeMigrationDB{
					columns: map[string][]connection.ColumnDefinition{
						"app.users": targetColumns,
					},
				},
			},
			true,
			false,
			false,
		)
		if err == nil {
			t.Fatal("expected execute source query error")
		}

		want := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.backend.error.execute_source_query_failed", map[string]any{
			"detail": queryErr.Error(),
		})
		if err.Error() != want {
			t.Fatalf("expected localized source query execution message %q, got %q", want, err.Error())
		}
		if !errors.Is(err, queryErr) {
			t.Fatalf("expected wrapped source query error %v, got %v", queryErr, err)
		}
		assertNoLegacySourceQueryChinese(t, err.Error())
	})

	t.Run("read target table failed", func(t *testing.T) {
		queryErr := errors.New("target query boom")
		_, err := loadSourceQuerySyncContext(
			baseConfig,
			&errorMigrationDB{},
			&errorMigrationDB{
				fakeMigrationDB: fakeMigrationDB{
					columns: map[string][]connection.ColumnDefinition{
						"app.users": targetColumns,
					},
				},
				queryErrors: map[string]error{
					targetQuery: queryErr,
				},
			},
			false,
			true,
			false,
		)
		if err == nil {
			t.Fatal("expected read target table error")
		}

		want := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.backend.error.read_target_table_failed", map[string]any{
			"detail": queryErr.Error(),
		})
		if err.Error() != want {
			t.Fatalf("expected localized target table read message %q, got %q", want, err.Error())
		}
		if !errors.Is(err, queryErr) {
			t.Fatalf("expected wrapped target table error %v, got %v", queryErr, err)
		}
		assertNoLegacySourceQueryChinese(t, err.Error())
	})
}

func TestAnalyzeSourceQueryUsesCurrentLanguageForInitAndConnectFailures(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	sourceDriverErr := errors.New("source driver boom")
	targetDriverErr := errors.New("target driver boom")
	sourceConnectErr := errors.New("source connect boom")
	targetConnectErr := errors.New("target connect boom")

	cases := []struct {
		name   string
		steps  []syncDatabaseFactoryStep
		key    string
		detail error
	}{
		{
			name: "init source driver failed",
			steps: []syncDatabaseFactoryStep{
				{err: sourceDriverErr},
			},
			key:    "data_sync.backend.error.init_source_driver_failed",
			detail: sourceDriverErr,
		},
		{
			name: "init target driver failed",
			steps: []syncDatabaseFactoryStep{
				{db: &fakeMigrationDB{}},
				{err: targetDriverErr},
			},
			key:    "data_sync.backend.error.init_target_driver_failed",
			detail: targetDriverErr,
		},
		{
			name: "connect source failed",
			steps: []syncDatabaseFactoryStep{
				{db: &connectErrorMigrationDB{connectErr: sourceConnectErr}},
				{db: &fakeMigrationDB{}},
			},
			key:    "data_sync.backend.error.connect_source_failed",
			detail: sourceConnectErr,
		},
		{
			name: "connect target failed",
			steps: []syncDatabaseFactoryStep{
				{db: &fakeMigrationDB{}},
				{db: &connectErrorMigrationDB{connectErr: targetConnectErr}},
			},
			key:    "data_sync.backend.error.connect_target_failed",
			detail: targetConnectErr,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			useSyncDatabaseFactorySequence(t, tc.steps...)

			result := NewSyncEngine(Reporter{}).Analyze(baseSourceQuerySyncConfig())
			if result.Success {
				t.Fatalf("expected Analyze failure for %s, got %+v", tc.name, result)
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.key, map[string]any{
				"detail": tc.detail.Error(),
			})
			if result.Message != want {
				t.Fatalf("expected localized Analyze failure message %q, got %q", want, result.Message)
			}
			assertNoLegacySourceQueryChinese(t, result.Message)
		})
	}
}

func TestPreviewSourceQueryUsesCurrentLanguageForInitAndConnectFailures(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	sourceDriverErr := errors.New("source driver boom")
	targetDriverErr := errors.New("target driver boom")
	sourceConnectErr := errors.New("source connect boom")
	targetConnectErr := errors.New("target connect boom")

	cases := []struct {
		name   string
		steps  []syncDatabaseFactoryStep
		key    string
		detail error
	}{
		{
			name: "init source driver failed",
			steps: []syncDatabaseFactoryStep{
				{err: sourceDriverErr},
			},
			key:    "data_sync.backend.error.init_source_driver_failed",
			detail: sourceDriverErr,
		},
		{
			name: "init target driver failed",
			steps: []syncDatabaseFactoryStep{
				{db: &fakeMigrationDB{}},
				{err: targetDriverErr},
			},
			key:    "data_sync.backend.error.init_target_driver_failed",
			detail: targetDriverErr,
		},
		{
			name: "connect source failed",
			steps: []syncDatabaseFactoryStep{
				{db: &connectErrorMigrationDB{connectErr: sourceConnectErr}},
				{db: &fakeMigrationDB{}},
			},
			key:    "data_sync.backend.error.connect_source_failed",
			detail: sourceConnectErr,
		},
		{
			name: "connect target failed",
			steps: []syncDatabaseFactoryStep{
				{db: &fakeMigrationDB{}},
				{db: &connectErrorMigrationDB{connectErr: targetConnectErr}},
			},
			key:    "data_sync.backend.error.connect_target_failed",
			detail: targetConnectErr,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			useSyncDatabaseFactorySequence(t, tc.steps...)

			_, err := NewSyncEngine(Reporter{}).previewSourceQuery(baseSourceQuerySyncConfig(), 20)
			if err == nil {
				t.Fatalf("expected previewSourceQuery failure for %s", tc.name)
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.key, map[string]any{
				"detail": tc.detail.Error(),
			})
			if err.Error() != want {
				t.Fatalf("expected localized preview failure message %q, got %q", want, err.Error())
			}
			if !errors.Is(err, tc.detail) {
				t.Fatalf("expected preview error to wrap %v, got %v", tc.detail, err)
			}
			assertNoLegacySourceQueryChinese(t, err.Error())
		})
	}
}

func TestRunSourceQuerySyncUsesCurrentLanguageForInitAndConnectFailures(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	sourceDriverErr := errors.New("source driver boom")
	targetDriverErr := errors.New("target driver boom")
	sourceConnectErr := errors.New("source connect boom")
	targetConnectErr := errors.New("target connect boom")

	cases := []struct {
		name   string
		steps  []syncDatabaseFactoryStep
		key    string
		detail error
	}{
		{
			name: "init source driver failed",
			steps: []syncDatabaseFactoryStep{
				{err: sourceDriverErr},
			},
			key:    "data_sync.backend.error.init_source_driver_failed",
			detail: sourceDriverErr,
		},
		{
			name: "init target driver failed",
			steps: []syncDatabaseFactoryStep{
				{db: &fakeMigrationDB{}},
				{err: targetDriverErr},
			},
			key:    "data_sync.backend.error.init_target_driver_failed",
			detail: targetDriverErr,
		},
		{
			name: "connect source failed",
			steps: []syncDatabaseFactoryStep{
				{db: &connectErrorMigrationDB{connectErr: sourceConnectErr}},
				{db: &fakeMigrationDB{}},
			},
			key:    "data_sync.backend.error.connect_source_failed",
			detail: sourceConnectErr,
		},
		{
			name: "connect target failed",
			steps: []syncDatabaseFactoryStep{
				{db: &fakeMigrationDB{}},
				{db: &connectErrorMigrationDB{connectErr: targetConnectErr}},
			},
			key:    "data_sync.backend.error.connect_target_failed",
			detail: targetConnectErr,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			useSyncDatabaseFactorySequence(t, tc.steps...)

			result := NewSyncEngine(Reporter{}).RunSync(baseSourceQuerySyncConfig())
			if result.Success {
				t.Fatalf("expected RunSync failure for %s, got %+v", tc.name, result)
			}

			want := localizedSyncTestText(t, i18n.LanguageEnUS, tc.key, map[string]any{
				"detail": tc.detail.Error(),
			})
			if result.Message != want {
				t.Fatalf("expected localized RunSync failure message %q, got %q", want, result.Message)
			}
			assertNoLegacySourceQueryChinese(t, result.Message)
		})
	}
}

func TestAnalyzeSourceQueryUsesCurrentLanguageForResultSummaryAndProgress(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.users": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(64)", Nullable: "YES"},
			},
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ ORDER BY `id` ASC LIMIT 1000 OFFSET 0": {
				{"id": 1, "name": "Alice New"},
				{"id": 2, "name": "Bob"},
			},
			"SELECT `id` FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ WHERE `id` IN (1, 3)": {
				{"id": 1},
			},
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.users": {
					{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
					{Name: "name", Type: "varchar(64)", Nullable: "YES"},
				},
			},
			queryData: map[string][]map[string]interface{}{
				"SELECT `id`, `name` FROM `app`.`users` WHERE `id` IN (1, 2)": {
					{"id": 1, "name": "Alice Old"},
				},
				"SELECT `id` FROM `app`.`users` ORDER BY `id` ASC LIMIT 1000": {
					{"id": 1},
					{"id": 3, "name": "Carol"},
				},
			},
		},
	}

	oldFactory := newSyncDatabase
	defer func() { newSyncDatabase = oldFactory }()
	callCount := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		callCount++
		if callCount == 1 {
			return sourceDB, nil
		}
		return targetDB, nil
	}

	progressEvents := make([]SyncProgressEvent, 0, 2)
	engine := NewSyncEngine(Reporter{
		OnProgress: func(event SyncProgressEvent) {
			progressEvents = append(progressEvents, event)
		},
	})
	config := baseSourceQuerySyncConfig()
	config.JobID = "job-source-query-analyze"

	result := engine.Analyze(config)
	if !result.Success {
		t.Fatalf("Analyze returned failure: %+v", result)
	}
	if len(result.Tables) != 1 {
		t.Fatalf("expected one table summary, got %d", len(result.Tables))
	}

	wantResult := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.backend.result.analyzed_target_tables", map[string]any{
		"count": 1,
	})
	if result.Message != wantResult {
		t.Fatalf("expected localized Analyze result message %q, got %q", wantResult, result.Message)
	}
	assertNoLegacySourceQueryChinese(t, result.Message)

	wantSummary := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.backend.summary.source_query_diff_completed", nil)
	if result.Tables[0].Message != wantSummary {
		t.Fatalf("expected localized Analyze summary message %q, got %q", wantSummary, result.Tables[0].Message)
	}
	assertNoLegacySourceQueryChinese(t, result.Tables[0].Message)

	if len(progressEvents) < 2 {
		t.Fatalf("expected at least two progress events, got %d", len(progressEvents))
	}
	wantStarted := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.analysis_started", nil)
	if progressEvents[0].Stage != wantStarted {
		t.Fatalf("expected localized analysis start stage %q, got %q", wantStarted, progressEvents[0].Stage)
	}
	assertNoLegacySourceQueryChinese(t, progressEvents[0].Stage)

	wantCompleted := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.analysis_completed", nil)
	gotCompleted := progressEvents[len(progressEvents)-1].Stage
	if gotCompleted != wantCompleted {
		t.Fatalf("expected localized analysis completed stage %q, got %q", wantCompleted, gotCompleted)
	}
	assertNoLegacySourceQueryChinese(t, gotCompleted)
}

func TestPreviewSourceQueryUsesCurrentLanguageForSchemaSummary(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.users": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(64)", Nullable: "YES"},
			},
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ ORDER BY `id` ASC LIMIT 1000 OFFSET 0": {
				{"id": 1, "name": "Alice New"},
				{"id": 2, "name": "Bob"},
			},
			"SELECT `id` FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ WHERE `id` IN (1, 3)": {
				{"id": 1},
			},
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.users": {
					{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
					{Name: "name", Type: "varchar(64)", Nullable: "YES"},
				},
			},
			queryData: map[string][]map[string]interface{}{
				"SELECT `id`, `name` FROM `app`.`users` WHERE `id` IN (1, 2)": {
					{"id": 1, "name": "Alice Old"},
				},
				"SELECT `id` FROM `app`.`users` ORDER BY `id` ASC LIMIT 1000": {
					{"id": 1},
					{"id": 3, "name": "Carol"},
				},
			},
		},
	}

	oldFactory := newSyncDatabase
	defer func() { newSyncDatabase = oldFactory }()
	callCount := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		callCount++
		if callCount == 1 {
			return sourceDB, nil
		}
		return targetDB, nil
	}

	preview, err := NewSyncEngine(Reporter{}).previewSourceQuery(baseSourceQuerySyncConfig(), 20)
	if err != nil {
		t.Fatalf("previewSourceQuery returned error: %v", err)
	}

	want := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.plan.source_query_preview", nil)
	if preview.SchemaSummary != want {
		t.Fatalf("expected localized preview schema summary %q, got %q", want, preview.SchemaSummary)
	}
	assertNoLegacySourceQueryChinese(t, preview.SchemaSummary)
}

func TestPreviewSourceQueryFallbackKeepsSingleKeyDisplayAndRows(t *testing.T) {
	const sourceSQL = "SELECT id, name FROM active_users"
	sourceDB := &fakeMigrationDB{queryData: map[string][]map[string]interface{}{
		sourceSQL: {{"id": int64(1), "name": "new"}},
	}}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.users": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(64)", Nullable: "YES"},
			},
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM `app`.`users`": {{"id": int64(1), "name": "old"}},
		},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	preview, err := NewSyncEngine(Reporter{}).previewSourceQuery(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "source_db"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  sourceSQL,
		Content:      "data",
		Mode:         "insert_update",
		Mappings: []SyncObjectMapping{{
			Source:     SyncObjectRef{Name: "active_users"},
			Target:     SyncObjectRef{Schema: "app", Name: "users"},
			KeyColumns: []string{"id"},
			Columns: []SyncColumnMapping{
				{Source: "id", Target: "id"},
				{Source: "name", Target: "name"},
			},
		}},
	}, 20)
	if err != nil {
		t.Fatalf("previewSourceQuery() error = %v", err)
	}
	if len(preview.Updates) != 1 || preview.Updates[0].PK != "1" || preview.Updates[0].Source["name"] != "new" || preview.Updates[0].Target["name"] != "old" {
		t.Fatalf("preview updates = %#v", preview.Updates)
	}
}

func TestRunSourceQuerySyncUsesCurrentLanguageForStartProgressAndSourceLog(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	useSyncDatabaseFactorySequence(t, syncDatabaseFactoryStep{err: errors.New("source driver boom")})

	progressEvents := make([]SyncProgressEvent, 0, 1)
	logEvents := make([]SyncLogEvent, 0, 2)
	engine := NewSyncEngine(Reporter{
		OnProgress: func(event SyncProgressEvent) {
			progressEvents = append(progressEvents, event)
		},
		OnLog: func(event SyncLogEvent) {
			logEvents = append(logEvents, event)
		},
	})
	config := baseSourceQuerySyncConfig()
	config.JobID = "job-source-query-run"

	result := engine.RunSync(config)
	if result.Success {
		t.Fatalf("expected RunSync failure, got %+v", result)
	}

	if len(progressEvents) == 0 {
		t.Fatalf("expected sync start progress event")
	}
	wantStage := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.progress.stage.sync_started", nil)
	if progressEvents[0].Stage != wantStage {
		t.Fatalf("expected localized sync start stage %q, got %q", wantStage, progressEvents[0].Stage)
	}
	assertNoLegacySourceQueryChinese(t, progressEvents[0].Stage)

	if len(logEvents) == 0 {
		t.Fatalf("expected source query sync source log event")
	}
	wantLog := localizedSyncTestText(t, i18n.LanguageEnUS, "data_sync.backend.log.source_query_sync_source", map[string]any{
		"table": "users",
		"mode":  "insert_update",
	})
	if logEvents[0].Message != wantLog {
		t.Fatalf("expected localized source query sync log %q, got %q", wantLog, logEvents[0].Message)
	}
	assertNoLegacySourceQueryChinese(t, logEvents[0].Message)
}
