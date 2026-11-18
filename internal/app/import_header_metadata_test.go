package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestParseImportHeaderCell(t *testing.T) {
	cases := []struct {
		raw          string
		name         string
		declaredType string
		comment      string
	}{
		{raw: "姓名 varchar(50) 客户姓名", name: "姓名", declaredType: "varchar(50)", comment: "客户姓名"},
		{raw: "姓名（varchar(50)，客户姓名）", name: "姓名", declaredType: "varchar(50)", comment: "客户姓名"},
		{raw: "amount decimal(10,2) 金额", name: "amount", declaredType: "decimal(10,2)", comment: "金额"},
		{raw: "金额(元)", name: "金额", comment: "元"},
		{raw: "订单(2024)", name: "订单(2024)"},
		{raw: "普通列名", name: "普通列名"},
		{raw: "数量 个", name: "数量 个"},
		{raw: "名称(name)", name: "名称", comment: "name"},
		{raw: "age(int)", name: "age", declaredType: "int"},
		{raw: "备注 varchar(255)", name: "备注", declaredType: "varchar(255)"},
		{raw: "name varchar2(50) 姓名", name: "name", declaredType: "varchar2(50)", comment: "姓名"},
	}
	for _, testCase := range cases {
		name, declaredType, comment := parseImportHeaderCell(testCase.raw)
		if name != testCase.name || declaredType != testCase.declaredType || comment != testCase.comment {
			t.Errorf("parseImportHeaderCell(%q) = (%q, %q, %q), want (%q, %q, %q)",
				testCase.raw, name, declaredType, comment, testCase.name, testCase.declaredType, testCase.comment)
		}
	}
}

func writeHeaderMetadataCSV(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "templated.csv")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadImportHeaderMetadata(t *testing.T) {
	path := writeHeaderMetadataCSV(t, "id,name,amount\nbigint,varchar(50),\"decimal(10,2)\"\n主键,姓名,金额\n1,张三,12.50\n2,李四,3.25\n")
	metadata, err := readImportHeaderMetadata(context.Background(), path, ImportFileOptions{HeaderRow: 1, TypeRow: 2, CommentRow: 3})
	if err != nil {
		t.Fatalf("readImportHeaderMetadata: %v", err)
	}
	if strings.Join(metadata.Header, "|") != "id|name|amount" {
		t.Fatalf("header = %#v", metadata.Header)
	}
	if strings.Join(metadata.Types, "|") != "bigint|varchar(50)|decimal(10,2)" {
		t.Fatalf("types = %#v", metadata.Types)
	}
	if strings.Join(metadata.Comments, "|") != "主键|姓名|金额" {
		t.Fatalf("comments = %#v", metadata.Comments)
	}
}

func TestNormalizeImportFileHeaderOptionsAdvancesHeaderRow(t *testing.T) {
	path := writeHeaderMetadataCSV(t, "id,name\nbigint,varchar(50)\n主键,姓名\n1,张三\n")
	options, err := normalizeImportFileHeaderOptions(context.Background(), path, ImportFileOptions{HeaderRow: 1, TypeRow: 2, CommentRow: 3})
	if err != nil {
		t.Fatalf("normalizeImportFileHeaderOptions: %v", err)
	}
	if options.HeaderRow != 3 {
		t.Fatalf("headerRow = %d, want 3", options.HeaderRow)
	}
	if strings.Join(options.HeaderOverride, "|") != "id|name" {
		t.Fatalf("headerOverride = %#v", options.HeaderOverride)
	}
}

func TestInferImportSchemaParsesInlineHeaderMetadata(t *testing.T) {
	path := writeHeaderMetadataCSV(t, "\"姓名 varchar(50) 客户姓名\",\"age int 年龄\",\"amount decimal(10,2) 金额\"\n张三,18,12.50\n")
	inference, err := inferImportTableSchema(context.Background(), path, ImportFileOptions{}, 64)
	if err != nil {
		t.Fatalf("inferImportTableSchema: %v", err)
	}
	if len(inference.Columns) != 3 {
		t.Fatalf("columns = %#v", inference.Columns)
	}
	want := []struct {
		name, declaredType, comment string
	}{
		{"姓名", "varchar(50)", "客户姓名"},
		{"age", "int", "年龄"},
		{"amount", "decimal(10,2)", "金额"},
	}
	for index, expected := range want {
		column := inference.Columns[index]
		if column.Name != expected.name || column.DeclaredType != expected.declaredType || column.Comment != expected.comment {
			t.Errorf("column %d = %#v, want %#v", index, column, expected)
		}
	}
}

func TestInferImportSchemaUsesTypeAndCommentRows(t *testing.T) {
	path := writeHeaderMetadataCSV(t, "id,name\nbigint,varchar(50)\n主键,姓名\n1,张三\n2,李四\n")
	inference, err := inferImportTableSchema(context.Background(), path, ImportFileOptions{HeaderRow: 1, TypeRow: 2, CommentRow: 3}, 64)
	if err != nil {
		t.Fatalf("inferImportTableSchema: %v", err)
	}
	if inference.SampledRows != 2 {
		t.Fatalf("sampled rows = %d, want 2 (metadata rows must be skipped)", inference.SampledRows)
	}
	if len(inference.Columns) != 2 {
		t.Fatalf("columns = %#v", inference.Columns)
	}
	if inference.Columns[0].Name != "id" || inference.Columns[0].DeclaredType != "bigint" || inference.Columns[0].Comment != "主键" {
		t.Fatalf("id column = %#v", inference.Columns[0])
	}
	if inference.Columns[1].Name != "name" || inference.Columns[1].DeclaredType != "varchar(50)" || inference.Columns[1].Comment != "姓名" {
		t.Fatalf("name column = %#v", inference.Columns[1])
	}
}

func TestImportHeaderMetadataRowsAreBounded(t *testing.T) {
	path := writeHeaderMetadataCSV(t, "id\nbigint\n1\n")
	_, err := readImportHeaderMetadata(context.Background(), path, ImportFileOptions{HeaderRow: 1, TypeRow: maxImportHeaderMetadataRow + 1})
	if err == nil {
		t.Fatal("expected an out-of-range error")
	}
	var typed *importHeaderMetadataError
	if !errors.As(err, &typed) || typed.Key != "file.backend.error.import_header_type_row_invalid" {
		t.Fatalf("error = %#v, want typed type-row range error", err)
	}
}

func TestImportJobTableOptionsRoundTripKeepsHeaderMetadata(t *testing.T) {
	options := ImportFileOptions{
		HeaderRow:  1,
		TypeRow:    2,
		CommentRow: 3,
		AutoCreateTable: &ImportAutoCreateTable{
			TableName: "orders",
			SQL:       "CREATE TABLE `orders` (`id` BIGINT)",
		},
	}
	jobOptions := importJobTableOptionsFromImportFileOptions(options)
	if jobOptions == nil {
		t.Fatal("job options are nil")
	}
	restored := importFileOptionsFromImportJobTableOptions(jobOptions)
	if restored.HeaderRow != 1 || restored.TypeRow != 2 || restored.CommentRow != 3 {
		t.Fatalf("restored header metadata = %#v", restored)
	}
	if restored.AutoCreateTable == nil || restored.AutoCreateTable.SQL != options.AutoCreateTable.SQL {
		t.Fatalf("restored auto create = %#v", restored.AutoCreateTable)
	}
	if buildImportFileOptionsHash(options) != buildImportFileOptionsHash(restored) {
		t.Fatal("round-tripped options changed the recovery hash")
	}
}

func TestInferImportSchemaReadsXLSXTypeAndCommentRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "templated.xlsx")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := newXLSXExportFileWriter(file, 0)
	if err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := writer.SetColumns([]string{"id", "name"}); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	for _, row := range [][]interface{}{
		{"bigint", "varchar(50)"},
		{"主键", "姓名"},
		{"1", "张三"},
	} {
		if err := writer.ConsumeRowValues(row); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	inference, err := inferImportTableSchema(context.Background(), path, ImportFileOptions{HeaderRow: 1, TypeRow: 2, CommentRow: 3}, 64)
	if err != nil {
		t.Fatalf("inferImportTableSchema: %v", err)
	}
	if inference.SampledRows != 1 {
		t.Fatalf("sampled rows = %d, want 1", inference.SampledRows)
	}
	if inference.Columns[0].DeclaredType != "bigint" || inference.Columns[0].Comment != "主键" {
		t.Fatalf("id column = %#v", inference.Columns[0])
	}
	if inference.Columns[1].DeclaredType != "varchar(50)" || inference.Columns[1].Comment != "姓名" {
		t.Fatalf("name column = %#v", inference.Columns[1])
	}
}

func TestInferImportSchemaReadsHiveCSVTypeRows(t *testing.T) {
	path := writeHeaderMetadataCSV(t, "id,name\nbigint,varchar(50)\n主键,姓名\n1,张三\n")
	inference, err := inferImportTableSchema(context.Background(), path, ImportFileOptions{
		HeaderRow:    1,
		TypeRow:      2,
		CommentRow:   3,
		LosslessHive: true,
	}, 64)
	if err != nil {
		t.Fatalf("inferImportTableSchema (hive): %v", err)
	}
	if inference.SampledRows != 1 || len(inference.Columns) != 2 {
		t.Fatalf("inference = %#v", inference)
	}
	if inference.Columns[0].DeclaredType != "bigint" || inference.Columns[1].Comment != "姓名" {
		t.Fatalf("columns = %#v", inference.Columns)
	}
}

func TestInferImportSchemaIgnoresUnknownTypeRowValues(t *testing.T) {
	path := writeHeaderMetadataCSV(t, "id,name\n整数,文本\n主键,姓名\n1,张三\n")
	inference, err := inferImportTableSchema(context.Background(), path, ImportFileOptions{HeaderRow: 1, TypeRow: 2, CommentRow: 3}, 64)
	if err != nil {
		t.Fatalf("inferImportTableSchema: %v", err)
	}
	if inference.Columns[0].DeclaredType != "" {
		t.Fatalf("unknown Chinese type must not become DDL, got %q", inference.Columns[0].DeclaredType)
	}
	if inference.Columns[0].LogicalType != "integer" {
		t.Fatalf("logical type = %q, want integer from sample data", inference.Columns[0].LogicalType)
	}
}

func TestImportAndPreviewSkipTypeAndCommentRows(t *testing.T) {
	database := &issue1025CapturingImportDB{fakeMetadataRetryDB: fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{
			{Name: "id", Type: "bigint", Nullable: "NO"},
			{Name: "name", Type: "varchar(50)", Nullable: "YES"},
		},
	}}
	installImportTestDatabase(t, database)

	path := writeHeaderMetadataCSV(t, "id,name\nbigint,varchar(50)\n主键,姓名\n1,张三\n2,李四\n")
	options := ImportFileOptions{HeaderRow: 1, TypeRow: 2, CommentRow: 3}
	preview := NewApp().PreviewImportFileWithOptions(path, options)
	if !preview.Success {
		t.Fatalf("preview failed: %#v", preview)
	}
	previewData, _ := preview.Data.(map[string]interface{})
	if got := NumberToIntForTest(previewData["totalRows"]); got != 2 {
		t.Fatalf("preview totalRows = %d, want 2", got)
	}

	app := newManagedImportTestApp(t)
	stopOnError := false
	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		"app",
		"users",
		path,
		ImportFileOptions{HeaderRow: 1, TypeRow: 2, CommentRow: 3, JobID: "metadata-rows-import", ContinueOnError: &stopOnError},
	)
	if !result.Success {
		t.Fatalf("import failed: %#v", result)
	}
	if len(database.batchChanges) != 1 || len(database.batchChanges[0].Inserts) != 2 {
		t.Fatalf("batch changes = %#v, want two data rows only", database.batchChanges)
	}
	if got := database.batchChanges[0].Inserts[0]["name"]; got != "张三" {
		t.Fatalf("first imported name = %#v", got)
	}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatalf("ensureImportJobStore: %v", err)
	}
	job, err := store.Get("metadata-rows-import")
	if err != nil {
		t.Fatalf("store.Get: %v", err)
	}
	if job.TableImportOptions == nil {
		t.Fatal("job did not persist table import options")
	}
	if job.TableImportOptions.HeaderRow != 1 || job.TableImportOptions.TypeRow != 2 || job.TableImportOptions.CommentRow != 3 {
		t.Fatalf("persisted header options = %#v, want original headerRow=1, typeRow=2, commentRow=3",
			job.TableImportOptions)
	}
}

func NumberToIntForTest(value interface{}) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}
