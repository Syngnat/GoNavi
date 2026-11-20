package db

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func mysqlAgentExecutableName() string {
	return optionalDriverAgentExecutableName("mysql")
}

func optionalDriverStorageTypeName(driverType string) string {
	normalized := normalizeRuntimeDriverType(driverType)
	if normalized == "diros" {
		// `diros` 仅作为历史内部键兼容保留；安装目录和可执行文件统一使用
		// 产品名 `doris`，避免驱动管理界面出现两套拼写。
		return "doris"
	}
	return normalized
}

func optionalDriverAgentExecutableName(driverType string) string {
	storageType := optionalDriverStorageTypeName(driverType)
	if storageType == "" {
		storageType = "unknown"
	}
	name := fmt.Sprintf("%s-driver-agent", storageType)
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func ResolveOptionalDriverAgentExecutablePath(downloadDir string, driverType string) (string, error) {
	normalized := normalizeRuntimeDriverType(driverType)
	if strings.TrimSpace(normalized) == "" {
		return "", fmt.Errorf("驱动类型为空")
	}
	storageType := optionalDriverStorageTypeName(normalized)
	root, err := resolveExternalDriverRoot(downloadDir)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, storageType, optionalDriverAgentExecutableName(normalized)), nil
}

func ResolveOptionalDriverAgentExecutablePathForVersion(downloadDir string, driverType string, version string) (string, error) {
	normalized := normalizeRuntimeDriverType(driverType)
	if strings.TrimSpace(normalized) == "" {
		return "", fmt.Errorf("驱动类型为空")
	}
	storageType := optionalDriverStorageTypeName(normalized)
	root, err := resolveExternalDriverRoot(downloadDir)
	if err != nil {
		return "", err
	}

	if normalized != "mongodb" {
		return filepath.Join(root, storageType, optionalDriverAgentExecutableName(normalized)), nil
	}

	baseName := optionalDriverAgentExecutableName(normalized)
	ext := filepath.Ext(baseName)
	stem := strings.TrimSuffix(baseName, ext)
	major := 2
	trimmed := strings.TrimSpace(version)
	trimmed = strings.TrimPrefix(trimmed, "v")
	if strings.HasPrefix(trimmed, "1.") || trimmed == "1" {
		major = 1
	}
	versionedName := fmt.Sprintf("%s-v%d%s", stem, major, ext)
	return filepath.Join(root, storageType, versionedName), nil
}

func resolveExistingOptionalDriverAgentExecutablePath(downloadDir string, driverType string) (string, error) {
	canonicalPath, err := ResolveOptionalDriverAgentExecutablePath(downloadDir, driverType)
	if err != nil {
		return "", err
	}
	if info, statErr := os.Stat(canonicalPath); statErr == nil && !info.IsDir() {
		return canonicalPath, nil
	}
	if normalizeRuntimeDriverType(driverType) != "diros" {
		return canonicalPath, nil
	}
	root, rootErr := resolveExternalDriverRoot(downloadDir)
	if rootErr != nil {
		return canonicalPath, nil
	}
	legacyPath := filepath.Join(root, "diros", optionalDriverExecutableNameForStorage("diros"))
	if info, statErr := os.Stat(legacyPath); statErr == nil && !info.IsDir() {
		return legacyPath, nil
	}
	return canonicalPath, nil
}

func optionalDriverExecutableNameForStorage(storageType string) string {
	name := fmt.Sprintf("%s-driver-agent", strings.TrimSpace(storageType))
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}
func ResolveMySQLAgentExecutablePath(downloadDir string) (string, error) {
	return ResolveOptionalDriverAgentExecutablePath(downloadDir, "mysql")
}
