package app

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
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

func TestImportErrorArtifactCapsRowsAndReportsOmittedScope(t *testing.T) {
	store, err := newImportErrorArtifactStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	w, err := store.Begin("import-job-cap")
	if err != nil {
		t.Fatal(err)
	}
	for index := int64(0); index < maxImportErrorArtifactRows+3; index++ {
		if err := w.Append(ImportRowError{
			SourceRow: index + 1,
			Category:  "database",
			Retryable: true,
			Values:    map[string]interface{}{"id": index},
			Message:   "duplicate",
		}); err != nil {
			t.Fatal(err)
		}
	}
	artifact, err := w.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if !artifact.Truncated || artifact.Count != maxImportErrorArtifactRows || artifact.OmittedCount != 3 {
		t.Fatalf("unexpected bounded artifact metadata: %#v", artifact)
	}
	if artifact.Bytes <= 0 || artifact.Bytes > maxImportErrorArtifactBytes || artifact.RetryableCount != maxImportErrorArtifactRows {
		t.Fatalf("unexpected bounded artifact size/scope: %#v", artifact)
	}
	file, err := store.Open(artifact.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	content, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(content)) != artifact.Bytes || strings.Count(string(content), "\n") != int(maxImportErrorArtifactRows) {
		t.Fatalf("artifact bytes/lines escaped quota: bytes=%d metadata=%d lines=%d", len(content), artifact.Bytes, strings.Count(string(content), "\n"))
	}
}

func TestImportErrorArtifactPublishesTruncatedArtifactWithoutRetainedRows(t *testing.T) {
	store, err := newImportErrorArtifactStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	w, err := store.Begin("import-job-large-row")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Append(ImportRowError{Category: "database", Values: map[string]interface{}{
		"value": strings.Repeat("x", int(maxImportErrorArtifactBytes)),
	}, Message: "too large"}); err != nil {
		t.Fatal(err)
	}
	artifact, err := w.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if artifact.ID == "" || !artifact.Truncated || artifact.Count != 0 || artifact.OmittedCount != 1 {
		t.Fatalf("oversized first row did not publish bounded metadata: %#v", artifact)
	}
}

func TestImportErrorArtifactCapsBytesBeforeRowLimit(t *testing.T) {
	store, err := newImportErrorArtifactStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	w, err := store.Begin("import-job-byte-cap")
	if err != nil {
		t.Fatal(err)
	}
	message := strings.Repeat("x", 8*1024)
	for index := int64(0); index < maxImportErrorArtifactRows; index++ {
		if err := w.Append(ImportRowError{
			SourceRow: index + 1,
			Category:  "database",
			Values:    map[string]interface{}{"id": index},
			Message:   message,
		}); err != nil {
			t.Fatal(err)
		}
		if w.truncated {
			break
		}
	}
	artifact, err := w.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if !artifact.Truncated || artifact.OmittedCount == 0 || artifact.Count >= maxImportErrorArtifactRows || artifact.Bytes > maxImportErrorArtifactBytes {
		t.Fatalf("byte quota was not enforced before row quota: %#v", artifact)
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

func TestExportImportErrorRowsRejectsOversizedLegacyArtifactAtomically(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()
	app.configDir = t.TempDir()
	store, err := app.ensureImportErrorArtifactStore()
	if err != nil {
		t.Fatal(err)
	}
	w, err := store.Begin("legacy-oversized-export")
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := w.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(w.path, maxImportErrorArtifactBytes+1); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "failed-rows.jsonl")
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return destination, nil
	}
	result := app.ExportImportErrorRows(artifact.ID)
	if result.Success || !strings.Contains(result.Message, "byte limit") {
		t.Fatalf("oversized legacy export was not rejected clearly: %#v", result)
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("oversized legacy export published a partial target: %v", err)
	}
}
