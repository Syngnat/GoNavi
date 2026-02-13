package db

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
)

func mysqlAgentExecutableName() string {
	return optionalDriverAgentExecutableName("mysql")
}

func optionalDriverAgentExecutableName(driverType string) string {
	normalized := normalizeRuntimeDriverType(driverType)
	if normalized == "" {
		normalized = "unknown"
	}
	name := fmt.Sprintf("%s-driver-agent", normalized)
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
	root, err := resolveExternalDriverRoot(downloadDir)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, normalized, optionalDriverAgentExecutableName(normalized)), nil
}

func ResolveMySQLAgentExecutablePath(downloadDir string) (string, error) {
	return ResolveOptionalDriverAgentExecutablePath(downloadDir, "mysql")
}
