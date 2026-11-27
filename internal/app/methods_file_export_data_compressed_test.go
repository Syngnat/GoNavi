package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"

	runtime "GoNavi-Wails/internal/desktop"
	"GoNavi-Wails/internal/secretstore"
)

func encodeCompressedExportRows(t *testing.T, rows []map[string]interface{}) string {
	t.Helper()
	payload, err := json.Marshal(rows)
	if err != nil {
		t.Fatalf("marshal rows: %v", err)
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(payload); err != nil {
		t.Fatalf("gzip rows: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close gzip writer: %v", err)
	}
	return base64.StdEncoding.EncodeToString(compressed.Bytes())
}

func TestExportDataWithOptionsStreamsCompressedRows(t *testing.T) {
	targetPath := filepath.Join(t.TempDir(), "report.csv")
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.saveFileDialog = func(_ context.Context, _ runtime.SaveDialogOptions) (string, error) {
		return targetPath, nil
	}

	rows := []map[string]interface{}{
		{"id": 1, "name": "Alice"},
		{"id": 2, "name": "中文"},
	}
	result := app.ExportDataWithOptions(
		nil,
		[]string{"id", "name"},
		"report",
		ExportFileOptions{
			Format:         "csv",
			DataGzipBase64: encodeCompressedExportRows(t, rows),
			TotalRowsKnown: true,
			TotalRowsHint:  int64(len(rows)),
		},
	)
	if !result.Success {
		t.Fatalf("compressed export failed: %#v", result)
	}
	content, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("read exported file: %v", err)
	}
	if !strings.Contains(string(content), "id,name") || !strings.Contains(string(content), "1,Alice") || !strings.Contains(string(content), "2,中文") {
		t.Fatalf("unexpected CSV content: %q", string(content))
	}
}

func TestExportDataWithOptionsStreamsCompressedRowsToXLSX(t *testing.T) {
	targetPath := filepath.Join(t.TempDir(), "report.xlsx")
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.saveFileDialog = func(_ context.Context, _ runtime.SaveDialogOptions) (string, error) {
		return targetPath, nil
	}

	rows := []map[string]interface{}{
		{"id": 1, "name": "Alice"},
		{"id": 2, "name": "Bob"},
	}
	result := app.ExportDataWithOptions(
		nil,
		[]string{"id", "name"},
		"report",
		ExportFileOptions{
			Format:              "xlsx",
			DataGzipBase64:      encodeCompressedExportRows(t, rows),
			TotalRowsKnown:      true,
			TotalRowsHint:       int64(len(rows)),
			XLSXMaxRowsPerSheet: 10,
		},
	)
	if !result.Success {
		t.Fatalf("compressed XLSX export failed: %#v", result)
	}
	workbook, err := excelize.OpenFile(targetPath)
	if err != nil {
		t.Fatalf("open exported workbook: %v", err)
	}
	defer workbook.Close()
	sheetRows, err := workbook.GetRows("Sheet1")
	if err != nil {
		t.Fatalf("read worksheet: %v", err)
	}
	want := [][]string{{"id", "name"}, {"1", "Alice"}, {"2", "Bob"}}
	if len(sheetRows) != len(want) {
		t.Fatalf("worksheet rows = %#v, want %#v", sheetRows, want)
	}
	for rowIndex := range want {
		for columnIndex := range want[rowIndex] {
			if sheetRows[rowIndex][columnIndex] != want[rowIndex][columnIndex] {
				t.Fatalf("worksheet[%d][%d] = %q, want %q", rowIndex, columnIndex, sheetRows[rowIndex][columnIndex], want[rowIndex][columnIndex])
			}
		}
	}
}

func TestExportDataWithOptionsCompressedFailurePreservesTarget(t *testing.T) {
	dir := t.TempDir()
	targetPath := filepath.Join(dir, "report.csv")
	legacy := writeLegacyExportTarget(t, targetPath, "LEGACY-CONTENT")
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.saveFileDialog = func(_ context.Context, _ runtime.SaveDialogOptions) (string, error) {
		return targetPath, nil
	}

	result := app.ExportDataWithOptions(
		nil,
		[]string{"id", "name"},
		"report",
		ExportFileOptions{
			Format:         "csv",
			DataGzipBase64: base64.StdEncoding.EncodeToString([]byte("not gzip")),
		},
	)
	if result.Success {
		t.Fatalf("invalid compressed payload should fail: %#v", result)
	}
	content, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("read existing target: %v", err)
	}
	if string(content) != legacy {
		t.Fatalf("existing target changed: %q", string(content))
	}
	assertNoTempExportResidue(t, dir)
}
