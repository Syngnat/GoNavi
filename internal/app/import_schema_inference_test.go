package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
)

func TestInferImportTableSchemaInfersLogicalTypesFromCSV(t *testing.T) {
	path := filepath.Join(t.TempDir(), "销售 数据.csv")
	content := strings.Join([]string{
		"id,amount,enabled,day,created_at,note,empty",
		"1,12.50,true,2026-01-02,2026-01-02 03:04:05,short,",
		"2,-3.25,false,2026-01-03,2026-01-03T04:05:06,短,",
		"3,0.00,true,2026-01-04,2026-01-04 05:06:07,plain,",
		"",
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	inference, err := inferImportTableSchema(context.Background(), path, ImportFileOptions{}, 64)
	if err != nil {
		t.Fatalf("inferImportTableSchema: %v", err)
	}
	if inference.TableName != "销售_数据" {
		t.Fatalf("table name = %q", inference.TableName)
	}
	if inference.SampledRows != 3 {
		t.Fatalf("sampled rows = %d, want 3", inference.SampledRows)
	}
	types := make(map[string]string, len(inference.Columns))
	for _, column := range inference.Columns {
		types[column.Name] = column.LogicalType
	}
	want := map[string]string{
		"id":         "integer",
		"amount":     "decimal",
		"enabled":    "boolean",
		"day":        "date",
		"created_at": "datetime",
		"note":       "text",
		"empty":      "text",
	}
	for name, wantType := range want {
		if got := types[name]; got != wantType {
			t.Errorf("column %s type = %q, want %q (all=%#v)", name, got, wantType, types)
		}
	}
	for _, column := range inference.Columns {
		if !column.Nullable {
			t.Fatalf("column %s should default to nullable", column.Name)
		}
		if column.Name == "amount" && (column.Precision != 4 || column.Scale != 2) {
			t.Fatalf("amount precision/scale = %d/%d, want 4/2", column.Precision, column.Scale)
		}
	}
}

func writeImportSamplingTestCSV(t *testing.T, path string) {
	t.Helper()
	var builder strings.Builder
	builder.WriteString("id,amount,note\n")
	for row := 1; row <= importSchemaSampleLimit+1; row++ {
		fmt.Fprintf(&builder, "%d,%d.50,note-%d\n", row, row, row)
	}
	if err := os.WriteFile(path, []byte(builder.String()), 0o600); err != nil {
		t.Fatalf("write CSV: %v", err)
	}
}

func writeImportSamplingTestXLSX(t *testing.T, path string) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := newXLSXExportFileWriter(file, 0)
	if err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := writer.SetColumns([]string{"id", "amount", "note"}); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	for row := 1; row <= importSchemaSampleLimit+1; row++ {
		if err := writer.ConsumeRowValues([]interface{}{
			fmt.Sprintf("%d", row),
			fmt.Sprintf("%d.50", row),
			fmt.Sprintf("note-%d", row),
		}); err != nil {
			_ = file.Close()
			t.Fatalf("write row %d: %v", row, err)
		}
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestInferImportTableSchemaStopsSamplingAtLimit(t *testing.T) {
	cases := []struct {
		name     string
		fileName string
		write    func(*testing.T, string)
	}{
		{name: "csv", fileName: "large-orders.csv", write: writeImportSamplingTestCSV},
		{name: "xlsx", fileName: "large-orders.xlsx", write: writeImportSamplingTestXLSX},
	}
	wantTypes := []string{"integer", "decimal", "text"}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), testCase.fileName)
			testCase.write(t, path)

			inference, err := inferImportTableSchema(context.Background(), path, ImportFileOptions{}, 64)
			if err != nil {
				t.Fatalf("inferImportTableSchema: %v", err)
			}
			if inference.SampledRows != importSchemaSampleLimit {
				t.Fatalf("sampled rows = %d, want %d", inference.SampledRows, importSchemaSampleLimit)
			}
			if inference.SampleLimit != importSchemaSampleLimit {
				t.Fatalf("sample limit = %d, want %d", inference.SampleLimit, importSchemaSampleLimit)
			}
			if len(inference.Columns) != len(wantTypes) {
				t.Fatalf("columns = %#v", inference.Columns)
			}
			for index, wantType := range wantTypes {
				if got := inference.Columns[index].LogicalType; got != wantType {
					t.Fatalf("column %d logical type = %q, want %q", index, got, wantType)
				}
			}
		})
	}
}

func TestInferImportTableSchemaMarksOverlongText(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.csv")
	content := "payload\n" + strings.Repeat("x", 300) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	inference, err := inferImportTableSchema(context.Background(), path, ImportFileOptions{}, 64)
	if err != nil {
		t.Fatalf("inferImportTableSchema: %v", err)
	}
	if len(inference.Columns) != 1 || inference.Columns[0].LogicalType != "longtext" {
		t.Fatalf("columns = %#v, want one longtext column", inference.Columns)
	}
}

func TestNormalizeImportSchemaColumnNames(t *testing.T) {
	raw := []string{"", "id", "ID", "very_long_column_name", "  name  ", "中文列"}
	names, warnings := normalizeImportSchemaColumnNames(raw, 10)

	if len(names) != len(raw) {
		t.Fatalf("names = %#v", names)
	}
	if names[0] != "column_1" {
		t.Fatalf("empty header = %q, want column_1", names[0])
	}
	seen := map[string]struct{}{}
	for index, name := range names {
		if name == "" {
			t.Fatalf("column %d produced an empty name", index)
		}
		if utf8.RuneCountInString(name) > 10 {
			t.Fatalf("column %d name %q exceeds the identifier limit", index, name)
		}
		key := strings.ToLower(name)
		if _, exists := seen[key]; exists {
			t.Fatalf("duplicate column name %q in %#v", name, names)
		}
		seen[key] = struct{}{}
	}
	if len(warnings) == 0 {
		t.Fatal("expected warnings for renamed columns")
	}
}

func TestSuggestImportTableName(t *testing.T) {
	cases := map[string]string{
		"2026 orders.xlsx": "t_2026_orders",
		"/tmp/a b-c.csv":   "a_b_c",
		"---.json":         "imported_table",
	}
	for input, want := range cases {
		if got := suggestImportTableName(input, 64); got != want {
			t.Errorf("suggestImportTableName(%q) = %q, want %q", input, got, want)
		}
	}
	if got := suggestImportTableName("very-long-name.xlsx", 6); utf8.RuneCountInString(got) > 6 {
		t.Errorf("table name = %q exceeds limit", got)
	}
}

func TestNormalizeImportAutoCreateStatements(t *testing.T) {
	statements, err := normalizeImportAutoCreateStatements("mysql", "CREATE TABLE `t` (`id` BIGINT)")
	if err != nil || len(statements) != 1 {
		t.Fatalf("single create table should pass: statements=%#v err=%v", statements, err)
	}
	statements, err = normalizeImportAutoCreateStatements(
		"postgres",
		"CREATE TABLE t (id bigint); COMMENT ON COLUMN t.id IS 'primary id';",
	)
	if err != nil || len(statements) != 2 {
		t.Fatalf("create table with column comments should pass: statements=%#v err=%v", statements, err)
	}
	statements, err = normalizeImportAutoCreateStatements(
		"sqlserver",
		"CREATE TABLE [dbo].[t] ([id] BIGINT); EXEC sp_addextendedproperty 'MS_Description', 'pk', 'SCHEMA', 'dbo', 'TABLE', 't', 'COLUMN', 'id';",
	)
	if err != nil || len(statements) != 2 {
		t.Fatalf("sqlserver extended properties should pass: statements=%#v err=%v", statements, err)
	}
	if _, err := normalizeImportAutoCreateStatements("mysql", "CREATE TABLE `t` (`id` BIGINT); DROP TABLE `x`"); err == nil {
		t.Fatal("unsupported follow-up statements must be rejected")
	}
	if _, err := normalizeImportAutoCreateStatements("mysql", "SELECT 1"); err == nil {
		t.Fatal("non create table SQL must be rejected")
	}
	if _, err := normalizeImportAutoCreateStatements("postgres", "CREATE TEMP TABLE t (id bigint)"); err == nil {
		t.Fatal("temporary tables must be rejected: they are invisible to the pooled import writer")
	}
}

type autoCreateProbeDB struct {
	fakeMetadataRetryDB
	executed  []string
	execError error
}

func (database *autoCreateProbeDB) Exec(query string) (int64, error) {
	database.executed = append(database.executed, query)
	if database.execError != nil {
		return 0, database.execError
	}
	return 1, nil
}

func TestEnsureImportAutoCreateTarget(t *testing.T) {
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"}
	options := ImportFileOptions{AutoCreateTable: &ImportAutoCreateTable{
		TableName: "orders",
		SQL:       "CREATE TABLE `orders` (`id` BIGINT)",
	}}

	t.Run("skips when option is absent", func(t *testing.T) {
		database := &autoCreateProbeDB{}
		if err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "orders", ImportFileOptions{}, false); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(database.executed) != 0 {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("creates a missing table", func(t *testing.T) {
		database := &autoCreateProbeDB{}
		if err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "orders", options, false); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(database.executed) != 1 || !strings.Contains(database.executed[0], "CREATE TABLE") {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("executes column comments after creating the table", func(t *testing.T) {
		database := &autoCreateProbeDB{}
		withComments := ImportFileOptions{AutoCreateTable: &ImportAutoCreateTable{
			TableName: "orders",
			SQL:       "CREATE TABLE `orders` (`id` BIGINT); COMMENT ON COLUMN `orders`.`id` IS 'pk';",
		}}
		if err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "orders", withComments, false); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(database.executed) != 2 || !strings.HasPrefix(database.executed[1], "COMMENT ON COLUMN") {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("rejects a mismatched CREATE TABLE target", func(t *testing.T) {
		database := &autoCreateProbeDB{}
		mismatched := ImportFileOptions{AutoCreateTable: &ImportAutoCreateTable{
			TableName: "orders",
			SQL:       "CREATE TABLE `other` (`id` BIGINT)",
		}}
		if err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "orders", mismatched, false); err == nil {
			t.Fatal("expected a target mismatch error")
		}
		if len(database.executed) != 0 {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("accepts quoted table names with spaces", func(t *testing.T) {
		database := &autoCreateProbeDB{}
		quoted := ImportFileOptions{AutoCreateTable: &ImportAutoCreateTable{
			TableName: "order items",
			SQL:       "CREATE TABLE `order items` (`id` BIGINT)",
		}}
		if err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "order items", quoted, false); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(database.executed) != 1 {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("rejects CREATE TABLE AS SELECT", func(t *testing.T) {
		database := &autoCreateProbeDB{}
		ctas := ImportFileOptions{AutoCreateTable: &ImportAutoCreateTable{
			TableName: "orders",
			SQL:       "CREATE TABLE `orders` AS SELECT 1",
		}}
		if err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "orders", ctas, false); err == nil {
			t.Fatal("expected a CTAS rejection")
		}
		if len(database.executed) != 0 {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("rejects a mismatched declared table name", func(t *testing.T) {
		database := &autoCreateProbeDB{}
		mismatched := ImportFileOptions{AutoCreateTable: &ImportAutoCreateTable{
			TableName: "another",
			SQL:       "CREATE TABLE `orders` (`id` BIGINT)",
		}}
		if err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "orders", mismatched, false); err == nil {
			t.Fatal("expected a declared table name mismatch")
		}
		if len(database.executed) != 0 {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("refuses to overwrite an existing table", func(t *testing.T) {
		database := &autoCreateProbeDB{fakeMetadataRetryDB: fakeMetadataRetryDB{tables: []string{"orders"}}}
		err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "orders", options, false)
		if err == nil {
			t.Fatal("expected an error for an existing target table")
		}
		if len(database.executed) != 0 {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("allows the table created by a previous run when resuming", func(t *testing.T) {
		database := &autoCreateProbeDB{fakeMetadataRetryDB: fakeMetadataRetryDB{tables: []string{"orders"}}}
		if err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "orders", options, true); err != nil {
			t.Fatalf("resume should tolerate the existing table: %v", err)
		}
		if len(database.executed) != 0 {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("honors structure edit protection", func(t *testing.T) {
		database := &autoCreateProbeDB{}
		protected := config
		protected.Protection.RestrictStructureEdit = true
		err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, protected, "app", "orders", options, false)
		if err == nil {
			t.Fatal("expected a protection error")
		}
		if len(database.executed) != 0 {
			t.Fatalf("executed = %#v", database.executed)
		}
	})

	t.Run("reports execution failures", func(t *testing.T) {
		database := &autoCreateProbeDB{execError: errors.New("boom")}
		if err := NewApp().ensureImportAutoCreateTarget(context.Background(), database, config, "app", "orders", options, false); err == nil {
			t.Fatal("expected the execution error to propagate")
		}
	})
}

func TestBuildImportFileOptionsHashTracksAutoCreateTable(t *testing.T) {
	base := ImportFileOptions{}
	created := ImportFileOptions{AutoCreateTable: &ImportAutoCreateTable{TableName: "orders", SQL: "CREATE TABLE orders (id bigint)"}}
	if buildImportFileOptionsHash(base) == buildImportFileOptionsHash(created) {
		t.Fatal("autoCreateTable must participate in the import options hash")
	}
	changed := ImportFileOptions{AutoCreateTable: &ImportAutoCreateTable{TableName: "orders", SQL: "CREATE TABLE orders (id text)"}}
	if buildImportFileOptionsHash(created) == buildImportFileOptionsHash(changed) {
		t.Fatal("a changed CREATE TABLE statement must invalidate the recovery contract")
	}
}

func TestImportDataWithProgressOptionsAutoCreatesTargetTable(t *testing.T) {
	database := &autoCreateProbeDB{fakeMetadataRetryDB: fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}},
	}}
	installImportTestDatabase(t, database)

	path := filepath.Join(t.TempDir(), "orders.csv")
	if err := os.WriteFile(path, []byte("id\n1\n2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newManagedImportTestApp(t)
	stopOnError := false
	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		"app",
		"orders",
		path,
		ImportFileOptions{
			JobID:           "auto-create-import",
			ContinueOnError: &stopOnError,
			AutoCreateTable: &ImportAutoCreateTable{
				TableName: "orders",
				SQL:       "CREATE TABLE `orders` (`id` BIGINT)",
			},
		},
	)
	if !result.Success {
		t.Fatalf("import failed: %#v", result)
	}
	if len(database.executed) != 1 || !strings.Contains(database.executed[0], "CREATE TABLE `orders`") {
		t.Fatalf("executed = %#v", database.executed)
	}
}
