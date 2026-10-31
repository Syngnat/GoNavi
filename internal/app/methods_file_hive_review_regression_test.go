package app

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveTransferReviewRelationAliasesAndCommaScopes(t *testing.T) {
	input := "CREATE VIEW source.v AS SELECT source.id,b.id FROM source.t source JOIN source.u b ON source.id=b.id"
	want := "CREATE VIEW v AS SELECT source.id,b.id FROM t source JOIN u b ON source.id=b.id"
	got, err := prepareHiveBackupDDL(input, "source", true)
	if err != nil || got != want {
		t.Fatalf("alias damaged: got=%s want=%s err=%v", got, want, err)
	}
	query := "CREATE VIEW a_view AS SELECT q.id FROM (SELECT e.id FROM events e,z_view z) q JOIN y_view y ON q.id=y.id"
	refs, err := hiveViewReferences(query, "source")
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{"source.events", "source.z_view", "source.y_view"} {
		if !containsHiveReviewString(refs, ref) {
			t.Fatalf("missing nested/comma relation %s: %#v", ref, refs)
		}
	}
	refs, err = hiveViewReferences("CREATE VIEW a AS SELECT extract(day FROM ts) FROM events", "source")
	if err != nil || containsHiveReviewString(refs, "source.ts") {
		t.Fatalf("expression FROM became a relation: %#v %v", refs, err)
	}
	views := map[string]string{"source.a_view": "a_view", "source.z_view": "z_view"}
	definitions := map[string]string{"source.a_view": "CREATE VIEW a_view AS SELECT e.id FROM events e,z_view z", "source.z_view": "CREATE VIEW z_view AS SELECT id FROM events"}
	order, err := orderHiveBackupViews(connection.ConnectionConfig{Type: "hive"}, "source", []string{"events", "a_view", "z_view"}, views, definitions)
	if err != nil || !reflect.DeepEqual(order, []string{"events", "z_view", "a_view"}) {
		t.Fatalf("comma dependency order %#v %v", order, err)
	}
}

func containsHiveReviewString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestHiveTransferReviewImpalaNativePartitions(t *testing.T) {
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	consumer := &hivePartitionExportConsumer{w: writer, table: "t", family: "impala", partitions: []connection.ColumnDefinition{{Name: "p", Type: "STRING"}, {Name: "year", Type: "INT"}}}
	if err := consumer.SetColumns([]string{"p", "year", "#Rows", "#Files", "Size", "Location"}); err != nil {
		t.Fatal(err)
	}
	for _, row := range []map[string]interface{}{
		{"p": "a%2Fb'", "year": 2026, "#Rows": 1, "Location": "hdfs://data/a"},
		{"p": "Total", "year": 2025, "#Rows": 1, "Location": "hdfs://data/real-total"},
		{"p": "Total", "year": nil, "#Rows": 2, "Location": ""},
	} {
		if err := consumer.ConsumeRow(row); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	if strings.Count(text, "ALTER TABLE") != 2 || !strings.Contains(text, "a%2Fb") || !strings.Contains(text, "Total") || strings.Contains(text, "hdfs://") {
		t.Fatal(text)
	}
	if err := consumer.SetColumns([]string{"p", "#Rows", "Location"}); err == nil {
		t.Fatal("missing partition schema accepted")
	}
	if hiveExportFamily(connection.ConnectionConfig{ConnectionParams: "hiveFamily=impala"}) != "impala" {
		t.Fatal("Impala family lost")
	}
}

func TestHiveTransferReviewLosslessNullFiles(t *testing.T) {
	values := []interface{}{nil, "NULL", "", "\\N", "\\\\N", "literal \"quote\"", "comma,newline\nvalue", "中文"}
	for _, format := range []string{"csv", "xlsx", "json"} {
		for _, encoding := range []string{"utf-8", "utf-16le", "gb18030"} {
			if format != "csv" && encoding != "utf-8" {
				continue
			}
			t.Run(format+"/"+encoding, func(t *testing.T) {
				rows := make([]map[string]interface{}, 0, len(values))
				for _, value := range values {
					rows = append(rows, map[string]interface{}{"v": value})
				}
				source := &hiveTransferFake{columns: []string{"v"}, rows: rows}
				path := filepath.Join(t.TempDir(), "paired."+format)
				output, err := os.Create(path)
				if err != nil {
					t.Fatal(err)
				}
				count, _, exportErr := exportQueryResultToFileWithContext(context.Background(), output, source, connection.ConnectionConfig{Type: "hive"}, "SELECT v", ExportFileOptions{Format: format, CSVEncoding: encoding}, nil)
				closeErr := output.Close()
				if exportErr != nil || closeErr != nil || count != int64(len(values)) {
					t.Fatalf("export count=%d error=%v close=%v", count, exportErr, closeErr)
				}
				collector := &importCollectConsumer{}
				token := "NULL"
				if err := streamImportFileWithOptions(path, collector, ImportFileOptions{LosslessHive: true, NullToken: &token}); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(collector.rows, rows) {
					t.Fatalf("literal/null lost: got %#v; want %#v", collector.rows, rows)
				}
			})
		}
	}
}

func TestHiveTransferReviewForeignCSVPreservesBackslashes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foreign.csv")
	input := "v\n\\N\n\"NULL\"\nNULL\n\"\"\n"
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	collector := &importCollectConsumer{}
	if err := streamImportFileWithOptions(path, collector, ImportFileOptions{LosslessHive: true}); err != nil {
		t.Fatal(err)
	}
	want := []map[string]interface{}{{"v": "\\N"}, {"v": "NULL"}, {"v": nil}, {"v": ""}}
	if !reflect.DeepEqual(collector.rows, want) {
		t.Fatalf("foreign CSV escaped: got=%#v want=%#v", collector.rows, want)
	}
	legacy := normalizeImportMapRowWithOptions([]string{"v"}, map[string]interface{}{"v": "NULL"}, ImportFileOptions{})
	if legacy["v"] != nil {
		t.Fatal("legacy NULL-token semantics changed")
	}
}
