package app

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/logger"
)

func launchUpdateScript(staged *stagedUpdate) error {
	if staged == nil {
		return localizedUpdateError{key: "app.update.backend.message.no_downloaded_package"}
	}
	if strings.TrimSpace(staged.InstallLogPath) == "" {
		staged.InstallLogPath = buildUpdateInstallLogPath(staged.WorkspaceDir)
	}
	if err := validateStagedUpdateWorkspace(staged); err != nil {
		return fmt.Errorf("invalid update workspace: %w", err)
	}
	exePath, err := resolveExecutablePath(os.Executable, filepath.EvalSymlinks)
	if err != nil || strings.TrimSpace(exePath) == "" {
		return localizedUpdateError{key: "app.update.backend.error.install_target_unresolved"}
	}
	pid := os.Getpid()

	switch stdRuntime.GOOS {
	case "windows":
		return launchWindowsUpdate(staged, exePath, pid)
	case "darwin":
		return launchMacUpdate(staged, exePath, pid)
	case "linux":
		return launchLinuxUpdate(staged, exePath, pid)
	default:
		return localizedUpdateError{
			key:    "app.update.backend.error.install_unsupported",
			params: map[string]any{"platform": stdRuntime.GOOS},
		}
	}
}

func launchWindowsUpdate(staged *stagedUpdate, targetExe string, pid int) error {
	if staged == nil {
		return localizedUpdateError{key: "app.update.backend.message.no_downloaded_package"}
	}
	handoff, err := prepareWindowsUpdateHandoff()
	if err != nil {
		return err
	}
	defer handoff.Close()
	staged.UpdateHandoffEventName = handoff.Name
	if staged != nil && staged.InstallMode == updateInstallModeMSI && staged.PackageType == updatePackageTypeMSI {
		return launchWindowsMSIUpdate(staged, targetExe, pid, handoff.Wait)
	}
	return launchWindowsUpdateWithCleanup(staged, targetExe, pid, handoff.Wait)
}

func launchMacUpdate(staged *stagedUpdate, targetExe string, pid int) error {
	targetApp := resolveMacUpdateTarget(targetExe)
	mountDir := filepath.Join(staged.StagedDir, "mnt")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		return err
	}
	logPath := strings.TrimSpace(staged.InstallLogPath)
	if logPath == "" {
		logPath = buildUpdateInstallLogPath(staged.WorkspaceDir)
		staged.InstallLogPath = logPath
	}

	scriptPath := filepath.Join(staged.StagedDir, "update.sh")
	content := buildMacScript(staged.FilePath, targetApp, resolveUpdateCleanupDir(staged.WorkspaceDir), staged.StagedDir, mountDir, logPath, pid)
	if err := os.WriteFile(scriptPath, []byte(content), 0o755); err != nil {
		return err
	}

	// 用 bash 执行脚本；Setsid 脱离主进程会话，避免 Quit 后脚本被 SIGHUP
	cmd := exec.Command("/bin/bash", scriptPath)
	configureDetachedUpdateCommand(cmd)
	logger.Infof("启动 macOS 更新脚本：target=%s script=%s log=%s package=%s", targetApp, scriptPath, logPath, staged.FilePath)
	if err := cmd.Start(); err != nil {
		return err
	}
	if cmd.Process != nil {
		if err := cmd.Process.Release(); err != nil {
			logger.Warnf("释放 macOS 更新脚本进程句柄失败：%v", err)
		}
	}
	return nil
}

func launchLinuxUpdate(staged *stagedUpdate, targetExe string, pid int) error {
	scriptPath := filepath.Join(staged.StagedDir, "update.sh")
	content := buildLinuxScript(staged.FilePath, targetExe, resolveUpdateCleanupDir(staged.WorkspaceDir), staged.StagedDir, staged.InstallLogPath, pid)
	if err := os.WriteFile(scriptPath, []byte(content), 0o755); err != nil {
		return err
	}

	cmd := exec.Command("/bin/sh", scriptPath)
	configureDetachedUpdateCommand(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	if cmd.Process != nil {
		_ = cmd.Process.Release()
	}
	return nil
}

func buildWindowsLaunchCommand(scriptPath string, context windowsUpdateLaunchContext) *exec.Cmd {
	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		windowsUpdatePowerShellExecutionPolicy,
		"-File",
		scriptPath,
	)
	cmd.Dir = context.StagedDir
	cmd.Env = append(cmd.Environ(),
		"GONAVI_UPDATE_SOURCE="+context.SourcePath,
		"GONAVI_UPDATE_TARGET="+context.TargetPath,
		"GONAVI_UPDATE_CURRENT_TARGET="+context.CurrentTargetPath,
		"GONAVI_UPDATE_ROOT_DIR="+context.UpdatesDir,
		"GONAVI_UPDATE_STAGED_DIR="+context.StagedDir,
		"GONAVI_UPDATE_LOG_PATH="+context.LogPath,
		"GONAVI_UPDATE_MAINTENANCE_EVENT_NAME="+context.MaintenanceEventName,
		"GONAVI_UPDATE_HANDOFF_EVENT_NAME="+context.HandoffEventName,
		"GONAVI_UPDATE_PID="+strconv.Itoa(context.PID),
	)
	configureWindowsUpdateCommand(cmd)
	return cmd
}

func buildMacScript(packagePath, targetApp, updatesDir, stagedDir, mountDir, logPath string, pid int) string {
	return fmt.Sprintf(`#!/bin/bash
set -uo pipefail
PID=%d
PACKAGE="%s"
TARGET_APP="%s"
UPDATES_DIR="%s"
STAGED="%s"
MOUNT_DIR="%s"
LOG_FILE="%s"
TMP_APP="${TARGET_APP}.new"
BACKUP_APP="${TARGET_APP}.backup"
EXTRACT_DIR="${STAGED}/_extract"
WAIT_PID_SECONDS=0
MAX_WAIT_PID_SECONDS=120
APP_SRC=""
APP_BIN_REL=""
DETACH_NEEDED=0

log() {
  echo "[$(date '+%%Y-%%m-%%d %%H:%%M:%%S')] $*" >> "$LOG_FILE" 2>/dev/null || true
}

cleanup_mount() {
  if [ "$DETACH_NEEDED" = "1" ]; then
    /usr/bin/hdiutil detach "$MOUNT_DIR" -quiet >>"$LOG_FILE" 2>&1 || \
      /usr/bin/hdiutil detach "$MOUNT_DIR" -force -quiet >>"$LOG_FILE" 2>&1 || true
    DETACH_NEEDED=0
  fi
}

resolve_app_binary_rel() {
  local app_root="$1"
  local preferred
  preferred=$(basename "$TARGET_APP" .app)
  if [ -n "$preferred" ] && [ -x "$app_root/Contents/MacOS/$preferred" ]; then
    APP_BIN_REL="Contents/MacOS/$preferred"
    return 0
  fi
  local found
  found=$(/usr/bin/find "$app_root/Contents/MacOS" -maxdepth 1 -type f -perm -111 2>/dev/null | /usr/bin/head -n 1 || true)
  if [ -n "$found" ]; then
    APP_BIN_REL="Contents/MacOS/$(basename "$found")"
    return 0
  fi
  return 1
}

prepare_app_source_from_package() {
  local ext
  ext=$(printf '%%s' "${PACKAGE##*.}" | tr '[:upper:]' '[:lower:]')
  case "$ext" in
    dmg)
      log "attaching dmg: $PACKAGE"
      /bin/mkdir -p "$MOUNT_DIR" >>"$LOG_FILE" 2>&1 || true
      if ! /usr/bin/hdiutil attach "$PACKAGE" -nobrowse -quiet -mountpoint "$MOUNT_DIR" >>"$LOG_FILE" 2>&1; then
        log "hdiutil attach failed, retry without quiet"
        if ! /usr/bin/hdiutil attach "$PACKAGE" -nobrowse -mountpoint "$MOUNT_DIR" >>"$LOG_FILE" 2>&1; then
          log "hdiutil attach failed for $PACKAGE"
          return 1
        fi
      fi
      DETACH_NEEDED=1
      APP_SRC=$(/usr/bin/find "$MOUNT_DIR" -maxdepth 2 -name "*.app" -type d 2>/dev/null | /usr/bin/head -n 1 || true)
      if [ -z "$APP_SRC" ]; then
        log "no .app found inside dmg mount: $MOUNT_DIR"
        return 1
      fi
      ;;
    zip)
      log "extracting zip package: $PACKAGE"
      /bin/rm -rf "$EXTRACT_DIR" >>"$LOG_FILE" 2>&1 || true
      /bin/mkdir -p "$EXTRACT_DIR" >>"$LOG_FILE" 2>&1 || true
      if ! /usr/bin/ditto -x -k "$PACKAGE" "$EXTRACT_DIR" >>"$LOG_FILE" 2>&1; then
        if ! /usr/bin/unzip -qo "$PACKAGE" -d "$EXTRACT_DIR" >>"$LOG_FILE" 2>&1; then
          log "extract zip failed: $PACKAGE"
          return 1
        fi
      fi
      APP_SRC=$(/usr/bin/find "$EXTRACT_DIR" -maxdepth 3 -name "*.app" -type d 2>/dev/null | /usr/bin/head -n 1 || true)
      if [ -z "$APP_SRC" ]; then
        log "no .app found inside zip: $PACKAGE"
        return 1
      fi
      ;;
    *)
      log "unsupported mac package type: $PACKAGE"
      return 1
      ;;
  esac
  if ! resolve_app_binary_rel "$APP_SRC"; then
    log "no executable found in package app: $APP_SRC"
    return 1
  fi
  log "package app source: $APP_SRC binary=$APP_BIN_REL"
  return 0
}

run_admin_replace() {
  /usr/bin/osascript <<'APPLESCRIPT' "$APP_SRC" "$TARGET_APP" "$TMP_APP" "$BACKUP_APP" "$APP_BIN_REL" "$LOG_FILE"
on run argv
  set srcPath to item 1 of argv
  set dstPath to item 2 of argv
  set tmpPath to item 3 of argv
  set bakPath to item 4 of argv
  set binRel to item 5 of argv
  set logPath to item 6 of argv
  set cmd to "set -eu; " & ¬
    "rm -rf " & quoted form of tmpPath & " " & quoted form of bakPath & "; " & ¬
    "/usr/bin/ditto " & quoted form of srcPath & " " & quoted form of tmpPath & "; " & ¬
    "if [ ! -x " & quoted form of (tmpPath & "/" & binRel) & " ]; then echo 'tmp app binary missing' >> " & quoted form of logPath & "; exit 1; fi; " & ¬
    "if [ -d " & quoted form of dstPath & " ]; then mv " & quoted form of dstPath & " " & quoted form of bakPath & "; fi; " & ¬
    "mv " & quoted form of tmpPath & " " & quoted form of dstPath & "; " & ¬
    "rm -rf " & quoted form of bakPath
  do shell script cmd with administrator privileges
end run
APPLESCRIPT
}

replace_app_direct() {
  /bin/rm -rf "$TMP_APP" "$BACKUP_APP" >>"$LOG_FILE" 2>&1 || true
  /usr/bin/ditto "$APP_SRC" "$TMP_APP" >>"$LOG_FILE" 2>&1
  if [ ! -x "$TMP_APP/$APP_BIN_REL" ]; then
    log "tmp app binary missing: $TMP_APP/$APP_BIN_REL"
    return 1
  fi
  if [ -d "$TARGET_APP" ]; then
    /bin/mv "$TARGET_APP" "$BACKUP_APP" >>"$LOG_FILE" 2>&1
  fi
  if ! /bin/mv "$TMP_APP" "$TARGET_APP" >>"$LOG_FILE" 2>&1; then
    log "move new app failed, trying rollback"
    /bin/rm -rf "$TARGET_APP" >>"$LOG_FILE" 2>&1 || true
    if [ -d "$BACKUP_APP" ]; then
      /bin/mv "$BACKUP_APP" "$TARGET_APP" >>"$LOG_FILE" 2>&1 || true
    fi
    return 1
  fi
  /bin/rm -rf "$BACKUP_APP" >>"$LOG_FILE" 2>&1 || true
  return 0
}

relaunch_app() {
  # open -a 需要应用名，不能传完整路径；路径必须用 open -n "xxx.app"
  if /usr/bin/open -n "$TARGET_APP" >>"$LOG_FILE" 2>&1; then
    log "relaunch via open -n path ok"
    return 0
  fi
  local app_name
  app_name=$(basename "$TARGET_APP" .app)
  if [ -n "$app_name" ] && /usr/bin/open -n -a "$app_name" >>"$LOG_FILE" 2>&1; then
    log "relaunch via open -n -a name ok: $app_name"
    return 0
  fi
  log "open failed, trying binary launch: $TARGET_APP/$APP_BIN_REL"
  if [ -x "$TARGET_APP/$APP_BIN_REL" ]; then
    nohup "$TARGET_APP/$APP_BIN_REL" >/dev/null 2>&1 &
    log "relaunch via binary pid=$!"
    return 0
  fi
  log "relaunch failed: no launch method succeeded"
  return 1
}

log "updater started package=$PACKAGE target=$TARGET_APP pid=$PID"
while /bin/kill -0 "$PID" 2>/dev/null; do
  if [ "$WAIT_PID_SECONDS" -ge "$MAX_WAIT_PID_SECONDS" ]; then
    log "host process still running after ${WAIT_PID_SECONDS}s, aborting update"
    exit 1
  fi
  /bin/sleep 1
  WAIT_PID_SECONDS=$((WAIT_PID_SECONDS + 1))
done
log "host process exited after ${WAIT_PID_SECONDS}s"
/bin/sleep 1

if [ ! -f "$PACKAGE" ]; then
  log "package file missing: $PACKAGE"
  exit 1
fi

if ! prepare_app_source_from_package; then
  cleanup_mount
  exit 1
fi

log "install target: $TARGET_APP"
if ! replace_app_direct; then
  log "direct replace failed, trying admin replace"
  if ! run_admin_replace >>"$LOG_FILE" 2>&1; then
    log "admin replace failed — package kept at: $PACKAGE"
    cleanup_mount
    exit 1
  fi
fi

if ! resolve_app_binary_rel "$TARGET_APP"; then
  log "target app binary missing after replace: $TARGET_APP — package kept at: $PACKAGE"
  cleanup_mount
  exit 1
fi
if [ ! -x "$TARGET_APP/$APP_BIN_REL" ]; then
  log "target app binary not executable: $TARGET_APP/$APP_BIN_REL — package kept at: $PACKAGE"
  cleanup_mount
  exit 1
fi

cleanup_mount
# 仅清理临时解压目录；安装包在 relaunch 成功后再删，失败则保留便于手动安装
/bin/rm -rf "$EXTRACT_DIR" >>"$LOG_FILE" 2>&1 || true

if ! relaunch_app; then
  log "update files replaced but relaunch failed — package kept for manual install: $PACKAGE"
  log "please open: $TARGET_APP"
  exit 1
fi

# 成功日志必须先落盘；删除工作区后不再写日志。
log "relaunch requested; removing updates directory"
cd /
exec /bin/rm -rf "$UPDATES_DIR"
	`, pid, packagePath, targetApp, updatesDir, stagedDir, mountDir, logPath)
}

func buildLinuxScript(tarPath, targetExe, updatesDir, stagedDir, logPath string, pid int) string {
	return fmt.Sprintf(`#!/bin/bash
set -e
PID=%d
ARCHIVE="%s"
TARGET="%s"
UPDATES_DIR="%s"
STAGED="%s"
LOG_FILE="%s"
UPDATE_TMP_DIR=""

log() {
  echo "[$(date '+%%Y-%%m-%%d %%H:%%M:%%S')] $*" >> "$LOG_FILE" 2>/dev/null || true
}

cleanup_tmp() {
  if [ -n "$UPDATE_TMP_DIR" ]; then
    rm -rf "$UPDATE_TMP_DIR"
  fi
}

trap cleanup_tmp EXIT
log "updater started archive=$ARCHIVE target=$TARGET pid=$PID"
while kill -0 $PID 2>/dev/null; do
  sleep 1
done
UPDATE_TMP_DIR=$(mktemp -d)
tar -xzf "$ARCHIVE" -C "$UPDATE_TMP_DIR"
TARGET_NAME="$(basename "$TARGET")"
NEWBIN="$UPDATE_TMP_DIR/$TARGET_NAME"
if [ ! -f "$NEWBIN" ]; then
  NEWBIN=$(find "$UPDATE_TMP_DIR" -type f -name "$TARGET_NAME" | head -n 1)
fi
if [ -z "$NEWBIN" ] || [ ! -f "$NEWBIN" ]; then
  NEWBIN=$(find "$UPDATE_TMP_DIR" -type f -name "GoNavi" | head -n 1)
fi
if [ -z "$NEWBIN" ] || [ ! -f "$NEWBIN" ]; then
  exit 1
fi
cp -f "$NEWBIN" "$TARGET"
chmod +x "$TARGET"
cleanup_tmp
UPDATE_TMP_DIR=""
"$TARGET" >/dev/null 2>&1 &
NEW_PID=$!
sleep 1
if ! kill -0 "$NEW_PID" 2>/dev/null; then
  log "updated application exited immediately after launch; updates directory retained"
  exit 1
fi
log "updated application relaunched; removing updates directory"
trap - EXIT
cd /
exec rm -rf "$UPDATES_DIR"
	`, pid, tarPath, targetExe, updatesDir, stagedDir, logPath)
}

func detectMacAppPath(exePath string) string {
	parts := strings.Split(exePath, string(filepath.Separator))
	for i := len(parts) - 1; i >= 0; i-- {
		if strings.HasSuffix(parts[i], ".app") {
			appPath := filepath.Join(parts[:i+1]...)
			// 确保返回绝对路径
			if !filepath.IsAbs(appPath) {
				appPath = string(filepath.Separator) + appPath
			}
			return appPath
		}
	}
	return ""
}

func resolveMacUpdateTarget(exePath string) string {
	targetApp := detectMacAppPath(exePath)
	if targetApp == "" {
		logger.Warnf("无法从可执行路径解析 .app，回退 /Applications/GoNavi.app：exe=%s", exePath)
		return "/Applications/GoNavi.app"
	}
	targetApp = filepath.Clean(targetApp)
	// Gatekeeper App Translocation 路径不可用于稳定覆盖更新。
	// 优先使用 /Applications 中已有的正式安装；否则仍回退到标准路径（避免写进临时隔离目录）。
	if strings.Contains(targetApp, string(filepath.Separator)+"AppTranslocation"+string(filepath.Separator)) {
		applicationsTarget := "/Applications/GoNavi.app"
		if st, err := os.Stat(applicationsTarget); err == nil && st.IsDir() {
			logger.Warnf("检测到 AppTranslocation，更新目标使用已有 Applications 安装：%s（来自 %s）", applicationsTarget, targetApp)
			return applicationsTarget
		}
		logger.Warnf("检测到 AppTranslocation 且 Applications 无安装，仍将更新到 %s（来自 %s）", applicationsTarget, targetApp)
		return applicationsTarget
	}
	// 正在运行的是桌面/便携 .app（含 dev 包）：必须覆盖「当前这份」而不是误写到 /Applications，
	// 否则会出现：latest 包被删、用户仍打开旧的 Desktop dev 包。
	logger.Infof("macOS 更新目标使用当前运行的应用包：%s", targetApp)
	return targetApp
}
