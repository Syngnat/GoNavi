package app

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/uievents"
)

func TestFormatImportSQLValue_NormalizesTimestampWithoutTimezone(t *testing.T) {
	got := formatImportSQLValue("postgres", "timestamp without time zone", "2026-01-21T18:32:26+08:00")
	if got != "'2026-01-21 18:32:26'" {
		t.Fatalf("时间字面量归一化异常，want=%q got=%q", "'2026-01-21 18:32:26'", got)
	}
}

func TestFormatImportSQLValue_LeavesTextLiteralUntouched(t *testing.T) {
	got := formatImportSQLValue("postgres", "text", "2026-01-21T18:32:26+08:00")
	if got != "'2026-01-21T18:32:26+08:00'" {
		t.Fatalf("文本字段不应被归一化，want=%q got=%q", "'2026-01-21T18:32:26+08:00'", got)
	}
}

func TestFormatImportSQLValue_MySQLHexLookingTextRemainsText(t *testing.T) {
	got := formatImportSQLValue("mysql", "varchar(32)", "0xDEADBEEF")
	if got != "'0xDEADBEEF'" {
		t.Fatalf("hex-looking text must remain quoted during import, got %q", got)
	}
}

func TestFormatImportSQLValue_PostgresBooleanColumnUsesBooleanLiteral(t *testing.T) {
	cases := []struct {
		name       string
		dbType     string
		columnType string
		value      interface{}
		want       string
	}{
		{name: "postgres bool true", dbType: "postgres", columnType: "boolean", value: true, want: "true"},
		{name: "postgres bool false", dbType: "postgres", columnType: "bool", value: false, want: "false"},
		{name: "pg catalog bool string", dbType: "postgres", columnType: "pg_catalog.bool", value: "t", want: "true"},
		{name: "highgo boolean bytes", dbType: "highgo", columnType: "boolean", value: []byte("0"), want: "false"},
		{name: "mysql keeps numeric bool", dbType: "mysql", columnType: "tinyint(1)", value: true, want: "1"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := formatImportSQLValue(tc.dbType, tc.columnType, tc.value)
			if got != tc.want {
				t.Fatalf("布尔字面量异常，want=%q got=%q", tc.want, got)
			}
		})
	}
}

func TestDumpTableSQL_PostgresBooleanBackupUsesBooleanLiterals(t *testing.T) {
	fake := &fakeExportQueryDB{
		data: []map[string]interface{}{
			{"active": true, "archived": false},
		},
		cols: []string{"active", "archived"},
		defs: []connection.ColumnDefinition{
			{Name: "active", Type: "boolean"},
			{Name: "archived", Type: "bool"},
		},
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	err := dumpTableSQL(
		context.Background(),
		writer,
		fake,
		connection.ConnectionConfig{Type: "postgres"},
		"public",
		"orders",
		false,
		true,
		map[string]string{},
	)
	if err != nil {
		t.Fatalf("dumpTableSQL 返回错误: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush 导出 SQL 失败: %v", err)
	}

	content := buf.String()
	if !strings.Contains(content, `INSERT INTO "public"."orders" ("active", "archived") VALUES (true, false);`) {
		t.Fatalf("PostgreSQL bool 备份应使用 true/false 字面量，content=%s", content)
	}
	if strings.Contains(content, "VALUES (1, 0)") {
		t.Fatalf("PostgreSQL bool 备份不应输出数字布尔值，content=%s", content)
	}
}

func TestDumpTableSQL_PostgresBackupExportIncludesEscapedTableComment(t *testing.T) {
	fake := &fakePostgresCommentExportDB{
		fakeSQLDumpExportDB: fakeSQLDumpExportDB{
			fakeExportQueryDB: fakeExportQueryDB{
				defs: []connection.ColumnDefinition{{Name: "ID", Type: "bigint", Nullable: "NO"}},
			},
			createSQL: "-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.",
		},
		tableComment: "Owner's archive\\path\n第二行",
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	err := dumpTableSQL(
		context.Background(),
		writer,
		fake,
		connection.ConnectionConfig{Type: "postgres"},
		"app",
		`"Sales.Schema"."Order.Items"`,
		true,
		true,
		map[string]string{},
	)
	if err != nil {
		t.Fatalf("dumpTableSQL returned error: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush exported SQL: %v", err)
	}

	content := buf.String()
	for _, want := range []string{
		`CREATE TABLE "Sales.Schema"."Order.Items"`,
		"COMMENT ON TABLE \"Sales.Schema\".\"Order.Items\" IS 'Owner''s archive\\path\n第二行';",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("expected PostgreSQL backup export to contain %q, got %s", want, content)
		}
	}
	if fake.tableCommentCalls != 1 || fake.commentSchema != "Sales.Schema" || fake.commentTable != `"Order.Items"` {
		t.Fatalf("unexpected table-comment metadata target: calls=%d target=%q.%q", fake.tableCommentCalls, fake.commentSchema, fake.commentTable)
	}
}

func TestDumpTableSQL_PostgresSchemaExportOmitsEmptyTableComment(t *testing.T) {
	fake := &fakePostgresCommentExportDB{
		fakeSQLDumpExportDB: fakeSQLDumpExportDB{
			fakeExportQueryDB: fakeExportQueryDB{
				defs: []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO"}},
			},
			createSQL: "-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.",
		},
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	if err := dumpTableSQL(
		context.Background(),
		writer,
		fake,
		connection.ConnectionConfig{Type: "postgres"},
		"app",
		"public.orders",
		true,
		false,
		map[string]string{},
	); err != nil {
		t.Fatalf("dumpTableSQL returned error: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush exported SQL: %v", err)
	}

	if content := buf.String(); strings.Contains(content, "COMMENT ON TABLE") {
		t.Fatalf("empty PostgreSQL table comment should not emit DDL, got %s", content)
	}
	if fake.tableCommentCalls != 1 {
		t.Fatalf("expected one table-comment metadata lookup, got %d", fake.tableCommentCalls)
	}
}

func TestResolveCreateStatementWithFallback_PostgresTableCommentUsesVisibleMetadataScope(t *testing.T) {
	fake := &fakePostgresCommentExportDB{
		fakeSQLDumpExportDB: fakeSQLDumpExportDB{
			fakeExportQueryDB: fakeExportQueryDB{
				defs: []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO"}},
			},
			createSQL: "-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP.",
		},
		tableComment: "orders comment",
	}

	ddl, err := resolveCreateStatementWithFallback(
		fake,
		connection.ConnectionConfig{Type: "postgres"},
		"app",
		"orders",
	)
	if err != nil {
		t.Fatalf("resolveCreateStatementWithFallback returned error: %v", err)
	}
	if fake.commentSchema != "" || fake.commentTable != "orders" {
		t.Fatalf("expected visible PostgreSQL metadata scope, got %q.%q", fake.commentSchema, fake.commentTable)
	}
	if !strings.Contains(ddl, `COMMENT ON TABLE "public"."orders" IS 'orders comment';`) {
		t.Fatalf("expected public-qualified DDL comment, got: %s", ddl)
	}
}

func TestBuildSQLDropIfExistsStatementKeepsDottedDelimitedTableAsOneIdentifier(t *testing.T) {
	tests := []struct {
		name   string
		config connection.ConnectionConfig
		dbName string
		object string
		want   string
	}{
		{
			name:   "postgres",
			config: connection.ConnectionConfig{Type: "postgres"},
			dbName: "app",
			object: `"order.items"`,
			want:   `DROP TABLE IF EXISTS "public"."order.items";`,
		},
		{
			name:   "mysql",
			config: connection.ConnectionConfig{Type: "mysql"},
			dbName: "app",
			object: "`order.items`",
			want:   "DROP TABLE IF EXISTS `app`.`order.items`;",
		},
		{
			name:   "sqlite",
			config: connection.ConnectionConfig{Type: "sqlite"},
			dbName: "main",
			object: "order.items",
			want:   `DROP TABLE IF EXISTS "main"."order.items";`,
		},
		{
			name:   "clickhouse",
			config: connection.ConnectionConfig{Type: "clickhouse"},
			dbName: "app",
			object: "`order.items`",
			want:   "DROP TABLE IF EXISTS `app`.`order.items`;",
		},
		{
			name:   "tdengine",
			config: connection.ConnectionConfig{Type: "tdengine"},
			dbName: "app",
			object: "`order.items`",
			want:   "DROP TABLE IF EXISTS `app`.`order.items`;",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := buildSQLDropIfExistsStatement(test.config, test.dbName, test.object, false); got != test.want {
				t.Fatalf("buildSQLDropIfExistsStatement(%q,%q) = %q, want %q", test.dbName, test.object, got, test.want)
			}
		})
	}
}

func TestDumpTableSQL_MySQLBackupBatchesRowsIntoMultiValueInsert(t *testing.T) {
	fake := &fakeValueStreamExportDB{
		streamCols: []string{"id", "name"},
		streamValues: [][]interface{}{
			{1, "alice"},
			{2, "bob"},
			{3, "carol"},
		},
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	err := dumpTableSQL(
		context.Background(),
		writer,
		fake,
		connection.ConnectionConfig{Type: "mysql"},
		"app",
		"users",
		false,
		true,
		map[string]string{},
	)
	if err != nil {
		t.Fatalf("dumpTableSQL 返回错误: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush 导出 SQL 失败: %v", err)
	}

	content := buf.String()
	if strings.Count(content, "INSERT INTO `app`.`users`") != 1 {
		t.Fatalf("MySQL 备份应合并为单条批量 INSERT，content=%s", content)
	}
	if !strings.Contains(content, "VALUES (1, 'alice'),\n(2, 'bob'),\n(3, 'carol');") {
		t.Fatalf("MySQL 批量 INSERT 内容异常，content=%s", content)
	}
}

func TestDumpTableSQL_OracleBackupBatchesRowsIntoInsertAll(t *testing.T) {
	fake := &fakeValueStreamExportDB{
		streamCols: []string{"id", "name"},
		streamValues: [][]interface{}{
			{1, "alice"},
			{2, "bob"},
		},
	}
	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)

	err := dumpTableSQL(
		context.Background(),
		writer,
		fake,
		connection.ConnectionConfig{Type: "oracle"},
		"APP",
		"USERS",
		false,
		true,
		map[string]string{},
	)
	if err != nil {
		t.Fatalf("dumpTableSQL 返回错误: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush 导出 SQL 失败: %v", err)
	}

	content := buf.String()
	if strings.Count(content, "INSERT ALL") != 1 {
		t.Fatalf("Oracle 备份应合并为单条 INSERT ALL，content=%s", content)
	}
	if !strings.Contains(content, "INTO \"APP\".\"USERS\" (\"id\", \"name\") VALUES (1, 'alice')\n  INTO \"APP\".\"USERS\" (\"id\", \"name\") VALUES (2, 'bob')\nSELECT 1 FROM DUAL;") {
		t.Fatalf("Oracle INSERT ALL 内容异常，content=%s", content)
	}
}

func TestNormalizeExportFileOptionsPreservesSQLDatabaseOptions(t *testing.T) {
	normalized := normalizeExportFileOptions("sql", ExportFileOptions{
		Format:                 " SQL ",
		IncludeDropIfExists:    true,
		IncludeDatabaseContext: true,
	})

	if normalized.Format != "sql" {
		t.Fatalf("expected normalized SQL format, got %q", normalized.Format)
	}
	if !normalized.IncludeDropIfExists {
		t.Fatal("expected IncludeDropIfExists to survive option normalization")
	}
	if !normalized.IncludeDatabaseContext {
		t.Fatal("expected IncludeDatabaseContext to survive option normalization")
	}
}

func TestWriteSQLDropIfExistsPreambleDefaultsOffAndRequiresSchemaExport(t *testing.T) {
	config := connection.ConnectionConfig{Type: "mysql"}
	objects := []string{"users"}

	for _, tc := range []struct {
		name          string
		includeSchema bool
		options       ExportFileOptions
	}{
		{name: "default off", includeSchema: true, options: ExportFileOptions{}},
		{name: "data only", includeSchema: false, options: ExportFileOptions{IncludeDropIfExists: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			writer := bufio.NewWriter(&output)
			if err := writeSQLDropIfExistsPreamble(
				writer,
				config,
				"app",
				objects,
				map[string]string{},
				tc.includeSchema,
				tc.options,
			); err != nil {
				t.Fatalf("writeSQLDropIfExistsPreamble returned error: %v", err)
			}
			if err := writer.Flush(); err != nil {
				t.Fatalf("flush drop preamble: %v", err)
			}
			if output.Len() != 0 {
				t.Fatalf("drop preamble must be omitted, got %q", output.String())
			}
		})
	}
}

func TestExportDatabaseSQLToFileDefaultOptionsDoNotEmitDropsOrDatabaseContext(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeSQLDumpExportDB{
		tables:    []string{"users"},
		createSQL: "CREATE TABLE `users` (`id` BIGINT)",
	}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}
	app := NewApp()
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306}

	legacyFile, err := os.CreateTemp(t.TempDir(), "legacy-export-*.sql")
	if err != nil {
		t.Fatalf("create legacy export file: %v", err)
	}
	legacyPath := legacyFile.Name()
	if err := legacyFile.Close(); err != nil {
		t.Fatalf("close legacy export file: %v", err)
	}
	legacyResult := app.exportDatabaseSQLToFile(context.Background(), config, "app", false, legacyPath, ExportFileOptions{})
	if !legacyResult.Success {
		t.Fatalf("legacy export failed: %+v", legacyResult)
	}
	legacyContent, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("read legacy export: %v", err)
	}
	if strings.Contains(string(legacyContent), "DROP TABLE") {
		t.Fatalf("default/legacy export must not emit DROP statements: %s", legacyContent)
	}
	if strings.Contains(string(legacyContent), "CREATE DATABASE") || strings.Contains(string(legacyContent), "USE `app`;") {
		t.Fatalf("default export must not emit database context statements: %s", legacyContent)
	}

	optInFile, err := os.CreateTemp(t.TempDir(), "drop-export-*.sql")
	if err != nil {
		t.Fatalf("create opt-in export file: %v", err)
	}
	optInPath := optInFile.Name()
	if err := optInFile.Close(); err != nil {
		t.Fatalf("close opt-in export file: %v", err)
	}
	contextFreeDropResult := app.exportDatabaseSQLToFile(
		context.Background(),
		config,
		"app",
		false,
		optInPath,
		ExportFileOptions{IncludeDropIfExists: true},
	)
	if !contextFreeDropResult.Success {
		t.Fatalf("context-free DROP export failed: %+v", contextFreeDropResult)
	}
	optInContent, err := os.ReadFile(optInPath)
	if err != nil {
		t.Fatalf("read opt-in export: %v", err)
	}
	dropIndex := strings.Index(string(optInContent), "DROP TABLE IF EXISTS `users`;")
	createIndex := strings.Index(string(optInContent), "CREATE TABLE `users`")
	if dropIndex < 0 || createIndex < 0 || dropIndex >= createIndex {
		t.Fatalf("context-free export must place unqualified DROP before CREATE: %s", optInContent)
	}
	if strings.Contains(string(optInContent), "`app`.`users`") {
		t.Fatalf("context-free export must not qualify output objects with the source database: %s", optInContent)
	}
}

func TestExportDatabaseSQLToFileDatabaseContextIsExplicitOptIn(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeSQLDumpExportDB{
		fakeExportQueryDB: fakeExportQueryDB{
			data: []map[string]interface{}{{"id": int64(1)}},
			cols: []string{"id"},
			defs: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}},
		},
		tables:    []string{"users"},
		createSQL: "CREATE TABLE `users` (`id` BIGINT)",
	}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}
	app := NewApp()
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306}

	contextFreePath := filepath.Join(t.TempDir(), "context-free.sql")
	contextFreeResult := app.exportDatabaseSQLToFile(
		context.Background(),
		config,
		"app",
		true,
		contextFreePath,
		ExportFileOptions{IncludeDropIfExists: true},
	)
	if !contextFreeResult.Success {
		t.Fatalf("context-free export failed: %+v", contextFreeResult)
	}
	contextFreeContent, err := os.ReadFile(contextFreePath)
	if err != nil {
		t.Fatalf("read context-free export: %v", err)
	}
	contextFreeSQL := string(contextFreeContent)
	for _, unexpected := range []string{
		"CREATE DATABASE",
		"USE `app`;",
		"DROP TABLE IF EXISTS `app`.`users`;",
		"INSERT INTO `app`.`users`",
	} {
		if strings.Contains(contextFreeSQL, unexpected) {
			t.Fatalf("context-free export must not contain %q: %s", unexpected, contextFreeSQL)
		}
	}
	for _, expected := range []string{
		"DROP TABLE IF EXISTS `users`;",
		"INSERT INTO `users` (`id`) VALUES (1);",
	} {
		if !strings.Contains(contextFreeSQL, expected) {
			t.Fatalf("context-free export must contain %q: %s", expected, contextFreeSQL)
		}
	}
	if !slices.Contains(fakeDB.queries, "SELECT * FROM `app`.`users`") {
		t.Fatalf("context-free output must still read from the source database, queries=%#v", fakeDB.queries)
	}

	contextPath := filepath.Join(t.TempDir(), "with-context.sql")
	contextResult := app.exportDatabaseSQLToFile(
		context.Background(),
		config,
		"app",
		true,
		contextPath,
		ExportFileOptions{
			IncludeDropIfExists:    true,
			IncludeDatabaseContext: true,
		},
	)
	if !contextResult.Success {
		t.Fatalf("database-context export failed: %+v", contextResult)
	}
	contextContent, err := os.ReadFile(contextPath)
	if err != nil {
		t.Fatalf("read database-context export: %v", err)
	}
	contextSQL := string(contextContent)
	orderedStatements := []string{
		"CREATE DATABASE IF NOT EXISTS `app`;",
		"USE `app`;",
		"DROP TABLE IF EXISTS `app`.`users`;",
		"CREATE TABLE `users`",
		"INSERT INTO `app`.`users` (`id`) VALUES (1);",
	}
	previousIndex := -1
	for _, statement := range orderedStatements {
		index := strings.Index(contextSQL, statement)
		if index < 0 || index <= previousIndex {
			t.Fatalf("database-context export statement order is invalid at %q: %s", statement, contextSQL)
		}
		previousIndex = index
	}
}

func TestExportDatabaseSQLToFileReportsObjectProgress(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeSQLDumpExportDB{
		tables:    []string{"users", "orders"},
		createSQL: "CREATE TABLE `placeholder` (`id` BIGINT)",
	}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}
	emitter := &captureExportProgressEmitter{}
	app := NewApp()
	app.ctx = uievents.WithEmitter(context.Background(), emitter)
	filePath := filepath.Join(t.TempDir(), "app_backup.sql")

	result := app.exportDatabaseSQLToFile(
		context.Background(),
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		"app",
		false,
		filePath,
		ExportFileOptions{Format: "sql", JobID: "database-backup-job"},
	)
	if !result.Success {
		t.Fatalf("database export failed: %+v", result)
	}
	if len(emitter.events) < 4 {
		t.Fatalf("expected start/running/finalizing/done events, got %#v", emitter.events)
	}
	statuses := make([]string, 0, len(emitter.events))
	for _, event := range emitter.events {
		statuses = append(statuses, event.Status)
		if event.JobID != "database-backup-job" {
			t.Fatalf("unexpected progress job id: %#v", event)
		}
		if event.FilePath != filePath {
			t.Fatalf("progress must expose selected backup path: %#v", event)
		}
	}
	for _, want := range []string{"start", "running", "finalizing", "done"} {
		if !slices.Contains(statuses, want) {
			t.Fatalf("missing %q progress status in %v", want, statuses)
		}
	}
	itemEvents := make([]exportProgressPayload, 0, 2)
	for _, event := range emitter.events {
		if event.Status == "running" && (strings.Contains(event.Stage, "users") || strings.Contains(event.Stage, "orders")) {
			itemEvents = append(itemEvents, event)
		}
	}
	if len(itemEvents) != 2 || itemEvents[0].Current != 0 || itemEvents[1].Current != 1 {
		t.Fatalf("expected one running event per object with completed-object counts, got %#v", itemEvents)
	}
	last := emitter.events[len(emitter.events)-1]
	if !last.TotalRowsKnown || last.Total != 2 || last.Current != 2 {
		t.Fatalf("done progress must report all exported objects: %#v", last)
	}
}

func TestExportDatabaseSQLToFilePreservesExistingBackupOnFailure(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeSQLDumpExportDB{
		tables:    []string{"users"},
		createErr: fmt.Errorf("forced create statement failure"),
	}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}
	directory := t.TempDir()
	filePath := filepath.Join(directory, "app_backup.sql")
	const previousBackup = "-- previous complete backup\n"
	if err := os.WriteFile(filePath, []byte(previousBackup), 0o600); err != nil {
		t.Fatalf("write previous backup: %v", err)
	}

	result := NewApp().exportDatabaseSQLToFile(
		context.Background(),
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		"app",
		false,
		filePath,
		ExportFileOptions{Format: "sql"},
	)
	if result.Success {
		t.Fatalf("expected export failure, got %+v", result)
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("read preserved backup: %v", err)
	}
	if string(content) != previousBackup {
		t.Fatalf("failed export must preserve previous backup, got %q", content)
	}
	temporaryFiles, err := filepath.Glob(filepath.Join(directory, ".gonavi-export-*.part"))
	if err != nil {
		t.Fatalf("glob temporary export files: %v", err)
	}
	if len(temporaryFiles) != 0 {
		t.Fatalf("failed export must remove temporary files, got %v", temporaryFiles)
	}
}

func TestWriteSQLDropIfExistsPreambleReversesCreateOrderAndDistinguishesViews(t *testing.T) {
	config := connection.ConnectionConfig{Type: "mysql"}
	objects := []string{"accounts", "orders", "active_orders"}
	viewLookup := map[string]string{
		normalizeExportObjectKey(config, "app", "active_orders"): "active_orders",
	}
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)

	if err := writeSQLDropIfExistsPreamble(
		writer,
		config,
		"app",
		objects,
		viewLookup,
		true,
		ExportFileOptions{IncludeDropIfExists: true},
	); err != nil {
		t.Fatalf("writeSQLDropIfExistsPreamble returned error: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush drop preamble: %v", err)
	}

	content := output.String()
	wantStatements := []string{
		"DROP VIEW IF EXISTS `app`.`active_orders`;",
		"DROP TABLE IF EXISTS `app`.`orders`;",
		"DROP TABLE IF EXISTS `app`.`accounts`;",
	}
	previousIndex := -1
	for _, statement := range wantStatements {
		index := strings.Index(content, statement)
		if index < 0 {
			t.Fatalf("drop preamble is missing %q: %s", statement, content)
		}
		if index <= previousIndex {
			t.Fatalf("drop statements do not follow reverse create order: %s", content)
		}
		previousIndex = index
	}
}

func TestBuildSQLDropIfExistsStatementKeepsOracleBackwardCompatible(t *testing.T) {
	statement := buildSQLDropIfExistsStatement(
		connection.ConnectionConfig{Type: "oracle"},
		"APP",
		"USERS",
		false,
	)

	for _, fragment := range []string{
		`EXECUTE IMMEDIATE 'DROP TABLE "APP"."USERS"'`,
		"IF SQLCODE != -942 THEN",
		"END;\n/",
	} {
		if !strings.Contains(statement, fragment) {
			t.Fatalf("Oracle drop block is missing %q: %s", fragment, statement)
		}
	}

	statements := splitSQLStatementsForDialect("oracle", statement+"\nCREATE TABLE \"APP\".\"USERS\" (\"ID\" NUMBER);")
	if len(statements) != 2 {
		t.Fatalf("Oracle drop block must remain one executable statement before CREATE, got %#v", statements)
	}
	if !strings.Contains(statements[0], `EXECUTE IMMEDIATE 'DROP TABLE "APP"."USERS"'`) {
		t.Fatalf("unexpected Oracle drop statement after splitting: %#v", statements)
	}
}

func TestBuildSQLDropIfExistsStatementUsesDropTableForClickHouseViews(t *testing.T) {
	statement := buildSQLDropIfExistsStatement(
		connection.ConnectionConfig{Type: "clickhouse"},
		"analytics",
		"events_by_hour",
		true,
	)

	if want := "DROP TABLE IF EXISTS `analytics`.`events_by_hour`;"; statement != want {
		t.Fatalf("ClickHouse view drop statement mismatch: got %q, want %q", statement, want)
	}
}

func TestWriteSQLDatabaseBackupHeaderCreatesMySQLDatabaseBeforeSelectingIt(t *testing.T) {
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)

	if err := writeSQLDatabaseBackupHeader(writer, connection.ConnectionConfig{Type: "mysql"}, "restore_target"); err != nil {
		t.Fatalf("writeSQLDatabaseBackupHeader returned error: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush header: %v", err)
	}

	content := output.String()
	createIndex := strings.Index(content, "CREATE DATABASE IF NOT EXISTS `restore_target`;")
	useIndex := strings.Index(content, "USE `restore_target`;")
	if createIndex < 0 {
		t.Fatalf("database backup header must create the source database, content=%q", content)
	}
	if useIndex < 0 || createIndex > useIndex {
		t.Fatalf("database backup header must create the database before USE, content=%q", content)
	}
}

func TestFilterExportObjectsBySchema_PostgresQualifiedObjectsOnly(t *testing.T) {
	got := filterExportObjectsBySchema(
		connection.ConnectionConfig{Type: "postgres"},
		"app_db",
		[]string{"public.users", "sales.orders", "sales.v_orders", "analytics.events"},
		"sales",
	)

	want := []string{"sales.orders", "sales.v_orders"}
	if len(got) != len(want) {
		t.Fatalf("filtered objects length mismatch, want=%d got=%d (%v)", len(want), len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("filtered objects mismatch at %d, want=%q got=%q", i, want[i], got[i])
		}
	}
}

func TestFilterExportViewLookupBySchema_PostgresQualifiedViewsOnly(t *testing.T) {
	got := filterExportViewLookupBySchema(
		connection.ConnectionConfig{Type: "postgres"},
		"app_db",
		map[string]string{
			"public.v_users":  "public.v_users",
			"sales.v_orders":  "sales.v_orders",
			"sales.v_summary": "sales.v_summary",
		},
		"sales",
	)

	if len(got) != 2 {
		t.Fatalf("filtered views length mismatch, want=2 got=%d (%v)", len(got), got)
	}
	if got["sales.v_orders"] != "sales.v_orders" {
		t.Fatalf("expected sales.v_orders to be retained, got=%q", got["sales.v_orders"])
	}
	if got["sales.v_summary"] != "sales.v_summary" {
		t.Fatalf("expected sales.v_summary to be retained, got=%q", got["sales.v_summary"])
	}
	if _, ok := got["public.v_users"]; ok {
		t.Fatalf("expected public.v_users to be filtered out, got=%v", got)
	}
}

func TestWriteSQLSchemaExportHeaderPostgresCreatesQuotedSchema(t *testing.T) {
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := writeSQLSchemaExportHeader(
		writer,
		connection.ConnectionConfig{Type: "postgres"},
		"app_db",
		`Sales"Ops`,
	); err != nil {
		t.Fatalf("write postgres schema export header: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush postgres schema export header: %v", err)
	}

	content := output.String()
	if !strings.Contains(content, `-- Schema: Sales"Ops`) {
		t.Fatalf("schema export header must describe the selected schema, content=%q", content)
	}
	if !strings.Contains(content, `CREATE SCHEMA IF NOT EXISTS "Sales""Ops";`) {
		t.Fatalf("schema export header must bootstrap the quoted schema, content=%q", content)
	}
	databaseIndex := strings.Index(content, "-- Database: app_db")
	schemaIndex := strings.Index(content, `-- Schema: Sales"Ops`)
	createIndex := strings.Index(content, `CREATE SCHEMA IF NOT EXISTS "Sales""Ops";`)
	if databaseIndex < 0 || schemaIndex < databaseIndex || createIndex < schemaIndex {
		t.Fatalf("schema bootstrap must follow the database and schema metadata, content=%q", content)
	}
}

func TestWriteSQLSchemaExportHeaderDoesNotBootstrapNonPostgresSchema(t *testing.T) {
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := writeSQLSchemaExportHeader(
		writer,
		connection.ConnectionConfig{Type: "mysql"},
		"app_db",
		"sales",
	); err != nil {
		t.Fatalf("write non-postgres schema export header: %v", err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatalf("flush non-postgres schema export header: %v", err)
	}

	if strings.Contains(output.String(), "CREATE SCHEMA") {
		t.Fatalf("non-postgres schema export must not inject postgres bootstrap SQL, content=%q", output.String())
	}
}
