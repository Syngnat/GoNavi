package app

import (
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"sort"
	"strings"
	"testing"
)

// testdata/driver_bundle_fixture.7z 由 tools/driver_bundle_7z.py 的 create_bundle 生成：
// mariadb 六个平台/架构各一条（内容为 fixture:<goos>-<goarch>），外加 Windows DuckDB 代理与 duckdb.dll；
// amd64 分组带 x86 BCJ 过滤器，arm64 分组不带过滤器，与发布总包的打包方式一致。
const driverBundleFixture7z = "testdata/driver_bundle_fixture.7z"

func copyDriverBundleFixture(t *testing.T, name string) string {
	t.Helper()
	payload, err := os.ReadFile(driverBundleFixture7z)
	if err != nil {
		t.Fatalf("读取 7z 夹具失败: %v", err)
	}
	target := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(target, payload, 0o644); err != nil {
		t.Fatalf("写入 7z 夹具失败: %v", err)
	}
	return target
}

func TestOpenDriverPackageArchiveListsSevenZipEntries(t *testing.T) {
	archive, err := openDriverPackageArchive(copyDriverBundleFixture(t, "GoNavi-DriverAgents.7z"))
	if err != nil {
		t.Fatalf("打开 7z 总包失败: %v", err)
	}
	defer archive.Close()

	names := make([]string, 0, len(archive.Entries))
	for _, entry := range archive.Entries {
		names = append(names, normalizeDriverPackageArchiveName(entry.Name))
	}
	sort.Strings(names)
	want := []string{
		"Linux/mariadb-driver-agent-linux-amd64",
		"Linux/mariadb-driver-agent-linux-arm64",
		"MacOS/mariadb-driver-agent-darwin-amd64",
		"MacOS/mariadb-driver-agent-darwin-arm64",
		"Windows/duckdb-driver-agent-windows-amd64.exe",
		"Windows/duckdb.dll",
		"Windows/mariadb-driver-agent-windows-amd64.exe",
		"Windows/mariadb-driver-agent-windows-arm64.exe",
	}
	if strings.Join(names, "\n") != strings.Join(want, "\n") {
		t.Fatalf("7z 条目不符：\nwant=%v\ngot=%v", want, names)
	}
}

func TestOpenDriverPackageArchiveDetectsSevenZipByContent(t *testing.T) {
	// 格式按文件头识别：改成 .zip 后缀的 7z 也必须能读。
	archive, err := openDriverPackageArchive(copyDriverBundleFixture(t, "renamed.zip"))
	if err != nil {
		t.Fatalf("按内容识别 7z 失败: %v", err)
	}
	defer archive.Close()
	if len(archive.Entries) == 0 {
		t.Fatal("改名后的 7z 应仍能列出条目")
	}
}

func TestInstallOptionalDriverAgentFromLocalArchiveInstallsHostEntryFromSevenZip(t *testing.T) {
	bundlePath := copyDriverBundleFixture(t, "GoNavi-DriverAgents.7z")
	executablePath := filepath.Join(t.TempDir(), "mariadb-driver-agent")

	entryName, err := installOptionalDriverAgentFromLocalArchive(bundlePath, driverDefinition{Type: "mariadb", Name: "MariaDB"}, executablePath, "")
	if err != nil {
		t.Fatalf("从 7z 总包安装失败: %v", err)
	}
	if entryName != optionalDriverBundleEntryPathForVersion("mariadb", "") {
		t.Fatalf("应命中宿主平台条目，实际 %q", entryName)
	}
	got, err := os.ReadFile(executablePath)
	if err != nil {
		t.Fatalf("读取安装结果失败: %v", err)
	}
	want := "fixture:" + stdRuntime.GOOS + "-" + stdRuntime.GOARCH
	if string(got) != want {
		t.Fatalf("解出的代理内容不符：want=%q got=%q", want, got)
	}
}

func TestExtractOptionalDriverSupportFilesFromSevenZipArchive(t *testing.T) {
	archive, err := openDriverPackageArchive(copyDriverBundleFixture(t, "GoNavi-DriverAgents.7z"))
	if err != nil {
		t.Fatalf("打开 7z 总包失败: %v", err)
	}
	defer archive.Close()

	entry := findOptionalDriverSupportFileInArchive(archive.Entries, "Windows/duckdb-driver-agent-windows-amd64.exe", duckDBWindowsSupportDLLName)
	if entry == nil {
		t.Fatal("应在代理同目录找到 duckdb.dll")
	}
	target := filepath.Join(t.TempDir(), duckDBWindowsSupportDLLName)
	if err := extractDriverPackageEntryToPath(entry, target); err != nil {
		t.Fatalf("解压 7z 运行库失败: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("读取解压结果失败: %v", err)
	}
	if string(got) != "fixture:duckdb-library" {
		t.Fatalf("运行库内容不符：%q", got)
	}
}

func TestDriverPackageArchiveEntryGuardUsesDeclaredSizeForSevenZip(t *testing.T) {
	atLimit := &driverPackageArchiveEntry{Name: "Windows/at-limit.exe", UncompressedSize: driverPackageMaxEntryUncompressedBytes}
	if err := atLimit.guard(); err != nil {
		t.Fatalf("恰好等于上限的 7z 条目不应被拦下：%v", err)
	}
	overLimit := &driverPackageArchiveEntry{Name: "Windows/over-limit.exe", UncompressedSize: driverPackageMaxEntryUncompressedBytes + 1}
	if err := overLimit.guard(); err == nil {
		t.Fatal("声明体积超限的 7z 条目应被拦下")
	}
}

func TestIsOptionalDriverDownloadZipURLAcceptsSevenZipBundle(t *testing.T) {
	cases := map[string]bool{
		"https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/GoNavi-DriverAgents.7z":                                       true,
		"https://github.com/Syngnat/GoNavi-DriverAgents/releases/latest/download/GoNavi-DriverAgents.7z#MacOS/kingbase-driver-agent-darwin-arm64":  true,
		"https://github.com/Syngnat/GoNavi-DriverAgents/releases/latest/download/GoNavi-DriverAgents.zip#MacOS/kingbase-driver-agent-darwin-arm64": true,
		"https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/kingbase-driver-agent-darwin-arm64":                           false,
	}
	for urlText, want := range cases {
		if got := isOptionalDriverDownloadZipURL(urlText); got != want {
			t.Fatalf("isOptionalDriverDownloadZipURL(%q)=%v, want %v", urlText, got, want)
		}
	}
}

func TestDriverNetworkProbeTargetsReleaseIndexInsteadOfBundle(t *testing.T) {
	// 总包已从 ZIP 改为 7z，旧发布上没有 7z；探测改用新旧发布都带的索引文件。
	for _, item := range buildDriverNetworkFallbackProbeItems(NewApp()) {
		if item.ProbeCode != driverNetworkProbeCodeGitHubRelease {
			continue
		}
		if !strings.HasSuffix(item.URL, "/"+optionalDriverBundleIndexAssetName) {
			t.Fatalf("GitHub 驱动发布探测应请求发布索引，实际 %q", item.URL)
		}
		return
	}
	t.Fatal("缺少 GitHub 驱动发布探测项")
}
