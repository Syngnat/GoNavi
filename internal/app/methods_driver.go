package app

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"

	"GoNavi-Wails/internal/db"
)

var (
	goBinaryLookPath = exec.LookPath
	goBinaryStat     = os.Stat
	goBinaryCommand  = func(name string, arg ...string) *exec.Cmd {
		return exec.Command(name, arg...)
	}
	goBinaryCommandOutput = func(cmd *exec.Cmd) ([]byte, error) {
		return cmd.Output()
	}
	optionalDriverAgentMetadataProbe = db.ProbeOptionalDriverAgentMetadata
)

type optionalDriverBundleDownloadState struct {
	done     chan struct{}
	path     string
	err      error
	finished bool
}

var (
	optionalDriverBundleDownloadMu sync.Mutex
	optionalDriverBundleDownloads  = make(map[string]*optionalDriverBundleDownloadState)
)

var (
	errOptionalDriverAgentMetadataUnavailable = errors.New("driver-agent metadata unavailable")
	errLocalDriverPackageJDBCJarUnsupported   = errors.New("JDBC Jar unsupported")
)

type driverBuildUnavailableError struct {
	Name string
}

func (e *driverBuildUnavailableError) Error() string {
	return localizedDriverBackendText(nil, "driver_manager.backend.status.slim_build_required", map[string]any{
		"name": strings.TrimSpace(e.Name),
	})
}

type driverVersionValidationError struct {
	DriverType string
	Version    string
}

func (e *driverVersionValidationError) Error() string {
	driverType := normalizeDriverType(e.DriverType)
	versionText := normalizeVersion(strings.TrimSpace(e.Version))
	switch driverType {
	case "mongodb":
		return localizedDriverBackendText(nil, "driver_manager.backend.error.mongo_version_unsupported", map[string]any{
			"version": versionText,
		})
	default:
		displayName := strings.TrimSpace(e.DriverType)
		if definition, ok := resolveDriverDefinition(driverType); ok {
			displayName = resolveDriverDisplayName(definition)
		} else if strings.TrimSpace(displayName) == "" {
			displayName = driverType
		}
		return localizedDriverBackendText(nil, "driver_manager.backend.error.driver_version_unsupported", map[string]any{
			"name":    displayName,
			"version": versionText,
		})
	}
}

// resolveGoBinaryPath 定位 Go 可执行文件，兼容 macOS 图形应用未继承 shell PATH 的场景 by AI.Coding
func resolveGoBinaryPath() (string, error) {
	if goPath, err := goBinaryLookPath("go"); err == nil {
		return goPath, nil
	}

	// 修复点：GUI 进程常拿不到终端里的 PATH，这里补充常见安装位置兜底。
	commonCandidates := []string{
		"/opt/homebrew/bin/go",
		"/usr/local/go/bin/go",
		"/usr/local/bin/go",
	}
	for _, candidate := range commonCandidates {
		if info, err := goBinaryStat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}

	for _, shell := range candidateShellsForCommandLookup() {
		cmd := goBinaryCommand(shell, "-lc", "command -v go")
		output, err := goBinaryCommandOutput(cmd)
		if err != nil {
			continue
		}
		goPath := resolveExistingPathFromCommandOutput(output)
		if goPath == "" {
			continue
		}
		if info, err := goBinaryStat(goPath); err == nil && !info.IsDir() {
			return goPath, nil
		}
	}

	return "", exec.ErrNotFound
}

// resolveExistingPathFromCommandOutput 从命令输出中提取真实存在的路径，避免 shell 启动脚本输出污染探测结果 by AI.Coding
func resolveExistingPathFromCommandOutput(value []byte) string {
	for _, line := range bytes.Split(value, []byte{'\n'}) {
		trimmed := strings.TrimSpace(string(line))
		if trimmed != "" {
			if info, err := goBinaryStat(trimmed); err == nil && !info.IsDir() {
				return trimmed
			}
		}
	}
	return ""
}

// candidateShellsForCommandLookup 返回可能可用的 shell，用于回收用户登录环境中的 PATH by AI.Coding
func candidateShellsForCommandLookup() []string {
	seen := make(map[string]struct{}, 4)
	result := make([]string, 0, 4)
	appendShell := func(value string) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return
		}
		if _, ok := seen[trimmed]; ok {
			return
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}

	appendShell(os.Getenv("SHELL"))
	appendShell("/bin/zsh")
	appendShell("/bin/bash")
	appendShell("/bin/sh")
	return result
}
