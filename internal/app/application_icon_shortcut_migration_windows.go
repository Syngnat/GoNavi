//go:build windows

package app

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

	"GoNavi-Wails/internal/logger"
)

// windowsShortcutReplacementCleanupPattern matches the whole-file replacement
// stubs the repair script builds next to the real shortcut
// ("<BaseName>-gonavi-update-<8hex>.lnk").
var windowsShortcutReplacementCleanupPattern = regexp.MustCompile(`(?i).+-gonavi-update-[0-9a-f]{8}\.lnk$`)

// removeStaleWindowsShortcutReplacementFiles deletes replacement stubs left in
// the shell shortcut folders when a previous update was killed by the 45s
// timeout before its Move-Item or the script's own cleanup could run. The
// script's catch block cannot run on a hard kill, so these would otherwise
// stay behind as visible junk next to the real shortcuts.
func removeStaleWindowsShortcutReplacementFiles() {
	for _, directory := range windowsKnownGoNaviShortcutDirectories() {
		entries, err := os.ReadDir(directory)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !windowsShortcutReplacementCleanupPattern.MatchString(entry.Name()) {
				continue
			}
			if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
				logger.Warnf("清理残留快捷方式替换文件失败：%s：%v", entry.Name(), err)
			} else {
				logger.Infof("已清理残留快捷方式替换文件：%s", entry.Name())
			}
		}
	}
}

// repairDefaultWindowsApplicationShortcuts converges machine-layer shortcuts
// to the user layer on startup even when no brand icon was ever persisted:
// the installer's per-file Users-Modify grant is a cross-user tampering
// surface that should close at first launch instead of the first brand
// switch, and profiles that never launched the app get their Start Menu entry
// rebuilt from the machine shortcuts an MSI repair/upgrade recreated.
// Best effort: failures log and retry on the next startup.
func repairDefaultWindowsApplicationShortcuts() {
	executablePath, err := os.Executable()
	if err != nil {
		logger.Warnf("解析可执行文件路径失败，跳过启动期快捷方式迁移：%v", err)
		return
	}
	// 便携/开发实例对机器层快捷方式没有所有权（MatchTargetOnly 门控），
	// 启动期迁移只属于 MSI 安装实例。
	if windowsBrandShortcutMatchTargetOnlyEnv(executablePath) == "1" {
		return
	}
	if !applicationBrandIconMu.TryLock() {
		// Initialize 派生本协程时父协程通常仍持锁，首轮常在此跳过：下次
		// 启动自动重试，篡改面在若干次启动内收敛。
		logger.Infof("启动期快捷方式迁移与图标切换并发，本轮跳过，下次启动重试")
		return
	}
	defer applicationBrandIconMu.Unlock()
	if err := migrateWindowsMachineShortcutsToUserLayer(executablePath); err != nil {
		logger.Warnf("启动期机器层快捷方式迁移失败（下次启动重试）：%v", err)
	}
}

// windowsEnsureShortcutsDisabledEnv reports "1" when the executable runs from
// a temporary directory (SFX portable extraction): a Start Menu shortcut
// created for it would point at a directory deleted on exit — a dead link the
// non-taskbar update branch never fixes (it only rewrites IconLocation) and
// the name-occupied guard never rebuilds.
func windowsEnsureShortcutsDisabledEnv(executablePath string) string {
	tempRoot := os.TempDir()
	if tempRoot != "" {
		// 补齐尾部分隔符再比较，避免 Temp 兄弟目录（如 ...\TempExtras\）
		// 被前缀误判为临时目录。
		if !strings.HasSuffix(tempRoot, string(os.PathSeparator)) && !strings.HasSuffix(tempRoot, "/") {
			tempRoot += string(os.PathSeparator)
		}
		if strings.HasPrefix(strings.ToLower(executablePath), strings.ToLower(tempRoot)) {
			return "1"
		}
	}
	return "0"
}

// migrateWindowsMachineShortcutsToUserLayer runs the shortcut repair script in
// migrate-only mode: machine-layer GoNavi shortcuts move to the user layer
// byte-for-byte (installer appearance and AppUserModel property bag intact),
// and Ensure-GoNaviAumidShortcut still backs a missing user-layer Start Menu
// entry with the executable's own icon. The icon argument is validated by the
// script but never written into shortcuts by the migration loop.
func migrateWindowsMachineShortcutsToUserLayer(executablePath string) error {
	iconDir := filepath.Join(resolveAppConfigDir(), windowsApplicationIconDirectoryName)
	if err := os.MkdirAll(iconDir, 0o755); err != nil {
		return fmt.Errorf("create Windows icon directory: %w", err)
	}
	return runWindowsShortcutUpdateScript(executablePath, executablePath, iconDir, iconDir,
		[][2]string{{"GONAVI_BRAND_MIGRATE_ONLY", "1"}})
}

// windowsShortcutUpdateEpilogue is appended to the embedded repair script for
// every brand-icon run: it drives Set-GoNaviShortcutBrandIcon with the brand
// environment and reports UPDATED/FAILED. When any shortcut was rewritten the
// Start menu host restarts so the all-apps list rebuilds its icon snapshot —
// that list ignores every shell notification (item, directory and the global
// association flush; observed on Windows 11 26200) and only rereads shortcuts
// when its host process starts.
const windowsShortcutUpdateEpilogue = `

$ErrorActionPreference = 'Stop'
$updated = Set-GoNaviShortcutBrandIcon -TargetPath $env:GONAVI_BRAND_TARGET -IconPath $env:GONAVI_BRAND_ICON -ApplicationUserModelID $env:GONAVI_BRAND_AUMID
$failed = 0
if ($null -ne $script:GoNaviBrandFailureCount) { $failed = [int]$script:GoNaviBrandFailureCount }
Write-Output ("UPDATED=" + $updated + " FAILED=" + $failed)
if ($updated -gt 0 -and $env:GONAVI_BRAND_RESTART_STARTMENU -ne '0') {
    Restart-GoNaviStartMenuHost
}
`

// runWindowsShortcutUpdateScript materializes the embedded repair script and
// runs it with the standard brand environment plus extraEnv. scriptDir hosts
// the temporary .ps1 (the icon directory for every caller, so standard users
// can always create it); logDir receives the repair log.
func runWindowsShortcutUpdateScript(executablePath, iconPath, scriptDir, logDir string, extraEnv [][2]string) error {
	temporary, err := os.CreateTemp(scriptDir, ".gonavi-brand-shortcuts-*.ps1")
	if err != nil {
		return fmt.Errorf("create Windows shortcut update script: %w", err)
	}
	scriptPath := temporary.Name()
	defer os.Remove(scriptPath)
	script := windowsShortcutRepairPowerShellScript + windowsShortcutUpdateEpilogue
	if _, err := temporary.WriteString(strings.ReplaceAll(script, "\n", "\r\n")); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write Windows shortcut update script: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close Windows shortcut update script: %w", err)
	}

	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		windowsUpdatePowerShellExecutionPolicy,
		"-File",
		scriptPath,
	)
	cmd.Dir = scriptDir
	cmd.Env = append(cmd.Environ(),
		"GONAVI_BRAND_TARGET="+executablePath,
		"GONAVI_BRAND_ICON="+iconPath,
		"GONAVI_BRAND_AUMID="+windowsApplicationUserModelIDForIconPath(iconPath),
		"GONAVI_BRAND_MATCH_TARGET_ONLY="+windowsBrandShortcutMatchTargetOnlyEnv(executablePath),
		"GONAVI_BRAND_REPAIR_LOG="+filepath.Join(logDir, "shortcut-repair.log"),
		"GONAVI_BRAND_ENSURE_SHORTCUTS_DISABLED="+windowsEnsureShortcutsDisabledEnv(executablePath),
	)
	for _, pair := range extraEnv {
		cmd.Env = append(cmd.Env, pair[0]+"="+pair[1])
	}
	configureWindowsUpdateCommand(cmd)
	// 启动路径同步等待本脚本；powershell 被 AV/策略挂起时绝不能拖死
	// OnStartup（否则 4s 窗口显示兜底永不启动，应用表现为启动了但无窗口）。
	// CommandContext 不改已配置的 Dir/Env/属性，只注入超时取消。
	const windowsShortcutUpdateTimeout = 45 * time.Second
	timeoutCtx, cancelTimeout := context.WithTimeout(context.Background(), windowsShortcutUpdateTimeout)
	defer cancelTimeout()
	commandContextCmd := exec.CommandContext(timeoutCtx, "powershell.exe")
	commandContextCmd.Path = cmd.Path
	commandContextCmd.Args = cmd.Args
	commandContextCmd.Dir = cmd.Dir
	commandContextCmd.Env = cmd.Env
	configureWindowsUpdateCommand(commandContextCmd)
	cmd = commandContextCmd
	output, err := cmd.CombinedOutput()
	if errors.Is(timeoutCtx.Err(), context.DeadlineExceeded) {
		logger.Warnf("Windows 快捷方式更新脚本执行超时（%v），按失败继续", windowsShortcutUpdateTimeout)
	}
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if detail != "" {
			return fmt.Errorf("update Windows application shortcuts: %w: %s", err, detail)
		}
		return fmt.Errorf("update Windows application shortcuts: %w", err)
	}
	// 单项失败（标准用户写机器级快捷方式被拒等）不中止，但必须可见：
	// 明细已写入 shortcut-repair.log，这里记一条汇总便于事后诊断。
	if m := windowsShortcutUpdateFailedCount(string(output)); m > 0 {
		logger.Warnf("Windows 快捷方式图标更新有 %d 项失败（详见 shortcut-repair.log）", m)
	}
	return nil
}
