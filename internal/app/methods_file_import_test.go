package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/uievents"

	"github.com/xuri/excelize/v2"
)

func TestReadImportedConnectionConfigFileRejectsOversizedFiles(t *testing.T) {
	for _, ext := range []string{connectionPackageExtension, ".json"} {
		t.Run(ext, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "connections"+ext)

			file, err := os.Create(path)
			if err != nil {
				t.Fatalf("Create returned error: %v", err)
			}
			if err := file.Truncate(connectionImportMaxFileBytes + 1); err != nil {
				file.Close()
				t.Fatalf("Truncate returned error: %v", err)
			}
			if err := file.Close(); err != nil {
				t.Fatalf("Close returned error: %v", err)
			}

			_, err = readImportedConnectionConfigFile(path)
			if !errors.Is(err, errConnectionImportFileTooLarge) {
				t.Fatalf("oversized import file should return errConnectionImportFileTooLarge, got: %v", err)
			}
		})
	}
}

func TestBuildImportPreviewCSVStreamKeepsFirstFiveRows(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "users.csv")
	var builder strings.Builder
	builder.WriteString("id,name\n")
	for i := 1; i <= 7; i++ {
		builder.WriteString(fmt.Sprintf("%d,user_%d\n", i, i))
	}
	if err := os.WriteFile(path, []byte(builder.String()), 0o600); err != nil {
		t.Fatalf("write csv: %v", err)
	}

	preview, err := buildImportPreview(path, 5)
	if err != nil {
		t.Fatalf("buildImportPreview returned error: %v", err)
	}

	if !reflect.DeepEqual(preview.Columns, []string{"id", "name"}) {
		t.Fatalf("unexpected columns: %#v", preview.Columns)
	}
	if preview.TotalRows != 5 {
		t.Fatalf("expected preview to stop after 5 rows, got %d", preview.TotalRows)
	}
	if preview.TotalRowsKnown {
		t.Fatal("short-circuited preview must report an unknown total row count")
	}
	if len(preview.PreviewRows) != 5 {
		t.Fatalf("expected 5 preview rows, got %d", len(preview.PreviewRows))
	}
	if got := preview.PreviewRows[0]["name"]; got != "user_1" {
		t.Fatalf("expected first preview row name user_1, got %#v", got)
	}
	if got := preview.PreviewRows[4]["id"]; got != "5" {
		t.Fatalf("expected fifth preview row id 5, got %#v", got)
	}
}

func TestPreviewImportFileReportsBoundedTotalAndStableSourceIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id,name\n1,a\n2,b\n3,c\n4,d\n5,e\n6,f\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	result := NewApp().PreviewImportFile(path)
	if !result.Success {
		t.Fatalf("preview failed: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected payload type: %T", result.Data)
	}
	if known, _ := payload["totalRowsKnown"].(bool); known {
		t.Fatalf("bounded preview incorrectly reported a known total: %#v", payload)
	}
	if size, _ := payload["fileSize"].(int64); size <= 0 {
		t.Fatalf("missing file size: %#v", payload)
	}
	identity, ok := payload["sourceIdentity"].(ImportSourceIdentity)
	if !ok || identity.Token == "" {
		t.Fatalf("missing source identity: %T %#v", payload["sourceIdentity"], payload["sourceIdentity"])
	}
}

func TestPreviewImportFileWithOptionsUsesTheSameParserSettingsAsImport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("ignored\nid;name\n1;alice\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	result := NewApp().PreviewImportFileWithOptions(path, ImportFileOptions{
		Delimiter: "semicolon",
		HeaderRow: 2,
	})
	if !result.Success {
		t.Fatalf("preview failed: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected payload type: %T", result.Data)
	}
	if !reflect.DeepEqual(payload["columns"], []string{"id", "name"}) {
		t.Fatalf("unexpected columns: %#v", payload["columns"])
	}
	rows, ok := payload["previewRows"].([]map[string]interface{})
	if !ok || len(rows) != 1 || rows[0]["name"] != "alice" {
		t.Fatalf("unexpected preview rows: %#v", payload["previewRows"])
	}
}

func TestFormatSQLValuePreservesValidatedJSONNumbersWithoutQuoting(t *testing.T) {
	if got := formatSQLValue("mysql", json.Number("9007199254740993")); got != "9007199254740993" {
		t.Fatalf("large JSON integer = %q", got)
	}
	if got := formatSQLValue("postgres", json.Number("-1.25e+4")); got != "-1.25e+4" {
		t.Fatalf("JSON decimal = %q", got)
	}
	if got := formatSQLValue("postgres", json.Number("1e1000")); got != "1e1000" {
		t.Fatalf("database-sized JSON decimal must not be silently converted to NULL: %q", got)
	}
	if got := formatSQLValue("mysql", json.Number("0); DROP TABLE users;--")); got != "NULL" {
		t.Fatalf("invalid JSON number must not become SQL: %q", got)
	}
}

func TestBuildImportRowFromValuesPreservesPositionsWhenHeaderContainsBlankColumns(t *testing.T) {
	row := buildImportRowFromValues([]string{"id", "", "name"}, []string{"1", "ignored", "alice"})
	if got := row["id"]; got != "1" {
		t.Fatalf("expected id to stay aligned, got %#v", got)
	}
	if got := row["name"]; got != "alice" {
		t.Fatalf("expected name to stay aligned, got %#v", got)
	}
	if _, ok := row[""]; ok {
		t.Fatal("blank header column should not be written into row map")
	}
}

func TestBuildImportPreviewXLSXStreamSupportsInlineStrings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inline.xlsx")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("创建 xlsx 文件失败: %v", err)
	}

	writer, err := newXLSXExportFileWriter(file, 0)
	if err != nil {
		t.Fatalf("创建 xlsx writer 失败: %v", err)
	}
	if err := writer.SetColumns([]string{"id", "name"}); err != nil {
		t.Fatalf("SetColumns 失败: %v", err)
	}
	if err := writer.ConsumeRowValues([]interface{}{1, "alice"}); err != nil {
		t.Fatalf("写入第 1 行失败: %v", err)
	}
	if err := writer.ConsumeRowValues([]interface{}{2, "bob"}); err != nil {
		t.Fatalf("写入第 2 行失败: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭 xlsx writer 失败: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("关闭 xlsx 文件失败: %v", err)
	}

	preview, err := buildImportPreview(path, 5)
	if err != nil {
		t.Fatalf("buildImportPreview 返回错误: %v", err)
	}
	if !reflect.DeepEqual(preview.Columns, []string{"id", "name"}) {
		t.Fatalf("unexpected columns: %#v", preview.Columns)
	}
	if preview.TotalRows != 2 {
		t.Fatalf("expected 2 rows, got %d", preview.TotalRows)
	}
	if got := preview.PreviewRows[1]["name"]; got != "bob" {
		t.Fatalf("expected second row name bob, got %#v", got)
	}
}

type issue1025CapturingImportDB struct {
	fakeMetadataRetryDB
	batchChanges []connection.ChangeSet
}

type sameSessionImportMetadataDB struct {
	issue1025CapturingImportDB
	contextValue any
	contextCalls int
}

func (database *sameSessionImportMetadataDB) GetColumnsContext(ctx context.Context, _, _ string) ([]connection.ColumnDefinition, error) {
	database.contextCalls++
	database.contextValue = ctx.Value(importMetadataContextKey{})
	return append([]connection.ColumnDefinition(nil), database.columns...), ctx.Err()
}

type importMetadataContextKey struct{}

func (database *issue1025CapturingImportDB) ApplyChanges(_ string, changes connection.ChangeSet) error {
	database.batchChanges = append(database.batchChanges, changes)
	return nil
}

func (database *issue1025CapturingImportDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return database.ApplyChanges(tableName, changes)
}

func TestIssue1025BlankNullableXLSXCellsBecomeSQLNull(t *testing.T) {
	database := &issue1025CapturingImportDB{fakeMetadataRetryDB: fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "bigint", Nullable: "NO"},
			{Name: "payload", Type: "json", Nullable: "YES"},
			{Name: "count", Type: "int", Nullable: "YES"},
			{Name: "required_count", Type: "int", Nullable: "NO"},
		},
	}}
	installImportTestDatabase(t, database)

	path := filepath.Join(t.TempDir(), "users.xlsx")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create xlsx: %v", err)
	}
	writer, err := newXLSXExportFileWriter(file, 0)
	if err != nil {
		_ = file.Close()
		t.Fatalf("create xlsx writer: %v", err)
	}
	if err := writer.SetColumns([]string{"id", "payload", "count", "required_count"}); err != nil {
		_ = file.Close()
		t.Fatalf("set xlsx columns: %v", err)
	}
	if err := writer.ConsumeRowValues([]interface{}{"1", "", "", ""}); err != nil {
		_ = file.Close()
		t.Fatalf("write xlsx row: %v", err)
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		t.Fatalf("close xlsx writer: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close xlsx: %v", err)
	}

	app := newManagedImportTestApp(t)
	continueOnError := false
	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		"app",
		"users",
		path,
		ImportFileOptions{
			ContinueOnError: &continueOnError,
		},
	)
	if !result.Success {
		t.Fatalf("blank nullable XLSX cells should import successfully: %#v", result)
	}
	if len(database.batchChanges) != 1 || len(database.batchChanges[0].Inserts) != 1 {
		t.Fatalf("batch changes = %#v, want one inserted row", database.batchChanges)
	}
	row := database.batchChanges[0].Inserts[0]
	if row["id"] != "1" {
		t.Fatalf("id = %#v, want string 1", row["id"])
	}
	if row["payload"] != nil || row["count"] != nil {
		t.Fatalf("nullable blank cells = %#v, want NULL values", row)
	}
	if row["required_count"] != "" {
		t.Fatalf("required blank cell = %#v, want empty string for database validation", row["required_count"])
	}
}

func TestSQLiteMemoryImportReadsColumnsFromSameContextAwareInstance(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	database := &sameSessionImportMetadataDB{issue1025CapturingImportDB: issue1025CapturingImportDB{
		fakeMetadataRetryDB: fakeMetadataRetryDB{
			columns: []connection.ColumnDefinition{{Name: "id", Type: "integer", Nullable: "NO"}},
		},
	}}
	installImportTestDatabase(t, database)
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	application := newManagedImportTestApp(t)
	ctx := context.WithValue(context.Background(), importMetadataContextKey{}, "request-1098")

	result := application.importDataWithProgressContext(
		ctx,
		connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"},
		"",
		"users",
		path,
		ImportFileOptions{ColumnMappings: map[string]string{"id": "id"}},
	)
	if !result.Success {
		t.Fatalf("in-memory import failed: %#v", result)
	}
	if database.contextCalls != 1 || database.contextValue != "request-1098" {
		t.Fatalf("same-session metadata context calls=%d value=%v", database.contextCalls, database.contextValue)
	}
	if database.connectCalls != 1 {
		t.Fatalf("database connect calls = %d, want one shared in-memory instance", database.connectCalls)
	}
	if len(database.batchChanges) != 1 || len(database.batchChanges[0].Inserts) != 1 {
		t.Fatalf("applied changes = %#v, want one row", database.batchChanges)
	}
}

func TestDuckDBMemoryImportReadsColumnsFromSameContextAwareInstance(t *testing.T) {
	database := &sameSessionImportMetadataDB{issue1025CapturingImportDB: issue1025CapturingImportDB{
		fakeMetadataRetryDB: fakeMetadataRetryDB{
			columns: []connection.ColumnDefinition{{Name: "id", Type: "integer", Nullable: "NO"}},
		},
	}}
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	ctx := context.WithValue(context.Background(), importMetadataContextKey{}, "request-1098")

	columns, err := application.importTargetColumnsContext(
		ctx,
		database,
		connection.ConnectionConfig{Type: "duckdb", Host: ":memory:"},
		"main",
		"users",
	)
	if err != nil {
		t.Fatalf("read in-memory DuckDB columns: %v", err)
	}
	if len(columns) != 1 || columns[0].Name != "id" {
		t.Fatalf("columns = %#v, want id", columns)
	}
	if database.contextCalls != 1 || database.contextValue != "request-1098" {
		t.Fatalf("same-session metadata context calls=%d value=%v", database.contextCalls, database.contextValue)
	}
}

func TestBuildImportPreviewXLSXStreamSupportsSharedStrings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared.xlsx")
	workbook := excelize.NewFile()
	if err := workbook.SetCellValue("Sheet1", "A1", "id"); err != nil {
		t.Fatalf("设置表头失败: %v", err)
	}
	if err := workbook.SetCellValue("Sheet1", "B1", "name"); err != nil {
		t.Fatalf("设置表头失败: %v", err)
	}
	if err := workbook.SetCellValue("Sheet1", "A2", "1"); err != nil {
		t.Fatalf("设置数据失败: %v", err)
	}
	if err := workbook.SetCellValue("Sheet1", "B2", "alice"); err != nil {
		t.Fatalf("设置数据失败: %v", err)
	}
	if err := workbook.SetCellValue("Sheet1", "A3", "2"); err != nil {
		t.Fatalf("设置数据失败: %v", err)
	}
	if err := workbook.SetCellValue("Sheet1", "B3", "bob"); err != nil {
		t.Fatalf("设置数据失败: %v", err)
	}
	if err := workbook.SaveAs(path); err != nil {
		t.Fatalf("保存 shared-string xlsx 失败: %v", err)
	}
	if err := workbook.Close(); err != nil {
		t.Fatalf("关闭 shared-string xlsx 失败: %v", err)
	}

	preview, err := buildImportPreview(path, 5)
	if err != nil {
		t.Fatalf("buildImportPreview 返回错误: %v", err)
	}
	if !reflect.DeepEqual(preview.Columns, []string{"id", "name"}) {
		t.Fatalf("unexpected columns: %#v", preview.Columns)
	}
	if preview.TotalRows != 2 {
		t.Fatalf("expected 2 rows, got %d", preview.TotalRows)
	}
	if got := preview.PreviewRows[0]["name"]; got != "alice" {
		t.Fatalf("expected first row name alice, got %#v", got)
	}
	if got := preview.PreviewRows[1]["id"]; got != "2" {
		t.Fatalf("expected second row id 2, got %#v", got)
	}
}

type fakeImportRowWriter struct {
	columns          []string
	disableBatch     bool
	batchCalls       int
	singleCalls      int
	batchSizes       []int
	batchRows        []map[string]interface{}
	batchErr         error
	singleErrByRowID map[interface{}]error
	afterSingleCall  func()
}

type contextBlockingImportRowWriter struct {
	fakeImportRowWriter
	started chan struct{}
}

func (w *contextBlockingImportRowWriter) ApplyBatchContext(ctx context.Context, _ []map[string]interface{}) error {
	close(w.started)
	<-ctx.Done()
	return ctx.Err()
}

type noopImportEventEmitter struct{}

func (noopImportEventEmitter) Emit(string, ...any) {}

type cancellableImportTestDB struct {
	fakeMetadataRetryDB
	execCalls      int
	afterFirstExec func()
}

type failingBatchImportTestDB struct {
	fakeMetadataRetryDB
	batchCalls int
	execCalls  int
}

type unsupportedTableImportRuntimeDB struct {
	db.Database
	connectCalls int
}

func (d *unsupportedTableImportRuntimeDB) Connect(connection.ConnectionConfig) error {
	d.connectCalls++
	return nil
}

func (*unsupportedTableImportRuntimeDB) Close() error { return nil }
func (*unsupportedTableImportRuntimeDB) Ping() error  { return nil }

func (d *cancellableImportTestDB) Exec(string) (int64, error) {
	d.execCalls++
	if d.execCalls == 1 && d.afterFirstExec != nil {
		d.afterFirstExec()
	}
	return 1, nil
}

func (d *cancellableImportTestDB) ApplyChanges(_ string, changes connection.ChangeSet) error {
	for range changes.Inserts {
		if _, err := d.Exec(""); err != nil {
			return err
		}
	}
	return nil
}

func (d *cancellableImportTestDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return d.ApplyChanges(tableName, changes)
}

func (d *failingBatchImportTestDB) ApplyChanges(string, connection.ChangeSet) error {
	d.batchCalls++
	return fmt.Errorf("batch rejected")
}

func (d *failingBatchImportTestDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return d.ApplyChanges(tableName, changes)
}

func (d *failingBatchImportTestDB) Exec(string) (int64, error) {
	d.execCalls++
	return 1, nil
}

func (w *fakeImportRowWriter) SetColumns(columns []string) {
	w.columns = append([]string(nil), columns...)
}

func (w *fakeImportRowWriter) ApplyBatch(rows []map[string]interface{}) error {
	w.batchCalls++
	w.batchSizes = append(w.batchSizes, len(rows))
	w.batchRows = append(w.batchRows, cloneImportRows(rows)...)
	return w.batchErr
}

func (w *fakeImportRowWriter) ApplyOne(row map[string]interface{}) error {
	w.singleCalls++
	if w.afterSingleCall != nil {
		w.afterSingleCall()
	}
	if err, ok := w.singleErrByRowID[row["id"]]; ok {
		return err
	}
	return nil
}

func (w *fakeImportRowWriter) BatchEnabled() bool {
	return !w.disableBatch
}

func TestImportColumnMappingConsumerStreamsMappedColumnsAndRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("User ID,Display Name,Ignored\n1,Alice,skip me\n"), 0o600); err != nil {
		t.Fatalf("write csv: %v", err)
	}

	writer := &fakeImportRowWriter{}
	batchConsumer := newImportBatchConsumer(writer, 1000, 0, false, false, nil)
	consumer, err := newImportColumnMappingConsumer(batchConsumer, map[string]string{
		"User ID":      "ID",
		"Display Name": "display_name",
	}, []connection.ColumnDefinition{
		{Name: "id", Type: "bigint"},
		{Name: "display_name", Type: "varchar(255)"},
	})
	if err != nil {
		t.Fatalf("newImportColumnMappingConsumer returned error: %v", err)
	}

	if err := streamImportFile(path, consumer); err != nil {
		t.Fatalf("streamImportFile returned error: %v", err)
	}
	if err := batchConsumer.Flush(); err != nil {
		t.Fatalf("Flush returned error: %v", err)
	}

	if !reflect.DeepEqual(writer.columns, []string{"id", "display_name"}) {
		t.Fatalf("unexpected mapped columns: %#v", writer.columns)
	}
	wantRows := []map[string]interface{}{{"id": "1", "display_name": "Alice"}}
	if !reflect.DeepEqual(writer.batchRows, wantRows) {
		t.Fatalf("unexpected mapped rows: %#v", writer.batchRows)
	}
}

func TestImportColumnMappingConsumerAllowsOmittedNullableTarget(t *testing.T) {
	collector := newImportPreviewCollector(5)
	consumer, err := newImportColumnMappingConsumer(collector, map[string]string{
		"id": "id",
	}, []connection.ColumnDefinition{
		{Name: "id", Nullable: "NO"},
		{Name: "note", Nullable: "YES"},
	})
	if err != nil {
		t.Fatalf("newImportColumnMappingConsumer returned error: %v", err)
	}
	if err := consumer.SetColumns([]string{"id"}); err != nil {
		t.Fatalf("nullable target should be omittable: %v", err)
	}
}

func TestImportColumnMappingConsumerRejectsOmittedRequiredTarget(t *testing.T) {
	collector := newImportPreviewCollector(5)
	consumer, err := newImportColumnMappingConsumer(collector, map[string]string{
		"id": "id",
	}, []connection.ColumnDefinition{
		{Name: "id", Nullable: "NO"},
		{Name: "name", Nullable: "NO"},
	})
	if err != nil {
		t.Fatalf("newImportColumnMappingConsumer returned error: %v", err)
	}
	if err := consumer.SetColumns([]string{"id"}); err == nil || !strings.Contains(err.Error(), "name") {
		t.Fatalf("expected omitted required target error, got %v", err)
	}
}

func TestImportColumnMappingConsumerNilMappingsPreserveLegacyHeaders(t *testing.T) {
	collector := newImportPreviewCollector(5)
	consumer, err := newImportColumnMappingConsumer(collector, nil, nil)
	if err != nil {
		t.Fatalf("newImportColumnMappingConsumer returned error: %v", err)
	}
	if err := consumer.SetColumns([]string{"Raw Header"}); err != nil {
		t.Fatalf("SetColumns returned error: %v", err)
	}
	if err := consumer.ConsumeRow(map[string]interface{}{"Raw Header": "value"}); err != nil {
		t.Fatalf("ConsumeRow returned error: %v", err)
	}
	result := collector.Result()
	if !reflect.DeepEqual(result.Columns, []string{"Raw Header"}) {
		t.Fatalf("legacy columns changed: %#v", result.Columns)
	}
	if got := result.PreviewRows[0]["Raw Header"]; got != "value" {
		t.Fatalf("legacy row changed: %#v", result.PreviewRows)
	}
}

func TestImportColumnMappingConsumerPrefersExactTargetWhenCaseDistinct(t *testing.T) {
	collector := newImportPreviewCollector(5)
	consumer, err := newImportColumnMappingConsumer(collector, map[string]string{
		"Source Value": "Foo",
	}, []connection.ColumnDefinition{
		{Name: "Foo", Type: "text"},
		{Name: "foo", Type: "integer"},
	})
	if err != nil {
		t.Fatalf("newImportColumnMappingConsumer returned error: %v", err)
	}
	if err := consumer.SetColumns([]string{"Source Value"}); err != nil {
		t.Fatalf("SetColumns returned error: %v", err)
	}
	if !reflect.DeepEqual(collector.columns, []string{"Foo"}) {
		t.Fatalf("unexpected exact mapped target: %#v", collector.columns)
	}
}

func TestImportColumnTypeLookupKeepsCaseDistinctTypes(t *testing.T) {
	lookup := newImportColumnTypeLookup([]connection.ColumnDefinition{
		{Name: "Foo", Type: "text"},
		{Name: "foo", Type: "boolean"},
		{Name: "event_id", Type: "bigint"},
	})
	if got := lookup.Resolve("Foo"); got != "text" {
		t.Fatalf("exact Foo type = %q, want text", got)
	}
	if got := lookup.Resolve("foo"); got != "boolean" {
		t.Fatalf("exact foo type = %q, want boolean", got)
	}
	if got := lookup.Resolve("FOO"); got != "" {
		t.Fatalf("ambiguous folded FOO type = %q, want empty", got)
	}
	if got := lookup.Resolve("EVENT_ID"); got != "bigint" {
		t.Fatalf("unique folded EVENT_ID type = %q, want bigint", got)
	}
	query, err := buildImportInsertQuery(
		"postgres",
		"events",
		[]string{"Foo", "foo"},
		map[string]interface{}{"Foo": "false", "foo": "false"},
		lookup,
	)
	if err != nil {
		t.Fatalf("buildImportInsertQuery returned error: %v", err)
	}
	if !strings.Contains(query, `("Foo", "foo") VALUES ('false', false)`) {
		t.Fatalf("case-distinct target types produced wrong SQL: %s", query)
	}
}

func TestImportColumnTypeLookupResolvesNullableMetadata(t *testing.T) {
	lookup := newImportColumnTypeLookup([]connection.ColumnDefinition{
		{Name: "optional_json", Type: "json", Nullable: "YES"},
		{Name: "required_count", Type: "int", Nullable: "NO"},
		{Name: "unknown", Type: "text"},
	})

	if nullable, known := lookup.IsNullable("OPTIONAL_JSON"); !known || !nullable {
		t.Fatalf("optional column metadata = (%t, %t), want (true, true)", nullable, known)
	}
	if nullable, known := lookup.IsNullable("required_count"); !known || nullable {
		t.Fatalf("required column metadata = (%t, %t), want (false, true)", nullable, known)
	}
	if _, known := lookup.IsNullable("unknown"); known {
		t.Fatal("missing nullable metadata should remain unknown")
	}
}

func TestBuildImportInsertQueryConvertsEmptyNullableValuesToSQLNull(t *testing.T) {
	query, err := buildImportInsertQuery(
		"mysql",
		"users",
		[]string{"optional_json", "optional_count", "required_count"},
		map[string]interface{}{
			"optional_json":  "",
			"optional_count": "",
			"required_count": "",
		},
		newImportColumnTypeLookup([]connection.ColumnDefinition{
			{Name: "optional_json", Type: "json", Nullable: "YES"},
			{Name: "optional_count", Type: "int", Nullable: "YES"},
			{Name: "required_count", Type: "int", Nullable: "NO"},
		}),
	)
	if err != nil {
		t.Fatalf("buildImportInsertQuery returned error: %v", err)
	}
	if !strings.Contains(query, "VALUES (NULL, NULL, '')") {
		t.Fatalf("nullable empty values produced wrong SQL: %s", query)
	}
}

func TestImportColumnMappingConsumerRejectsInvalidMappings(t *testing.T) {
	targetColumns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint"},
		{Name: "display_name", Type: "varchar(255)"},
	}
	tests := []struct {
		name          string
		mappings      map[string]string
		headers       []string
		targetColumns []connection.ColumnDefinition
		wantInError   string
	}{
		{
			name:        "requires at least one selected target",
			mappings:    map[string]string{"User ID": ""},
			headers:     []string{"User ID"},
			wantInError: "至少",
		},
		{
			name:        "rejects unknown target",
			mappings:    map[string]string{"User ID": "missing"},
			headers:     []string{"User ID"},
			wantInError: "目标字段",
		},
		{
			name: "rejects duplicate targets",
			mappings: map[string]string{
				"User ID":      "id",
				"Display Name": "ID",
			},
			headers:     []string{"User ID", "Display Name"},
			wantInError: "重复",
		},
		{
			name:        "rejects unknown source",
			mappings:    map[string]string{"Missing Header": "id"},
			headers:     []string{"User ID"},
			wantInError: "源字段",
		},
		{
			name:     "rejects ambiguous case insensitive target",
			mappings: map[string]string{"Value": "FOO"},
			headers:  []string{"Value"},
			targetColumns: []connection.ColumnDefinition{
				{Name: "Foo", Type: "text"},
				{Name: "foo", Type: "integer"},
			},
			wantInError: "不明确",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			baseConsumer := newImportPreviewCollector(5)
			columns := targetColumns
			if tt.targetColumns != nil {
				columns = tt.targetColumns
			}
			consumer, err := newImportColumnMappingConsumer(baseConsumer, tt.mappings, columns)
			if err == nil {
				err = consumer.SetColumns(tt.headers)
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantInError) {
				t.Fatalf("error = %v, want substring %q", err, tt.wantInError)
			}
		})
	}
}

func TestImportDataWithProgressOptionsRejectsEmptyFilePathBeforeDatabaseAccess(t *testing.T) {
	app := &App{}
	wantMessage := app.appText("file.backend.error.import_file_empty", nil)
	result := app.ImportDataWithProgressOptions(connection.ConnectionConfig{}, "", "users", "  ", ImportFileOptions{})
	if result.Success {
		t.Fatal("empty file path should fail")
	}
	if result.Message != wantMessage {
		t.Fatalf("message = %q, want %q", result.Message, wantMessage)
	}
}

func TestBuildImportExecutionPayloadUsesAttemptedRowsForKnownStop(t *testing.T) {
	payload := buildImportExecutionPayload(importExecutionResult{
		Success:        1,
		Failed:         1,
		Total:          1000,
		StoppedOnError: true,
	}, "stopped", false)
	if payload["total"] != 2 {
		t.Fatalf("known stopped total = %v, want 2 attempted rows", payload["total"])
	}

	unknownPayload := buildImportExecutionPayload(importExecutionResult{
		Failed:         1,
		Total:          1000,
		StoppedOnError: true,
		OutcomeUnknown: true,
	}, "stopped", false)
	if unknownPayload["total"] != 1000 {
		t.Fatalf("unknown batch total = %v, want 1000 submitted rows", unknownPayload["total"])
	}
}

func TestImportDataWithProgressOptionsStopModeReturnsPartialResultWithoutReplay(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	database := &failingBatchImportTestDB{fakeMetadataRetryDB: fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}},
	}}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n2\n3\n"), 0o600); err != nil {
		t.Fatalf("write csv: %v", err)
	}
	continueOnError := false
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	app.ctx = uievents.WithEmitter(context.Background(), noopImportEventEmitter{})
	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		"app",
		"users",
		path,
		ImportFileOptions{
			ColumnMappings:  map[string]string{"id": "id"},
			ContinueOnError: &continueOnError,
		},
	)
	if result.Success {
		t.Fatal("stop mode batch failure must not be reported as success")
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("result data type = %T, want map[string]interface{}", result.Data)
	}
	if payload["stoppedOnError"] != true || payload["outcomeUnknown"] != true || payload["success"] != 0 || payload["failed"] != 1 || payload["total"] != 3 {
		t.Fatalf("unexpected stopped payload: %#v", payload)
	}
	if database.batchCalls != 1 || database.execCalls != 0 {
		t.Fatalf("failed batch was replayed: batchCalls=%d execCalls=%d", database.batchCalls, database.execCalls)
	}
}

func TestImportDataWithProgressOptionsStopsByJobIDAndReturnsCommittedPartialResult(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	database := &cancellableImportTestDB{fakeMetadataRetryDB: fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}},
	}}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n2\n3\n"), 0o600); err != nil {
		t.Fatalf("write csv: %v", err)
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.ctx = uievents.WithEmitter(context.Background(), noopImportEventEmitter{})
	const jobID = "import-cancel-test"
	app.configDir = t.TempDir()
	database.afterFirstExec = func() {
		cancelResult := app.CancelImportJob(jobID)
		if !cancelResult.Success {
			t.Errorf("CancelImportJob returned failure: %s", cancelResult.Message)
		}
		app.queryMu.Lock()
		_, retainedWhileStopping := app.runningQueries[jobID]
		app.queryMu.Unlock()
		if !retainedWhileStopping {
			t.Error("cancelled import job was unregistered before its owner stopped")
		}
	}

	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		"app",
		"users",
		path,
		ImportFileOptions{ColumnMappings: map[string]string{"id": "id"}, JobID: jobID},
	)
	if result.Success {
		t.Fatal("cancelled import should not be reported as a completed success")
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("result data type = %T, want map[string]interface{}", result.Data)
	}
	if payload["cancelled"] != true || payload["success"] != 1 || payload["failed"] != 0 || payload["total"] != 1 {
		t.Fatalf("unexpected cancelled payload: %#v", payload)
	}
	if database.execCalls != 1 {
		t.Fatalf("Exec calls = %d, want 1", database.execCalls)
	}
	app.queryMu.Lock()
	_, stillRegistered := app.runningQueries[jobID]
	app.queryMu.Unlock()
	if stillRegistered {
		t.Fatal("cancelled import job remained registered")
	}
}

func TestImportDataWithProgressOptionsUsesOracleColumnMetadataFallback(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})

	fakeDB := &fakeMetadataRetryDB{
		queryResults: []fakeMetadataQueryResult{{
			match: "all_tab_columns",
			rows: []map[string]interface{}{
				{"COLUMN_NAME": "ID", "DATA_TYPE": "NUMBER", "DATA_PRECISION": 19, "NULLABLE": "N"},
				{"COLUMN_NAME": "DISPLAY_NAME", "DATA_TYPE": "VARCHAR2", "CHAR_LENGTH": 255, "NULLABLE": "Y"},
			},
			fields: []string{"COLUMN_NAME", "DATA_TYPE", "DATA_PRECISION", "CHAR_LENGTH", "NULLABLE"},
		}},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }

	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("User ID,Display Name\n1,Alice\n"), 0o600); err != nil {
		t.Fatalf("write csv: %v", err)
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.ctx = uievents.WithEmitter(context.Background(), noopImportEventEmitter{})
	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, Database: "ORCL"},
		"APP",
		"USERS",
		path,
		ImportFileOptions{ColumnMappings: map[string]string{
			"User ID":      "ID",
			"Display Name": "DISPLAY_NAME",
		}},
	)
	if !result.Success {
		t.Fatalf("Oracle fallback columns should allow mapped import, got: %s", result.Message)
	}
	if fakeDB.columnSchema != "APP" || fakeDB.columnTable != "USERS" {
		t.Fatalf("GetColumns target = %q.%q, want APP.USERS", fakeDB.columnSchema, fakeDB.columnTable)
	}
	if len(fakeDB.queries) == 0 || !strings.Contains(fakeDB.queries[0], "all_tab_columns") {
		t.Fatalf("expected Oracle dictionary metadata fallback, queries=%v", fakeDB.queries)
	}
}

func TestImportDataWithProgressOptionsRejectsUnsupportedTableRuntimeBeforeMetadata(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	database := &unsupportedTableImportRuntimeDB{}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.ctx = uievents.WithEmitter(context.Background(), noopImportEventEmitter{})
	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		"app",
		"users",
		path,
		ImportFileOptions{},
	)
	if result.Success {
		t.Fatalf("unsupported table runtime unexpectedly imported: %#v", result)
	}
	if database.connectCalls != 1 {
		t.Fatalf("database connect calls = %d, want 1 capability probe", database.connectCalls)
	}
}

func TestImportBatchConsumerUsesBatchWriterInConfiguredBatches(t *testing.T) {
	writer := &fakeImportRowWriter{}
	consumer := newImportBatchConsumer(writer, 1000, 1201, true, false, nil)
	if err := consumer.SetColumns([]string{"id"}); err != nil {
		t.Fatalf("SetColumns returned error: %v", err)
	}
	for i := 1; i <= 1201; i++ {
		if err := consumer.ConsumeRow(map[string]interface{}{"id": i}); err != nil {
			t.Fatalf("ConsumeRow(%d) returned error: %v", i, err)
		}
	}
	if err := consumer.Flush(); err != nil {
		t.Fatalf("Flush returned error: %v", err)
	}

	if writer.batchCalls != 2 {
		t.Fatalf("expected 2 batch calls, got %d", writer.batchCalls)
	}
	if !reflect.DeepEqual(writer.batchSizes, []int{1000, 201}) {
		t.Fatalf("unexpected batch sizes: %#v", writer.batchSizes)
	}
	result := consumer.Result()
	if result.Success != 1201 || result.Failed != 0 || result.Total != 1201 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if writer.singleCalls != 0 {
		t.Fatalf("expected no single-row fallback, got %d calls", writer.singleCalls)
	}
}

func TestImportBatchConsumerCancelsInFlightContextBatchAndMarksOutcomeUnknown(t *testing.T) {
	writer := &contextBlockingImportRowWriter{started: make(chan struct{})}
	consumer := newImportBatchConsumer(writer, 2, 2, true, false, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	consumer.SetContext(ctx)
	if err := consumer.SetColumns([]string{"id"}); err != nil {
		t.Fatal(err)
	}
	if err := consumer.ConsumeRow(map[string]interface{}{"id": 1}); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		done <- consumer.ConsumeRow(map[string]interface{}{"id": 2})
	}()
	select {
	case <-writer.started:
	case <-time.After(time.Second):
		t.Fatal("context-aware batch write did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("ConsumeRow error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("in-flight batch write did not stop after cancellation")
	}

	result := consumer.Result()
	if !result.OutcomeUnknown || result.Success != 0 || result.Total != 2 {
		t.Fatalf("unexpected cancellation result: %#v", result)
	}
}

func TestImportBatchConsumerStopModeDoesNotReplayFailedBatch(t *testing.T) {
	writer := &fakeImportRowWriter{batchErr: fmt.Errorf("batch failed")}
	consumer := newImportBatchConsumer(writer, 1000, 3, true, false, nil)
	if err := consumer.SetColumns([]string{"id"}); err != nil {
		t.Fatalf("SetColumns returned error: %v", err)
	}
	for i := 1; i <= 3; i++ {
		if err := consumer.ConsumeRow(map[string]interface{}{"id": i}); err != nil {
			t.Fatalf("ConsumeRow(%d) returned error before flush: %v", i, err)
		}
	}

	err := consumer.Flush()
	if !errors.Is(err, errImportStoppedOnError) {
		t.Fatalf("Flush error = %v, want errImportStoppedOnError", err)
	}
	if writer.batchCalls != 1 {
		t.Fatalf("batch calls = %d, want 1", writer.batchCalls)
	}
	if writer.singleCalls != 0 {
		t.Fatalf("failed batch must not be replayed row by row, single calls=%d", writer.singleCalls)
	}
	result := consumer.Result()
	if result.Success != 0 || result.Failed != 1 || !result.StoppedOnError || !result.OutcomeUnknown {
		t.Fatalf("unexpected stopped result: %#v", result)
	}
}

func TestImportBatchConsumerContinueModeExecutesEachRowOnce(t *testing.T) {
	writer := &fakeImportRowWriter{
		batchErr: fmt.Errorf("batch failed"),
		singleErrByRowID: map[interface{}]error{
			2: fmt.Errorf("duplicate key"),
		},
	}
	consumer := newImportBatchConsumer(writer, 1000, 3, true, true, nil)
	if err := consumer.SetColumns([]string{"id"}); err != nil {
		t.Fatalf("SetColumns returned error: %v", err)
	}
	for i := 1; i <= 3; i++ {
		if err := consumer.ConsumeRow(map[string]interface{}{"id": i}); err != nil {
			t.Fatalf("ConsumeRow(%d) returned error: %v", i, err)
		}
	}
	if err := consumer.Flush(); err != nil {
		t.Fatalf("Flush returned error: %v", err)
	}

	result := consumer.Result()
	if result.Success != 2 || result.Failed != 1 || result.Total != 3 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if writer.batchCalls != 0 {
		t.Fatalf("continue mode must not attempt an ambiguous batch, got %d calls", writer.batchCalls)
	}
	if writer.singleCalls != 3 {
		t.Fatalf("expected 3 single-row fallback calls, got %d", writer.singleCalls)
	}
	if len(result.ErrorLogs) != 1 || result.ErrorLogs[0] != "Row 2: duplicate key" {
		t.Fatalf("unexpected error logs: %#v", result.ErrorLogs)
	}
}

func TestImportBatchConsumerStopModeStopsAtFirstSingleRowError(t *testing.T) {
	writer := &fakeImportRowWriter{
		disableBatch: true,
		singleErrByRowID: map[interface{}]error{
			2: fmt.Errorf("duplicate key"),
		},
	}
	consumer := newImportBatchConsumer(writer, 1000, 3, true, false, nil)
	for i := 1; i <= 3; i++ {
		if err := consumer.ConsumeRow(map[string]interface{}{"id": i}); err != nil {
			t.Fatalf("ConsumeRow(%d) returned error before flush: %v", i, err)
		}
	}

	err := consumer.Flush()
	if !errors.Is(err, errImportStoppedOnError) {
		t.Fatalf("Flush error = %v, want errImportStoppedOnError", err)
	}
	if writer.singleCalls != 2 {
		t.Fatalf("single calls = %d, want stop after row 2", writer.singleCalls)
	}
	result := consumer.Result()
	if result.Success != 1 || result.Failed != 1 || !result.StoppedOnError || result.OutcomeUnknown {
		t.Fatalf("unexpected stopped result: %#v", result)
	}
}

func TestImportBatchConsumerCapsErrorDetailsWithoutLosingFailureCount(t *testing.T) {
	rowCount := maxImportErrorDetails + 7
	singleErrors := make(map[interface{}]error, rowCount)
	for i := 1; i <= rowCount; i++ {
		singleErrors[i] = fmt.Errorf("duplicate key %d", i)
	}
	writer := &fakeImportRowWriter{
		disableBatch:     true,
		singleErrByRowID: singleErrors,
	}
	consumer := newImportBatchConsumer(writer, rowCount, rowCount, true, true, nil)
	for i := 1; i <= rowCount; i++ {
		if err := consumer.ConsumeRow(map[string]interface{}{"id": i}); err != nil {
			t.Fatalf("ConsumeRow(%d) returned error: %v", i, err)
		}
	}
	if err := consumer.Flush(); err != nil {
		t.Fatalf("Flush returned error: %v", err)
	}
	result := consumer.Result()
	if result.Failed != rowCount {
		t.Fatalf("failed count = %d, want %d", result.Failed, rowCount)
	}
	if len(result.ErrorLogs) != maxImportErrorDetails {
		t.Fatalf("error detail count = %d, want cap %d", len(result.ErrorLogs), maxImportErrorDetails)
	}
}

func TestResolveImportContinueOnErrorPreservesLegacyNilPolicy(t *testing.T) {
	continueValue := true
	stopValue := false
	tests := []struct {
		name    string
		options ImportFileOptions
		want    bool
	}{
		{name: "legacy omitted policy continues safely", options: ImportFileOptions{}, want: true},
		{name: "explicit continue", options: ImportFileOptions{ContinueOnError: &continueValue}, want: true},
		{name: "explicit stop", options: ImportFileOptions{ContinueOnError: &stopValue}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := resolveImportContinueOnError(test.options); got != test.want {
				t.Fatalf("resolveImportContinueOnError() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestImportBatchConsumerStopsSingleRowFallbackAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	writer := &fakeImportRowWriter{
		batchErr:        fmt.Errorf("batch failed"),
		afterSingleCall: cancel,
	}
	consumer := newImportBatchConsumer(writer, 1000, 3, true, true, nil)
	consumer.SetContext(ctx)

	for i := 1; i <= 3; i++ {
		if err := consumer.ConsumeRow(map[string]interface{}{"id": i}); err != nil {
			t.Fatalf("ConsumeRow(%d) returned error: %v", i, err)
		}
	}

	err := consumer.Flush()
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Flush error = %v, want context.Canceled", err)
	}
	if writer.singleCalls != 1 {
		t.Fatalf("single-row fallback calls = %d, want 1", writer.singleCalls)
	}
	result := consumer.Result()
	if result.Success != 1 || result.Failed != 0 {
		t.Fatalf("unexpected partial result: %#v", result)
	}
}

func TestImportBatchConsumerDoesNotCountCancellationAsRowFailure(t *testing.T) {
	writer := &fakeImportRowWriter{
		batchErr:         fmt.Errorf("batch failed"),
		singleErrByRowID: map[interface{}]error{1: context.Canceled},
	}
	consumer := newImportBatchConsumer(writer, 1, 1, true, true, nil)

	err := consumer.ConsumeRow(map[string]interface{}{"id": 1})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ConsumeRow error = %v, want context.Canceled", err)
	}
	result := consumer.Result()
	if result.Success != 0 || result.Failed != 0 || !result.OutcomeUnknown {
		t.Fatalf("unexpected cancelled result: %#v", result)
	}
}

func TestImportBatchConsumerProgressIncludesJobID(t *testing.T) {
	writer := &fakeImportRowWriter{}
	var progress []importProgressState
	consumer := newImportBatchConsumer(writer, 1, 1, true, false, func(state importProgressState) {
		progress = append(progress, state)
	})
	consumer.jobID = "import-job-1"

	if err := consumer.ConsumeRow(map[string]interface{}{"id": 1}); err != nil {
		t.Fatalf("ConsumeRow returned error: %v", err)
	}
	if len(progress) != 1 {
		t.Fatalf("progress event count = %d, want 1", len(progress))
	}
	if progress[0].JobID != "import-job-1" {
		t.Fatalf("progress job id = %q, want import-job-1", progress[0].JobID)
	}
}
