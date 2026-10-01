package app

import (
	"os"
	"path/filepath"
	"testing"
)

// 用户可能绕过应用直接从文件夹删驱动文件。此时 installed.json 仍在，
// 状态页若不校验二进制就会谎报「已安装」并给出「仍可正常使用」的误导文案。

func installDriverWithMetaOnly(t *testing.T, root string, driverType string) (string, string) {
	t.Helper()

	driverDir := filepath.Join(root, driverType)
	if err := os.MkdirAll(driverDir, 0o755); err != nil {
		t.Fatalf("创建驱动目录失败: %v", err)
	}
	executablePath := filepath.Join(driverDir, driverType+"-driver-agent")
	metaPath := installedDriverMetaPath(root, driverType)
	payload := `{"driverType":"` + driverType + `","version":"1.8.22","agentRevision":"src-test",` +
		`"executablePath":"` + executablePath + `"}`
	if err := os.WriteFile(metaPath, []byte(payload), 0o644); err != nil {
		t.Fatalf("写入元数据失败: %v", err)
	}
	return metaPath, executablePath
}

func statusItemFor(t *testing.T, app *App, root string, driverType string) driverStatusItem {
	t.Helper()

	result := app.GetDriverStatusList(root, "")
	if !result.Success {
		t.Fatalf("获取驱动状态失败: %v", result.Message)
	}
	for _, item := range result.Data.(map[string]interface{})["drivers"].([]driverStatusItem) {
		if item.Type == driverType {
			return item
		}
	}
	t.Fatalf("状态列表中没有 %s", driverType)
	return driverStatusItem{}
}

func TestProbeOptionalDriverInstallTreatsMissingBinaryAsNotInstalled(t *testing.T) {
	root := t.TempDir()
	metaPath, _ := installDriverWithMetaOnly(t, root, "dameng")

	probe := probeOptionalDriverInstall(root, "dameng")
	if !probe.MetaExists {
		t.Fatal("元数据存在，MetaExists 应为 true")
	}
	if probe.BinaryPresent {
		t.Fatal("二进制不存在，BinaryPresent 应为 false")
	}
	if probe.Installed {
		t.Fatal("二进制不存在时不应视为已安装")
	}
	if probe.StaleMetaPath != metaPath {
		t.Fatalf("应报告失效元数据路径，want=%q got=%q", metaPath, probe.StaleMetaPath)
	}
}

func TestProbeOptionalDriverInstallAcceptsCompleteInstall(t *testing.T) {
	root := t.TempDir()
	_, executablePath := installDriverWithMetaOnly(t, root, "dameng")
	if err := os.WriteFile(executablePath, []byte("binary"), 0o755); err != nil {
		t.Fatalf("写入二进制失败: %v", err)
	}

	probe := probeOptionalDriverInstall(root, "dameng")
	if !probe.Installed {
		t.Fatal("元数据与二进制齐备时应视为已安装")
	}
	if probe.StaleMetaPath != "" {
		t.Fatalf("完整安装不应报告失效元数据，got=%q", probe.StaleMetaPath)
	}
}

func TestProbeOptionalDriverInstallIgnoresNonOptionalDrivers(t *testing.T) {
	root := t.TempDir()

	// 内置/未知类型不走可选驱动判定，由调用方另行处理。
	if probe := probeOptionalDriverInstall(root, "mysql"); probe.MetaExists || probe.Installed {
		t.Fatalf("非可选驱动不应产生探测结果: %#v", probe)
	}
}

func TestGetDriverStatusListReportsDeletedBinaryAsNotInstalled(t *testing.T) {
	root := t.TempDir()
	metaPath, _ := installDriverWithMetaOnly(t, root, "dameng")

	app := NewApp()
	app.SetLanguage("zh-CN")
	item := statusItemFor(t, app, root, "dameng")

	if item.PackageInstalled {
		t.Fatalf("二进制已删除，不应报告为已安装: %#v", item)
	}
	if item.InstalledVersion != "" {
		t.Fatalf("不应残留幽灵版本号，got=%q", item.InstalledVersion)
	}
	if _, err := os.Stat(metaPath); !os.IsNotExist(err) {
		t.Fatalf("失效元数据应被清理: %v", err)
	}
	// 空壳目录也一并收掉，避免干扰用户排查。
	if _, err := os.Stat(filepath.Dir(metaPath)); !os.IsNotExist(err) {
		t.Fatalf("空驱动目录应被清理: %v", err)
	}
}

func TestGetDriverStatusListKeepsValidInstallUntouched(t *testing.T) {
	root := t.TempDir()
	metaPath, executablePath := installDriverWithMetaOnly(t, root, "dameng")
	if err := os.WriteFile(executablePath, []byte("binary"), 0o755); err != nil {
		t.Fatalf("写入二进制失败: %v", err)
	}

	app := NewApp()
	app.SetLanguage("zh-CN")
	item := statusItemFor(t, app, root, "dameng")

	if !item.PackageInstalled {
		t.Fatalf("完整安装应报告为已安装: %#v", item)
	}
	// 有效安装的元数据与目录都不能被动。
	if _, err := os.Stat(metaPath); err != nil {
		t.Fatalf("有效元数据不应被清理: %v", err)
	}
	if _, err := os.Stat(filepath.Dir(metaPath)); err != nil {
		t.Fatalf("有效驱动目录不应被清理: %v", err)
	}
}

func TestRemoveStaleInstalledDriverMetaLeavesSiblingFiles(t *testing.T) {
	root := t.TempDir()
	driverDir := filepath.Join(root, "dameng")
	if err := os.MkdirAll(driverDir, 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	metaPath := filepath.Join(driverDir, "installed.json")
	if err := os.WriteFile(metaPath, []byte("{}"), 0o644); err != nil {
		t.Fatalf("写入元数据失败: %v", err)
	}
	// 目录里还有别的文件（如 DuckDB 运行时依赖）：只删元数据，不删目录。
	sibling := filepath.Join(driverDir, "duckdb.dll")
	if err := os.WriteFile(sibling, []byte("dll"), 0o644); err != nil {
		t.Fatalf("写入同级文件失败: %v", err)
	}

	removeStaleInstalledDriverMeta(metaPath)

	if _, err := os.Stat(metaPath); !os.IsNotExist(err) {
		t.Fatalf("元数据应被删除: %v", err)
	}
	if _, err := os.Stat(sibling); err != nil {
		t.Fatalf("同级文件不应被误删: %v", err)
	}
	if _, err := os.Stat(driverDir); err != nil {
		t.Fatalf("非空目录不应被删除: %v", err)
	}
}

func TestRemoveStaleInstalledDriverMetaToleratesEmptyPath(t *testing.T) {
	// 空路径是无效输入，应该静默返回而不是 panic 或误删。
	removeStaleInstalledDriverMeta("")
	removeStaleInstalledDriverMeta("   ")
}
