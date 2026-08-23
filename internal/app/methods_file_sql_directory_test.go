package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildSQLDirectoryEntriesKeepsOnlySQLFilesAndNestedFolders(t *testing.T) {
	root := t.TempDir()
	nestedDir := filepath.Join(root, "nested")
	emptyDir := filepath.Join(root, "empty")
	if err := os.MkdirAll(nestedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	if err := os.MkdirAll(emptyDir, 0o755); err != nil {
		t.Fatalf("MkdirAll empty returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "z-last.sql"), []byte("select 1;"), 0o644); err != nil {
		t.Fatalf("WriteFile sql returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "ignore.txt"), []byte("skip"), 0o644); err != nil {
		t.Fatalf("WriteFile txt returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(nestedDir, "inner.SQL"), []byte("select 2;"), 0o644); err != nil {
		t.Fatalf("WriteFile nested sql returned error: %v", err)
	}

	entries, err := buildSQLDirectoryEntries(root)
	if err != nil {
		t.Fatalf("buildSQLDirectoryEntries returned error: %v", err)
	}

	if len(entries) != 3 {
		t.Fatalf("expected two folders and one sql file, got %d entries", len(entries))
	}
	if !entries[0].IsDir || entries[0].Name != "empty" || len(entries[0].Children) != 0 {
		t.Fatalf("expected empty directory first, got %#v", entries[0])
	}
	if !entries[1].IsDir || entries[1].Name != "nested" {
		t.Fatalf("expected nested directory second, got %#v", entries[1])
	}
	if len(entries[1].Children) != 1 || entries[1].Children[0].Name != "inner.SQL" {
		t.Fatalf("expected nested sql child, got %#v", entries[1].Children)
	}
	if entries[2].IsDir || entries[2].Name != "z-last.sql" {
		t.Fatalf("expected top-level sql file third, got %#v", entries[2])
	}
}

func TestWriteSQLFileByPathOverwritesExistingSQLFile(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "report.sql")
	if err := os.WriteFile(filePath, []byte("select 1;"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	result := writeSQLFileByPath(filePath, "select 2;\n")
	if !result.Success {
		t.Fatalf("expected sql file write to succeed, got %#v", result)
	}

	content, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if string(content) != "select 2;\n" {
		t.Fatalf("expected file content to be overwritten, got %q", string(content))
	}
}

func TestWriteSQLFileByPathRejectsDirectories(t *testing.T) {
	result := writeSQLFileByPath(t.TempDir(), "select 1;")
	if result.Success {
		t.Fatalf("expected directory write to fail, got %#v", result)
	}
}

func TestWriteSQLFileByPathRejectsEmptyPath(t *testing.T) {
	result := writeSQLFileByPath("   ", "select 1;")
	if result.Success {
		t.Fatalf("expected empty path write to fail, got %#v", result)
	}
}

func TestCreateSQLFileInDirectoryCreatesEmptySQLFile(t *testing.T) {
	root := t.TempDir()

	result := createSQLFileInDirectory(root, "draft")
	if !result.Success {
		t.Fatalf("expected sql file create to succeed, got %#v", result)
	}

	filePath := filepath.Join(root, "draft.sql")
	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if string(data) != "" {
		t.Fatalf("expected empty sql file, got %q", string(data))
	}
}

func TestCreateSQLFileInDirectoryRejectsPathTraversalName(t *testing.T) {
	result := createSQLFileInDirectory(t.TempDir(), "../escape.sql")
	if result.Success {
		t.Fatalf("expected path traversal name to fail, got %#v", result)
	}
}

func TestCreateSQLDirectoryInDirectoryCreatesEmptyDirectory(t *testing.T) {
	root := t.TempDir()

	result := createSQLDirectoryInDirectory(root, "reports")
	if !result.Success {
		t.Fatalf("expected sql directory create to succeed, got %#v", result)
	}

	target := filepath.Join(root, "reports")
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("Stat returned error: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("expected target to be a directory")
	}
}

func TestCreateSQLDirectoryInDirectoryRejectsPathTraversalName(t *testing.T) {
	result := createSQLDirectoryInDirectory(t.TempDir(), "../escape")
	if result.Success {
		t.Fatalf("expected path traversal directory name to fail, got %#v", result)
	}
}

func TestDeleteSQLFileByPathRemovesExistingSQLFile(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "old.sql")
	if err := os.WriteFile(filePath, []byte("select 1;"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	result := deleteSQLFileByPath(filePath)
	if !result.Success {
		t.Fatalf("expected sql file delete to succeed, got %#v", result)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("expected deleted sql file to be gone, stat err=%v", err)
	}
}

func TestDeleteSQLFileByPathRejectsNonSQLFile(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(filePath, []byte("skip"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	result := deleteSQLFileByPath(filePath)
	if result.Success {
		t.Fatalf("expected non sql file delete to fail, got %#v", result)
	}
}

func TestDeleteSQLDirectoryByPathRemovesEmptyDirectory(t *testing.T) {
	directoryPath := filepath.Join(t.TempDir(), "old")
	if err := os.Mkdir(directoryPath, 0o755); err != nil {
		t.Fatalf("Mkdir returned error: %v", err)
	}

	result := deleteSQLDirectoryByPath(directoryPath)
	if !result.Success {
		t.Fatalf("expected sql directory delete to succeed, got %#v", result)
	}
	if _, err := os.Stat(directoryPath); !os.IsNotExist(err) {
		t.Fatalf("expected deleted sql directory to be gone, stat err=%v", err)
	}
}

func TestDeleteSQLDirectoryByPathRejectsNonEmptyDirectory(t *testing.T) {
	directoryPath := filepath.Join(t.TempDir(), "non-empty")
	if err := os.Mkdir(directoryPath, 0o755); err != nil {
		t.Fatalf("Mkdir returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directoryPath, "query.sql"), []byte("select 1;"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	result := deleteSQLDirectoryByPath(directoryPath)
	if result.Success {
		t.Fatalf("expected non-empty sql directory delete to fail, got %#v", result)
	}
	if _, err := os.Stat(directoryPath); err != nil {
		t.Fatalf("expected non-empty sql directory to remain, stat err=%v", err)
	}
}

func TestDeleteSQLDirectoryByPathTreatsMissingDirectoryAsAlreadyDeleted(t *testing.T) {
	directoryPath := filepath.Join(t.TempDir(), "missing")

	result := deleteSQLDirectoryByPath(directoryPath)
	if !result.Success {
		t.Fatalf("expected missing sql directory delete to succeed, got %#v", result)
	}
	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("expected deletion metadata, got %#v", result.Data)
	}
	if data["directoryPath"] != directoryPath {
		t.Fatalf("expected directoryPath %q, got %#v", directoryPath, data["directoryPath"])
	}
	if data["alreadyMissing"] != true {
		t.Fatalf("expected alreadyMissing marker, got %#v", data["alreadyMissing"])
	}
}

func TestListSQLDirectoryMarksMissingDirectory(t *testing.T) {
	directoryPath := filepath.Join(t.TempDir(), "missing")

	result := (&App{}).ListSQLDirectory(directoryPath)
	if result.Success {
		t.Fatalf("expected missing sql directory list to fail, got %#v", result)
	}
	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("expected directory error metadata, got %#v", result.Data)
	}
	if data["errorCode"] != sqlDirectoryErrorCodeNotFound {
		t.Fatalf("expected directory_not_found error code, got %#v", data["errorCode"])
	}
	if data["directoryPath"] != directoryPath {
		t.Fatalf("expected directoryPath %q, got %#v", directoryPath, data["directoryPath"])
	}
}

func TestRenameSQLFileByPathRenamesWithinSameDirectory(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "old.sql")
	if err := os.WriteFile(source, []byte("select 1;"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	result := renameSQLFileByPath(source, "new-name")
	if !result.Success {
		t.Fatalf("expected sql file rename to succeed, got %#v", result)
	}
	target := filepath.Join(root, "new-name.sql")
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("expected target sql file, got err=%v", err)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("expected source sql file to be gone, stat err=%v", err)
	}
}

func TestRenameSQLDirectoryByPathRenamesWithinSameParent(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "old")
	if err := os.Mkdir(source, 0o755); err != nil {
		t.Fatalf("Mkdir returned error: %v", err)
	}

	result := renameSQLDirectoryByPath(source, "new-name")
	if !result.Success {
		t.Fatalf("expected sql directory rename to succeed, got %#v", result)
	}
	target := filepath.Join(root, "new-name")
	if info, err := os.Stat(target); err != nil || !info.IsDir() {
		t.Fatalf("expected target sql directory, got info=%#v err=%v", info, err)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("expected source sql directory to be gone, stat err=%v", err)
	}
}

func TestNormalizeSQLExportDefaultFilename(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "blank", raw: "   ", want: "query.sql"},
		{name: "appends extension", raw: "daily report", want: "daily report.sql"},
		{name: "keeps sql extension", raw: "report.SQL", want: "report.SQL"},
		{name: "uses base name", raw: filepath.Join("folder", "report.sql"), want: "report.sql"},
		{name: "replaces invalid chars", raw: `a:b*c?d"e<f>g|h`, want: "a_b_c_d_e_f_g_h.sql"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeSQLExportDefaultFilename(tt.raw); got != tt.want {
				t.Fatalf("expected %q, got %q", tt.want, got)
			}
		})
	}
}

func TestWriteExportedSQLFileByPathCreatesNewSQLFile(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "exported")

	result := writeExportedSQLFileByPath(filePath, "select 42;\n")
	if !result.Success {
		t.Fatalf("expected sql export to succeed, got %#v", result)
	}

	data, err := os.ReadFile(filePath + ".sql")
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if string(data) != "select 42;\n" {
		t.Fatalf("expected exported sql content, got %q", string(data))
	}
}

func TestReadSQLFileByPathReturnsLargeFileMetadata(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "big.sql")
	file, err := os.Create(filePath)
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if err := file.Truncate(maxSQLFileSizeBytes + 1024); err != nil {
		file.Close()
		t.Fatalf("Truncate returned error: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}

	result := readSQLFileByPath(filePath)
	if !result.Success {
		t.Fatalf("expected large sql file read to succeed, got %#v", result)
	}

	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("expected metadata map, got %#v", result.Data)
	}
	if data["isLargeFile"] != true {
		t.Fatalf("expected isLargeFile true, got %#v", data["isLargeFile"])
	}
	if data["filePath"] != filePath {
		t.Fatalf("expected filePath %q, got %#v", filePath, data["filePath"])
	}
}

func TestReadSQLFileByPathMarksMissingFile(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "missing.sql")

	result := readSQLFileByPath(filePath)
	if result.Success {
		t.Fatalf("expected missing sql file read to fail, got %#v", result)
	}

	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("expected error metadata map, got %#v", result.Data)
	}
	if data["errorCode"] != sqlFileErrorCodeNotFound {
		t.Fatalf("expected file_not_found error code, got %#v", data["errorCode"])
	}
	if data["filePath"] != filePath {
		t.Fatalf("expected filePath %q, got %#v", filePath, data["filePath"])
	}
}

func TestReadSQLFileWithMetadataByPathReturnsSmallFileContentAndPath(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "report.sql")
	if err := os.WriteFile(filePath, []byte("select 1;"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	result := readSQLFileWithMetadataByPath(filePath)
	if !result.Success {
		t.Fatalf("expected sql file read to succeed, got %#v", result)
	}

	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("expected metadata map, got %#v", result.Data)
	}
	if data["content"] != "select 1;" {
		t.Fatalf("expected content, got %#v", data["content"])
	}
	if data["filePath"] != filePath {
		t.Fatalf("expected filePath %q, got %#v", filePath, data["filePath"])
	}
	if data["name"] != "report.sql" {
		t.Fatalf("expected name report.sql, got %#v", data["name"])
	}
}
