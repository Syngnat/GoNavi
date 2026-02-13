package db

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var coreBuiltinDrivers = map[string]struct{}{
	"mysql":    {},
	"redis":    {},
	"oracle":   {},
	"postgres": {},
}

// optionalGoDrivers 表示需要用户“安装启用”后才能使用的纯 Go 驱动。
// 注意：这是一种运行时门控（installed.json 标记），并不减少主二进制体积。
var optionalGoDrivers = map[string]struct{}{
	"mariadb":   {},
	"diros":     {},
	"sphinx":    {},
	"sqlserver": {},
	"sqlite":    {},
	"duckdb":    {},
	"dameng":    {},
	"kingbase":  {},
	"highgo":    {},
	"vastbase":  {},
	"mongodb":   {},
	"tdengine":  {},
}

var (
	externalDriverDirMu sync.RWMutex
	externalDriverDir   string
)

func normalizeRuntimeDriverType(driverType string) string {
	normalized := strings.ToLower(strings.TrimSpace(driverType))
	switch normalized {
	case "doris":
		return "diros"
	case "postgresql":
		return "postgres"
	default:
		return normalized
	}
}

func driverDisplayName(driverType string) string {
	switch normalizeRuntimeDriverType(driverType) {
	case "mysql":
		return "MySQL"
	case "oracle":
		return "Oracle"
	case "redis":
		return "Redis"
	case "mariadb":
		return "MariaDB"
	case "diros":
		return "Diros"
	case "sphinx":
		return "Sphinx"
	case "postgres":
		return "PostgreSQL"
	case "sqlserver":
		return "SQL Server"
	case "sqlite":
		return "SQLite"
	case "duckdb":
		return "DuckDB"
	case "dameng":
		return "Dameng"
	case "kingbase":
		return "Kingbase"
	case "highgo":
		return "HighGo"
	case "vastbase":
		return "Vastbase"
	case "mongodb":
		return "MongoDB"
	case "tdengine":
		return "TDengine"
	default:
		return strings.ToUpper(strings.TrimSpace(driverType))
	}
}

func IsOptionalGoDriver(driverType string) bool {
	_, ok := optionalGoDrivers[normalizeRuntimeDriverType(driverType)]
	return ok
}

func IsOptionalGoDriverBuildIncluded(driverType string) bool {
	return optionalGoDriverBuildIncluded(normalizeRuntimeDriverType(driverType))
}

func IsBuiltinDriver(driverType string) bool {
	_, ok := coreBuiltinDrivers[normalizeRuntimeDriverType(driverType)]
	return ok
}

func defaultExternalDriverDownloadDirectory() string {
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		return filepath.Join(home, ".gonavi", "drivers")
	}
	if wd, err := os.Getwd(); err == nil && strings.TrimSpace(wd) != "" {
		return filepath.Join(wd, ".gonavi-drivers")
	}
	return ".gonavi-drivers"
}

func resolveExternalDriverRoot(downloadDir string) (string, error) {
	root := strings.TrimSpace(downloadDir)
	if root == "" {
		root = currentExternalDriverDownloadDirectory()
	}
	if root == "" {
		root = defaultExternalDriverDownloadDirectory()
	}
	if !filepath.IsAbs(root) {
		abs, err := filepath.Abs(root)
		if err != nil {
			return "", err
		}
		root = abs
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("创建驱动目录失败：%w", err)
	}
	return root, nil
}

func currentExternalDriverDownloadDirectory() string {
	externalDriverDirMu.RLock()
	current := strings.TrimSpace(externalDriverDir)
	externalDriverDirMu.RUnlock()
	if current != "" {
		return current
	}
	return defaultExternalDriverDownloadDirectory()
}

func SetExternalDriverDownloadDirectory(downloadDir string) {
	root, err := resolveExternalDriverRoot(downloadDir)
	if err != nil {
		root = defaultExternalDriverDownloadDirectory()
	}
	externalDriverDirMu.Lock()
	externalDriverDir = root
	externalDriverDirMu.Unlock()
}

func ResolveExternalDriverRoot(downloadDir string) (string, error) {
	return resolveExternalDriverRoot(downloadDir)
}

func ResolveOptionalGoDriverMarkerPath(downloadDir string, driverType string) (string, error) {
	normalized := normalizeRuntimeDriverType(driverType)
	if !IsOptionalGoDriver(normalized) {
		return "", fmt.Errorf("%s 不是可选 Go 驱动", driverDisplayName(normalized))
	}
	root, err := resolveExternalDriverRoot(downloadDir)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, normalized, "installed.json"), nil
}

func optionalGoDriverInstalled(driverType string) bool {
	markerPath, err := ResolveOptionalGoDriverMarkerPath("", driverType)
	if err != nil {
		return false
	}
	info, statErr := os.Stat(markerPath)
	return statErr == nil && !info.IsDir()
}

func optionalGoDriverRuntimeReady(driverType string) (bool, string) {
	normalized := normalizeRuntimeDriverType(driverType)
	if !IsOptionalGoDriver(normalized) {
		return true, ""
	}
	executablePath, err := ResolveOptionalDriverAgentExecutablePath("", normalized)
	if err != nil {
		return false, fmt.Sprintf("%s 驱动代理路径解析失败，请在驱动管理中重新安装启用", driverDisplayName(normalized))
	}
	info, statErr := os.Stat(executablePath)
	if statErr != nil || info.IsDir() {
		return false, fmt.Sprintf("%s 驱动代理缺失，请在驱动管理中重新安装启用", driverDisplayName(normalized))
	}
	return true, ""
}

// DriverRuntimeSupportStatus 返回当前构建下驱动是否可用（可直接用于连接）。
func DriverRuntimeSupportStatus(driverType string) (bool, string) {
	normalized := normalizeRuntimeDriverType(driverType)
	if normalized == "" {
		return false, "未识别的数据源类型"
	}
	if normalized == "custom" {
		return true, ""
	}
	if IsBuiltinDriver(normalized) {
		return true, ""
	}
	if IsOptionalGoDriver(normalized) {
		if !IsOptionalGoDriverBuildIncluded(normalized) {
			return false, fmt.Sprintf("%s 当前发行包为精简构建，未内置该驱动；如需使用请安装 Full 版", driverDisplayName(normalized))
		}
		if optionalGoDriverInstalled(normalized) {
			if ready, reason := optionalGoDriverRuntimeReady(normalized); !ready {
				return false, reason
			}
			return true, ""
		}
		return false, fmt.Sprintf("%s 纯 Go 驱动未启用，请先在驱动管理中点击“安装启用”", driverDisplayName(normalized))
	}
	return true, ""
}
