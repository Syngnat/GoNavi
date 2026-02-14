//go:build gonavi_full_drivers || gonavi_sqlite_driver

package db

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestResolveSQLiteDSNRejectsHostPort(t *testing.T) {
	_, err := resolveSQLiteDSN(connection.ConnectionConfig{Type: "sqlite", Host: "localhost:3306"})
	if err == nil {
		t.Fatalf("期望拦截 host:port 输入")
	}
	if !strings.Contains(err.Error(), "本地数据库文件路径") {
		t.Fatalf("错误提示不符合预期: %v", err)
	}
}

func TestResolveSQLiteDSNFallbackDatabase(t *testing.T) {
	dsn, err := resolveSQLiteDSN(connection.ConnectionConfig{Type: "sqlite", Database: "/tmp/demo.sqlite"})
	if err != nil {
		t.Fatalf("解析 DSN 失败: %v", err)
	}
	if dsn != "/tmp/demo.sqlite" {
		t.Fatalf("期望使用 database 作为 DSN，实际=%s", dsn)
	}
}

func TestResolveSQLiteDSNNormalizesWindowsLegacyPath(t *testing.T) {
	dsn, err := resolveSQLiteDSN(connection.ConnectionConfig{Type: "sqlite", Host: `F:\py\py\history.db:3306:3306`})
	if err != nil {
		t.Fatalf("解析 DSN 失败: %v", err)
	}
	if dsn != `F:\py\py\history.db` {
		t.Fatalf("期望清理历史端口污染，实际=%s", dsn)
	}
}

func TestResolveSQLiteDSNNormalizesWindowsPathWithLeadingSlash(t *testing.T) {
	dsn, err := resolveSQLiteDSN(connection.ConnectionConfig{Type: "sqlite", Host: `/F:\py\py\history.db:3306`})
	if err != nil {
		t.Fatalf("解析 DSN 失败: %v", err)
	}
	if dsn != `F:\py\py\history.db` {
		t.Fatalf("期望清理前导斜杠与端口污染，实际=%s", dsn)
	}
}

func TestEnsureSQLiteParentDirCreatesNestedDir(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "nested", "child", "demo.sqlite")
	if err := ensureSQLiteParentDir(target); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	info, err := os.Stat(filepath.Dir(target))
	if err != nil {
		t.Fatalf("目录不存在: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("目标不是目录: %s", filepath.Dir(target))
	}
}

func TestLooksLikeHostPort(t *testing.T) {
	if !looksLikeHostPort("localhost:3306") {
		t.Fatalf("localhost:3306 应识别为 host:port")
	}
	if looksLikeHostPort("/tmp/demo.sqlite") {
		t.Fatalf("/tmp/demo.sqlite 不应识别为 host:port")
	}
	if looksLikeHostPort(`C:\sqlite\demo.db`) {
		t.Fatalf("Windows 路径不应识别为 host:port")
	}
}
