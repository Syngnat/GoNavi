package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	runtime "GoNavi-Wails/internal/desktop"
)

func TestNormalizeExportTargetPath(t *testing.T) {
	root := t.TempDir()
	tests := []struct {
		name     string
		filePath string
		format   string
		want     string
	}{
		{name: "csv", filePath: filepath.Join(root, "report"), format: "csv", want: filepath.Join(root, "report.csv")},
		{name: "xlsx", filePath: filepath.Join(root, "report"), format: "xlsx", want: filepath.Join(root, "report.xlsx")},
		{name: "json", filePath: filepath.Join(root, "report"), format: "json", want: filepath.Join(root, "report.json")},
		{name: "markdown", filePath: filepath.Join(root, "report"), format: "md", want: filepath.Join(root, "report.md")},
		{name: "html", filePath: filepath.Join(root, "report"), format: "html", want: filepath.Join(root, "report.html")},
		{name: "sql", filePath: filepath.Join(root, "report"), format: "sql", want: filepath.Join(root, "report.sql")},
		{name: "keeps matching extension case", filePath: filepath.Join(root, "report.CSV"), format: "csv", want: filepath.Join(root, "report.CSV")},
		{name: "appends instead of replacing another extension", filePath: filepath.Join(root, "report.txt"), format: "csv", want: filepath.Join(root, "report.txt.csv")},
		{name: "trims path and format", filePath: "  " + filepath.Join(root, "report") + "  ", format: " XLSX ", want: filepath.Join(root, "report.xlsx")},
		{name: "blank path", filePath: "   ", format: "csv", want: ""},
		{name: "ignores unsupported format", filePath: filepath.Join(root, "report"), format: `..\\exe`, want: filepath.Join(root, "report")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeExportTargetPath(tt.filePath, tt.format); got != tt.want {
				t.Fatalf("normalizeExportTargetPath(%q, %q) = %q, want %q", tt.filePath, tt.format, got, tt.want)
			}
		})
	}
}

func TestExportFileDialogFilters(t *testing.T) {
	for _, format := range []string{"csv", "xlsx", "json", "md", "html", "sql"} {
		t.Run(format, func(t *testing.T) {
			filters := exportFileDialogFilters(format)
			if len(filters) != 1 {
				t.Fatalf("exportFileDialogFilters(%q) returned %d filters, want 1", format, len(filters))
			}
			if want := "*." + format; filters[0].Pattern != want {
				t.Fatalf("filter pattern = %q, want %q", filters[0].Pattern, want)
			}
			if filters[0].DisplayName != strings.ToUpper(format) {
				t.Fatalf("filter display name = %q, want %q", filters[0].DisplayName, strings.ToUpper(format))
			}
		})
	}

	if filters := exportFileDialogFilters("../../exe"); len(filters) != 0 {
		t.Fatalf("unsupported format returned filters: %#v", filters)
	}
}

func TestExportDataWithOptionsAppendsFormatExtension(t *testing.T) {
	selectedPath := filepath.Join(t.TempDir(), "report")
	app := &App{
		saveFileDialog: func(_ context.Context, options runtime.SaveDialogOptions) (string, error) {
			if options.DefaultFilename != "report.csv" {
				t.Fatalf("default filename = %q, want report.csv", options.DefaultFilename)
			}
			if len(options.Filters) != 1 || options.Filters[0].Pattern != "*.csv" {
				t.Fatalf("unexpected CSV filters: %#v", options.Filters)
			}
			return selectedPath, nil
		},
	}

	result := app.ExportDataWithOptions(
		[]map[string]interface{}{{"id": 1, "name": "Alice"}},
		[]string{"id", "name"},
		"report",
		ExportFileOptions{Format: "csv"},
	)
	if !result.Success {
		t.Fatalf("ExportDataWithOptions failed: %#v", result)
	}

	targetPath := selectedPath + ".csv"
	content, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("read normalized export target %q: %v", targetPath, err)
	}
	if !strings.Contains(string(content), "id,name") || !strings.Contains(string(content), "1,Alice") {
		t.Fatalf("unexpected CSV content: %q", string(content))
	}
	if _, err := os.Stat(selectedPath); !os.IsNotExist(err) {
		t.Fatalf("extensionless export path should not exist, stat err=%v", err)
	}
}

func TestExportDataWithOptionsDoesNotSilentlyOverwriteNormalizedTarget(t *testing.T) {
	selectedPath := filepath.Join(t.TempDir(), "report")
	targetPath := selectedPath + ".csv"
	if err := os.WriteFile(targetPath, []byte("keep-existing-content"), 0o600); err != nil {
		t.Fatalf("prepare existing export target: %v", err)
	}
	app := &App{
		saveFileDialog: func(_ context.Context, _ runtime.SaveDialogOptions) (string, error) {
			return selectedPath, nil
		},
	}

	result := app.ExportDataWithOptions(
		[]map[string]interface{}{{"id": 1}},
		[]string{"id"},
		"report",
		ExportFileOptions{Format: "csv"},
	)
	if result.Success {
		t.Fatalf("expected export to reject an unconfirmed normalized target overwrite, got %#v", result)
	}
	if !strings.Contains(result.Message, ".csv") || !strings.Contains(result.Message, targetPath) {
		t.Fatalf("overwrite rejection should identify the normalized target, got %q", result.Message)
	}

	content, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("read existing export target: %v", err)
	}
	if string(content) != "keep-existing-content" {
		t.Fatalf("existing export target was overwritten: %q", string(content))
	}
}

func TestWriteExportedSQLFileByPathDoesNotSilentlyOverwriteNormalizedTarget(t *testing.T) {
	selectedPath := filepath.Join(t.TempDir(), "query")
	targetPath := selectedPath + ".sql"
	if err := os.WriteFile(targetPath, []byte("select 'keep';\n"), 0o600); err != nil {
		t.Fatalf("prepare existing SQL target: %v", err)
	}

	result := writeExportedSQLFileByPath(selectedPath, "select 'replace';\n")
	if result.Success {
		t.Fatalf("expected SQL export to reject an unconfirmed normalized target overwrite, got %#v", result)
	}
	content, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("read existing SQL target: %v", err)
	}
	if string(content) != "select 'keep';\n" {
		t.Fatalf("existing SQL target was overwritten: %q", string(content))
	}
}

func TestResolveExportTargetPathAllowsExplicitExistingTarget(t *testing.T) {
	targetPath := filepath.Join(t.TempDir(), "report.csv")
	if err := os.WriteFile(targetPath, []byte("confirmed"), 0o600); err != nil {
		t.Fatalf("prepare explicit export target: %v", err)
	}

	resolved, err := resolveExportTargetPath(targetPath, "csv")
	if err != nil {
		t.Fatalf("explicit target should retain the save dialog overwrite confirmation: %v", err)
	}
	if resolved != targetPath {
		t.Fatalf("resolved explicit target = %q, want %q", resolved, targetPath)
	}
}
