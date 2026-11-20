package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateLegacyDorisDriverInstallRenamesStorageAndMetadata(t *testing.T) {
	root := t.TempDir()
	legacyDir := filepath.Join(root, "diros")
	if err := os.MkdirAll(legacyDir, 0o755); err != nil {
		t.Fatalf("创建旧 Doris 目录失败: %v", err)
	}
	legacyExecutable := filepath.Join(legacyDir, optionalDriverExecutableBaseNameForType("diros"))
	if err := os.WriteFile(legacyExecutable, []byte("legacy-doris-agent"), 0o755); err != nil {
		t.Fatalf("写入旧 Doris 代理失败: %v", err)
	}
	legacyMeta := installedDriverPackage{
		DriverType:     "diros",
		Version:        "1.9.3",
		FilePath:       legacyExecutable,
		FileName:       filepath.Base(legacyExecutable),
		ExecutablePath: legacyExecutable,
		DownloadedAt:   "2026-11-20T10:00:00+08:00",
	}
	payload, err := json.MarshalIndent(legacyMeta, "", "  ")
	if err != nil {
		t.Fatalf("编码旧 Doris 元数据失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(legacyDir, "installed.json"), payload, 0o644); err != nil {
		t.Fatalf("写入旧 Doris 元数据失败: %v", err)
	}

	migrateLegacyDorisDriverInstall(root)

	targetDir := filepath.Join(root, "doris")
	targetExecutable := filepath.Join(targetDir, optionalDriverExecutableBaseNameForType("doris"))
	if _, err := os.Stat(targetExecutable); err != nil {
		t.Fatalf("迁移后应存在 doris 代理: %v", err)
	}
	if _, err := os.Stat(legacyDir); !os.IsNotExist(err) {
		t.Fatalf("迁移后不应保留 diros 目录: %v", err)
	}

	content, err := os.ReadFile(filepath.Join(targetDir, "installed.json"))
	if err != nil {
		t.Fatalf("读取迁移后元数据失败: %v", err)
	}
	var meta installedDriverPackage
	if err := json.Unmarshal(content, &meta); err != nil {
		t.Fatalf("解析迁移后元数据失败: %v", err)
	}
	if meta.FilePath != targetExecutable || meta.ExecutablePath != targetExecutable {
		t.Fatalf("元数据路径应迁移到 doris: %#v", meta)
	}
	if meta.FileName != filepath.Base(targetExecutable) {
		t.Fatalf("元数据文件名应迁移到 doris: %#v", meta)
	}
}
