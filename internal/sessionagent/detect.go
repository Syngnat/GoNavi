package sessionagent

// 本文件是智能体工具的安装探测：只读取命令与目录结构证据，不遍历
// 会话正文。检测状态与原因码保持稳定字符串，绑定层映射 i18n。
// 骨架参考旧 sessionassets/adapters/codex/detect.go。

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// 检测状态与原因码。
const (
	StatusNotInstalled   = "not_installed"
	StatusNotInitialized = "not_initialized"
	StatusDataUnreadable = "data_unreadable"
	StatusReady          = "ready"

	DetailOK                = "ok"
	DetailCommandMissing    = "command_missing"
	DetailDataDirMissing    = "data_dir_missing"
	DetailDataDirUnreadable = "data_dir_unreadable"
	DetailVersionUnknown    = "version_unknown"
	DetailUnsupported       = "unsupported_kind"

	// versionProbeTimeout 限制 `--version` 的等待时间。
	versionProbeTimeout = 3 * time.Second
)

// Detection 是一次探测的完整证据：路径、版本与数据目录可读性。
type Detection struct {
	Kind         string   `json:"kind"`
	Status       string   `json:"status"`
	CommandPath  string   `json:"commandPath"`
	Version      string   `json:"version"`
	DataDir      string   `json:"dataDir"`
	DataReadable bool     `json:"dataReadable"`
	Details      []string `json:"details"`
}

// versionRe 从 `--version` 输出中提取语义化版本号。
var versionRe = regexp.MustCompile(`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`)

// Detect 探测本机安装：显式数据目录优先，否则按工具默认（Codex 尊重
// CODEX_HOME，Claude 用 ~/.claude）。命令从 PATH 查找，找不到不猜测
// 其他安装位置。
func Detect(ctx context.Context, kind, explicitDataDir string) Detection {
	normalized := ProviderID(strings.TrimSpace(kind))
	detection := Detection{Kind: normalized}

	commandName := ""
	switch normalized {
	case ProviderCodex:
		commandName = "codex"
	case ProviderClaude:
		commandName = "claude"
	default:
		detection.Status = StatusNotInstalled
		detection.Details = []string{DetailUnsupported}
		return detection
	}

	commandPath, version := resolveAgentCommand(ctx, commandName)
	detection.CommandPath = commandPath
	detection.Version = version
	commandFound := commandPath != ""
	if !commandFound {
		detection.Details = append(detection.Details, DetailCommandMissing)
	}

	dataDir, dataDirErr := resolveAgentDataDir(normalized, explicitDataDir)
	detection.DataDir = dataDir
	if dataDirErr != nil {
		detection.Status = detectStatusWithoutData(commandFound)
		detection.Details = append(detection.Details, DetailDataDirMissing)
		return detection
	}
	readable, readErr := probeAgentDataDir(normalized, dataDir)
	detection.DataReadable = readable
	switch {
	case readErr == nil && readable:
		detection.Status = StatusReady
		detection.Details = append(detection.Details, DetailOK)
		if version == "" {
			detection.Details = append(detection.Details, DetailVersionUnknown)
		}
	case os.IsNotExist(readErr):
		detection.Status = detectStatusWithoutData(commandFound)
		detection.Details = append(detection.Details, DetailDataDirMissing)
	default:
		detection.Status = StatusDataUnreadable
		detection.Details = append(detection.Details, DetailDataDirUnreadable)
	}
	return detection
}

// detectStatusWithoutData 区分「未安装」与「已安装但未初始化」。
func detectStatusWithoutData(commandFound bool) string {
	if commandFound {
		return StatusNotInitialized
	}
	return StatusNotInstalled
}

// resolveAgentCommand 从 PATH 定位命令并探版本；找不到返回空串。
func resolveAgentCommand(ctx context.Context, commandName string) (string, string) {
	path, err := exec.LookPath(commandName)
	if err != nil {
		return "", ""
	}
	version := probeAgentVersion(ctx, path)
	return path, version
}

// probeAgentVersion 运行 `<cmd> --version` 提取版本号；失败返回空串。
func probeAgentVersion(ctx context.Context, commandPath string) string {
	probeCtx, cancel := context.WithTimeout(ctx, versionProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, commandPath, "--version")
	// 探测只是读个版本号，不该在桌面上闪一个控制台窗口。
	configureProbeProcess(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return versionRe.FindString(string(out))
}

// resolveAgentDataDir 解析数据目录：显式指定 > 工具环境变量 > 默认。
func resolveAgentDataDir(kind ProviderID, explicit string) (string, error) {
	if trimmed := strings.TrimSpace(explicit); trimmed != "" {
		absolute, err := filepath.Abs(trimmed)
		if err != nil {
			return "", fmt.Errorf("resolve data dir: %w", err)
		}
		return absolute, nil
	}
	if kind == ProviderCodex {
		if env := strings.TrimSpace(os.Getenv("CODEX_HOME")); env != "" {
			return env, nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	switch kind {
	case ProviderCodex:
		return filepath.Join(home, ".codex"), nil
	case ProviderClaude:
		return filepath.Join(home, ".claude"), nil
	}
	return "", errors.New("unsupported agent kind")
}

// probeAgentDataDir 只读验证数据目录存在且会话子目录可读。
func probeAgentDataDir(kind ProviderID, dataDir string) (bool, error) {
	info, err := os.Stat(dataDir)
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, fmt.Errorf("%s is not a directory", dataDir)
	}
	// 验证会话根可列（不存在视为未初始化，可读视为就绪）。
	for _, root := range sessionRootsFor(kind, dataDir) {
		if _, err := os.ReadDir(root); err == nil {
			return true, nil
		} else if !os.IsNotExist(err) {
			return false, err
		}
	}
	return false, os.ErrNotExist
}

// sessionRootsFor 返回工具的会话根目录列表（不含工具根本身）。
func sessionRootsFor(kind ProviderID, dataDir string) []string {
	switch kind {
	case ProviderCodex:
		return []string{
			filepath.Join(dataDir, "sessions"),
			filepath.Join(dataDir, "archived_sessions"),
		}
	case ProviderClaude:
		return []string{filepath.Join(dataDir, "projects")}
	}
	return nil
}
