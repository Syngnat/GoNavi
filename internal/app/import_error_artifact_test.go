package app

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func TestImportErrorArtifactStoresAllRowsBehindOpaqueID(t *testing.T) {
	store, err := newImportErrorArtifactStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	w, err := store.Begin("import-job-1")
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []ImportRowError{
		{SourceRow: 2, Category: "constraint", Code: "duplicate", Message: "duplicate key value is (alice@example.com)", Values: map[string]interface{}{"id": 1}},
		{SourceRow: 9, Category: "validation", Code: "invalid_date", Message: "bad date", Values: map[string]interface{}{"id": 8}},
	} {
		if err := w.Append(row); err != nil {
			t.Fatal(err)
		}
	}
	artifact, err := w.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if artifact.ID == "" || artifact.Count != 2 {
		t.Fatalf("unexpected artifact: %+v", artifact)
	}

	f, err := store.Open(artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	var rows []ImportRowError
	for scanner.Scan() {
		var row ImportRowError
		if err := json.Unmarshal(scanner.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, row)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].SourceRow != 2 || rows[1].SourceRow != 9 {
		t.Fatalf("unexpected stored rows: %#v", rows)
	}
	if rows[0].Message == "duplicate key value is (alice@example.com)" {
		t.Fatalf("stored driver message was not sanitized: %q", rows[0].Message)
	}

	if _, err := store.Open("../../outside"); !os.IsNotExist(err) {
		t.Fatalf("opaque artifact lookup should reject unknown IDs, got %v", err)
	}
}

func TestExportImportErrorRowsCopiesManagedArtifactAtomically(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()
	app.configDir = t.TempDir()
	store, err := app.ensureImportErrorArtifactStore()
	if err != nil {
		t.Fatal(err)
	}
	w, err := store.Begin("import-job-export")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Append(ImportRowError{SourceRow: 3, Category: "constraint", Message: "duplicate"}); err != nil {
		t.Fatal(err)
	}
	artifact, err := w.Finish()
	if err != nil {
		t.Fatal(err)
	}

	destination := filepath.Join(t.TempDir(), "failed-rows.jsonl")
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return destination, nil
	}
	result := app.ExportImportErrorRows(artifact.ID)
	if !result.Success {
		t.Fatalf("export failed: %#v", result)
	}
	content, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if len(content) == 0 {
		t.Fatal("exported artifact is empty")
	}
	if _, err := os.Stat(destination + ".part"); !os.IsNotExist(err) {
		t.Fatalf("temporary export file leaked: %v", err)
	}
}
