package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/secretstore"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func newExportTextTestApp() *App {
	return NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
}

func TestExportTextFileWritesHTMLContent(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "compare-report.html")
	app := newExportTextTestApp()
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return target, nil
	}

	result := app.ExportTextFile("compare-report", "<html><body>ok</body></html>", "html")
	if !result.Success {
		t.Fatalf("ExportTextFile 失败: %#v", result)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("读取导出文件失败: %v", err)
	}
	if string(content) != "<html><body>ok</body></html>" {
		t.Fatalf("内容应原样落盘, got=%q", string(content))
	}
	paths, ok := result.Data.(map[string]string)
	if !ok || paths["path"] != target {
		t.Fatalf("应回报落盘路径, got=%#v", result.Data)
	}
}

func TestExportTextFileAppendsMissingExtension(t *testing.T) {
	dir := t.TempDir()
	app := newExportTextTestApp()
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return filepath.Join(dir, "report"), nil
	}

	result := app.ExportTextFile("report", "<html></html>", "html")
	if !result.Success {
		t.Fatalf("ExportTextFile 失败: %#v", result)
	}
	if _, err := os.Stat(filepath.Join(dir, "report.html")); err != nil {
		t.Fatalf("缺少扩展名时应自动补 .html: %v", err)
	}
}

func TestExportTextFileCancelsWithoutWriting(t *testing.T) {
	dir := t.TempDir()
	app := newExportTextTestApp()
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return "", nil
	}

	result := app.ExportTextFile("report", "<html></html>", "html")
	if result.Success {
		t.Fatalf("取消时不应报告成功: %#v", result)
	}
	if result.Message != "已取消" {
		t.Fatalf("取消文案应保持既有哨兵值, got=%q", result.Message)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读取目录失败: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("取消后不应留下文件: %v", entries)
	}
}

func TestExportTextFileRejectsUnknownFormat(t *testing.T) {
	app := newExportTextTestApp()
	result := app.ExportTextFile("report", "content", "exe")
	if result.Success {
		t.Fatalf("未知扩展名应被拒绝: %#v", result)
	}
	if !strings.Contains(result.Message, "unsupported text export format") {
		t.Fatalf("错误应说明格式不受支持, got=%q", result.Message)
	}
}

func TestExportTextFileRejectsOversizedContent(t *testing.T) {
	app := newExportTextTestApp()
	oversized := strings.Repeat("x", maxExportedTextBytes+1)
	result := app.ExportTextFile("report", oversized, "txt")
	if result.Success {
		t.Fatalf("超限内容应被拒绝: %#v", result)
	}
	if result.Message != errExportedTextTooLarge.Error() {
		t.Fatalf("应返回体积上限错误, got=%q", result.Message)
	}
}

func TestBuildExportedTextFileNameFallsBackToTimestamp(t *testing.T) {
	name := buildExportedTextFileName("   ", "html")
	if !strings.HasSuffix(name, ".html") {
		t.Fatalf("空名称应回落为带时间戳的文件名, got=%q", name)
	}
	if !strings.HasPrefix(name, "gonavi-export-") {
		t.Fatalf("空名称前缀不符合约定, got=%q", name)
	}
	sanitized := buildExportedTextFileName(`a/b:c*?"<>|`, "md")
	if strings.ContainsAny(sanitized, `/\:*?"<>|`) {
		t.Fatalf("文件名应剔除非法字符, got=%q", sanitized)
	}
}
