package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	updateRepo                  = "Syngnat/GoNavi"
	updateAPIURL                = "https://api.github.com/repos/" + updateRepo + "/releases/latest"
	updateChecksumAsset         = "SHA256SUMS"
	updateDownloadProgressEvent = "update:download-progress"
)

type updateState struct {
	lastCheck   *UpdateInfo
	downloading bool
	staged      *stagedUpdate
}

type UpdateInfo struct {
	HasUpdate       bool   `json:"hasUpdate"`
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	ReleaseName     string `json:"releaseName"`
	ReleaseNotesURL string `json:"releaseNotesUrl"`
	AssetName       string `json:"assetName"`
	AssetURL        string `json:"assetUrl"`
	AssetSize       int64  `json:"assetSize"`
	SHA256          string `json:"sha256"`
}

type AppInfo struct {
	Version    string `json:"version"`
	Author     string `json:"author"`
	RepoURL    string `json:"repoUrl,omitempty"`
	IssueURL   string `json:"issueUrl,omitempty"`
	ReleaseURL string `json:"releaseUrl,omitempty"`
	BuildTime  string `json:"buildTime,omitempty"`
}

type updateDownloadResult struct {
	Info           UpdateInfo `json:"info"`
	DownloadPath   string     `json:"downloadPath,omitempty"`
	InstallLogPath string     `json:"installLogPath,omitempty"`
	InstallTarget  string     `json:"installTarget,omitempty"`
	Platform       string     `json:"platform"`
	AutoRelaunch   bool       `json:"autoRelaunch"`
}

type updateDownloadProgressPayload struct {
	Status     string  `json:"status"`
	Percent    float64 `json:"percent"`
	Downloaded int64   `json:"downloaded"`
	Total      int64   `json:"total"`
	Message    string  `json:"message,omitempty"`
}

type stagedUpdate struct {
	Version        string
	AssetName      string
	FilePath       string
	StagedDir      string
	InstallLogPath string
}

type githubRelease struct {
	TagName    string        `json:"tag_name"`
	Name       string        `json:"name"`
	HTMLURL    string        `json:"html_url"`
	Prerelease bool          `json:"prerelease"`
	Assets     []githubAsset `json:"assets"`
}

type githubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

func (a *App) CheckForUpdates() connection.QueryResult {
	info, err := fetchLatestUpdateInfo()
	if err != nil {
		logger.Error(err, "检查更新失败")
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	a.updateMu.Lock()
	a.updateState.lastCheck = &info
	a.updateMu.Unlock()

	msg := "已是最新版本"
	if info.HasUpdate {
		msg = fmt.Sprintf("发现新版本：%s", info.LatestVersion)
	}
	return connection.QueryResult{Success: true, Message: msg, Data: info}
}

func (a *App) GetAppInfo() connection.QueryResult {
	info := AppInfo{
		Version:    getCurrentVersion(),
		Author:     getCurrentAuthor(),
		RepoURL:    "https://github.com/" + updateRepo,
		IssueURL:   "https://github.com/" + updateRepo + "/issues",
		ReleaseURL: "https://github.com/" + updateRepo + "/releases",
		BuildTime:  strings.TrimSpace(AppBuildTime),
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: info}
}

func (a *App) DownloadUpdate() connection.QueryResult {
	a.updateMu.Lock()
	if a.updateState.downloading {
		a.updateMu.Unlock()
		return connection.QueryResult{Success: false, Message: "更新包正在下载中，请稍后重试"}
	}
	info := a.updateState.lastCheck
	if info == nil {
		a.updateMu.Unlock()
		return connection.QueryResult{Success: false, Message: "请先检查更新"}
	}
	if !info.HasUpdate {
		a.updateMu.Unlock()
		return connection.QueryResult{Success: false, Message: "当前已是最新版本"}
	}
	if info.AssetURL == "" || info.AssetName == "" {
		a.updateMu.Unlock()
		return connection.QueryResult{Success: false, Message: "未找到可用的更新包"}
	}
	staged := a.updateState.staged
	if staged != nil && staged.Version == info.LatestVersion {
		a.updateMu.Unlock()
		return connection.QueryResult{Success: true, Message: "更新包已下载完成", Data: buildUpdateDownloadResult(*info, staged)}
	}
	a.updateState.downloading = true
	a.updateMu.Unlock()

	a.emitUpdateDownloadProgress("start", 0, info.AssetSize, "")
	result := a.downloadAndStageUpdate(*info)

	a.updateMu.Lock()
	a.updateState.downloading = false
	a.updateMu.Unlock()

	return result
}

func (a *App) InstallUpdateAndRestart() connection.QueryResult {
	a.updateMu.Lock()
	staged := a.updateState.staged
	if staged != nil && strings.TrimSpace(staged.InstallLogPath) == "" {
		staged.InstallLogPath = buildUpdateInstallLogPath(filepath.Dir(staged.FilePath))
	}
	a.updateMu.Unlock()
	if staged == nil {
		return connection.QueryResult{Success: false, Message: "未找到已下载的更新包"}
	}

	if err := launchUpdateScript(staged); err != nil {
		logger.Error(err, "启动更新脚本失败")
		msg := err.Error()
		if staged.InstallLogPath != "" {
			msg = fmt.Sprintf("%s（更新日志：%s）", msg, staged.InstallLogPath)
		}
		return connection.QueryResult{
			Success: false,
			Message: msg,
			Data: map[string]any{
				"logPath": staged.InstallLogPath,
			},
		}
	}

	go func() {
		time.Sleep(300 * time.Millisecond)
		wailsRuntime.Quit(a.ctx)
		// 兜底退出，避免某些平台/窗口状态下 Quit 未真正结束进程，导致更新脚本一直等待。
		time.Sleep(2 * time.Second)
		os.Exit(0)
	}()

	msg := "更新已开始安装"
	if staged.InstallLogPath != "" {
		msg = fmt.Sprintf("更新已开始安装，日志路径：%s", staged.InstallLogPath)
	}
	return connection.QueryResult{
		Success: true,
		Message: msg,
		Data: map[string]any{
			"logPath": staged.InstallLogPath,
		},
	}
}

func (a *App) downloadAndStageUpdate(info UpdateInfo) connection.QueryResult {
	workspaceDir := strings.TrimSpace(resolveUpdateWorkspaceDir())
	if workspaceDir == "" {
		a.emitUpdateDownloadProgress("error", 0, info.AssetSize, "无法确定当前应用目录")
		return connection.QueryResult{Success: false, Message: "无法确定当前应用目录，无法下载更新"}
	}
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		errMsg := fmt.Sprintf("无法访问应用目录：%s", workspaceDir)
		a.emitUpdateDownloadProgress("error", 0, info.AssetSize, errMsg)
		return connection.QueryResult{Success: false, Message: errMsg}
	}

	stagedDir, err := os.MkdirTemp(workspaceDir, ".gonavi-update-work-")
	if err != nil {
		errMsg := fmt.Sprintf("无法在应用目录创建更新工作目录：%s", workspaceDir)
		a.emitUpdateDownloadProgress("error", 0, info.AssetSize, errMsg)
		return connection.QueryResult{Success: false, Message: errMsg}
	}

	assetPath := filepath.Join(workspaceDir, info.AssetName)
	actualHash, err := downloadFileWithHash(info.AssetURL, assetPath, func(downloaded, total int64) {
		reportTotal := total
		if reportTotal <= 0 {
			reportTotal = info.AssetSize
		}
		a.emitUpdateDownloadProgress("downloading", downloaded, reportTotal, "")
	})
	if err != nil {
		_ = os.Remove(assetPath)
		_ = os.RemoveAll(stagedDir)
		a.emitUpdateDownloadProgress("error", 0, info.AssetSize, err.Error())
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if info.SHA256 == "" {
		_ = os.Remove(assetPath)
		_ = os.RemoveAll(stagedDir)
		a.emitUpdateDownloadProgress("error", 0, info.AssetSize, "缺少更新包校验值（SHA256SUMS）")
		return connection.QueryResult{Success: false, Message: "缺少更新包校验值（SHA256SUMS）"}
	}
	if !strings.EqualFold(info.SHA256, actualHash) {
		_ = os.Remove(assetPath)
		_ = os.RemoveAll(stagedDir)
		a.emitUpdateDownloadProgress("error", 0, info.AssetSize, "更新包校验失败，请重试")
		return connection.QueryResult{Success: false, Message: "更新包校验失败，请重试"}
	}

	staged := &stagedUpdate{
		Version:        info.LatestVersion,
		AssetName:      info.AssetName,
		FilePath:       assetPath,
		StagedDir:      stagedDir,
		InstallLogPath: buildUpdateInstallLogPath(workspaceDir),
	}
	a.updateMu.Lock()
	a.updateState.staged = staged
	a.updateMu.Unlock()

	a.emitUpdateDownloadProgress("done", info.AssetSize, info.AssetSize, "")
	return connection.QueryResult{Success: true, Message: "更新包下载完成", Data: buildUpdateDownloadResult(info, staged)}
}

func fetchLatestUpdateInfo() (UpdateInfo, error) {
	release, err := fetchLatestRelease()
	if err != nil {
		return UpdateInfo{}, err
	}

	currentVersion := getCurrentVersion()
	latestVersion := normalizeVersion(release.TagName)
	if latestVersion == "" {
		return UpdateInfo{}, errors.New("无法解析最新版本号")
	}

	assetName, err := expectedAssetName(stdRuntime.GOOS, stdRuntime.GOARCH)
	if err != nil {
		return UpdateInfo{}, err
	}
	asset, err := findReleaseAsset(release.Assets, assetName)
	if err != nil {
		return UpdateInfo{}, err
	}

	hashMap, err := fetchReleaseSHA256(release.Assets)
	if err != nil {
		return UpdateInfo{}, err
	}
	sha256Value := strings.TrimSpace(hashMap[assetName])
	if sha256Value == "" {
		return UpdateInfo{}, errors.New("SHA256SUMS 未包含当前平台更新包")
	}

	hasUpdate := compareVersion(currentVersion, latestVersion) < 0

	return UpdateInfo{
		HasUpdate:       hasUpdate,
		CurrentVersion:  currentVersion,
		LatestVersion:   latestVersion,
		ReleaseName:     release.Name,
		ReleaseNotesURL: release.HTMLURL,
		AssetName:       asset.Name,
		AssetURL:        asset.BrowserDownloadURL,
		AssetSize:       asset.Size,
		SHA256:          sha256Value,
	}, nil
}

func getCurrentAuthor() string {
	if env := strings.TrimSpace(os.Getenv("GONAVI_AUTHOR")); env != "" {
		return env
	}
	parts := strings.Split(updateRepo, "/")
	if len(parts) > 0 {
		return parts[0]
	}
	return ""
}

func fetchLatestRelease() (*githubRelease, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodGet, updateAPIURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoNavi-Updater")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("检查更新失败：HTTP %d", resp.StatusCode)
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, err
	}
	return &release, nil
}

func expectedAssetName(goos, goarch string) (string, error) {
	switch goos {
	case "windows":
		if goarch == "amd64" {
			return "GoNavi-windows-amd64.exe", nil
		}
		if goarch == "arm64" {
			return "GoNavi-windows-arm64.exe", nil
		}
	case "darwin":
		if goarch == "amd64" {
			return "GoNavi-mac-amd64.dmg", nil
		}
		if goarch == "arm64" {
			return "GoNavi-mac-arm64.dmg", nil
		}
	case "linux":
		if goarch == "amd64" {
			return "GoNavi-linux-amd64.tar.gz", nil
		}
	}
	return "", fmt.Errorf("当前平台暂不支持在线更新：%s/%s", goos, goarch)
}

func findReleaseAsset(assets []githubAsset, name string) (*githubAsset, error) {
	for _, asset := range assets {
		if asset.Name == name {
			return &asset, nil
		}
	}
	return nil, fmt.Errorf("未找到更新包：%s", name)
}

func fetchReleaseSHA256(assets []githubAsset) (map[string]string, error) {
	var checksumURL string
	for _, asset := range assets {
		if strings.EqualFold(asset.Name, updateChecksumAsset) || strings.Contains(strings.ToLower(asset.Name), "sha256sums") {
			checksumURL = asset.BrowserDownloadURL
			break
		}
	}
	if checksumURL == "" {
		return nil, errors.New("Release 未提供 SHA256SUMS")
	}

	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodGet, checksumURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoNavi-Updater")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载 SHA256SUMS 失败：HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	return parseSHA256Sums(string(body)), nil
}

func parseSHA256Sums(content string) map[string]string {
	result := make(map[string]string)
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		hash := fields[0]
		name := fields[len(fields)-1]
		name = strings.TrimPrefix(name, "*")
		name = strings.TrimPrefix(name, "./")
		result[name] = hash
	}
	return result
}

type downloadProgressWriter struct {
	total      int64
	written    int64
	lastEmit   time.Time
	emitEvery  time.Duration
	onProgress func(downloaded, total int64)
}

func (w *downloadProgressWriter) Write(p []byte) (int, error) {
	n := len(p)
	if n == 0 {
		return 0, nil
	}
	w.written += int64(n)
	if w.onProgress == nil {
		return n, nil
	}
	now := time.Now()
	if w.lastEmit.IsZero() || now.Sub(w.lastEmit) >= w.emitEvery || (w.total > 0 && w.written >= w.total) {
		w.lastEmit = now
		w.onProgress(w.written, w.total)
	}
	return n, nil
}

func downloadFileWithHash(url, filePath string, onProgress func(downloaded, total int64)) (string, error) {
	client := &http.Client{Timeout: 10 * time.Minute}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "GoNavi-Updater")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载更新包失败：HTTP %d", resp.StatusCode)
	}

	out, err := os.Create(filePath)
	if err != nil {
		return "", err
	}
	defer out.Close()

	hasher := sha256.New()
	total := resp.ContentLength
	progressWriter := &downloadProgressWriter{
		total:      total,
		emitEvery:  120 * time.Millisecond,
		onProgress: onProgress,
	}
	writers := []io.Writer{out, hasher, progressWriter}
	if onProgress != nil {
		onProgress(0, total)
	}
	if _, err := io.Copy(io.MultiWriter(writers...), resp.Body); err != nil {
		return "", err
	}
	if onProgress != nil {
		onProgress(progressWriter.written, total)
	}

	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func buildUpdateDownloadResult(info UpdateInfo, staged *stagedUpdate) updateDownloadResult {
	result := updateDownloadResult{
		Info:          info,
		Platform:      stdRuntime.GOOS,
		InstallTarget: resolveUpdateInstallTarget(),
		AutoRelaunch:  true,
	}
	if staged != nil {
		result.DownloadPath = staged.FilePath
		result.InstallLogPath = staged.InstallLogPath
	}
	return result
}

func buildUpdateInstallLogPath(baseDir string) string {
	platform := stdRuntime.GOOS
	if platform == "darwin" {
		platform = "macos"
	}
	logDir := strings.TrimSpace(baseDir)
	if logDir == "" {
		logDir = os.TempDir()
	}
	return filepath.Join(logDir, fmt.Sprintf("gonavi-update-%s-%d.log", platform, time.Now().UnixNano()))
}

func resolveUpdateWorkspaceDir() string {
	exePath, err := os.Executable()
	if err != nil {
		return ""
	}
	exePath, _ = filepath.EvalSymlinks(exePath)
	if stdRuntime.GOOS == "darwin" {
		appPath := detectMacAppPath(exePath)
		if appPath != "" {
			return filepath.Dir(appPath)
		}
	}
	return filepath.Dir(exePath)
}

func resolveUpdateInstallTarget() string {
	exePath, err := os.Executable()
	if err != nil {
		return ""
	}
	exePath, _ = filepath.EvalSymlinks(exePath)
	if stdRuntime.GOOS == "darwin" {
		return resolveMacUpdateTarget(exePath)
	}
	return exePath
}

func (a *App) emitUpdateDownloadProgress(status string, downloaded, total int64, message string) {
	if a.ctx == nil {
		return
	}
	payload := updateDownloadProgressPayload{
		Status:     status,
		Percent:    0,
		Downloaded: downloaded,
		Total:      total,
		Message:    strings.TrimSpace(message),
	}
	if total > 0 {
		payload.Percent = math.Min(100, (float64(downloaded)/float64(total))*100)
	}
	if status == "done" && payload.Percent < 100 {
		payload.Percent = 100
	}
	wailsRuntime.EventsEmit(a.ctx, updateDownloadProgressEvent, payload)
}

func launchUpdateScript(staged *stagedUpdate) error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	exePath, _ = filepath.EvalSymlinks(exePath)
	pid := os.Getpid()

	switch stdRuntime.GOOS {
	case "windows":
		return launchWindowsUpdate(staged, exePath, pid)
	case "darwin":
		return launchMacUpdate(staged, exePath, pid)
	case "linux":
		return launchLinuxUpdate(staged, exePath, pid)
	default:
		return fmt.Errorf("当前平台暂不支持更新安装：%s", stdRuntime.GOOS)
	}
}

func launchWindowsUpdate(staged *stagedUpdate, targetExe string, pid int) error {
	scriptPath := filepath.Join(staged.StagedDir, "update.cmd")
	logPath := strings.TrimSpace(staged.InstallLogPath)
	if logPath == "" {
		logPath = buildUpdateInstallLogPath(filepath.Dir(staged.FilePath))
		staged.InstallLogPath = logPath
	}
	content := buildWindowsScript(staged.FilePath, targetExe, staged.StagedDir, logPath, pid)
	if err := os.WriteFile(scriptPath, []byte(content), 0o644); err != nil {
		return err
	}

	logger.Infof("启动 Windows 更新脚本：target=%s script=%s log=%s", targetExe, scriptPath, logPath)
	cmd := exec.Command("cmd", "/C", "start", "", scriptPath)
	return cmd.Start()
}

func launchMacUpdate(staged *stagedUpdate, targetExe string, pid int) error {
	targetApp := resolveMacUpdateTarget(targetExe)
	mountDir := filepath.Join(staged.StagedDir, "mnt")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		return err
	}
	logPath := strings.TrimSpace(staged.InstallLogPath)
	if logPath == "" {
		logPath = buildUpdateInstallLogPath(filepath.Dir(staged.FilePath))
		staged.InstallLogPath = logPath
	}

	scriptPath := filepath.Join(staged.StagedDir, "update.sh")
	content := buildMacScript(staged.FilePath, targetApp, staged.StagedDir, mountDir, logPath, pid)
	if err := os.WriteFile(scriptPath, []byte(content), 0o755); err != nil {
		return err
	}

	cmd := exec.Command("/bin/bash", scriptPath)
	logger.Infof("启动 macOS 更新脚本：target=%s script=%s log=%s", targetApp, scriptPath, logPath)
	return cmd.Start()
}

func launchLinuxUpdate(staged *stagedUpdate, targetExe string, pid int) error {
	scriptPath := filepath.Join(staged.StagedDir, "update.sh")
	content := buildLinuxScript(staged.FilePath, targetExe, staged.StagedDir, pid)
	if err := os.WriteFile(scriptPath, []byte(content), 0o755); err != nil {
		return err
	}

	cmd := exec.Command("/bin/sh", scriptPath)
	return cmd.Start()
}

func buildWindowsScript(source, target, stagedDir, logPath string, pid int) string {
	return fmt.Sprintf(`@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "SOURCE=%s"
set "TARGET=%s"
set "STAGED=%s"
set "LOG_FILE=%s"
set PID=%d

call :log updater started
if not exist "%%SOURCE%%" (
  call :log source file not found: %%SOURCE%%
  exit /b 1
)

:waitloop
tasklist /FI "PID eq %%PID%%" | find "%%PID%%" >nul
if %%ERRORLEVEL%%==0 (
  timeout /t 1 /nobreak >nul
  goto waitloop
)
call :log host process exited

set /a RETRY=0
:move_retry
move /Y "%%SOURCE%%" "%%TARGET%%" >> "%%LOG_FILE%%" 2>&1
if %%ERRORLEVEL%%==0 goto move_done

copy /Y "%%SOURCE%%" "%%TARGET%%" >> "%%LOG_FILE%%" 2>&1
if %%ERRORLEVEL%%==0 goto move_done

set /a RETRY+=1
if !RETRY! LSS 20 (
  timeout /t 1 /nobreak >nul
  goto move_retry
)

call :log replace failed after retries (portable mode, no elevation): check directory write permission or file lock
exit /b 1

:move_done
start "" "%%TARGET%%" >> "%%LOG_FILE%%" 2>&1
if %%ERRORLEVEL%% NEQ 0 (
  call :log cmd start failed, trying powershell Start-Process
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%%TARGET%%'" >> "%%LOG_FILE%%" 2>&1
  if %%ERRORLEVEL%% NEQ 0 (
    call :log relaunch failed
    exit /b 1
  )
)
rmdir /S /Q "%%STAGED%%" >> "%%LOG_FILE%%" 2>&1
call :log update finished
exit /b 0

:log
echo [%%date%% %%time%%] %%*>>"%%LOG_FILE%%"
exit /b 0
`, source, target, stagedDir, logPath, pid)
}

func buildMacScript(dmgPath, targetApp, stagedDir, mountDir, logPath string, pid int) string {
	return fmt.Sprintf(`#!/bin/bash
set -euo pipefail
PID=%d
DMG="%s"
TARGET_APP="%s"
STAGED="%s"
MOUNT_DIR="%s"
LOG_FILE="%s"
TMP_APP="${TARGET_APP}.new"
BACKUP_APP="${TARGET_APP}.backup"
APP_BIN_NAME=$(basename "$TARGET_APP" .app)
APP_BIN_REL="Contents/MacOS/$APP_BIN_NAME"

log() {
  echo "[$(date '+%%Y-%%m-%%d %%H:%%M:%%S')] $*" >> "$LOG_FILE"
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
    "xattr -rd com.apple.quarantine " & quoted form of tmpPath & " >> " & quoted form of logPath & " 2>&1 || true; " & ¬
    "if [ -d " & quoted form of dstPath & " ]; then mv " & quoted form of dstPath & " " & quoted form of bakPath & "; fi; " & ¬
    "mv " & quoted form of tmpPath & " " & quoted form of dstPath & "; " & ¬
    "rm -rf " & quoted form of bakPath & "; " & ¬
    "xattr -rd com.apple.quarantine " & quoted form of dstPath & " >> " & quoted form of logPath & " 2>&1 || true"
  do shell script cmd with administrator privileges
end run
APPLESCRIPT
}

replace_app_direct() {
  rm -rf "$TMP_APP" "$BACKUP_APP" >>"$LOG_FILE" 2>&1 || true
  /usr/bin/ditto "$APP_SRC" "$TMP_APP" >>"$LOG_FILE" 2>&1
  if [ ! -x "$TMP_APP/$APP_BIN_REL" ]; then
    log "tmp app binary missing: $TMP_APP/$APP_BIN_REL"
    return 1
  fi
  xattr -rd com.apple.quarantine "$TMP_APP" >>"$LOG_FILE" 2>&1 || true
  if [ -d "$TARGET_APP" ]; then
    mv "$TARGET_APP" "$BACKUP_APP" >>"$LOG_FILE" 2>&1
  fi
  if ! mv "$TMP_APP" "$TARGET_APP" >>"$LOG_FILE" 2>&1; then
    log "move new app failed, trying rollback"
    rm -rf "$TARGET_APP" >>"$LOG_FILE" 2>&1 || true
    if [ -d "$BACKUP_APP" ]; then
      mv "$BACKUP_APP" "$TARGET_APP" >>"$LOG_FILE" 2>&1 || true
    fi
    return 1
  fi
  rm -rf "$BACKUP_APP" >>"$LOG_FILE" 2>&1 || true
  xattr -rd com.apple.quarantine "$TARGET_APP" >>"$LOG_FILE" 2>&1 || true
  return 0
}

relaunch_app() {
  if /usr/bin/open -n "$TARGET_APP" >>"$LOG_FILE" 2>&1; then
    return 0
  fi
  log "open -n failed, trying binary launch"
  "$TARGET_APP/$APP_BIN_REL" >>"$LOG_FILE" 2>&1 &
  return 0
}

log "updater started"
while kill -0 $PID 2>/dev/null; do
  sleep 1
done
log "host process exited"
hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MOUNT_DIR" >>"$LOG_FILE" 2>&1
APP_SRC=$(ls "$MOUNT_DIR"/*.app 2>/dev/null | head -n 1 || true)
if [ -z "$APP_SRC" ]; then
  log "no .app found inside dmg"
  hdiutil detach "$MOUNT_DIR" -quiet >>"$LOG_FILE" 2>&1 || true
  exit 1
fi

log "install target: $TARGET_APP"
if ! replace_app_direct; then
  log "direct replace failed, trying admin replace"
  run_admin_replace >>"$LOG_FILE" 2>&1
fi

if [ ! -x "$TARGET_APP/$APP_BIN_REL" ]; then
  log "target app binary missing after replace: $TARGET_APP/$APP_BIN_REL"
  hdiutil detach "$MOUNT_DIR" -quiet >>"$LOG_FILE" 2>&1 || true
  exit 1
fi

hdiutil detach "$MOUNT_DIR" -quiet >>"$LOG_FILE" 2>&1 || true
rm -rf "$MOUNT_DIR" "$DMG" "$STAGED" >>"$LOG_FILE" 2>&1 || true
relaunch_app
log "relaunch requested"
	`, pid, dmgPath, targetApp, stagedDir, mountDir, logPath)
}

func buildLinuxScript(tarPath, targetExe, stagedDir string, pid int) string {
	return fmt.Sprintf(`#!/bin/bash
set -e
PID=%d
ARCHIVE="%s"
TARGET="%s"
STAGED="%s"
while kill -0 $PID 2>/dev/null; do
  sleep 1
done
TMPDIR=$(mktemp -d)
tar -xzf "$ARCHIVE" -C "$TMPDIR"
NEWBIN="$TMPDIR/GoNavi"
if [ ! -f "$NEWBIN" ]; then
  NEWBIN=$(find "$TMPDIR" -type f -name "GoNavi" | head -n 1)
fi
if [ -z "$NEWBIN" ] || [ ! -f "$NEWBIN" ]; then
  exit 1
fi
cp -f "$NEWBIN" "$TARGET"
chmod +x "$TARGET"
rm -rf "$TMPDIR" "$ARCHIVE" "$STAGED"
"$TARGET" &
`, pid, tarPath, targetExe, stagedDir)
}

func detectMacAppPath(exePath string) string {
	parts := strings.Split(exePath, string(filepath.Separator))
	for i := len(parts) - 1; i >= 0; i-- {
		if strings.HasSuffix(parts[i], ".app") {
			return filepath.Join(parts[:i+1]...)
		}
	}
	return ""
}

func resolveMacUpdateTarget(exePath string) string {
	targetApp := detectMacAppPath(exePath)
	if targetApp == "" {
		return "/Applications/GoNavi.app"
	}
	targetApp = filepath.Clean(targetApp)
	// Gatekeeper App Translocation 路径不可用于稳定覆盖更新，统一回退到 /Applications。
	if strings.Contains(targetApp, string(filepath.Separator)+"AppTranslocation"+string(filepath.Separator)) {
		logger.Warnf("检测到 AppTranslocation 运行路径，更新目标回退至 /Applications/GoNavi.app：%s", targetApp)
		return "/Applications/GoNavi.app"
	}
	return targetApp
}

func normalizeVersion(version string) string {
	version = strings.TrimSpace(version)
	version = strings.TrimPrefix(version, "v")
	return version
}

func compareVersion(current, latest string) int {
	current = normalizeVersion(current)
	latest = normalizeVersion(latest)
	if current == "" {
		return -1
	}
	if current == latest {
		return 0
	}

	curParts := splitVersionParts(current)
	latParts := splitVersionParts(latest)
	max := len(curParts)
	if len(latParts) > max {
		max = len(latParts)
	}
	for i := 0; i < max; i++ {
		cur := 0
		lat := 0
		if i < len(curParts) {
			cur = curParts[i]
		}
		if i < len(latParts) {
			lat = latParts[i]
		}
		if cur < lat {
			return -1
		}
		if cur > lat {
			return 1
		}
	}
	return 0
}

func splitVersionParts(version string) []int {
	parts := strings.Split(version, ".")
	result := make([]int, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			result = append(result, 0)
			continue
		}
		num := 0
		for _, ch := range part {
			if ch < '0' || ch > '9' {
				break
			}
			num = num*10 + int(ch-'0')
		}
		result = append(result, num)
	}
	return result
}
