package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/db"
)

// 用户可能绕过应用直接从文件夹删驱动文件。此时 installed.json 仍在，
// 状态页若不校验二进制就会谎报「已安装」并给出「仍可正常使用」的误导文案。

func installDriverWithMetaOnly(t *testing.T, root string, driverType string) (string, string) {
	t.Helper()

	driverDir := driverInstallDir(root, driverType)
	if err := os.MkdirAll(driverDir, 0o755); err != nil {
		t.Fatalf("创建驱动目录失败: %v", err)
	}
	// 二进制路径必须与实现同源解析：Windows 代理名带 .exe，手拼裸名会在
	// 夹具与状态探测之间产生路径分歧，探测永远判定二进制缺失。
	executablePath, err := db.ResolveOptionalDriverAgentExecutablePathForVersion(root, driverType, "1.8.22")
	if err != nil {
		t.Fatalf("解析驱动二进制路径失败: %v", err)
	}
	metaPath := installedDriverMetaPath(root, driverType)
	// 路径必须经 json.Marshal 转义：Windows 分隔符 `\` 直拼进 JSON 字符串会
	// 构成 \U、\k 等非法转义，元数据在 Windows 上永远解析失败。
	payload, err := json.Marshal(map[string]string{
		"driverType":     driverType,
		"version":        "1.8.22",
		"agentRevision":  "src-test",
		"executablePath": executablePath,
	})
	if err != nil {
		t.Fatalf("编码元数据失败: %v", err)
	}
	if err := os.WriteFile(metaPath, payload, 0o644); err != nil {
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

func TestDriverStatusUsesCanonicalDorisStoragePaths(t *testing.T) {
	root := t.TempDir()
	_, executablePath := installDriverWithMetaOnly(t, root, "diros")
	if err := os.WriteFile(executablePath, []byte("binary"), 0o755); err != nil {
		t.Fatalf("写入二进制失败: %v", err)
	}

	app := NewApp()
	app.SetLanguage("zh-CN")
	item := statusItemFor(t, app, root, "diros")

	if item.Name != "Doris" {
		t.Fatalf("驱动展示名应为 Doris，got=%q", item.Name)
	}
	if got := filepath.Base(item.InstallDir); got != "doris" {
		t.Fatalf("安装目录应使用 doris，got=%q path=%q", got, item.InstallDir)
	}
	if got := filepath.Base(item.ExecutablePath); got != "doris-driver-agent"+filepath.Ext(item.ExecutablePath) {
		t.Fatalf("代理文件名应使用 doris，got=%q path=%q", got, item.ExecutablePath)
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
