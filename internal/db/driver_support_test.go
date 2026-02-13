package db

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

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
	if err := os.WriteFile(executablePath, []byte("placeholder"), 0o755); err != nil {
		t.Fatalf("写入 mariadb 代理占位文件失败: %v", err)
	}
	if runtime.GOOS == "windows" {
		_ = os.Chmod(executablePath, 0o644)
	}

	supported, reason := DriverRuntimeSupportStatus("mariadb")
	if !supported {
		t.Fatalf("mariadb 安装后应可用，reason=%s", reason)
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
