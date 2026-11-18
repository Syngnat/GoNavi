package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
	runtime "GoNavi-Wails/internal/desktop"
)

// writeLegacyExportTarget 预置既有导出文件，返回写入前的原始内容。
func writeLegacyExportTarget(t *testing.T, path string, content string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("预置旧导出文件失败: %v", err)
	}
	return content
}

// assertNoTempExportResidue 断言目录中没有残留的原子导出临时文件。
func assertNoTempExportResidue(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读取目录失败: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".gonavi-export-") && strings.HasSuffix(entry.Name(), ".part") {
			t.Fatalf("残留临时导出文件: %s", entry.Name())
		}
	}
}

func TestExportQueryFailurePreservesExistingTarget(t *testing.T) {
	dir := t.TempDir()
	targetPath := filepath.Join(dir, "result.csv")
	legacy := writeLegacyExportTarget(t, targetPath, "LEGACY-CONTENT")

	fake := &fakeBatchWriteDB{queryErr: map[string]error{"SELECT 1": errors.New("query exploded")}}
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	newDatabaseFunc = func(string) (db.Database, error) { return fake, nil }

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.saveFileDialog = func(_ context.Context, options runtime.SaveDialogOptions) (string, error) {
		return targetPath, nil
	}
	result := app.ExportQuery(
		connection.ConnectionConfig{Type: "mysql"},
		"main",
		"SELECT 1",
		"result",
		"csv",
	)
	if result.Success {
		t.Fatalf("查询失败时导出应失败: %#v", result)
	}

	content, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("读取既有目标失败: %v", err)
	}
	if string(content) != legacy {
		t.Fatalf("失败后旧文件内容应保持不变，want=%q got=%q", legacy, string(content))
	}
	assertNoTempExportResidue(t, dir)
}

func TestExportDataSuccessReplacesExistingTargetAtomically(t *testing.T) {
	dir := t.TempDir()
	targetPath := filepath.Join(dir, "report.csv")
	writeLegacyExportTarget(t, targetPath, "LEGACY-CONTENT")

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.saveFileDialog = func(_ context.Context, options runtime.SaveDialogOptions) (string, error) {
		return targetPath, nil
	}
	result := app.ExportDataWithOptions(
		[]map[string]interface{}{{"id": 7, "name": "Bob"}},
		[]string{"id", "name"},
		"report",
		ExportFileOptions{Format: "csv"},
	)
	if !result.Success {
		t.Fatalf("ExportDataWithOptions 失败: %#v", result)
	}

	content, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatalf("读取导出目标失败: %v", err)
	}
	if !strings.Contains(string(content), "id,name") || !strings.Contains(string(content), "7,Bob") {
		t.Fatalf("目标应为完整新内容: %q", string(content))
	}
	if strings.Contains(string(content), "LEGACY-CONTENT") {
		t.Fatal("旧内容应被替换")
	}
	assertNoTempExportResidue(t, dir)
}

func TestOpenExportFileForTargetAbortPreservesExistingTarget(t *testing.T) {
	dir := t.TempDir()
	targetPath := filepath.Join(dir, "legacy.csv")
	if err := os.WriteFile(targetPath, []byte("OLD"), 0o644); err != nil {
		t.Fatal(err)
	}

	f, atomic, err := openExportFileForTarget(nil, targetPath)
	if err != nil {
		t.Fatalf("桌面目标打开失败: %v", err)
	}
	if atomic == nil {
		t.Fatal("桌面目标应返回原子导出目标")
	}
	// 未提交：旧文件保持不变
	if content, err := os.ReadFile(targetPath); err != nil || string(content) != "OLD" {
		t.Fatalf("未提交前旧文件应保持不变: %v %q", err, string(content))
	}
	if _, err := f.Write([]byte("PARTIAL")); err != nil {
		t.Fatal(err)
	}
	atomic.abort()
	if content, err := os.ReadFile(targetPath); err != nil || string(content) != "OLD" {
		t.Fatalf("abort 后旧文件应保持不变: %v %q", err, string(content))
	}
	assertNoTempExportResidue(t, dir)
}

func TestOpenExportFileForTargetCommitReplacesExistingTarget(t *testing.T) {
	dir := t.TempDir()
	targetPath := filepath.Join(dir, "legacy.csv")
	if err := os.WriteFile(targetPath, []byte("OLD"), 0o644); err != nil {
		t.Fatal(err)
	}

	f, atomic, err := openExportFileForTarget(nil, targetPath)
	if err != nil {
		t.Fatalf("桌面目标打开失败: %v", err)
	}
	if atomic == nil {
		t.Fatal("桌面目标应返回原子导出目标")
	}
	if _, err := f.Write([]byte("NEW")); err != nil {
		t.Fatal(err)
	}
	if err := atomic.commit(context.Background()); err != nil {
		t.Fatalf("commit 失败: %v", err)
	}
	if content, err := os.ReadFile(targetPath); err != nil || string(content) != "NEW" {
		t.Fatalf("commit 后目标应为新内容: %v %q", err, string(content))
	}
	atomic.abort() // committed 后为 no-op
	assertNoTempExportResidue(t, dir)
}
