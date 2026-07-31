package db

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"GoNavi-Wails/shared/i18n"
)

func driverSupportFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("driver_support.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

func TestPostgresRuntimeSupportRequiresInstallMarker(t *testing.T) {
	tmpDir := t.TempDir()
	SetExternalDriverDownloadDirectory(tmpDir)

	supported, _ := DriverRuntimeSupportStatus("postgres")
	if !supported {
		t.Fatalf("postgres 属于免安装内置驱动，应可用")
	}
	supported, reason := DriverRuntimeSupportStatus("postgres")
	if !supported {
		t.Fatalf("postgres 应可用，reason=%s", reason)
	}
}

func TestBuiltinLikeDriversRemainAvailable(t *testing.T) {
	tmpDir := t.TempDir()
	SetExternalDriverDownloadDirectory(tmpDir)

	supported, reason := DriverRuntimeSupportStatus("redis")
	if !supported {
		t.Fatalf("redis 应始终可用，reason=%s", reason)
	}

	supported, reason = DriverRuntimeSupportStatus("kafka")
	if !supported {
		t.Fatalf("kafka 应始终可用，reason=%s", reason)
	}

	supported, reason = DriverRuntimeSupportStatus("goldendb")
	if !supported {
		t.Fatalf("goldendb 应始终可用，reason=%s", reason)
	}
}

func TestOptionalDriverAgentRevisionsGeneratedForOptionalDrivers(t *testing.T) {
	for driverType := range optionalGoDrivers {
		revision := OptionalDriverAgentRevision(driverType)
		if revision == "" {
			t.Fatalf("%s 缺少自动生成的 driver-agent revision", driverType)
		}
		if revision == "src-local" {
			t.Fatalf("%s driver-agent revision 仍是本地占位值", driverType)
		}
	}
	if OptionalDriverAgentRevision("doris") != OptionalDriverAgentRevision("diros") {
		t.Fatalf("doris/diros revision 应归一一致")
	}
}

func TestKingbaseRuntimeAliasesNormalizeToKingbase(t *testing.T) {
	if got := normalizeRuntimeDriverType("kingbase8"); got != "kingbase" {
		t.Fatalf("expected kingbase8 runtime alias to normalize to kingbase, got %q", got)
	}
	if got := normalizeDatabaseType("kingbasees"); got != "kingbase" {
		t.Fatalf("expected kingbasees database alias to normalize to kingbase, got %q", got)
	}
	if got := normalizeRuntimeDriverType("greatdb"); got != "goldendb" {
		t.Fatalf("expected greatdb runtime alias to normalize to goldendb, got %q", got)
	}
	if got := normalizeDatabaseType("gdb"); got != "goldendb" {
		t.Fatalf("expected gdb database alias to normalize to goldendb, got %q", got)
	}
}

func TestManagedDriverRequiresInstallMarker(t *testing.T) {
	tmpDir := t.TempDir()
	SetExternalDriverDownloadDirectory(tmpDir)

	supported, _ := DriverRuntimeSupportStatus("mariadb")
	if supported {
		t.Fatalf("mariadb 未安装时不应可用")
	}

	if !IsOptionalGoDriverBuildIncluded("mariadb") {
		supported, reason := DriverRuntimeSupportStatus("mariadb")
		if supported {
			t.Fatalf("精简构建下 mariadb 不应可用")
		}
		if reason == "" {
			t.Fatalf("精简构建下 mariadb 应返回不可用原因")
		}
		return
	}

	markerPath, err := ResolveOptionalGoDriverMarkerPath(tmpDir, "mariadb")
	if err != nil {
		t.Fatalf("解析 marker 路径失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(markerPath), 0o755); err != nil {
		t.Fatalf("创建 marker 目录失败: %v", err)
	}
	if err := os.WriteFile(markerPath, []byte("{}"), 0o644); err != nil {
		t.Fatalf("写入 marker 失败: %v", err)
	}
	executablePath, err := ResolveOptionalDriverAgentExecutablePath(tmpDir, "mariadb")
	if err != nil {
		t.Fatalf("解析 mariadb 代理路径失败: %v", err)
	}
	if runtime.GOOS == "windows" {
		selfPath, selfErr := os.Executable()
		if selfErr != nil {
			t.Fatalf("获取测试进程路径失败: %v", selfErr)
		}
		content, readErr := os.ReadFile(selfPath)
		if readErr != nil {
			t.Fatalf("读取测试进程失败: %v", readErr)
		}
		if err := os.WriteFile(executablePath, content, 0o755); err != nil {
			t.Fatalf("写入 mariadb 代理占位可执行文件失败: %v", err)
		}
	} else {
		if err := os.WriteFile(executablePath, []byte("placeholder"), 0o755); err != nil {
			t.Fatalf("写入 mariadb 代理占位文件失败: %v", err)
		}
	}

	supported, reason := DriverRuntimeSupportStatus("mariadb")
	if !supported {
		t.Fatalf("mariadb 安装后应可用，reason=%s", reason)
	}
}

func TestNewCompatibleDriversAreOptionalAgentDrivers(t *testing.T) {
	tmpDir := t.TempDir()
	SetExternalDriverDownloadDirectory(tmpDir)

	for _, driverType := range []string{"oceanbase", "opengauss", "open_gauss", "gaussdb", "gauss_db", "starrocks", "iris", "intersystems"} {
		if IsBuiltinDriver(driverType) {
			t.Fatalf("%s 不应是免安装内置驱动", driverType)
		}
		if !IsOptionalGoDriver(driverType) {
			t.Fatalf("%s 应走可选 driver-agent 链路", driverType)
		}
		supported, _ := DriverRuntimeSupportStatus(driverType)
		if supported {
			t.Fatalf("%s 未安装 agent 时不应可用", driverType)
		}
	}
}

func TestMySQLBuiltinRuntimeSupportAvailable(t *testing.T) {
	tmpDir := t.TempDir()
	SetExternalDriverDownloadDirectory(tmpDir)

	supported, reason := DriverRuntimeSupportStatus("mysql")
	if !supported {
		t.Fatalf("mysql 属于免安装内置驱动，应可用，reason=%s", reason)
	}
}

func TestGoldenDBBuiltinDatabaseFactoryUsesMySQLImplementation(t *testing.T) {
	dbInst, err := NewDatabase("goldendb")
	if err != nil {
		t.Fatalf("expected goldendb database factory, got err=%v", err)
	}
	if _, ok := dbInst.(*MySQLDB); !ok {
		t.Fatalf("expected goldendb to reuse MySQLDB implementation, got %T", dbInst)
	}
}

func TestDriverRuntimeSupportStatusUsesCurrentLanguageForUnrecognizedDriverType(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	supported, reason := DriverRuntimeSupportStatus(" ")
	if supported {
		t.Fatal("expected blank driver type to be unsupported")
	}
	if reason != "Unrecognized data source type" {
		t.Fatalf("expected English unrecognized-driver reason, got %q", reason)
	}
}

func TestDriverRuntimeSupportStatusUsesCurrentLanguageForOptionalDriverDisabledState(t *testing.T) {
	tmpDir := t.TempDir()
	SetExternalDriverDownloadDirectory(tmpDir)
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	supported, reason := DriverRuntimeSupportStatus("mariadb")
	if supported {
		t.Fatal("expected mariadb to stay unavailable without installation marker")
	}
	if !IsOptionalGoDriverBuildIncluded("mariadb") {
		want := "MariaDB is not included in the current slim build. Install the Full edition to use this driver."
		if reason != want {
			t.Fatalf("expected English slim-build reason %q, got %q", want, reason)
		}
		return
	}
	want := "MariaDB Go driver is not enabled; install and enable it in Driver Manager."
	if reason != want {
		t.Fatalf("expected English disabled-driver reason %q, got %q", want, reason)
	}
}

func TestDriverRuntimeSupportStatusUsesCurrentLanguageForMissingOptionalDriverAgent(t *testing.T) {
	if !IsOptionalGoDriverBuildIncluded("mariadb") {
		t.Skip("mariadb is not included in the current slim build")
	}

	tmpDir := t.TempDir()
	SetExternalDriverDownloadDirectory(tmpDir)
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	markerPath, err := ResolveOptionalGoDriverMarkerPath(tmpDir, "mariadb")
	if err != nil {
		t.Fatalf("resolve marker path failed: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(markerPath), 0o755); err != nil {
		t.Fatalf("create marker directory failed: %v", err)
	}
	if err := os.WriteFile(markerPath, []byte("{}"), 0o644); err != nil {
		t.Fatalf("write marker failed: %v", err)
	}

	supported, reason := DriverRuntimeSupportStatus("mariadb")
	if supported {
		t.Fatal("expected mariadb to stay unavailable when the driver agent executable is missing")
	}
	want := "MariaDB driver agent is missing; reinstall and enable it in Driver Manager."
	if reason != want {
		t.Fatalf("expected English missing-agent reason %q, got %q", want, reason)
	}
}


func TestResolveExternalDriverRootUsesCurrentLanguageForCreateDirectoryFailure(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	tmpDir := t.TempDir()
	blocker := filepath.Join(tmpDir, "driver-root-blocker")
	if err := os.WriteFile(blocker, []byte("blocker"), 0o644); err != nil {
		t.Fatalf("write blocker file: %v", err)
	}

	_, err := ResolveExternalDriverRoot(filepath.Join(blocker, "nested"))
	if err == nil {
		t.Fatal("expected create-directory failure")
	}
	if !strings.Contains(err.Error(), "Failed to create driver directory:") {
		t.Fatalf("expected English create-directory wrapper, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "\u521b\u5efa\u9a71\u52a8\u76ee\u5f55\u5931\u8d25") {
		t.Fatalf("expected no Chinese create-directory wrapper in en-US mode, got %q", err.Error())
	}
}
