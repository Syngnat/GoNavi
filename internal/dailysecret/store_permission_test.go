package dailysecret

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestSaveRestrictsFilePermissions 覆盖明文口令文件的权限收紧。
//
// 回归背景：daily_secrets.json 以明文保存全部数据库/SSH/代理口令与 AI Provider 的 API Key，
// 却用 0o644 创建。在 Linux/macOS（含以 web-server / mcp-server 形态部署到多用户服务器或
// 挂载进容器时，见 cmd/gonavi-mcp-server/README.md）默认 umask 022 下权限为 -rw-r--r--，
// 同机任意非特权用户可直接读取全部凭据。
func TestSaveRestrictsFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 不实现 POSIX 权限位，Chmod 仅影响只读位")
	}

	root := t.TempDir()
	store := NewStore(root)
	if err := store.Save(File{}); err != nil {
		t.Fatalf("Save 失败：%v", err)
	}

	info, err := os.Stat(store.Path())
	if err != nil {
		t.Fatalf("读取文件信息失败：%v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("daily_secrets.json 权限 = %04o，期望 0600（明文凭据不得对同机其他用户可读）", perm)
	}
}

// TestSaveTightensPermissionsOnExistingFile os.WriteFile 的权限参数只在创建新文件时生效。
// 对历史上以 0o644 创建的文件必须显式收紧，否则升级后的用户仍然暴露。
func TestSaveTightensPermissionsOnExistingFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 不实现 POSIX 权限位，Chmod 仅影响只读位")
	}

	root := t.TempDir()
	path := filepath.Join(root, fileName)
	if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
		t.Fatalf("预置旧权限文件失败：%v", err)
	}

	store := NewStore(root)
	if err := store.Save(File{}); err != nil {
		t.Fatalf("Save 失败：%v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("读取文件信息失败：%v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("已存在文件的权限 = %04o，期望被收紧为 0600", perm)
	}
}

// TestSaveCreatesRootWithRestrictedPermissions 目录也应收紧，避免同机其他用户遍历。
func TestSaveCreatesRootWithRestrictedPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 不实现 POSIX 权限位")
	}

	base := t.TempDir()
	root := filepath.Join(base, "gonavi-data")
	store := NewStore(root)
	if err := store.Save(File{}); err != nil {
		t.Fatalf("Save 失败：%v", err)
	}

	info, err := os.Stat(root)
	if err != nil {
		t.Fatalf("读取目录信息失败：%v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Errorf("数据目录权限 = %04o，期望 0700", perm)
	}
}
