package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	updateRepo          = "Syngnat/GoNavi"
	updateAPIURL        = "https://api.github.com/repos/" + updateRepo + "/releases/latest"
	updateChecksumAsset = "SHA256SUMS"
)

type updateState struct {
	lastCheck  *UpdateInfo
	downloading bool
	staged     *stagedUpdate
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
	Version   string `json:"version"`
	Author    string `json:"author"`
	RepoURL   string `json:"repoUrl,omitempty"`
	IssueURL  string `json:"issueUrl,omitempty"`
	ReleaseURL string `json:"releaseUrl,omitempty"`
	BuildTime string `json:"buildTime,omitempty"`
}

type stagedUpdate struct {
	Version   string
	AssetName string
	FilePath  string
	StagedDir string
}

type githubRelease struct {
	TagName    string         `json:"tag_name"`
	Name       string         `json:"name"`
	HTMLURL    string         `json:"html_url"`
	Prerelease bool           `json:"prerelease"`
	Assets     []githubAsset  `json:"assets"`
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
		Version:   getCurrentVersion(),
		Author:    getCurrentAuthor(),
		RepoURL:   "https://github.com/" + updateRepo,
		IssueURL:  "https://github.com/" + updateRepo + "/issues",
		ReleaseURL: "https://github.com/" + updateRepo + "/releases",
		BuildTime: strings.TrimSpace(AppBuildTime),
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
	if a.updateState.staged != nil && a.updateState.staged.Version == info.LatestVersion {
		a.updateMu.Unlock()
		return connection.QueryResult{Success: true, Message: "更新包已下载完成", Data: info}
	}
	a.updateState.downloading = true
	a.updateMu.Unlock()

	result := a.downloadAndStageUpdate(*info)

	a.updateMu.Lock()
	a.updateState.downloading = false
	a.updateMu.Unlock()

	return result
}

func (a *App) InstallUpdateAndRestart() connection.QueryResult {
	a.updateMu.Lock()
	staged := a.updateState.staged
	a.updateMu.Unlock()
	if staged == nil {
		return connection.QueryResult{Success: false, Message: "未找到已下载的更新包"}
	}

	if err := launchUpdateScript(staged); err != nil {
		logger.Error(err, "启动更新脚本失败")
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	go func() {
		time.Sleep(300 * time.Millisecond)
		wailsRuntime.Quit(a.ctx)
	}()

	return connection.QueryResult{Success: true, Message: "更新已开始安装"}
}

func (a *App) downloadAndStageUpdate(info UpdateInfo) connection.QueryResult {
	stagedDir, err := os.MkdirTemp("", "gonavi-update-")
	if err != nil {
		return connection.QueryResult{Success: false, Message: "创建临时目录失败"}
	}

	assetPath := filepath.Join(stagedDir, info.AssetName)
	actualHash, err := downloadFileWithHash(info.AssetURL, assetPath)
	if err != nil {
		_ = os.RemoveAll(stagedDir)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if info.SHA256 == "" {
		_ = os.RemoveAll(stagedDir)
		return connection.QueryResult{Success: false, Message: "缺少更新包校验值（SHA256SUMS）"}
	}
	if !strings.EqualFold(info.SHA256, actualHash) {
		_ = os.RemoveAll(stagedDir)
		return connection.QueryResult{Success: false, Message: "更新包校验失败，请重试"}
	}

	a.updateMu.Lock()
	a.updateState.staged = &stagedUpdate{
		Version:   info.LatestVersion,
		AssetName: info.AssetName,
		FilePath:  assetPath,
		StagedDir: stagedDir,
	}
	a.updateMu.Unlock()

	return connection.QueryResult{Success: true, Message: "更新包下载完成", Data: info}
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

func downloadFileWithHash(url, filePath string) (string, error) {
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
	writer := io.MultiWriter(out, hasher)
	if _, err := io.Copy(writer, resp.Body); err != nil {
		return "", err
	}

	return hex.EncodeToString(hasher.Sum(nil)), nil
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
	content := buildWindowsScript(staged.FilePath, targetExe, staged.StagedDir, pid)
	if err := os.WriteFile(scriptPath, []byte(content), 0o644); err != nil {
		return err
	}

	cmd := exec.Command("cmd", "/C", "start", "", scriptPath)
	return cmd.Start()
}

func launchMacUpdate(staged *stagedUpdate, targetExe string, pid int) error {
	targetApp := detectMacAppPath(targetExe)
	if targetApp == "" {
		targetApp = "/Applications/GoNavi.app"
	}
	mountDir := filepath.Join(staged.StagedDir, "mnt")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		return err
	}

	scriptPath := filepath.Join(staged.StagedDir, "update.sh")
	content := buildMacScript(staged.FilePath, targetApp, staged.StagedDir, mountDir, pid)
	if err := os.WriteFile(scriptPath, []byte(content), 0o755); err != nil {
		return err
	}

	cmd := exec.Command("/bin/sh", scriptPath)
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

func buildWindowsScript(source, target, stagedDir string, pid int) string {
	return fmt.Sprintf(`@echo off
setlocal
set "SOURCE=%s"
set "TARGET=%s"
set "STAGED=%s"
set PID=%d
:waitloop
tasklist /FI "PID eq %%PID%%" | find "%%PID%%" >nul
if %%ERRORLEVEL%%==0 (
  timeout /t 1 /nobreak >nul
  goto waitloop
)
move /Y "%%SOURCE%%" "%%TARGET%%" >nul
start "" "%%TARGET%%"
rmdir /S /Q "%%STAGED%%"
exit /b 0
`, source, target, stagedDir, pid)
}

func buildMacScript(dmgPath, targetApp, stagedDir, mountDir string, pid int) string {
	return fmt.Sprintf(`#!/bin/bash
set -e
PID=%d
DMG="%s"
TARGET_APP="%s"
STAGED="%s"
MOUNT_DIR="%s"
while kill -0 $PID 2>/dev/null; do
  sleep 1
done
hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MOUNT_DIR"
APP_SRC=$(ls "$MOUNT_DIR"/*.app 2>/dev/null | head -n 1)
if [ -z "$APP_SRC" ]; then
  hdiutil detach "$MOUNT_DIR" -quiet || true
  exit 1
fi
rm -rf "$TARGET_APP"
cp -R "$APP_SRC" "$TARGET_APP"
hdiutil detach "$MOUNT_DIR" -quiet
rm -rf "$MOUNT_DIR" "$DMG" "$STAGED"
open "$TARGET_APP"
`, pid, dmgPath, targetApp, stagedDir, mountDir)
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
