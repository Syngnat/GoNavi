//go:build windows

package appdata

import (
	"io"
	"os"
	"path/filepath"
	"strings"
)

func ResolveWindowsWebviewUserDataPath() string {
	appDataDir := strings.TrimSpace(os.Getenv("APPDATA"))
	if appDataDir == "" {
		return ""
	}

	targetDir := filepath.Join(appDataDir, "GoNavi", "WebView2")
	_ = migrateLegacyWindowsWebviewUserData(appDataDir, targetDir)
	return targetDir
}

func migrateLegacyWindowsWebviewUserData(appDataDir, targetDir string) error {
	if dirHasContent(targetDir) {
		return nil
	}

	exeName := "GoNavi.exe"
	if exePath, err := os.Executable(); err == nil {
		base := strings.TrimSpace(filepath.Base(exePath))
		if base != "" {
			exeName = base
		}
	}
	exeBase := strings.TrimSuffix(exeName, filepath.Ext(exeName))

	candidates := []string{
		filepath.Join(appDataDir, exeName),
		filepath.Join(appDataDir, exeBase),
		filepath.Join(appDataDir, "GoNavi.exe"),
		filepath.Join(appDataDir, "GoNavi"),
	}

	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		src := filepath.Clean(strings.TrimSpace(candidate))
		if src == "" || strings.EqualFold(src, filepath.Clean(targetDir)) {
			continue
		}
		key := strings.ToLower(src)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}

		if !dirHasContent(src) {
			continue
		}
		return copyDirTree(src, targetDir)
	}
	return nil
}

func dirHasContent(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return false
	}
	entries, err := os.ReadDir(path)
	return err == nil && len(entries) > 0
}

func copyDirTree(srcDir, dstDir string) error {
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}

	return filepath.WalkDir(srcDir, func(srcPath string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relPath, err := filepath.Rel(srcDir, srcPath)
		if err != nil {
			return err
		}
		if relPath == "." {
			return nil
		}
		dstPath := filepath.Join(dstDir, relPath)

		if d.IsDir() {
			return os.MkdirAll(dstPath, 0o755)
		}

		info, err := d.Info()
		if err != nil {
			return err
		}
		return copyFileWithMode(srcPath, dstPath, info.Mode())
	})
}

func copyFileWithMode(srcPath, dstPath string, mode os.FileMode) error {
	srcFile, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
		return err
	}
	dstFile, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode.Perm())
	if err != nil {
		return err
	}
	defer dstFile.Close()

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return err
	}
	return nil
}
