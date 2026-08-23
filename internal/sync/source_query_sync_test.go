package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestDiffRowsByKeyColumnsUsesCompleteCompositeKey(t *testing.T) {
	source := []map[string]interface{}{
		{"tenant_id": int64(1), "order_id": int64(7), "status": "paid"},
		{"tenant_id": int64(2), "order_id": int64(7), "status": "new"},
	}
	target := []map[string]interface{}{
		{"tenant_id": int64(1), "order_id": int64(7), "status": "new"},
		{"tenant_id": int64(3), "order_id": int64(7), "status": "old"},
	}
	inserts, updates, deletes, same := diffRowsByKeyColumns([]string{"tenant_id", "order_id"}, source, target)
	if len(inserts) != 1 || len(updates) != 1 || len(deletes) != 1 || same != 0 {
		t.Fatalf("unexpected composite diff: inserts=%#v updates=%#v deletes=%#v same=%d", inserts, updates, deletes, same)
	}
	if got := updates[0].Keys; len(got) != 2 || got["tenant_id"] != int64(1) || got["order_id"] != int64(7) {
		t.Fatalf("update keys = %#v, want complete composite key", got)
	}
	if got := deletes[0]; len(got) != 2 || got["tenant_id"] != int64(3) || got["order_id"] != int64(7) {
		t.Fatalf("delete keys = %#v, want complete composite key", got)
	}
}

func TestDiffRowsByKeyColumnsPreservesWhitespaceAndEmptyStrings(t *testing.T) {
	source := []map[string]interface{}{
		{"tenant_id": "", "order_id": "7", "status": "insert"},
		{"tenant_id": " tenant", "order_id": "8", "status": "left-space"},
	}
	target := []map[string]interface{}{
		{"tenant_id": "tenant", "order_id": "8", "status": "no-space"},
	}

	inserts, updates, deletes, same := diffRowsByKeyColumns([]string{"tenant_id", "order_id"}, source, target)
	if len(inserts) != 2 || len(updates) != 0 || len(deletes) != 1 || same != 0 {
		t.Fatalf("whitespace-sensitive diff: inserts=%#v updates=%#v deletes=%#v same=%d", inserts, updates, deletes, same)
	}
	if key, ok := syncRowKey(source[0], []string{"tenant_id", "order_id"}); !ok || key != `["","7"]` {
		t.Fatalf("empty-string composite key = %q, %v", key, ok)
	}
}

type fakeQuerySyncTargetDB struct {
	fakeMigrationDB
	appliedTable   string
	appliedChanges connection.ChangeSet
	appliedBatches []connection.ChangeSet
}

func (f *fakeQuerySyncTargetDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	f.appliedTable = tableName
	f.appliedChanges.Inserts = append(f.appliedChanges.Inserts, changes.Inserts...)
	f.appliedChanges.Updates = append(f.appliedChanges.Updates, changes.Updates...)
	f.appliedChanges.Deletes = append(f.appliedChanges.Deletes, changes.Deletes...)
	f.appliedBatches = append(f.appliedBatches, changes)
	return nil
}

var _ db.BatchApplier = (*fakeQuerySyncTargetDB)(nil)

type errorMigrationDB struct {
	fakeMigrationDB
	getColumnsErr error
	queryErrors   map[string]error
}

type connectErrorMigrationDB struct {
	fakeMigrationDB
	connectErr error
}

type syncDatabaseFactoryStep struct {
	db  db.Database
	err error
}

func (f *errorMigrationDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if err, ok := f.queryErrors[query]; ok {
		f.queryLog = append(f.queryLog, query)
		return nil, nil, err
	}
	return f.fakeMigrationDB.Query(query)
}

func (f *errorMigrationDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if f.getColumnsErr != nil {
		return nil, f.getColumnsErr
	}
	return f.fakeMigrationDB.GetColumns(dbName, tableName)
}

func (f *connectErrorMigrationDB) Connect(config connection.ConnectionConfig) error {
	return f.connectErr
}

func useSyncDatabaseFactorySequence(t *testing.T, steps ...syncDatabaseFactoryStep) {
	t.Helper()

	oldFactory := newSyncDatabase
	index := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		if index >= len(steps) {
			t.Fatalf("unexpected newSyncDatabase call %d for %s", index+1, dbType)
		}
		step := steps[index]
		index++
		return step.db, step.err
	}
	t.Cleanup(func() {
		newSyncDatabase = oldFactory
	})
}

func baseSourceQuerySyncConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  "SELECT id, name FROM active_users",
		Tables:       []string{"users"},
		Mode:         "insert_update",
	}
}

func localizedSyncTestText(t *testing.T, language i18n.Language, key string, params map[string]any) string {
	t.Helper()

	localizer, err := i18n.NewLocalizer(language)
	if err != nil {
		t.Fatalf("NewLocalizer(%s) error = %v", language, err)
	}
	return localizer.T(key, params)
}

func assertNoLegacySourceQueryChinese(t *testing.T, text string) {
	t.Helper()

	legacyFragments := []string{
		"源查询 SQL 不能为空",
		"SQL 结果集同步当前仅支持",
		"SQL 结果集同步要求且仅允许选择一个目标表",
		"目标表不能为空",
		"目标表无主键，不支持基于 SQL 结果集的差异分析",
		"目标表为复合主键",
		"获取目标表字段失败",
		"不存在或未读取到字段定义",
		"执行源查询失败",
		"读取目标表失败",
		"\u521d\u59cb\u5316\u6e90\u6570\u636e\u5e93\u9a71\u52a8\u5931\u8d25",
		"\u521d\u59cb\u5316\u76ee\u6807\u6570\u636e\u5e93\u9a71\u52a8\u5931\u8d25",
		"\u6e90\u6570\u636e\u5e93\u8fde\u63a5\u5931\u8d25",
		"\u76ee\u6807\u6570\u636e\u5e93\u8fde\u63a5\u5931\u8d25",
		"已完成 1 个目标表的差异分析",
		"SQL 结果集差异分析完成",
		"SQL 结果集同步预览",
		"差异分析开始",
		"差异分析完成",
		"开始同步",
		"同步来源：SQL 结果集 -> 目标表",
	}
	for _, fragment := range legacyFragments {
		if strings.Contains(text, fragment) {
			t.Fatalf("expected localized message without legacy Chinese fragment %q, got %q", fragment, text)
		}
	}
}

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

func TestAnalyze_SourceQueryUsesQueryResultAsSourceDataset(t *testing.T) {
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

	engine := NewSyncEngine(Reporter{})
	result := engine.Analyze(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"users"},
		Mode:         "insert_update",
		SourceQuery:  "SELECT id, name FROM active_users",
	})

	if !result.Success {
		t.Fatalf("Analyze 返回失败: %+v", result)
	}
	if len(result.Tables) != 1 {
		t.Fatalf("expected one table summary, got %d", len(result.Tables))
	}

	summary := result.Tables[0]
	if summary.PKColumn != "id" {
		t.Fatalf("expected PKColumn=id, got %q", summary.PKColumn)
	}
	if !summary.CanSync {
		t.Fatalf("expected summary can sync, got %+v", summary)
	}
	if summary.Inserts != 1 || summary.Updates != 1 || summary.Deletes != 1 {
		t.Fatalf("unexpected diff summary: %+v", summary)
	}
}

func TestRunSync_SourceQueryAppliesDiffAgainstTargetTable(t *testing.T) {
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

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"users"},
		Mode:         "insert_update",
		SourceQuery:  "SELECT id, name FROM active_users",
		TableOptions: map[string]TableOptions{
			"users": {Insert: true, Update: true, Delete: true},
		},
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.TablesSynced != 1 || result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("unexpected sync result: %+v", result)
	}
	if targetDB.appliedTable != "users" {
		t.Fatalf("expected applied table users, got %q", targetDB.appliedTable)
	}

	wantInserts := []map[string]interface{}{{"id": 2, "name": "Bob"}}
	if !reflect.DeepEqual(targetDB.appliedChanges.Inserts, wantInserts) {
		t.Fatalf("unexpected inserts: got=%v want=%v", targetDB.appliedChanges.Inserts, wantInserts)
	}

	wantUpdates := []connection.UpdateRow{{
		Keys:   map[string]interface{}{"id": 1},
		Values: map[string]interface{}{"name": "Alice New"},
	}}
	if !reflect.DeepEqual(targetDB.appliedChanges.Updates, wantUpdates) {
		t.Fatalf("unexpected updates: got=%v want=%v", targetDB.appliedChanges.Updates, wantUpdates)
	}

	wantDeletes := []map[string]interface{}{{"id": 3}}
	if !reflect.DeepEqual(targetDB.appliedChanges.Deletes, wantDeletes) {
		t.Fatalf("unexpected deletes: got=%v want=%v", targetDB.appliedChanges.Deletes, wantDeletes)
	}
}

func TestRunSync_SourceQueryInsertUpdateUsesPagedQueries(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
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
				"app.users": columns,
			},
			queryData: map[string][]map[string]interface{}{
				"SELECT `id`, `name` FROM `app`.`users` WHERE `id` IN (1, 2)": {
					{"id": 1, "name": "Alice Old"},
				},
				"SELECT `id` FROM `app`.`users` ORDER BY `id` ASC LIMIT 1000": {
					{"id": 1},
					{"id": 3},
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

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"users"},
		Mode:         "insert_update",
		SourceQuery:  "SELECT id, name FROM active_users",
		TableOptions: map[string]TableOptions{
			"users": {Insert: true, Update: true, Delete: true},
		},
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("unexpected sync result: %+v", result)
	}
	for _, query := range sourceDB.queryLog {
		if query == "SELECT id, name FROM active_users" {
			t.Fatalf("SQL 结果集分页同步不应全量执行原始查询，实际查询=%s", query)
		}
	}
}

func TestRunSync_BatchesLargeTableChanges(t *testing.T) {
	sourceRows := make([]map[string]interface{}, 2501)
	for i := range sourceRows {
		sourceRows[i] = map[string]interface{}{
			"id":   i + 1,
			"name": "event",
		}
	}

	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.events": columns,
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 0":    sourceRows[:1000],
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 1000": sourceRows[1000:2000],
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 2000": sourceRows[2000:],
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.events": columns,
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

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_only",
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.RowsInserted != len(sourceRows) {
		t.Fatalf("RowsInserted=%d, want %d", result.RowsInserted, len(sourceRows))
	}
	for _, query := range sourceDB.queryLog {
		if strings.HasPrefix(query, "SELECT * FROM") {
			t.Fatalf("期望分页流式导入不再全量读取源表，实际查询=%s", query)
		}
	}
	if len(targetDB.appliedBatches) != 3 {
		t.Fatalf("期望大表拆成 3 批提交，实际 %d 批", len(targetDB.appliedBatches))
	}
	wantBatchSizes := []int{1000, 1000, 501}
	for idx, want := range wantBatchSizes {
		if got := len(targetDB.appliedBatches[idx].Inserts); got != want {
			t.Fatalf("batch %d inserts=%d, want %d", idx+1, got, want)
		}
	}
}

func TestRunSync_UsesConfiguredBatchSizeForSnapshotReadAndApply(t *testing.T) {
	sourceRows := []map[string]interface{}{
		{"id": 1, "name": "one"},
		{"id": 2, "name": "two"},
		{"id": 3, "name": "three"},
		{"id": 4, "name": "four"},
		{"id": 5, "name": "five"},
	}
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"app.events": columns},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 2 OFFSET 0": sourceRows[:2],
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 2 OFFSET 2": sourceRows[2:4],
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 2 OFFSET 4": sourceRows[4:],
		},
	}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"app.events": columns}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_only",
		BatchSize:    2,
	})
	if !result.Success || result.RowsInserted != 5 {
		t.Fatalf("RunSync() = %+v, want five inserts", result)
	}
	if len(targetDB.appliedBatches) != 3 {
		t.Fatalf("applied batches = %#v, want three configured batches", targetDB.appliedBatches)
	}
	for index, want := range []int{2, 2, 1} {
		if got := len(targetDB.appliedBatches[index].Inserts); got != want {
			t.Fatalf("batch %d size = %d, want %d", index+1, got, want)
		}
	}
}

func TestRunSync_RejectsInvalidBatchSizeBeforeConnect(t *testing.T) {
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, fmt.Errorf("must not connect")
	}
	t.Cleanup(func() { newSyncDatabase = oldFactory })

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_only",
		BatchSize:    maxSyncBatchSize + 1,
	})
	if result.Success || !strings.Contains(result.Message, "不能超过 10000") {
		t.Fatalf("RunSync() = %+v, want batch-size rejection", result)
	}
	if factoryCalls != 0 {
		t.Fatalf("invalid batch opened %d connections", factoryCalls)
	}
}

func TestRunSync_SourceQueryAppliesSingleExplicitProjectionMapping(t *testing.T) {
	const sourceSQL = "SELECT external_id, raw_name, amount FROM active_accounts"
	sourceDB := &fakeMigrationDB{queryData: map[string][]map[string]interface{}{
		sourceSQL: {{
			"external_id": "7",
			"raw_name":    "  alice  ",
			"amount":      "9223372036854775808.125",
		}},
	}}
	targetColumns := []connection.ColumnDefinition{
		{Name: "user_id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "display_name", Type: "varchar(100)"},
		{Name: "amount_exact", Type: "decimal(30,3)"},
		{Name: "status", Type: "varchar(20)"},
	}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"app.people": targetColumns},
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM `app`.`people`": {{
				"user_id": int64(7), "display_name": "OLD", "amount_exact": "0", "status": "inactive",
			}},
		},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"people"},
		SourceQuery:  sourceSQL,
		Content:      "data",
		Mode:         "insert_update",
		Mappings: []SyncObjectMapping{{
			ID:         "active-query-to-people",
			Source:     SyncObjectRef{Name: "active_query"},
			Target:     SyncObjectRef{Schema: "app", Name: "people"},
			KeyColumns: []string{"external_id"},
			Columns: []SyncColumnMapping{
				{Source: "external_id", Target: "user_id", Transforms: []SyncValueTransform{{Type: "int64"}}},
				{Source: "raw_name", Target: "display_name", Transforms: []SyncValueTransform{{Type: "trim"}, {Type: "upper"}}},
				{Source: "amount", Target: "amount_exact", Transforms: []SyncValueTransform{{Type: "decimal-safe"}}},
				{Target: "status", Default: &SyncDefaultValue{ValueType: "string", Value: "active"}},
			},
		}},
	})
	if !result.Success || result.RowsInserted != 0 || result.RowsUpdated != 1 {
		t.Fatalf("RunSync() = %+v, want mapped source-query update", result)
	}
	if len(targetDB.appliedBatches) != 1 || len(targetDB.appliedBatches[0].Updates) != 1 {
		t.Fatalf("mapped source-query batches = %#v", targetDB.appliedBatches)
	}
	update := targetDB.appliedBatches[0].Updates[0]
	if update.Keys["user_id"] != int64(7) || update.Values["display_name"] != "ALICE" || fmt.Sprint(update.Values["amount_exact"]) != "9223372036854775808.125" || update.Values["status"] != "active" {
		t.Fatalf("mapped source-query update = %#v", update)
	}
	if len(sourceDB.queryLog) != 1 || sourceDB.queryLog[0] != sourceSQL {
		t.Fatalf("mapped source query must fail closed to full execution, queries=%#v", sourceDB.queryLog)
	}
}

func TestRunSync_SourceQueryMappingProjectionErrorDoesNotLeakPayload(t *testing.T) {
	const sourceSQL = "SELECT external_id FROM active_accounts"
	sourceDB := &fakeMigrationDB{queryData: map[string][]map[string]interface{}{
		sourceSQL: {{"external_id": "customer-password-raw"}},
	}}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"app.people": {{Name: "user_id", Type: "bigint", Nullable: "NO", Key: "PRI"}},
	}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  sourceSQL,
		Content:      "data",
		Mode:         "insert_update",
		Mappings: []SyncObjectMapping{{
			Source:     SyncObjectRef{Name: "active_query"},
			Target:     SyncObjectRef{Schema: "app", Name: "people"},
			KeyColumns: []string{"external_id"},
			Columns: []SyncColumnMapping{{
				Source: "external_id", Target: "user_id", Transforms: []SyncValueTransform{{Type: "int64"}},
			}},
		}},
	})
	if result.Success || !strings.Contains(result.Message, "字段投影失败") {
		t.Fatalf("RunSync() = %+v, want projection failure", result)
	}
	if strings.Contains(result.Message, "customer-password-raw") || strings.Contains(strings.Join(result.Logs, " "), "customer-password-raw") {
		t.Fatalf("projection payload leaked: result=%+v", result)
	}
}

func TestRunSync_SourceQueryMappingRejectsKeyThatDoesNotMatchTargetPK(t *testing.T) {
	sourceDB := &fakeMigrationDB{}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"app.people": {
			{Name: "user_id", Type: "bigint", Nullable: "NO", Key: "PRI"},
			{Name: "external_code", Type: "varchar(50)", Nullable: "NO"},
		},
	}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)
	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  "SELECT external_id FROM active_accounts",
		Content:      "data",
		Mode:         "insert_update",
		Mappings: []SyncObjectMapping{{
			Source:     SyncObjectRef{Name: "active_query"},
			Target:     SyncObjectRef{Schema: "app", Name: "people"},
			KeyColumns: []string{"external_id"},
			Columns:    []SyncColumnMapping{{Source: "external_id", Target: "external_code"}},
		}},
	})
	if result.Success || !strings.Contains(result.Message, "必须与目标表主键 user_id 一致") {
		t.Fatalf("RunSync() = %+v, want mapped-key rejection", result)
	}
	if len(sourceDB.queryLog) != 0 {
		t.Fatalf("invalid mapped key executed source query: %#v", sourceDB.queryLog)
	}
}

func TestRunSync_SourceQueryRejectsMultipleMappingsBeforeConnect(t *testing.T) {
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, fmt.Errorf("must not connect")
	}
	t.Cleanup(func() { newSyncDatabase = oldFactory })
	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  "SELECT id FROM active_accounts",
		Content:      "data",
		Mode:         "insert_only",
		Mappings: []SyncObjectMapping{
			{Source: SyncObjectRef{Name: "query_a"}, Target: SyncObjectRef{Name: "people"}, Columns: []SyncColumnMapping{{Source: "id", Target: "id"}}},
			{Source: SyncObjectRef{Name: "query_b"}, Target: SyncObjectRef{Name: "archive"}, Columns: []SyncColumnMapping{{Source: "id", Target: "id"}}},
		},
	})
	if result.Success || !strings.Contains(result.Message, "恰好一个对象映射") {
		t.Fatalf("RunSync() = %+v, want multiple-mapping rejection", result)
	}
	if factoryCalls != 0 {
		t.Fatalf("invalid mapping opened %d connections", factoryCalls)
	}
}

func TestRunSync_DirectImportPagingKeepsSelectedPKFilter(t *testing.T) {
	sourceRows := []map[string]interface{}{
		{"id": 1, "name": "event-1"},
		{"id": 2, "name": "event-2"},
		{"id": 3, "name": "event-3"},
	}
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.events": columns,
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 0": sourceRows,
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.events": columns,
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

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_only",
		TableOptions: map[string]TableOptions{
			"events": {
				Insert:            true,
				SelectedInsertPKs: []string{"2"},
			},
		},
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.RowsInserted != 1 {
		t.Fatalf("RowsInserted=%d, want 1", result.RowsInserted)
	}
	if len(targetDB.appliedBatches) != 1 || len(targetDB.appliedBatches[0].Inserts) != 1 {
		t.Fatalf("expected one selected insert batch, got %+v", targetDB.appliedBatches)
	}
	if got := targetDB.appliedBatches[0].Inserts[0]["id"]; got != 2 {
		t.Fatalf("selected insert id=%v, want 2", got)
	}
}

func TestRunSync_InsertUpdateDiffUsesPagedPKLookups(t *testing.T) {
	sourceRows := []map[string]interface{}{
		{"id": 1, "name": "one-new"},
		{"id": 2, "name": "two"},
		{"id": 3, "name": "three"},
	}
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.events": columns,
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 0": sourceRows,
			"SELECT `id` FROM `app`.`events` WHERE `id` IN (1, 4)": {
				{"id": 1},
			},
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.events": columns,
			},
			queryData: map[string][]map[string]interface{}{
				"SELECT `id`, `name` FROM `app`.`events` WHERE `id` IN (1, 2, 3)": {
					{"id": 1, "name": "one-old"},
					{"id": 2, "name": "two"},
				},
				"SELECT `id` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000": {
					{"id": 1},
					{"id": 4},
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

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_update",
		TableOptions: map[string]TableOptions{
			"events": {Insert: true, Update: true, Delete: true},
		},
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("unexpected sync result: %+v", result)
	}
	if len(targetDB.appliedBatches) != 2 {
		t.Fatalf("expected source diff batch and delete batch, got %d", len(targetDB.appliedBatches))
	}
	firstBatch := targetDB.appliedBatches[0]
	if !reflect.DeepEqual(firstBatch.Inserts, []map[string]interface{}{{"id": 3, "name": "three"}}) {
		t.Fatalf("unexpected inserts: %+v", firstBatch.Inserts)
	}
	wantUpdates := []connection.UpdateRow{{
		Keys:   map[string]interface{}{"id": 1},
		Values: map[string]interface{}{"name": "one-new"},
	}}
	if !reflect.DeepEqual(firstBatch.Updates, wantUpdates) {
		t.Fatalf("unexpected updates: %+v", firstBatch.Updates)
	}
	if !reflect.DeepEqual(targetDB.appliedBatches[1].Deletes, []map[string]interface{}{{"id": 4}}) {
		t.Fatalf("unexpected deletes: %+v", targetDB.appliedBatches[1].Deletes)
	}
	for _, query := range append(sourceDB.queryLog, targetDB.queryLog...) {
		if strings.HasPrefix(query, "SELECT * FROM") {
			t.Fatalf("分页差异同步不应全量读取表，实际查询=%s", query)
		}
	}
}
