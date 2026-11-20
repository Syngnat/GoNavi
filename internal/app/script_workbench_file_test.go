package app

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/scriptengine"

	"github.com/xuri/excelize/v2"
)

func writeScriptWorkbenchXLSX(t *testing.T, rows [][]any) string {
	t.Helper()
	book := excelize.NewFile()
	sheet := book.GetSheetName(0)
	for index, row := range rows {
		if err := book.SetSheetRow(sheet, "A"+itoaForScriptTest(index+1), &row); err != nil {
			t.Fatalf("set xlsx row %d: %v", index+1, err)
		}
	}
	path := filepath.Join(t.TempDir(), "ids.xlsx")
	if err := book.SaveAs(path); err != nil {
		t.Fatalf("save xlsx: %v", err)
	}
	_ = book.Close()
	return path
}

func itoaForScriptTest(value int) string {
	if value == 0 {
		return "0"
	}
	var result [20]byte
	index := len(result)
	for value > 0 {
		index--
		result[index] = byte('0' + value%10)
		value /= 10
	}
	return string(result[index:])
}

func TestScriptWorkbenchFileReaderStreamsXLSXBatches(t *testing.T) {
	path := writeScriptWorkbenchXLSX(t, [][]any{
		{"user_id", "status"},
		{1, "active"},
		{2, "disabled"},
		{3, "active"},
		{4, "pending"},
		{5, "active"},
	})
	reader, err := newScriptWorkbenchFileReader(context.Background(), scriptPreparedInput{
		alias:     "ids",
		path:      path,
		name:      "ids.xlsx",
		sheetName: "Sheet1",
		headerRow: 1,
		batchSize: 2,
	})
	if err != nil {
		t.Fatalf("new reader: %v", err)
	}
	t.Cleanup(func() { _ = reader.Close() })
	if strings.Join(reader.columns, ",") != "user_id,status" {
		t.Fatalf("columns = %v", reader.columns)
	}

	batchSizes := make([]int, 0, 3)
	seen := make([]string, 0, 5)
	for {
		rows, done, err := reader.Next()
		if err != nil {
			t.Fatalf("next: %v", err)
		}
		if done {
			break
		}
		batchSizes = append(batchSizes, len(rows))
		for _, row := range rows {
			seen = append(seen, row["status"].(string))
		}
	}
	if fmt.Sprint(batchSizes) != "[2 2 1]" {
		t.Fatalf("batch sizes = %v", batchSizes)
	}
	if len(seen) != 5 || seen[0] != "active" || seen[4] != "active" {
		t.Fatalf("streamed rows = %v", seen)
	}
}

func TestScriptWorkbenchHostFileRequestsRequireBoundAlias(t *testing.T) {
	path := writeScriptWorkbenchXLSX(t, [][]any{
		{"id"},
		{1},
	})
	host := &scriptWorkbenchHost{
		app: newScriptWorkbenchTestApp(t, false),
		prepared: &scriptWorkbenchPrepared{
			inputs: map[string]scriptPreparedInput{
				"ids": {
					alias:     "ids",
					path:      path,
					name:      "ids.xlsx",
					sheetName: "Sheet1",
					headerRow: 1,
					batchSize: 1,
				},
			},
		},
		readers: make(map[string]*scriptWorkbenchFileReader),
	}
	t.Cleanup(host.Close)
	params, _ := json.Marshal(map[string]any{"alias": "missing"})
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest("file.open", params)); err == nil {
		t.Fatal("unbound file alias must be rejected")
	}

	params, _ = json.Marshal(map[string]any{"alias": "ids"})
	opened, err := host.Handle(context.Background(), scriptengineHostRequestForTest("file.open", params))
	if err != nil {
		t.Fatalf("open bound file: %v", err)
	}
	readerID := opened.(map[string]any)["readerId"].(string)
	nextParams, _ := json.Marshal(map[string]any{"readerId": readerID})
	next, err := host.Handle(context.Background(), scriptengineHostRequestForTest("file.next", nextParams))
	if err != nil {
		t.Fatalf("next bound file: %v", err)
	}
	rows := next.(map[string]any)["rows"].([]map[string]any)
	if len(rows) != 1 || rows[0]["id"] == nil {
		t.Fatalf("next rows = %+v", rows)
	}
	done, err := host.Handle(context.Background(), scriptengineHostRequestForTest("file.next", nextParams))
	if err != nil {
		t.Fatalf("next done: %v", err)
	}
	doneRows, ok := done.(map[string]any)["rows"].([]map[string]any)
	if !ok || len(doneRows) != 0 {
		t.Fatalf("done rows must be an empty array: %+v", done)
	}
}

func TestScriptWorkbenchBatchConsumerEnforcesPageByteBudget(t *testing.T) {
	if scriptWorkbenchInputPageBytes >= scriptengine.MaxFrameBytes {
		t.Fatalf("script input page budget %d must stay below the frame limit", scriptWorkbenchInputPageBytes)
	}
	options := scriptWorkbenchInputOptions(scriptPreparedInput{})
	if options.lexicalLimits.maxRowBytes >= maxImportRowBytes ||
		options.xlsxLimits.MaxEntryUncompressedBytes >= defaultXLSXArchiveResourceLimits.MaxEntryUncompressedBytes {
		t.Fatalf("script input quotas are not stricter: %+v / %+v", options.lexicalLimits, options.xlsxLimits)
	}
	consumer := &scriptWorkbenchBatchConsumer{
		ctx:          context.Background(),
		batchSize:    100,
		maxPageBytes: 128,
		events:       make(chan scriptWorkbenchFileEvent, 2),
	}
	err := consumer.ConsumeRow(map[string]any{"payload": strings.Repeat("x", 256)})
	if err == nil || !strings.Contains(err.Error(), "page budget") {
		t.Fatalf("oversized row error = %v", err)
	}
}
