package app

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// installFakeDriverPackage 在 root 下构造一个"已安装"的可选驱动：
// 目录、假二进制、installed.json 元数据齐备，二进制名为当前平台的主程序名。
func installFakeDriverPackage(t *testing.T, root string, driverType string, version string, agentRevision string) string {
	t.Helper()
	driverDir := filepath.Join(root, driverType)
	if err := os.MkdirAll(driverDir, 0o755); err != nil {
		t.Fatalf("创建驱动目录失败: %v", err)
	}

	binaryPath, err := db.ResolveOptionalDriverAgentExecutablePathForVersion(root, driverType, version)
	if err != nil {
		t.Fatalf("解析驱动二进制路径失败: %v", err)
	}
	if err := os.WriteFile(binaryPath, []byte("fake-agent-"+driverType+"-"+version), 0o755); err != nil {
		t.Fatalf("写入假驱动二进制失败: %v", err)
	}

	meta := installedDriverPackage{
		DriverType:     driverType,
		Version:        version,
		AgentRevision:  agentRevision,
		FilePath:       binaryPath,
		FileName:       filepath.Base(binaryPath),
		ExecutablePath: binaryPath,
		DownloadedAt:   "2026-09-28T10:00:00+08:00",
	}
	payload, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		t.Fatalf("编码 installed.json 失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(driverDir, "installed.json"), payload, 0o644); err != nil {
		t.Fatalf("写入 installed.json 失败: %v", err)
	}
	return binaryPath
}

// exportDriverPackageTo 让 ExportDriverPackage 写到固定路径，避开保存对话框。
// jobID 传空表示不需要进度事件与取消能力（beginCancelableExportTask 的既有约定）。
func exportDriverPackageTo(t *testing.T, app *App, root string, target string) connection.QueryResult {
	t.Helper()
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return target, nil
	}
	return app.ExportDriverPackage(root, "")
}

// readDriverPackageZipEntries 读出 zip 内所有条目名。
func readDriverPackageZipEntries(t *testing.T, path string) map[string]uint64 {
	t.Helper()
	reader, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("打开导出包失败: %v", err)
	}
	defer reader.Close()

	entries := make(map[string]uint64, len(reader.File))
	for _, file := range reader.File {
		entries[file.Name] = file.UncompressedSize64
	}
	return entries
}

func TestExportDriverPackageWritesPlatformEntries(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	result := exportDriverPackageTo(t, app, root, target)
	if !result.Success {
		t.Fatalf("导出应成功，实际: %#v", result)
	}

	entries := readDriverPackageZipEntries(t, target)
	platformDir := optionalDriverBundlePlatformDir(stdRuntime.GOOS)
	wantEntry := platformDir + "/mariadb-driver-agent-" + stdRuntime.GOOS + "-" + stdRuntime.GOARCH
	if _, ok := entries[wantEntry]; !ok {
		t.Fatalf("导出包缺少平台条目 %s，实际条目: %v", wantEntry, entries)
	}
	if _, ok := entries[driverPackageManifestEntry]; !ok {
		t.Fatalf("导出包缺少清单 %s，实际条目: %v", driverPackageManifestEntry, entries)
	}
}

func TestExportDriverPackageUsesPublicTypeNameForDiros(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "diros", "1.2.3", "src-c5fd0ab228bd5474")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	if result := exportDriverPackageTo(t, app, root, target); !result.Success {
		t.Fatalf("导出应成功，实际: %#v", result)
	}

	entries := readDriverPackageZipEntries(t, target)
	// diros 对外必须落成 doris：导出包要能直接被发布总包同源的导入路径识别。
	wantEntry := optionalDriverBundlePlatformDir(stdRuntime.GOOS) + "/doris-driver-agent-" + stdRuntime.GOOS + "-" + stdRuntime.GOARCH
	if _, ok := entries[wantEntry]; !ok {
		t.Fatalf("diros 应导出为 %s，实际条目: %v", wantEntry, entries)
	}
	for name := range entries {
		if strings.Contains(name, "diros-driver-agent") {
			t.Fatalf("导出包不应出现内部类型名 diros：%s", name)
		}
	}
}

func TestExportDriverPackageKeepsMongoV1Suffix(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mongodb", "1.17.9", "src-ignored-for-v1")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	if result := exportDriverPackageTo(t, app, root, target); !result.Success {
		t.Fatalf("导出应成功，实际: %#v", result)
	}

	entries := readDriverPackageZipEntries(t, target)
	// mongodb v1 必须带 -v1 后缀：漏掉后缀会让导入侧按 v2 的 entry 名查找而报"条目缺失"。
	wantEntry := optionalDriverBundlePlatformDir(stdRuntime.GOOS) + "/mongodb-driver-agent-v1-" + stdRuntime.GOOS + "-" + stdRuntime.GOARCH
	if _, ok := entries[wantEntry]; !ok {
		t.Fatalf("mongodb v1 应导出为 %s，实际条目: %v", wantEntry, entries)
	}
}

func TestExportDriverPackageManifestMatchesInstalledDrivers(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")
	installFakeDriverPackage(t, root, "duckdb", "2.5.6", "src-64700b9b23a5dbd4")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	if result := exportDriverPackageTo(t, app, root, target); !result.Success {
		t.Fatalf("导出应成功，实际: %#v", result)
	}

	reader, err := zip.OpenReader(target)
	if err != nil {
		t.Fatalf("打开导出包失败: %v", err)
	}
	defer reader.Close()

	var manifest *driverPackageManifest
	for _, file := range reader.File {
		if file.Name != driverPackageManifestEntry {
			continue
		}
		stream, openErr := file.Open()
		if openErr != nil {
			t.Fatalf("读取清单失败: %v", openErr)
		}
		payload, readErr := io.ReadAll(stream)
		_ = stream.Close()
		if readErr != nil {
			t.Fatalf("读取清单内容失败: %v", readErr)
		}
		var parsed driverPackageManifest
		if err := json.Unmarshal(payload, &parsed); err != nil {
			t.Fatalf("解析清单失败: %v", err)
		}
		manifest = &parsed
	}
	if manifest == nil {
		t.Fatal("导出包内应包含清单")
	}
	if manifest.Kind != driverPackageKind || manifest.SchemaVersion != driverPackageSchemaVersion {
		t.Fatalf("清单头不匹配: kind=%q schema=%d", manifest.Kind, manifest.SchemaVersion)
	}

	byType := make(map[string]driverPackageManifestEntryItem, len(manifest.Drivers))
	for _, item := range manifest.Drivers {
		byType[item.DriverType] = item
	}
	if len(byType) != 2 {
		t.Fatalf("清单应记录 2 个驱动，实际: %#v", manifest.Drivers)
	}
	mariadb, ok := byType["mariadb"]
	if !ok {
		t.Fatalf("清单缺少 mariadb: %#v", manifest.Drivers)
	}
	if mariadb.Version != "1.9.3" || mariadb.AgentRevision != "src-0a451007282c8777" {
		t.Fatalf("mariadb 清单项不匹配: %#v", mariadb)
	}
	if mariadb.Entry != optionalDriverBundleEntryPathsForVersion("mariadb", "1.9.3")[0] {
		t.Fatalf("mariadb 条目名应与导入侧候选一致，实际: %q", mariadb.Entry)
	}
	if _, ok := byType["duckdb"]; !ok {
		t.Fatalf("清单缺少 duckdb: %#v", manifest.Drivers)
	}
}

func TestExportDriverPackageSkipsDriversWithoutBinary(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")

	// 只有元数据、没有二进制的残留记录（如 embedded-go-driver）不得中断整体导出。
	residualDir := filepath.Join(root, "sqlite")
	if err := os.MkdirAll(residualDir, 0o755); err != nil {
		t.Fatalf("创建残留目录失败: %v", err)
	}
	residual := `{"driverType":"sqlite","version":"1.0.0","fileName":"embedded-go-driver","filePath":"","downloadedAt":"2026-09-28T10:00:00+08:00"}`
	if err := os.WriteFile(filepath.Join(residualDir, "installed.json"), []byte(residual), 0o644); err != nil {
		t.Fatalf("写入残留元数据失败: %v", err)
	}

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	result := exportDriverPackageTo(t, app, root, target)
	if !result.Success {
		t.Fatalf("有可用驱动时导出应成功，实际: %#v", result)
	}

	entries := readDriverPackageZipEntries(t, target)
	for name := range entries {
		if strings.Contains(name, "sqlite") {
			t.Fatalf("无二进制的驱动不应出现在导出包里: %s", name)
		}
	}
	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("导出结果缺少 Data: %#v", result.Data)
	}
	skipped, _ := data["skipped"].([]string)
	if len(skipped) != 1 || skipped[0] != "sqlite" {
		t.Fatalf("应把 sqlite 计入跳过清单，实际: %#v", data["skipped"])
	}
}

// inspectDriverPackageTypes 调 InspectDriverPackage 并按驱动类型索引结果。
func inspectDriverPackageTypes(t *testing.T, app *App, zipPath string, root string) (map[string]driverPackageInspectItem, connection.QueryResult) {
	t.Helper()
	result := app.InspectDriverPackage(zipPath, root)
	if !result.Success {
		return nil, result
	}
	raw, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("解析结果缺少 Data: %#v", result.Data)
	}
	items, ok := raw["drivers"].([]driverPackageInspectItem)
	if !ok {
		t.Fatalf("解析结果 drivers 类型不符: %#v", raw["drivers"])
	}
	byType := make(map[string]driverPackageInspectItem, len(items))
	for _, item := range items {
		byType[item.DriverType] = item
	}
	return byType, result
}

func TestDriverPackageRoundTripRestoresDriverSet(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")
	installFakeDriverPackage(t, root, "duckdb", "2.5.6", "src-64700b9b23a5dbd4")
	installFakeDriverPackage(t, root, "diros", "1.2.3", "src-c5fd0ab228bd5474")
	installFakeDriverPackage(t, root, "mongodb", "1.17.9", "src-ignored-for-v1")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	if result := exportDriverPackageTo(t, app, root, target); !result.Success {
		t.Fatalf("导出应成功，实际: %#v", result)
	}

	// 解析到另一个空目录：全部驱动都应视为"未安装"，且平台匹配（同机导出同机导入）。
	freshRoot := t.TempDir()
	byType, result := inspectDriverPackageTypes(t, app, target, freshRoot)
	if byType == nil {
		t.Fatalf("解析应成功，实际: %#v", result)
	}
	for _, driverType := range []string{"mariadb", "duckdb", "diros", "mongodb"} {
		item, ok := byType[driverType]
		if !ok {
			t.Fatalf("解析结果缺少 %s，实际: %#v", driverType, byType)
		}
		if item.PlatformMismatch {
			t.Fatalf("%s 不应被判为平台不匹配（同机导出）：%#v", driverType, item)
		}
		if item.Installed {
			t.Fatalf("%s 在空目录不应显示为已安装：%#v", driverType, item)
		}
	}
	// mongodb v1 必须回放出 v1 版本，否则批量导入会按 v2 的 entry 名去装而失败。
	if got := byType["mongodb"].Version; got != "1.17.9" {
		t.Fatalf("mongodb 版本应回放为 1.17.9，实际: %q", got)
	}
	if got := byType["mariadb"].Entry; got != optionalDriverBundleEntryPathsForVersion("mariadb", "1.9.3")[0] {
		t.Fatalf("mariadb 条目名应与导入侧候选一致，实际: %q", got)
	}

	// 原地解析：全部应标记为已安装。
	installedByType, _ := inspectDriverPackageTypes(t, app, target, root)
	for _, driverType := range []string{"mariadb", "duckdb", "diros", "mongodb"} {
		if !installedByType[driverType].Installed {
			t.Fatalf("%s 在原始目录应显示为已安装：%#v", driverType, installedByType[driverType])
		}
	}
}

func TestInspectDriverPackageWithoutManifestFallsBackToEntryNames(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	if result := exportDriverPackageTo(t, app, root, target); !result.Success {
		t.Fatalf("导出应成功，实际: %#v", result)
	}

	// 剥掉清单，模拟第三方/发布总包：解析必须靠条目名反解还原驱动。
	stripped := filepath.Join(t.TempDir(), "stripped.zip")
	source, err := zip.OpenReader(target)
	if err != nil {
		t.Fatalf("打开导出包失败: %v", err)
	}
	defer source.Close()
	out, err := os.Create(stripped)
	if err != nil {
		t.Fatalf("创建剥离包失败: %v", err)
	}
	writer := zip.NewWriter(out)
	for _, file := range source.File {
		if file.Name == driverPackageManifestEntry {
			continue
		}
		stream, openErr := file.Open()
		if openErr != nil {
			t.Fatalf("读取条目失败: %v", openErr)
		}
		entry, createErr := writer.Create(file.Name)
		if createErr != nil {
			t.Fatalf("写入条目失败: %v", createErr)
		}
		if _, copyErr := io.Copy(entry, stream); copyErr != nil {
			t.Fatalf("复制条目失败: %v", copyErr)
		}
		_ = stream.Close()
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭剥离包失败: %v", err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("关闭剥离包文件失败: %v", err)
	}

	byType, result := inspectDriverPackageTypes(t, app, stripped, t.TempDir())
	if byType == nil {
		t.Fatalf("无清单的包仍应解析出驱动，实际: %#v", result)
	}
	item, ok := byType["mariadb"]
	if !ok {
		t.Fatalf("条目名反解应识别出 mariadb，实际: %#v", byType)
	}
	if item.PlatformMismatch {
		t.Fatalf("本机导出的条目不应判为平台不匹配：%#v", item)
	}
	// 无清单时没有 revision 可比对，不得误报不匹配。
	if item.RevisionMismatch {
		t.Fatalf("无清单时不应报 revision 不匹配：%#v", item)
	}
}

func TestInspectDriverPackageRejectsOversizedEntry(t *testing.T) {
	target := filepath.Join(t.TempDir(), "bomb.zip")
	out, err := os.Create(target)
	if err != nil {
		t.Fatalf("创建测试包失败: %v", err)
	}
	writer := zip.NewWriter(out)
	entry, err := writer.Create("MacOS/mariadb-driver-agent-darwin-arm64")
	if err != nil {
		t.Fatalf("创建条目失败: %v", err)
	}
	// 高压缩比的零字节流：护栏必须在解压前按声明体积拦下，而不是先展开再判断。
	if _, err := io.Copy(entry, io.LimitReader(zeroReader{}, 8<<20)); err != nil {
		t.Fatalf("写入条目失败: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭测试包失败: %v", err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("关闭测试包文件失败: %v", err)
	}

	app := NewApp()
	app.SetLanguage("en-US")
	result := app.InspectDriverPackage(target, t.TempDir())
	if result.Success {
		t.Fatalf("超高压缩比的包应被拒绝，实际: %#v", result)
	}
	want := app.appText("driver_manager.backend.error.package_entry_limit_exceeded", map[string]any{
		"name": "MacOS/mariadb-driver-agent-darwin-arm64",
	})
	if result.Message != want {
		t.Fatalf("护栏文案不匹配，want=%q got=%q", want, result.Message)
	}
}

// zeroReader 产出无限零字节，用于构造高压缩比条目。
type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}

func TestInspectDriverPackageReportsCrossPlatformEntries(t *testing.T) {
	// 锁住「解析必须平台无关」：条目名由 basename 反解 stem + goos/goarch，
	// 而不是复用只认宿主平台的 optionalDriverBundleEntryPathsForVersion。
	// 在 macOS 上解析 Windows 包，必须能列出驱动并标记平台不匹配。
	target := filepath.Join(t.TempDir(), "windows-package.zip")
	out, err := os.Create(target)
	if err != nil {
		t.Fatalf("创建测试包失败: %v", err)
	}
	writer := zip.NewWriter(out)
	entry, err := writer.Create("Windows/mariadb-driver-agent-windows-amd64.exe")
	if err != nil {
		t.Fatalf("创建条目失败: %v", err)
	}
	if _, err := entry.Write([]byte("fake-windows-agent")); err != nil {
		t.Fatalf("写入条目失败: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭测试包失败: %v", err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("关闭测试包文件失败: %v", err)
	}

	app := NewApp()
	byType, result := inspectDriverPackageTypes(t, app, target, t.TempDir())
	if byType == nil {
		t.Fatalf("跨平台包仍应可解析，实际: %#v", result)
	}
	item, ok := byType["mariadb"]
	if !ok {
		t.Fatalf("应反解出 mariadb，实际: %#v", byType)
	}
	if stdRuntime.GOOS == "windows" && stdRuntime.GOARCH == "amd64" {
		if item.PlatformMismatch {
			t.Fatalf("Windows/amd64 宿主上不应报平台不匹配：%#v", item)
		}
		return
	}
	if !item.PlatformMismatch {
		t.Fatalf("非 Windows 宿主上应标记平台不匹配：%#v", item)
	}
	if item.GOOS != "windows" || item.GOARCH != "amd64" {
		t.Fatalf("应回放条目的平台信息，实际: goos=%q goarch=%q", item.GOOS, item.GOARCH)
	}
}

func TestInspectDriverPackageReportsRevisionMismatch(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	if result := exportDriverPackageTo(t, app, root, target); !result.Success {
		t.Fatalf("导出应成功，实际: %#v", result)
	}

	// 改写清单里的 agentRevision，模拟「由其他版本 GoNavi 导出」的包。
	rewritten := filepath.Join(t.TempDir(), "rewritten.zip")
	source, err := zip.OpenReader(target)
	if err != nil {
		t.Fatalf("打开导出包失败: %v", err)
	}
	defer source.Close()
	out, err := os.Create(rewritten)
	if err != nil {
		t.Fatalf("创建改写包失败: %v", err)
	}
	writer := zip.NewWriter(out)
	for _, file := range source.File {
		stream, openErr := file.Open()
		if openErr != nil {
			t.Fatalf("读取条目失败: %v", openErr)
		}
		payload, readErr := io.ReadAll(stream)
		_ = stream.Close()
		if readErr != nil {
			t.Fatalf("读取条目内容失败: %v", readErr)
		}
		if file.Name == driverPackageManifestEntry {
			var manifest driverPackageManifest
			if err := json.Unmarshal(payload, &manifest); err != nil {
				t.Fatalf("解析清单失败: %v", err)
			}
			for index := range manifest.Drivers {
				manifest.Drivers[index].AgentRevision = "src-deadbeefdeadbeef"
			}
			payload, err = json.MarshalIndent(manifest, "", "  ")
			if err != nil {
				t.Fatalf("重新编码清单失败: %v", err)
			}
		}
		entry, createErr := writer.Create(file.Name)
		if createErr != nil {
			t.Fatalf("写入条目失败: %v", createErr)
		}
		if _, writeErr := entry.Write(payload); writeErr != nil {
			t.Fatalf("写入条目内容失败: %v", writeErr)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭改写包失败: %v", err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("关闭改写包文件失败: %v", err)
	}

	byType, result := inspectDriverPackageTypes(t, app, rewritten, t.TempDir())
	if byType == nil {
		t.Fatalf("改写包仍应可解析，实际: %#v", result)
	}
	item := byType["mariadb"]
	if !item.RevisionMismatch {
		t.Fatalf("应标记 revision 不匹配：%#v", item)
	}
	if item.PackageRevision != "src-deadbeefdeadbeef" {
		t.Fatalf("应回放包内 revision，实际: %q", item.PackageRevision)
	}
	// 期望值随 driver_agent_revisions_gen.go 重新生成而变化，不能写死。
	if want := db.OptionalDriverAgentRevision("mariadb"); want == "" || item.ExpectedRevision != want {
		t.Fatalf("应给出当前构建期望的 revision %q，实际: %q", want, item.ExpectedRevision)
	}
}

func TestInspectDriverPackageRejectsNonPackage(t *testing.T) {
	broken := filepath.Join(t.TempDir(), "broken.zip")
	if err := os.WriteFile(broken, []byte("not a zip at all"), 0o644); err != nil {
		t.Fatalf("写入损坏包失败: %v", err)
	}

	app := NewApp()
	app.SetLanguage("en-US")
	result := app.InspectDriverPackage(broken, t.TempDir())
	if result.Success {
		t.Fatalf("非 zip 文件应被拒绝，实际: %#v", result)
	}
	want := app.appText("driver_manager.backend.error.package_open_failed", nil)
	if result.Message != want {
		t.Fatalf("文案不匹配，want=%q got=%q", want, result.Message)
	}
}

func TestInspectDriverPackageEmptyArchiveFails(t *testing.T) {
	target := filepath.Join(t.TempDir(), "empty.zip")
	out, err := os.Create(target)
	if err != nil {
		t.Fatalf("创建空包失败: %v", err)
	}
	writer := zip.NewWriter(out)
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭空包失败: %v", err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("关闭空包文件失败: %v", err)
	}

	app := NewApp()
	app.SetLanguage("en-US")
	result := app.InspectDriverPackage(target, t.TempDir())
	if result.Success {
		t.Fatalf("空包应被拒绝，实际: %#v", result)
	}
	want := app.appText("driver_manager.backend.error.package_empty", nil)
	if result.Message != want {
		t.Fatalf("文案不匹配，want=%q got=%q", want, result.Message)
	}
}

func TestExportDriverPackageSelectionKeepsOnlyRequestedDrivers(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")
	installFakeDriverPackage(t, root, "diros", "1.2.3", "src-c5fd0ab228bd5474")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	result := exportDriverPackageSelectionTo(t, app, root, target, []string{"mariadb"})
	if !result.Success {
		t.Fatalf("按选择导出应成功，实际: %#v", result)
	}

	entries := readDriverPackageZipEntries(t, target)
	platformDir := optionalDriverBundlePlatformDir(stdRuntime.GOOS)
	mariadbEntry := platformDir + "/mariadb-driver-agent-" + stdRuntime.GOOS + "-" + stdRuntime.GOARCH
	dorisEntry := platformDir + "/doris-driver-agent-" + stdRuntime.GOOS + "-" + stdRuntime.GOARCH
	if _, ok := entries[mariadbEntry]; !ok {
		t.Fatalf("导出包缺少 %s，实际条目: %v", mariadbEntry, entries)
	}
	if _, ok := entries[dorisEntry]; ok {
		t.Fatalf("未选择的 doris 不应出现在导出包中，实际条目: %v", entries)
	}
	if count, ok := result.Data.(map[string]interface{})["driverCount"]; !ok || count != 1 {
		t.Fatalf("driverCount = %#v，期望 1", result.Data)
	}
}

func TestExportDriverPackageSelectionEmptyExportsAll(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")
	installFakeDriverPackage(t, root, "diros", "1.2.3", "src-c5fd0ab228bd5474")

	target := filepath.Join(t.TempDir(), "drivers.zip")
	app := NewApp()
	result := exportDriverPackageSelectionTo(t, app, root, target, nil)
	if !result.Success {
		t.Fatalf("空选择应导出全部，实际: %#v", result)
	}
	if count, ok := result.Data.(map[string]interface{})["driverCount"]; !ok || count != 2 {
		t.Fatalf("driverCount = %#v，期望 2", result.Data)
	}
}

func TestExportDriverPackageSelectionMissingDriverSkipsDialog(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")

	app := NewApp()
	app.SetLanguage("en-US")
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		t.Fatal("所选驱动不可导出时不应弹出保存对话框")
		return "", nil
	}
	result := app.ExportDriverPackageSelection(root, "", []string{"clickhouse"})
	if result.Success {
		t.Fatalf("未安装的选择应失败，实际: %#v", result)
	}
	want := app.appText("driver_manager.backend.error.package_no_selected_drivers", nil)
	if result.Message != want {
		t.Fatalf("提示文案不匹配，want=%q got=%q", want, result.Message)
	}
}

func exportDriverPackageSelectionTo(t *testing.T, app *App, root string, target string, driverTypes []string) connection.QueryResult {
	t.Helper()
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return target, nil
	}
	return app.ExportDriverPackageSelection(root, "", driverTypes)
}

func TestDriverPackageZipDialogAllowsOnlyArchives(t *testing.T) {
	zipDialog := driverPackageFileDialogOptions("选择驱动包（ZIP / 7z）", "/tmp", true)
	if len(zipDialog.Filters) != 1 || zipDialog.Filters[0].Pattern != "*.zip;*.7z" {
		t.Fatalf("驱动包导入对话框应只允许 *.zip 与 *.7z，实际: %#v", zipDialog.Filters)
	}
	plainDialog := driverPackageFileDialogOptions("选择驱动包文件", "/tmp", false)
	if len(plainDialog.Filters) != 0 {
		t.Fatalf("单驱动文件对话框不应限制扩展名，实际: %#v", plainDialog.Filters)
	}
}

func TestExportDriverPackageWithoutInstalledDriversFails(t *testing.T) {
	root := t.TempDir()
	app := NewApp()
	app.SetLanguage("en-US")
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		t.Fatal("没有可导出驱动时不应弹出保存对话框")
		return "", nil
	}

	result := app.ExportDriverPackage(root, "")
	if result.Success {
		t.Fatalf("没有已安装驱动时应失败，实际: %#v", result)
	}
	want := app.appText("driver_manager.backend.error.package_no_installed_drivers", nil)
	if result.Message != want {
		t.Fatalf("提示文案不匹配，want=%q got=%q", want, result.Message)
	}
}

func TestExportDriverPackageCancelledByUser(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")

	app := NewApp()
	app.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		return "", nil
	}
	result := app.ExportDriverPackage(root, "")
	if result.Success {
		t.Fatalf("用户取消应返回失败，实际: %#v", result)
	}
	if result.Message != "已取消" {
		t.Fatalf("取消提示应与既有约定一致，实际: %q", result.Message)
	}
}

func TestExportDriverPackageAppendsZipExtension(t *testing.T) {
	root := t.TempDir()
	installFakeDriverPackage(t, root, "mariadb", "1.9.3", "src-0a451007282c8777")

	dir := t.TempDir()
	target := filepath.Join(dir, "no-extension")
	app := NewApp()
	result := exportDriverPackageTo(t, app, root, target)
	if !result.Success {
		t.Fatalf("导出应成功，实际: %#v", result)
	}
	if _, err := os.Stat(target + ".zip"); err != nil {
		t.Fatalf("缺少 .zip 后缀时应自动补齐: %v", err)
	}
}
