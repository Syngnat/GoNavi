package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	urlpkg "net/url"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/uievents"
	"github.com/google/uuid"
)

const (
	updateRepo                             = "Syngnat/GoNavi"
	updateLatestAPIURL                     = "https://api.github.com/repos/" + updateRepo + "/releases/latest"
	updateDevAPIURL                        = "https://api.github.com/repos/" + updateRepo + "/releases/tags/" + updateDevReleaseTag
	updateChecksumAsset                    = "SHA256SUMS"
	updateDownloadProgressEvent            = "update:download-progress"
	updateNetworkRetryDelay                = 250 * time.Millisecond
	updateCurrentDevAssetRetryLimit        = 8
	updateCurrentDevAssetRetryInitialDelay = time.Second
	updateCurrentDevAssetRetryMaxDelay     = time.Minute
	updateQuitRequestDelay                 = 300 * time.Millisecond
	updateQuitForceExitDelay               = 35 * time.Second
	updateReleaseCacheTTL                  = 10 * time.Minute
	updateGitHubAPIVersion                 = "2022-11-28"
	updateHTTPBodySnippetLimit             = 240
)

type cachedGitHubRelease struct {
	release   *githubRelease
	fetchedAt time.Time
}

var updateReleaseCache sync.Map // apiURL -> cachedGitHubRelease

var (
	updateFetchLatestRelease                    = fetchLatestRelease
	updateFetchDevRelease                       = fetchDevRelease
	updateFetchReleaseSHA256                    = fetchReleaseSHA256
	updateLogCheckError                         = func(err error) { logger.Error(err, "检查更新失败") }
	updateResolveInstallTarget                  = resolveUpdateInstallTarget
	updateResolveInstallMode                    = resolveCurrentUpdateInstallMode
	updateLaunchInstallScript                   = launchUpdateScript
	updateFindOtherWindowsInstances             = findOtherWindowsUpdateInstances
	updateCloseWindowsInstances                 = closeWindowsUpdateInstances
	updateAcquireWindowsMaintenance             = acquireWindowsUpdateMaintenance
	updateQuitSleep                             = time.Sleep
	updateCurrentDevAssetRetrySleep             = time.Sleep
	updateExitProcess                           = os.Exit
	updateDownloadFileWithExpectedSize          = downloadFileWithHashWithExpectedSize
	updateDownloadFileWithExpectedSizePreferred = downloadFileWithHashWithExpectedSizePreferred
)

var errUpdateChecksumMismatch = errors.New("update package checksum mismatch")

type updateState struct {
	lastCheck   *UpdateInfo
	downloading bool
	staged      *stagedUpdate
	task        *UpdateDownloadTaskStatus
	revision    uint64
}

type UpdateInfo struct {
	HasUpdate          bool   `json:"hasUpdate"`
	Channel            string `json:"channel"`
	CurrentVersion     string `json:"currentVersion"`
	LatestVersion      string `json:"latestVersion"`
	ReleaseName        string `json:"releaseName"`
	ReleasePublishedAt string `json:"releasePublishedAt,omitempty"`
	ReleaseNotesURL    string `json:"releaseNotesUrl"`
	// ReleaseNotes 为 Markdown 更新日志正文（来自 latest.json / GitHub release body）。
	ReleaseNotes string `json:"releaseNotes,omitempty"`
	AssetName    string `json:"assetName"`
	AssetURL     string `json:"assetUrl"`
	AssetAPIURL  string `json:"assetApiUrl,omitempty"`
	AssetSize    int64  `json:"assetSize"`
	SHA256       string `json:"sha256"`
	Downloaded   bool   `json:"downloaded"`
	DownloadPath string `json:"downloadPath,omitempty"`
	InstallMode  string `json:"installMode"`
	PackageType  string `json:"packageType,omitempty"`
	AutoRelaunch bool   `json:"autoRelaunch"`
}

type AppInfo struct {
	Version      string `json:"version"`
	Author       string `json:"author"`
	RepoURL      string `json:"repoUrl,omitempty"`
	IssueURL     string `json:"issueUrl,omitempty"`
	ReleaseURL   string `json:"releaseUrl,omitempty"`
	CommunityURL string `json:"communityUrl,omitempty"`
	BuildTime    string `json:"buildTime,omitempty"`
}

type updateDownloadResult struct {
	Info           UpdateInfo `json:"info"`
	DownloadPath   string     `json:"downloadPath,omitempty"`
	InstallLogPath string     `json:"installLogPath,omitempty"`
	InstallTarget  string     `json:"installTarget,omitempty"`
	Platform       string     `json:"platform"`
	InstallMode    string     `json:"installMode"`
	PackageType    string     `json:"packageType"`
	AutoRelaunch   bool       `json:"autoRelaunch"`
}

// UpdateDownloadTaskStatus is the in-process source of truth for an update
// package download. It intentionally outlives a frontend modal or WebView
// reload, but is not persisted across application restarts.
type UpdateDownloadTaskStatus struct {
	TaskID     string                `json:"taskId"`
	Status     string                `json:"status"`
	Percent    float64               `json:"percent"`
	Downloaded int64                 `json:"downloaded"`
	Total      int64                 `json:"total"`
	Message    string                `json:"message,omitempty"`
	Running    bool                  `json:"running"`
	StartedAt  string                `json:"startedAt"`
	FinishedAt string                `json:"finishedAt,omitempty"`
	Info       *UpdateInfo           `json:"info,omitempty"`
	Result     *updateDownloadResult `json:"result,omitempty"`
}

type updateDownloadTaskWork struct {
	taskID   string
	info     UpdateInfo
	channel  updateChannel
	revision uint64
}

type updateDownloadProgressPayload struct {
	TaskID     string      `json:"taskId,omitempty"`
	Status     string      `json:"status"`
	Percent    float64     `json:"percent"`
	Downloaded int64       `json:"downloaded"`
	Total      int64       `json:"total"`
	Message    string      `json:"message,omitempty"`
	Info       *UpdateInfo `json:"info,omitempty"`
}

type stagedUpdate struct {
	Channel                updateChannel
	Version                string
	AssetName              string
	WorkspaceDir           string
	FilePath               string
	StagedDir              string
	InstallLogPath         string
	InstallMode            updateInstallMode
	PackageType            updatePackageType
	AutoRelaunch           bool
	MaintenanceEventName   string
	UpdateHandoffEventName string
}

func snapshotStagedUpdate(current *stagedUpdate) *stagedUpdate {
	if current == nil {
		return nil
	}
	snapshot := *current
	return &snapshot
}

func snapshotUpdateInfo(current *UpdateInfo) *UpdateInfo {
	if current == nil {
		return nil
	}
	snapshot := *current
	return &snapshot
}

type updatePathCandidate struct {
	workspaceDir string
	stagedDir    string
	assetPath    string
}

type windowsUpdateProcess struct {
	PID        uint32
	Executable string
}

type githubRelease struct {
	TagName     string        `json:"tag_name"`
	Name        string        `json:"name"`
	HTMLURL     string        `json:"html_url"`
	PublishedAt string        `json:"published_at"`
	Body        string        `json:"body"`
	Prerelease  bool          `json:"prerelease"`
	Assets      []githubAsset `json:"assets"`
}

type githubAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	URL                string `json:"url"`
	Digest             string `json:"digest"`
	Size               int64  `json:"size"`
}

type localizedUpdateError struct {
	key        string
	params     map[string]any
	httpStatus int
}

func (e localizedUpdateError) Error() string {
	return e.key
}

func (a *App) localizedUpdateError(err error) string {
	if err == nil {
		return ""
	}
	var localized localizedUpdateError
	if errors.As(err, &localized) {
		return a.appText(localized.key, localized.params)
	}
	return err.Error()
}

func (a *App) CheckForUpdates() connection.QueryResult {
	// 用户手动检查：强制走网络（静态清单优先，API 回退）
	return a.checkForUpdates(true, true)
}

func (a *App) CheckForUpdatesSilently() connection.QueryResult {
	// 静默检查：允许节流，优先磁盘/短时缓存，避免启动刷爆网络
	return a.checkForUpdates(false, false)
}

func (a *App) checkForUpdates(logFailure bool, forceNetwork bool) connection.QueryResult {
	a.ensurePersistedGlobalProxyRuntime()
	a.updateMu.Lock()
	channel := a.currentUpdateChannel()
	expectedRevision := a.updateState.revision
	currentStaged := snapshotStagedUpdate(a.updateState.staged)
	a.updateMu.Unlock()

	info, err := fetchLatestUpdateInfoWithOptions(channel, forceNetwork)
	if err != nil {
		if logFailure {
			updateLogCheckError(err)
		}
		return connection.QueryResult{Success: false, Message: a.localizedUpdateError(err)}
	}

	if info.HasUpdate {
		reusable := resolveReusableStagedUpdate(info, currentStaged)
		if reusable != nil {
			info.Downloaded = true
			info.DownloadPath = reusable.FilePath
			currentStaged = reusable
		} else if currentStaged != nil && (currentStaged.Version != info.LatestVersion || currentStaged.Channel != updateChannel(info.Channel)) {
			currentStaged = nil
		}
	} else {
		currentStaged = nil
	}

	if !a.publishUpdateCheckSnapshot(expectedRevision, info, currentStaged) {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.update.backend.message.check_stale", nil),
		}
	}

	msg := a.appText("app.update.backend.message.latest", nil)
	if info.HasUpdate {
		msg = a.appText("app.update.backend.message.update_found", map[string]any{"version": info.LatestVersion})
	}
	return connection.QueryResult{Success: true, Message: msg, Data: info}
}

func (a *App) publishUpdateCheckSnapshot(expectedRevision uint64, info UpdateInfo, staged *stagedUpdate) bool {
	a.updateMu.Lock()
	defer a.updateMu.Unlock()
	if a.updateState.downloading || a.updateState.revision != expectedRevision {
		return false
	}
	a.updateState.lastCheck = snapshotUpdateInfo(&info)
	a.updateState.staged = snapshotStagedUpdate(staged)
	if task := a.updateState.task; task != nil && !task.Running {
		if updateDownloadTaskMatchesInfo(task, info) {
			task.Info = snapshotUpdateInfo(&info)
		} else {
			a.updateState.task = nil
		}
	}
	a.updateState.revision++
	return true
}

func (a *App) GetAppInfo() connection.QueryResult {
	info := AppInfo{
		Version:      getCurrentVersion(),
		Author:       getCurrentAuthor(),
		RepoURL:      "https://github.com/" + updateRepo,
		IssueURL:     "https://github.com/" + updateRepo + "/issues",
		ReleaseURL:   "https://github.com/" + updateRepo + "/releases",
		CommunityURL: "https://aibook.ren",
		BuildTime:    strings.TrimSpace(AppBuildTime),
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: info}
}

// DownloadUpdate keeps the original synchronous Wails API for older
// frontends. Newer frontends should use StartUpdateDownload so the caller can
// close or reload its surface without owning the running download.
func (a *App) DownloadUpdate() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}
	work, _, immediate, _ := a.prepareUpdateDownloadTask(false)
	if immediate != nil {
		return *immediate
	}
	if work == nil {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.download_in_progress", nil)}
	}
	return a.runUpdateDownloadTask(*work)
}

// StartUpdateDownload starts an in-process update package task and returns
// immediately. The task remains queryable after a frontend modal closes or a
// WebView reloads, but intentionally does not survive an application restart.
func (a *App) StartUpdateDownload() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}
	work, task, immediate, alreadyRunning := a.prepareUpdateDownloadTask(true)
	if immediate != nil {
		if !immediate.Success {
			return *immediate
		}
		return connection.QueryResult{
			Success: true,
			Message: immediate.Message,
			Data: map[string]interface{}{
				"task":           task,
				"alreadyRunning": false,
			},
		}
	}
	if alreadyRunning {
		return connection.QueryResult{Success: true, Data: map[string]interface{}{
			"task":           task,
			"alreadyRunning": true,
		}}
	}
	if work == nil || task == nil {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.download_in_progress", nil)}
	}

	go a.runUpdateDownloadTask(*work)
	return connection.QueryResult{Success: true, Data: map[string]interface{}{
		"task":           task,
		"alreadyRunning": false,
	}}
}

// GetUpdateDownloadTask returns the active task or the latest terminal task.
// It is deliberately in-memory only: a restarted application has no task to
// resume and therefore returns a nil task.
func (a *App) GetUpdateDownloadTask() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}
	a.updateMu.Lock()
	task := snapshotUpdateDownloadTask(a.updateState.task)
	a.updateMu.Unlock()
	return connection.QueryResult{Success: true, Data: map[string]interface{}{
		"task": task,
	}}
}

func (a *App) prepareUpdateDownloadTask(reuseActive bool) (*updateDownloadTaskWork, *UpdateDownloadTaskStatus, *connection.QueryResult, bool) {
	a.ensurePersistedGlobalProxyRuntime()
	a.updateMu.Lock()
	if a.updateState.downloading {
		task := snapshotUpdateDownloadTask(a.updateState.task)
		a.updateMu.Unlock()
		if reuseActive && task != nil && task.Running {
			return nil, task, nil, true
		}
		result := connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.download_in_progress", nil)}
		return nil, task, &result, false
	}

	info := snapshotUpdateInfo(a.updateState.lastCheck)
	if info == nil {
		a.updateMu.Unlock()
		result := connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.check_first", nil)}
		return nil, nil, &result, false
	}
	if !info.HasUpdate {
		a.updateMu.Unlock()
		result := connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.latest", nil)}
		return nil, nil, &result, false
	}
	channel, err := normalizeUpdateChannel(info.Channel)
	if err != nil {
		a.updateMu.Unlock()
		result := connection.QueryResult{Success: false, Message: a.localizedUpdateError(err)}
		return nil, nil, &result, false
	}
	if invalid := a.validateUpdateInfoForDownload(info); invalid != nil {
		a.updateMu.Unlock()
		return nil, nil, invalid, false
	}

	staged := resolveReusableStagedUpdate(*info, snapshotStagedUpdate(a.updateState.staged))
	if staged != nil {
		info.Downloaded = true
		info.DownloadPath = staged.FilePath
		a.updateState.staged = staged
		a.updateState.revision++
		result := connection.QueryResult{
			Success: true,
			Message: a.appText("app.update.backend.message.package_already_downloaded", nil),
			Data:    buildUpdateDownloadResult(*info, staged),
		}
		task := newCompletedUpdateDownloadTask(*info, result)
		a.updateState.task = task
		a.updateMu.Unlock()
		return nil, snapshotUpdateDownloadTask(task), &result, false
	}

	// Once the lease is visible, install APIs must not be able to reuse the old
	// package while the dev channel resolves a newer release.
	a.updateState.staged = nil
	a.updateState.downloading = true
	a.updateState.revision++
	task := newActiveUpdateDownloadTask(*info)
	a.updateState.task = task
	work := &updateDownloadTaskWork{
		taskID:   task.TaskID,
		info:     *info,
		channel:  channel,
		revision: a.updateState.revision,
	}
	a.updateMu.Unlock()
	return work, snapshotUpdateDownloadTask(task), nil, false
}

func (a *App) runUpdateDownloadTask(work updateDownloadTaskWork) (result connection.QueryResult) {
	result = connection.QueryResult{Success: false, Message: "update download did not run"}
	defer func() {
		if recovered := recover(); recovered != nil {
			result = connection.QueryResult{Success: false, Message: fmt.Sprintf("update download panic: %v", recovered)}
		}
		a.finishUpdateDownloadTask(work.taskID, result)
	}()

	info := snapshotUpdateInfo(&work.info)
	downloadRevision := work.revision
	a.emitUpdateDownloadProgress(info, "start", 0, info.AssetSize, "")
	result, downloadErr := a.downloadAndStageUpdate(*info, downloadRevision)
	mismatchRetries := 0
	waitForCurrentAssetRetry := func() bool {
		if mismatchRetries >= updateCurrentDevAssetRetryLimit {
			return false
		}
		delay := currentDevAssetRetryDelay(mismatchRetries)
		mismatchRetries++
		logger.Warnf("dev 更新包尚未在 Dispatcher 激活，等待后重试：attempt=%d delay=%s", mismatchRetries, delay)
		updateCurrentDevAssetRetrySleep(delay)
		return true
	}
	for recoveryAttempts := 0; work.channel == updateChannelDev && isExpiredUpdateAssetError(downloadErr) && recoveryAttempts <= updateCurrentDevAssetRetryLimit; recoveryAttempts++ {
		var pendingIfNoUpdate *UpdateInfo
		if isCurrentDevAssetMismatchError(downloadErr) {
			pendingIfNoUpdate = info
		}
		refreshed, staged, revision, refreshErr := a.refreshDevUpdateInfoForDownload(downloadRevision, pendingIfNoUpdate)
		if refreshErr != nil {
			logger.Warnf("dev 更新包失效后刷新清单失败：%v", refreshErr)
			break
		}

		downloadRevision = revision
		if !refreshed.HasUpdate && isCurrentDevAssetMismatchError(downloadErr) {
			// A mutable dev-latest source can briefly expose the next build while
			// Dispatcher control still points at the already-installed build. Keep
			// retrying the gated future asset; the refreshed no-update snapshot only
			// advances the state revision and must not discard that pending target.
			if !waitForCurrentAssetRetry() {
				break
			}
			result, downloadErr = a.downloadAndStageUpdate(*info, downloadRevision)
			continue
		}

		identityChanged := updateAssetIdentityChanged(*info, *refreshed)
		info = refreshed
		if invalid := a.validateUpdateInfoForDownload(info); invalid != nil {
			result = *invalid
			downloadErr = nil
			break
		}
		if staged != nil {
			result = connection.QueryResult{Success: true, Message: a.appText("app.update.backend.message.package_already_downloaded", nil), Data: buildUpdateDownloadResult(*info, staged)}
			downloadErr = nil
			break
		}
		if identityChanged {
			a.emitUpdateDownloadProgress(info, "start", 0, info.AssetSize, "")
		} else {
			if !isCurrentDevAssetMismatchError(downloadErr) || !waitForCurrentAssetRetry() {
				break
			}
		}
		result, downloadErr = a.downloadAndStageUpdate(*info, downloadRevision)
	}
	if !result.Success {
		a.emitUpdateDownloadProgress(info, "error", 0, info.AssetSize, result.Message)
	}
	return result
}

func newActiveUpdateDownloadTask(info UpdateInfo) *UpdateDownloadTaskStatus {
	return &UpdateDownloadTaskStatus{
		TaskID:     uuid.NewString(),
		Status:     "start",
		Percent:    0,
		Downloaded: 0,
		Total:      max(0, info.AssetSize),
		Running:    true,
		StartedAt:  time.Now().UTC().Format(time.RFC3339),
		Info:       snapshotUpdateInfo(&info),
	}
}

func newCompletedUpdateDownloadTask(info UpdateInfo, result connection.QueryResult) *UpdateDownloadTaskStatus {
	now := time.Now().UTC().Format(time.RFC3339)
	task := &UpdateDownloadTaskStatus{
		TaskID:     uuid.NewString(),
		Status:     "done",
		Percent:    100,
		Downloaded: max(0, info.AssetSize),
		Total:      max(0, info.AssetSize),
		Running:    false,
		StartedAt:  now,
		FinishedAt: now,
		Info:       snapshotUpdateInfo(&info),
		Result:     snapshotUpdateDownloadResultFromQueryResult(result),
	}
	return task
}

func snapshotUpdateDownloadTask(current *UpdateDownloadTaskStatus) *UpdateDownloadTaskStatus {
	if current == nil {
		return nil
	}
	snapshot := *current
	snapshot.Info = snapshotUpdateInfo(current.Info)
	if current.Result != nil {
		result := *current.Result
		snapshot.Result = &result
	}
	return &snapshot
}

func updateDownloadTaskMatchesInfo(task *UpdateDownloadTaskStatus, info UpdateInfo) bool {
	if task == nil || task.Info == nil {
		return false
	}
	current := task.Info
	return strings.EqualFold(strings.TrimSpace(current.Channel), strings.TrimSpace(info.Channel)) &&
		!updateAssetIdentityChanged(*current, info)
}

func snapshotUpdateDownloadResultFromQueryResult(result connection.QueryResult) *updateDownloadResult {
	switch data := result.Data.(type) {
	case updateDownloadResult:
		snapshot := data
		return &snapshot
	case *updateDownloadResult:
		if data == nil {
			return nil
		}
		snapshot := *data
		return &snapshot
	default:
		return nil
	}
}

func (a *App) finishUpdateDownloadTask(taskID string, result connection.QueryResult) {
	if a == nil {
		return
	}
	a.updateMu.Lock()
	task := a.updateState.task
	if task == nil || task.TaskID != strings.TrimSpace(taskID) {
		a.updateMu.Unlock()
		return
	}
	terminalAlreadyEmitted := task.Status == "done" || task.Status == "error"
	if !terminalAlreadyEmitted {
		if result.Success {
			task.Status = "done"
			task.Percent = 100
			if task.Total > 0 {
				task.Downloaded = task.Total
			}
		} else {
			task.Status = "error"
		}
		if message := strings.TrimSpace(result.Message); message != "" {
			task.Message = message
		}
	}
	if taskResult := snapshotUpdateDownloadResultFromQueryResult(result); taskResult != nil {
		task.Result = taskResult
		task.Info = snapshotUpdateInfo(&taskResult.Info)
	}
	task.Running = false
	task.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	a.updateState.downloading = false
	a.updateState.revision++
	snapshot := snapshotUpdateDownloadTask(task)
	a.updateMu.Unlock()

	// The normal download path emits done/error itself. If the task exits before
	// that path (for example a panic or an already-staged dev refresh), publish a
	// final snapshot so an already-open UI does not stay on "starting".
	if !terminalAlreadyEmitted {
		a.emitUpdateDownloadTaskSnapshot(*snapshot)
	}
}

func (a *App) validateUpdateInfoForDownload(info *UpdateInfo) *connection.QueryResult {
	if info == nil || !info.HasUpdate {
		return &connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.latest", nil)}
	}
	if info.AssetURL == "" || info.AssetName == "" {
		return &connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.no_update_package", nil)}
	}
	if err := validateUpdatePackageForCurrentInstallMode(
		stdRuntime.GOOS,
		updateInstallMode(info.InstallMode),
		updatePackageType(info.PackageType),
		info.AssetName,
	); err != nil {
		return &connection.QueryResult{Success: false, Message: a.localizedUpdateError(err)}
	}
	return nil
}

func (a *App) refreshDevUpdateInfoForDownload(expectedRevision uint64, pendingIfNoUpdate *UpdateInfo) (*UpdateInfo, *stagedUpdate, uint64, error) {
	info, err := fetchLatestUpdateInfoWithOptions(updateChannelDev, true)
	if err != nil {
		return nil, nil, expectedRevision, err
	}

	a.updateMu.Lock()
	defer a.updateMu.Unlock()
	if !a.updateState.downloading || a.updateState.revision != expectedRevision {
		return nil, nil, expectedRevision, localizedUpdateError{key: "app.update.backend.message.check_stale"}
	}

	stateInfo := &info
	if !info.HasUpdate && pendingIfNoUpdate != nil && pendingIfNoUpdate.HasUpdate {
		stateInfo = snapshotUpdateInfo(pendingIfNoUpdate)
	}
	var staged *stagedUpdate
	if stateInfo.HasUpdate {
		staged = resolveReusableStagedUpdate(*stateInfo, snapshotStagedUpdate(a.updateState.staged))
		if staged != nil {
			stateInfo.Downloaded = true
			stateInfo.DownloadPath = staged.FilePath
		}
	}
	a.updateState.lastCheck = snapshotUpdateInfo(stateInfo)
	a.updateState.staged = snapshotStagedUpdate(staged)
	a.updateState.revision++
	return snapshotUpdateInfo(&info), snapshotStagedUpdate(staged), a.updateState.revision, nil
}

func updateAssetIdentityChanged(previous, current UpdateInfo) bool {
	return previous.Channel != current.Channel ||
		previous.LatestVersion != current.LatestVersion ||
		previous.AssetName != current.AssetName ||
		previous.AssetURL != current.AssetURL ||
		previous.AssetAPIURL != current.AssetAPIURL ||
		!strings.EqualFold(previous.SHA256, current.SHA256)
}

func isExpiredUpdateAssetError(err error) bool {
	var currentAssetMismatch downloadCurrentAssetMismatchError
	if errors.As(err, &currentAssetMismatch) {
		return true
	}
	// Only statuses observed directly from the gated Dispatcher identify a
	// stale dev asset. A 404/410 from Cst, Bero, GitHub, or a joined fallback
	// error is an ordinary source failure and must not trigger a manifest
	// refresh loop.
	var terminal downloadCurrentAssetTerminalError
	if !errors.As(err, &terminal) {
		return false
	}
	var localized localizedUpdateError
	if !errors.As(err, &localized) {
		return false
	}
	return localized.httpStatus == http.StatusNotFound ||
		localized.httpStatus == http.StatusGone
}

func isCurrentDevAssetMismatchError(err error) bool {
	var currentAssetMismatch downloadCurrentAssetMismatchError
	return errors.As(err, &currentAssetMismatch)
}

func currentDevAssetRetryDelay(retry int) time.Duration {
	delay := updateCurrentDevAssetRetryInitialDelay
	for attempt := 0; attempt < retry && delay < updateCurrentDevAssetRetryMaxDelay; attempt++ {
		delay *= 2
	}
	if delay > updateCurrentDevAssetRetryMaxDelay {
		return updateCurrentDevAssetRetryMaxDelay
	}
	return delay
}

func (a *App) InstallUpdateAndRestart(closeAllWindowsInstancesConfirmed bool) connection.QueryResult {
	a.updateMu.Lock()
	staged := snapshotStagedUpdate(a.updateState.staged)
	a.updateMu.Unlock()
	if staged == nil {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.no_downloaded_package", nil)}
	}
	if strings.TrimSpace(staged.InstallLogPath) == "" {
		staged.InstallLogPath = buildUpdateInstallLogPath(staged.WorkspaceDir)
	}
	installTarget := ""
	if stdRuntime.GOOS == "windows" {
		installTarget = strings.TrimSpace(updateResolveInstallTarget())
		if installTarget == "" {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
					"detail": a.appText("app.update.backend.error.install_target_unresolved", nil),
				}),
			}
		}
	}
	if err := validateUpdatePackageForCurrentInstallMode(stdRuntime.GOOS, staged.InstallMode, staged.PackageType, staged.FilePath); err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
				"detail": a.localizedUpdateError(err),
			}),
		}
	}
	if stdRuntime.GOOS == "windows" {
		maintenanceLease, err := updateAcquireWindowsMaintenance(installTarget)
		if err != nil {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
					"detail": a.appText("app.update.backend.error.maintenance_lock_failed", map[string]any{"detail": err.Error()}),
				}),
			}
		}
		defer func() {
			if maintenanceLease.Release != nil {
				maintenanceLease.Release()
			}
		}()
		staged.MaintenanceEventName = maintenanceLease.Name

		finalTarget := resolveWindowsUpdateFinalTargetPath(installTarget, staged.FilePath)
		runningInstances, err := updateFindOtherWindowsInstances([]string{installTarget, finalTarget}, os.Getpid())
		if err != nil {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
					"detail": a.appText("app.update.backend.error.close_instances_failed", map[string]any{"detail": err.Error()}),
				}),
			}
		}
		if windowsUpdateCloseConfirmationRequired(stdRuntime.GOOS, closeAllWindowsInstancesConfirmed, len(runningInstances)) {
			return connection.QueryResult{
				Success: false,
				Data: map[string]any{
					"requiresCloseConfirmation": true,
					"instanceCount":             len(runningInstances),
					"runningPids":               otherWindowsUpdateProcessIDs(runningInstances),
				},
			}
		}

		if staged.InstallMode == updateInstallModePortable {
			if err := ensureWindowsUpdateTargetWritable(installTarget); err != nil {
				return connection.QueryResult{
					Success: false,
					Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
						"detail": a.localizedUpdateError(err),
					}),
				}
			}
		}

		if closeAllWindowsInstancesConfirmed {
			closedPIDs, closeErr := closeOtherWindowsUpdateInstancesForInstall([]string{installTarget, finalTarget}, os.Getpid())
			if closeErr != nil {
				logger.Warnf("关闭 Windows 更新相关实例失败 current=%s target=%s pids=%v error=%v", installTarget, finalTarget, closedPIDs, closeErr)
				return connection.QueryResult{
					Success: false,
					Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
						"detail": a.appText("app.update.backend.error.close_instances_failed", map[string]any{"detail": closeErr.Error()}),
					}),
					Data: map[string]any{
						"runningPids": closedPIDs,
					},
				}
			}
			if len(closedPIDs) > 0 {
				logger.Infof("Windows 更新已关闭其他 GoNavi 实例 current=%s target=%s pids=%v", installTarget, finalTarget, closedPIDs)
			}
		}
	}

	if err := updateLaunchInstallScript(staged); err != nil {
		logger.Error(err, "启动更新脚本失败")
		detail := a.localizedUpdateError(err)
		msg := a.appText("app.update.backend.message.install_launch_failed", map[string]any{"detail": detail})
		if staged.InstallLogPath != "" {
			msg = a.appText("app.update.backend.message.install_launch_failed_with_log", map[string]any{
				"detail": detail,
				"path":   staged.InstallLogPath,
			})
		}
		return connection.QueryResult{
			Success: false,
			Message: msg,
			Data: map[string]any{
				"logPath":      staged.InstallLogPath,
				"installMode":  string(staged.InstallMode),
				"packageType":  string(staged.PackageType),
				"autoRelaunch": staged.AutoRelaunch,
			},
		}
	}
	go a.quitForUpdate()

	msg := a.appText("app.update.backend.message.install_started", nil)
	if staged.InstallLogPath != "" {
		msg = a.appText("app.update.backend.message.install_started_with_log", map[string]any{"path": staged.InstallLogPath})
	}
	return connection.QueryResult{
		Success: true,
		Message: msg,
		Data: map[string]any{
			"logPath":      staged.InstallLogPath,
			"installMode":  string(staged.InstallMode),
			"packageType":  string(staged.PackageType),
			"autoRelaunch": staged.AutoRelaunch,
		},
	}
}

func (a *App) quitForUpdate() {
	updateQuitSleep(updateQuitRequestDelay)
	a.ForceQuitApplication()
	// Leave enough time for shutdown transaction rollback before forcing the process down.
	updateQuitSleep(updateQuitForceExitDelay)
	updateExitProcess(0)
}

func (a *App) OpenDownloadedUpdateDirectory() connection.QueryResult {
	a.updateMu.Lock()
	staged := snapshotStagedUpdate(a.updateState.staged)
	a.updateMu.Unlock()
	if staged == nil {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.no_downloaded_package", nil)}
	}
	assetPath := strings.TrimSpace(staged.FilePath)
	if assetPath == "" {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.package_path_empty", nil)}
	}
	dirPath := strings.TrimSpace(filepath.Dir(assetPath))
	if dirPath == "" || dirPath == "." {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.package_directory_unresolved", nil)}
	}
	if stat, err := os.Stat(dirPath); err != nil || !stat.IsDir() {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.package_directory_unavailable", nil)}
	}

	var cmd *exec.Cmd
	switch stdRuntime.GOOS {
	case "darwin":
		cmd = exec.Command("open", dirPath)
	case "windows":
		cmd = exec.Command("explorer", dirPath)
	case "linux":
		cmd = exec.Command("xdg-open", dirPath)
	default:
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.open_directory_unsupported", map[string]any{"platform": stdRuntime.GOOS})}
	}
	if err := startBackgroundCommand(cmd, func(waitErr error) {
		if waitErr != nil {
			logger.Warnf("打开更新目录的后台进程退出异常：%v", waitErr)
		}
	}); err != nil {
		logger.Error(err, "打开更新目录失败")
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.open_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("app.update.backend.message.opened_install_directory", map[string]any{"path": dirPath}),
		Data: map[string]any{
			"path": dirPath,
		},
	}
}

func (a *App) downloadAndStageUpdate(info UpdateInfo, expectedRevision uint64) (connection.QueryResult, error) {
	workspaceCandidates := resolveUpdateWorkspaceDirCandidatesForInstallMode(info.LatestVersion, updateInstallMode(info.InstallMode))
	workspaceDir, stagedDir, prepareErr := prepareUpdateWorkspaceAndStagingDirs(workspaceCandidates, info.Channel, info.LatestVersion)
	if prepareErr != nil {
		preferredDir := strings.TrimSpace(resolveUpdateWorkspaceDirForInstallMode(info.LatestVersion, updateInstallMode(info.InstallMode)))
		if preferredDir == "" {
			preferredDir = os.TempDir()
		}
		logger.Error(prepareErr, "创建更新工作区失败")
		errMsg := a.appText("app.update.backend.message.create_workspace_failed", map[string]any{"path": preferredDir})
		return connection.QueryResult{Success: false, Message: errMsg}, prepareErr
	}

	// 安装包本体放在工作区根级，staging 目录只保留更新脚本和临时展开物。
	assetPath := resolveUpdateAssetPath(workspaceDir, stagedDir, info.AssetName)
	progressCB := func(downloaded, total int64) {
		reportTotal := total
		if reportTotal <= 0 {
			reportTotal = info.AssetSize
		}
		a.emitUpdateDownloadProgress(&info, "downloading", downloaded, reportTotal, "")
	}
	if info.SHA256 == "" {
		_ = os.Remove(assetPath)
		_ = os.RemoveAll(stagedDir)
		message := a.appText("app.update.backend.message.checksum_missing", nil)
		return connection.QueryResult{Success: false, Message: message}, localizedUpdateError{key: "app.update.backend.message.checksum_missing"}
	}

	preferred := a.preferredDownloadSource()
	var err error
	if preferred == DownloadSourceCst {
		_, err = downloadUpdateAssetWithFallback(
			[]string{info.AssetURL, info.AssetAPIURL},
			assetPath,
			info.SHA256,
			info.AssetSize,
			progressCB,
		)
	} else {
		_, err = downloadUpdateAssetWithFallbackPreferred(
			[]string{info.AssetURL, info.AssetAPIURL},
			assetPath,
			info.SHA256,
			info.AssetSize,
			progressCB,
			preferred,
		)
	}
	if err != nil {
		_ = os.Remove(assetPath)
		_ = os.RemoveAll(stagedDir)
		if errors.Is(err, errUpdateChecksumMismatch) {
			message := a.appText("app.update.backend.message.checksum_failed", nil)
			return connection.QueryResult{Success: false, Message: message}, err
		}
		message := a.localizedUpdateError(err)
		return connection.QueryResult{Success: false, Message: message}, err
	}

	staged := &stagedUpdate{
		Channel:        updateChannel(info.Channel),
		Version:        info.LatestVersion,
		AssetName:      info.AssetName,
		WorkspaceDir:   workspaceDir,
		FilePath:       assetPath,
		StagedDir:      stagedDir,
		InstallLogPath: buildUpdateInstallLogPath(workspaceDir),
		InstallMode:    updateInstallMode(info.InstallMode),
		PackageType:    updatePackageType(info.PackageType),
		AutoRelaunch:   info.AutoRelaunch,
	}
	info.Downloaded = true
	info.DownloadPath = assetPath
	a.updateMu.Lock()
	if !a.updateState.downloading || a.updateState.revision != expectedRevision {
		a.updateMu.Unlock()
		_ = os.Remove(assetPath)
		_ = os.RemoveAll(stagedDir)
		err := localizedUpdateError{key: "app.update.backend.message.check_stale"}
		return connection.QueryResult{Success: false, Message: a.localizedUpdateError(err)}, err
	}
	a.updateState.lastCheck = snapshotUpdateInfo(&info)
	a.updateState.staged = staged
	a.updateState.revision++
	a.updateMu.Unlock()

	a.emitUpdateDownloadProgress(&info, "done", info.AssetSize, info.AssetSize, "")
	return connection.QueryResult{Success: true, Message: a.appText("app.update.backend.message.package_downloaded", nil), Data: buildUpdateDownloadResult(info, staged)}, nil
}

func downloadUpdateAssetWithFallback(
	candidates []string,
	assetPath string,
	expectedSHA256 string,
	expectedSize int64,
	onProgress func(downloaded, total int64),
) (string, error) {
	return downloadUpdateAssetWithFallbackUsing(
		candidates,
		assetPath,
		expectedSHA256,
		expectedSize,
		onProgress,
		DownloadSourceCst,
		false,
	)
}

func downloadUpdateAssetWithFallbackPreferred(
	candidates []string,
	assetPath string,
	expectedSHA256 string,
	expectedSize int64,
	onProgress func(downloaded, total int64),
	preferred DownloadSource,
) (string, error) {
	return downloadUpdateAssetWithFallbackUsing(
		candidates,
		assetPath,
		expectedSHA256,
		expectedSize,
		onProgress,
		preferred,
		true,
	)
}

func downloadUpdateAssetWithFallbackUsing(
	candidates []string,
	assetPath string,
	expectedSHA256 string,
	expectedSize int64,
	onProgress func(downloaded, total int64),
	preferred DownloadSource,
	usePreferredDownloader bool,
) (string, error) {
	seen := make(map[string]struct{}, len(candidates))
	urls := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		urls = append(urls, trimmed)
	}
	if len(urls) == 0 {
		return "", localizedUpdateError{
			key:    "app.update.backend.error.download_failed",
			params: map[string]any{"detail": "download URL is empty"},
		}
	}

	expectedHash := strings.TrimSpace(expectedSHA256)
	var lastErr error
	for index, candidate := range urls {
		candidate, requiresCurrentDevAsset := prepareUpdateDownloadCandidate(candidate, index == 0)
		_ = os.Remove(assetPath)
		var actualHash string
		var err error
		if usePreferredDownloader {
			actualHash, err = updateDownloadFileWithExpectedSizePreferred(candidate, assetPath, onProgress, expectedSize, preferred)
		} else {
			actualHash, err = updateDownloadFileWithExpectedSize(candidate, assetPath, onProgress, expectedSize)
		}
		if err == nil && expectedSize > 0 {
			stat, statErr := os.Stat(assetPath)
			if statErr != nil {
				err = statErr
			} else if stat.Size() != expectedSize {
				err = fmt.Errorf("update package size mismatch: expected=%d actual=%d", expectedSize, stat.Size())
			}
		}
		if err == nil && expectedHash != "" && !strings.EqualFold(expectedHash, actualHash) {
			err = errUpdateChecksumMismatch
		}
		if err == nil {
			return actualHash, nil
		}
		if errors.Is(err, errInvalidDownloadDispatcherURL) ||
			(requiresCurrentDevAsset && isCurrentDevAssetTerminalError(err)) {
			_ = os.Remove(assetPath)
			return "", err
		}
		lastErr = err
		if index+1 < len(urls) {
			logger.Warnf("更新包下载源失败，尝试下一下载源：attempt=%d err=%v", index+1, err)
		}
	}
	_ = os.Remove(assetPath)
	return "", lastErr
}

func prepareUpdateDownloadCandidate(rawURL string, primary bool) (string, bool) {
	candidate := strings.TrimSpace(rawURL)
	if !primary {
		return candidate, false
	}
	candidate = downloadDispatcherURLRequiringCurrentDevAsset(candidate)
	return candidate, dispatcherURLRequiresCurrentDevAsset(candidate)
}

func fetchLatestUpdateInfo(channel updateChannel) (UpdateInfo, error) {
	return fetchLatestUpdateInfoWithOptions(channel, true)
}

func fetchLatestUpdateInfoWithOptions(channel updateChannel, forceNetwork bool) (UpdateInfo, error) {
	if channel != updateChannelDev {
		channel = updateChannelLatest
	}
	installMode := updateResolveInstallMode()
	packageType := resolveUpdatePackageType(stdRuntime.GOOS, installMode)
	if stdRuntime.GOOS == "windows" && packageType == "" {
		return UpdateInfo{}, localizedUpdateError{
			key:    "app.update.backend.error.online_update_unsupported",
			params: map[string]any{"platform": stdRuntime.GOOS + "/" + stdRuntime.GOARCH + "/" + string(installMode)},
		}
	}

	// 优先静态 latest.json（不占 api.github.com 配额）→ GitHub API → 磁盘缓存
	release, err := fetchReleaseForChannelPreferringStatic(channel, forceNetwork)
	if err != nil {
		return UpdateInfo{}, err
	}

	currentVersion := getCurrentVersion()
	latestVersion := resolveReleaseVersion(channel, release)
	if latestVersion == "" {
		return UpdateInfo{}, localizedUpdateError{key: "app.update.backend.error.latest_version_unparseable"}
	}

	hasUpdate := false
	if channel == updateChannelDev {
		hasUpdate = normalizeVersion(currentVersion) != latestVersion
	} else {
		hasUpdate = compareVersion(currentVersion, latestVersion) < 0
	}
	if !hasUpdate {
		return UpdateInfo{
			HasUpdate:          false,
			Channel:            string(channel),
			CurrentVersion:     currentVersion,
			LatestVersion:      latestVersion,
			ReleaseName:        release.Name,
			ReleasePublishedAt: strings.TrimSpace(release.PublishedAt),
			ReleaseNotesURL:    release.HTMLURL,
			ReleaseNotes:       strings.TrimSpace(release.Body),
			InstallMode:        string(installMode),
			PackageType:        string(packageType),
			AutoRelaunch:       true,
		}, nil
	}

	assetVersion := strings.TrimSpace(release.TagName)
	if assetVersion == "" || strings.EqualFold(normalizeVersion(assetVersion), updateDevReleaseTag) {
		assetVersion = latestVersion
	}
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, assetVersion, installMode)
	if err != nil {
		return UpdateInfo{}, err
	}
	asset, err := findReleaseAsset(release.Assets, assetName)
	if err != nil {
		return UpdateInfo{}, err
	}

	sha256Value := normalizeGitHubAssetSHA256(asset.Digest)
	if sha256Value == "" {
		hashMap, err := updateFetchReleaseSHA256(release.Assets)
		if err != nil {
			return UpdateInfo{}, err
		}
		sha256Value = strings.TrimSpace(hashMap[assetName])
	}
	if sha256Value == "" {
		return UpdateInfo{}, localizedUpdateError{key: "app.update.backend.error.sha256_missing_current_package"}
	}
	assetURL := updateDispatcherAssetURL(channel, assetVersion, asset.Name)
	if assetURL == "" {
		// Keep legacy release metadata usable if an unexpected asset coordinate
		// cannot be represented by the Dispatcher path validator.
		assetURL = firstNonEmptyString(asset.BrowserDownloadURL, asset.URL)
	}
	return UpdateInfo{
		HasUpdate:          hasUpdate,
		Channel:            string(channel),
		CurrentVersion:     currentVersion,
		LatestVersion:      latestVersion,
		ReleaseName:        release.Name,
		ReleasePublishedAt: strings.TrimSpace(release.PublishedAt),
		ReleaseNotesURL:    release.HTMLURL,
		ReleaseNotes:       strings.TrimSpace(release.Body),
		AssetName:          asset.Name,
		AssetURL:           assetURL,
		AssetAPIURL:        strings.TrimSpace(asset.URL),
		AssetSize:          asset.Size,
		SHA256:             sha256Value,
		InstallMode:        string(installMode),
		PackageType:        string(packageType),
		AutoRelaunch:       true,
	}, nil
}

func devUpdateDispatcherAssetURL(version string, assetName string) string {
	return updateDispatcherAssetURL(updateChannelDev, version, assetName)
}

func updateDispatcherAssetURL(channel updateChannel, version string, assetName string) string {
	version = strings.TrimSpace(version)
	assetName = strings.TrimSpace(assetName)
	if version == "" || assetName == "" {
		return ""
	}
	prefix := "/gonavi/releases/download/"
	if channel == updateChannelDev {
		prefix = "/gonavi/dev/releases/download/"
	}
	assetPath := prefix + urlpkg.PathEscape(version) + "/" + urlpkg.PathEscape(assetName)
	if err := validateDownloadDispatcherAssetPath(assetPath); err != nil {
		return ""
	}
	return downloadDispatcherURLForPath(assetPath)
}

func fetchReleaseForChannel(channel updateChannel) (*githubRelease, error) {
	if channel == updateChannelDev {
		return updateFetchDevRelease()
	}
	return updateFetchLatestRelease()
}

func swapUpdateFetchLatestRelease(next func() (*githubRelease, error)) func() {
	original := updateFetchLatestRelease
	updateFetchLatestRelease = next
	return func() {
		updateFetchLatestRelease = original
	}
}

func swapUpdateFetchDevRelease(next func() (*githubRelease, error)) func() {
	original := updateFetchDevRelease
	updateFetchDevRelease = next
	return func() {
		updateFetchDevRelease = original
	}
}

func swapUpdateFetchReleaseSHA256(next func([]githubAsset) (map[string]string, error)) func() {
	original := updateFetchReleaseSHA256
	updateFetchReleaseSHA256 = next
	return func() {
		updateFetchReleaseSHA256 = original
	}
}

func swapUpdateCheckErrorLogger(next func(error)) func() {
	original := updateLogCheckError
	updateLogCheckError = next
	return func() {
		updateLogCheckError = original
	}
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
	return fetchReleaseByURL(updateLatestAPIURL)
}

func fetchDevRelease() (*githubRelease, error) {
	return fetchReleaseByURL(updateDevAPIURL)
}

func fetchReleaseByURL(apiURL string) (*githubRelease, error) {
	apiURL = strings.TrimSpace(apiURL)
	if apiURL == "" {
		return nil, localizedUpdateError{key: "app.update.backend.error.latest_version_unparseable"}
	}

	client := newStrictHTTPClientWithGlobalProxy(15 * time.Second)
	req, err := http.NewRequest(http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, err
	}
	applyGitHubAPIRequestHeaders(req)

	resp, err := doUpdateRequest(client, req)
	if err != nil {
		if cached := loadCachedGitHubRelease(apiURL); cached != nil {
			logger.Warnf("检查更新网络失败，回退缓存发布信息：url=%s err=%v", apiURL, err)
			return cached, nil
		}
		return nil, err
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if readErr != nil {
		if cached := loadCachedGitHubRelease(apiURL); cached != nil {
			logger.Warnf("检查更新读取响应失败，回退缓存发布信息：url=%s err=%v", apiURL, readErr)
			return cached, nil
		}
		return nil, wrapUpdateNetworkError(readErr)
	}

	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
			if cached := loadCachedGitHubRelease(apiURL); cached != nil {
				logger.Warnf("检查更新被限流/拒绝 (HTTP %d)，回退缓存发布信息：url=%s", resp.StatusCode, apiURL)
				return cached, nil
			}
		}
		return nil, classifyGitHubUpdateHTTPError(resp.StatusCode, body, resp.Header, true)
	}

	var release githubRelease
	if err := json.Unmarshal(body, &release); err != nil {
		return nil, wrapUpdateNetworkError(err)
	}
	storeCachedGitHubRelease(apiURL, &release)
	return &release, nil
}

func applyGitHubAPIRequestHeaders(req *http.Request) {
	if req == nil {
		return
	}
	req.Header.Set("User-Agent", "GoNavi-Updater/"+strings.TrimSpace(getCurrentVersion()))
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", updateGitHubAPIVersion)
	if token := resolveGitHubAPIToken(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

func applyGitHubDownloadRequestHeaders(req *http.Request, assetAPIURL bool) {
	if req == nil {
		return
	}
	req.Header.Set("User-Agent", "GoNavi-Updater/"+strings.TrimSpace(getCurrentVersion()))
	if assetAPIURL {
		req.Header.Set("Accept", "application/octet-stream")
		req.Header.Set("X-GitHub-Api-Version", updateGitHubAPIVersion)
		if token := resolveGitHubAPIToken(); token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		return
	}
	// browser_download_url 通常走 objects/release-assets CDN，不强制 github+json
	req.Header.Set("Accept", "*/*")
}

func resolveGitHubAPIToken() string {
	for _, key := range []string{"GONAVI_GITHUB_TOKEN", "GITHUB_TOKEN"} {
		if token := strings.TrimSpace(os.Getenv(key)); token != "" {
			return token
		}
	}
	return ""
}

func loadCachedGitHubRelease(apiURL string) *githubRelease {
	value, ok := updateReleaseCache.Load(strings.TrimSpace(apiURL))
	if !ok {
		return nil
	}
	entry, ok := value.(cachedGitHubRelease)
	if !ok || entry.release == nil {
		return nil
	}
	if time.Since(entry.fetchedAt) > updateReleaseCacheTTL {
		return nil
	}
	// 浅拷贝，避免调用方意外改写缓存
	cloned := *entry.release
	if entry.release.Assets != nil {
		cloned.Assets = append([]githubAsset(nil), entry.release.Assets...)
	}
	return &cloned
}

func storeCachedGitHubRelease(apiURL string, release *githubRelease) {
	if strings.TrimSpace(apiURL) == "" || release == nil {
		return
	}
	cloned := *release
	if release.Assets != nil {
		cloned.Assets = append([]githubAsset(nil), release.Assets...)
	}
	updateReleaseCache.Store(strings.TrimSpace(apiURL), cachedGitHubRelease{
		release:   &cloned,
		fetchedAt: time.Now(),
	})
}

func classifyGitHubUpdateHTTPError(status int, body []byte, headers http.Header, isCheck bool) error {
	snippet := strings.TrimSpace(string(body))
	if len(snippet) > updateHTTPBodySnippetLimit {
		snippet = snippet[:updateHTTPBodySnippetLimit] + "…"
	}
	lower := strings.ToLower(snippet)
	remaining := strings.TrimSpace(headers.Get("X-RateLimit-Remaining"))
	reset := strings.TrimSpace(headers.Get("X-RateLimit-Reset"))
	detailParts := make([]string, 0, 3)
	if snippet != "" {
		// 尽量抽出 GitHub JSON message 字段
		var payload struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(body, &payload) == nil && strings.TrimSpace(payload.Message) != "" {
			detailParts = append(detailParts, strings.TrimSpace(payload.Message))
		} else {
			detailParts = append(detailParts, snippet)
		}
	}
	if remaining != "" {
		detailParts = append(detailParts, "X-RateLimit-Remaining="+remaining)
	}
	if reset != "" {
		detailParts = append(detailParts, "X-RateLimit-Reset="+reset)
	}
	detail := strings.Join(detailParts, " | ")

	rateLimited := status == http.StatusTooManyRequests ||
		strings.Contains(lower, "rate limit") ||
		strings.Contains(lower, "secondary rate limit") ||
		(status == http.StatusForbidden && remaining == "0")

	if rateLimited {
		return localizedUpdateError{
			key:        "app.update.backend.error.check_http_rate_limited",
			params:     map[string]any{"detail": detail},
			httpStatus: status,
		}
	}
	if status == http.StatusForbidden {
		if isCheck {
			return localizedUpdateError{
				key:        "app.update.backend.error.check_http_forbidden",
				params:     map[string]any{"detail": detail},
				httpStatus: status,
			}
		}
		return localizedUpdateError{
			key:        "app.update.backend.error.package_download_forbidden",
			params:     map[string]any{"detail": detail},
			httpStatus: status,
		}
	}
	if isCheck {
		return localizedUpdateError{
			key:        "app.update.backend.error.check_http_status",
			params:     map[string]any{"status": status},
			httpStatus: status,
		}
	}
	return localizedUpdateError{
		key:        "app.update.backend.error.package_download_http_failed",
		params:     map[string]any{"status": status},
		httpStatus: status,
	}
}

func expectedAssetName(goos, goarch, version string) (string, error) {
	installMode := updateInstallModeUnknown
	if strings.EqualFold(strings.TrimSpace(goos), "windows") {
		installMode = updateResolveInstallMode()
	}
	return expectedAssetNameForInstallMode(goos, goarch, version, installMode)
}

func expectedAssetNameForInstallMode(goos, goarch, version string, installMode updateInstallMode) (string, error) {
	executablePath := ""
	if goos == "linux" {
		if path, err := os.Executable(); err == nil {
			if resolved, resolveErr := filepath.EvalSymlinks(path); resolveErr == nil && strings.TrimSpace(resolved) != "" {
				path = resolved
			}
			executablePath = path
		}
	}
	return expectedAssetNameForExecutableAndInstallMode(goos, goarch, version, executablePath, installMode)
}

func expectedAssetNameForExecutable(goos, goarch, version, executablePath string) (string, error) {
	return expectedAssetNameForExecutableAndInstallMode(goos, goarch, version, executablePath, updateInstallModePortable)
}

func expectedAssetNameForExecutableAndInstallMode(goos, goarch, version, executablePath string, installMode updateInstallMode) (string, error) {
	version = strings.TrimSpace(version)
	version = strings.TrimPrefix(version, "v")
	version = strings.TrimPrefix(version, "V")
	if version == "" {
		return "", localizedUpdateError{key: "app.update.backend.error.release_version_unparseable"}
	}

	switch goos {
	case "windows":
		suffix := "-Portable.zip"
		if installMode == updateInstallModeMSI {
			suffix = "-Installer.msi"
		} else if installMode != updateInstallModePortable {
			return "", localizedUpdateError{
				key:    "app.update.backend.error.online_update_unsupported",
				params: map[string]any{"platform": goos + "/" + goarch + "/" + string(installMode)},
			}
		}
		if goarch == "amd64" {
			return fmt.Sprintf("GoNavi-%s-Windows-Amd64%s", version, suffix), nil
		}
		if goarch == "arm64" {
			return fmt.Sprintf("GoNavi-%s-Windows-Arm64%s", version, suffix), nil
		}
	case "darwin":
		if goarch == "amd64" {
			return fmt.Sprintf("GoNavi-%s-MacOS-Amd64.dmg", version), nil
		}
		if goarch == "arm64" {
			return fmt.Sprintf("GoNavi-%s-MacOS-Arm64.dmg", version), nil
		}
	case "linux":
		if goarch == "amd64" {
			return fmt.Sprintf("GoNavi-%s-Linux-Amd64%s.tar.gz", version, resolveLinuxReleaseArtifactSuffix(executablePath)), nil
		}
		if goarch == "arm64" {
			return fmt.Sprintf("GoNavi-%s-Linux-Arm64%s.tar.gz", version, resolveLinuxReleaseArtifactSuffix(executablePath)), nil
		}
	}
	return "", localizedUpdateError{
		key:    "app.update.backend.error.online_update_unsupported",
		params: map[string]any{"platform": goos + "/" + goarch},
	}
}

func resolveLinuxReleaseArtifactSuffix(executablePath string) string {
	normalizedPath := strings.ToLower(strings.TrimSpace(executablePath))
	if normalizedPath == "" {
		return ""
	}
	normalizedPath = strings.ReplaceAll(normalizedPath, "\\", "/")
	compactPath := strings.ReplaceAll(normalizedPath, "_", "")
	compactPath = strings.ReplaceAll(compactPath, "-", "")
	if strings.Contains(normalizedPath, "webkit41") || strings.Contains(compactPath, "webkit241") || strings.Contains(compactPath, "webkit41") {
		return "-WebKit41"
	}
	return ""
}

func findReleaseAsset(assets []githubAsset, name string) (*githubAsset, error) {
	for _, asset := range assets {
		if asset.Name == name {
			return &asset, nil
		}
	}
	return nil, localizedUpdateError{
		key:    "app.update.backend.error.update_package_not_found",
		params: map[string]any{"name": name},
	}
}

func normalizeGitHubAssetSHA256(digest string) string {
	digest = strings.TrimSpace(digest)
	if digest == "" {
		return ""
	}
	if algorithm, value, ok := strings.Cut(digest, ":"); ok {
		if !strings.EqualFold(strings.TrimSpace(algorithm), "sha256") {
			return ""
		}
		digest = strings.TrimSpace(value)
	}
	return strings.ToLower(digest)
}

func fetchReleaseSHA256(assets []githubAsset) (map[string]string, error) {
	var candidates []string
	seen := map[string]struct{}{}
	addCandidate := func(raw string) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return
		}
		if _, ok := seen[raw]; ok {
			return
		}
		seen[raw] = struct{}{}
		candidates = append(candidates, raw)
	}
	for _, asset := range assets {
		if strings.EqualFold(asset.Name, updateChecksumAsset) || strings.Contains(strings.ToLower(asset.Name), "sha256sums") {
			addCandidate(asset.BrowserDownloadURL)
			addCandidate(asset.URL)
			break
		}
	}
	if len(candidates) == 0 {
		return nil, localizedUpdateError{key: "app.update.backend.error.sha256sums_missing"}
	}

	client := newStrictHTTPClientWithGlobalProxy(15 * time.Second)
	var lastStatus int
	for _, candidate := range candidates {
		resp, err := doGitHubDownload(client, candidate)
		if err != nil {
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		_ = resp.Body.Close()
		if readErr != nil {
			continue
		}
		if resp.StatusCode == http.StatusOK {
			return parseSHA256Sums(string(body)), nil
		}
		lastStatus = resp.StatusCode
	}
	if lastStatus == 0 {
		lastStatus = http.StatusForbidden
	}
	return nil, localizedUpdateError{
		key:    "app.update.backend.error.sha256sums_download_failed",
		params: map[string]any{"status": lastStatus},
	}
}

func doGitHubDownload(client *http.Client, rawURL string) (*http.Response, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return nil, localizedUpdateError{
			key:    "app.update.backend.error.package_download_http_failed",
			params: map[string]any{"status": 0},
		}
	}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	applyGitHubDownloadRequestHeaders(req, isGitHubReleaseAssetAPIURL(rawURL))
	return doUpdateRequest(client, req)
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
	mu         sync.Mutex
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
	w.mu.Lock()
	defer w.mu.Unlock()
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

func (w *downloadProgressWriter) finish() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.onProgress != nil {
		w.lastEmit = time.Now()
		w.onProgress(w.written, w.total)
	}
	return w.written
}

func downloadFileWithHash(url, filePath string, onProgress func(downloaded, total int64)) (string, error) {
	return downloadFileWithHashWithTimeout(url, filePath, onProgress, 10*time.Minute)
}

func downloadFileWithHashPreferred(url, filePath string, onProgress func(downloaded, total int64), preferred DownloadSource) (string, error) {
	return downloadFileWithHashWithTimeoutPreferred(url, filePath, onProgress, 10*time.Minute, preferred)
}

func downloadFileWithHashWithExpectedSize(url, filePath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
	return downloadFileWithHashParallelAwareAndExpectedSize(url, filePath, onProgress, 10*time.Minute, expectedSize)
}

func downloadFileWithHashWithExpectedSizePreferred(url, filePath string, onProgress func(downloaded, total int64), expectedSize int64, preferred DownloadSource) (string, error) {
	return downloadFileWithHashParallelAwareAndExpectedSizePreferred(url, filePath, onProgress, 10*time.Minute, expectedSize, preferred)
}

func downloadFileWithHashWithTimeout(url, filePath string, onProgress func(downloaded, total int64), timeout time.Duration) (string, error) {
	return downloadFileWithHashParallelAware(url, filePath, onProgress, timeout)
}

func downloadFileWithHashWithTimeoutPreferred(url, filePath string, onProgress func(downloaded, total int64), timeout time.Duration, preferred DownloadSource) (string, error) {
	return downloadFileWithHashParallelAwareAndExpectedSizePreferred(url, filePath, onProgress, timeout, 0, preferred)
}

func downloadFileWithHashPreferredForApp(a *App, url, filePath string, onProgress func(downloaded, total int64)) (string, error) {
	preferred := DownloadSourceCst
	if a != nil {
		preferred = a.preferredDownloadSource()
	}
	if preferred == DownloadSourceCst {
		return downloadFileWithHash(url, filePath, onProgress)
	}
	return downloadFileWithHashPreferred(url, filePath, onProgress, preferred)
}

func doUpdateRequest(client *http.Client, req *http.Request) (*http.Response, error) {
	resp, err := client.Do(req)
	if err == nil {
		return resp, nil
	}
	if !shouldRetryUpdateNetworkError(err) {
		return nil, wrapUpdateNetworkError(err)
	}
	time.Sleep(updateNetworkRetryDelay)
	retryReq := req.Clone(req.Context())
	resp, err = client.Do(retryReq)
	if err != nil {
		return nil, wrapUpdateNetworkError(err)
	}
	return resp, nil
}

func shouldRetryUpdateNetworkError(err error) bool {
	if err == nil {
		return false
	}
	if isUpdateEOFError(err) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "connection reset by peer") ||
		strings.Contains(lower, "connection refused") ||
		strings.Contains(lower, "server closed idle connection")
}

func wrapUpdateNetworkError(err error) error {
	if err == nil {
		return nil
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		host := strings.TrimSpace(dnsErr.Name)
		if host == "" {
			host = "api.github.com"
		}
		return localizedUpdateError{
			key: "app.update.backend.error.network_dns",
			params: map[string]any{
				"host":   host,
				"detail": err.Error(),
			},
		}
	}
	if isUpdateEOFError(err) {
		return localizedUpdateError{
			key:    "app.update.backend.error.network_eof",
			params: map[string]any{"detail": err.Error()},
		}
	}
	return localizedUpdateError{
		key:    "app.update.backend.error.network_failed",
		params: map[string]any{"detail": err.Error()},
	}
}

func isUpdateEOFError(err error) bool {
	return errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF) ||
		strings.Contains(strings.ToLower(err.Error()), "eof")
}

func isGitHubReleaseAssetAPIURL(urlText string) bool {
	parsed, err := urlpkg.Parse(strings.TrimSpace(urlText))
	if err != nil {
		return false
	}
	if !strings.EqualFold(parsed.Host, "api.github.com") {
		return false
	}
	return strings.Contains(strings.ToLower(strings.TrimSpace(parsed.Path)), "/releases/assets/")
}

func buildUpdateDownloadResult(info UpdateInfo, staged *stagedUpdate) updateDownloadResult {
	result := updateDownloadResult{
		Info:          info,
		Platform:      stdRuntime.GOOS,
		InstallTarget: resolveUpdateInstallTarget(),
		InstallMode:   info.InstallMode,
		PackageType:   info.PackageType,
		AutoRelaunch:  info.AutoRelaunch,
	}
	if staged != nil {
		result.DownloadPath = staged.FilePath
		result.InstallLogPath = staged.InstallLogPath
		result.InstallMode = string(staged.InstallMode)
		result.PackageType = string(staged.PackageType)
		result.AutoRelaunch = staged.AutoRelaunch
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

func buildUpdateStageDirName(channel string, version string) string {
	return buildUpdateStageDirNameForPlatform(stdRuntime.GOOS, channel, version)
}

func buildUpdateStageDirNameForPlatform(goos string, channel string, version string) string {
	normalizedChannel, err := normalizeUpdateChannel(channel)
	if err != nil {
		normalizedChannel = updateChannelLatest
	}
	return fmt.Sprintf(
		".gonavi-update-%s-%s-%s",
		strings.TrimSpace(strings.ToLower(goos)),
		sanitizeVersionForPath(string(normalizedChannel)),
		sanitizeVersionForPath(version),
	)
}

func resolveReleaseVersion(channel updateChannel, release *githubRelease) string {
	if release == nil {
		return ""
	}

	tagVersion := normalizeVersion(release.TagName)
	if channel != updateChannelDev && tagVersion != "" && !strings.EqualFold(tagVersion, updateDevReleaseTag) {
		return tagVersion
	}

	if nameVersion := extractVersionFromReleaseName(release.Name); nameVersion != "" {
		return nameVersion
	}
	if assetVersion := extractVersionFromReleaseAssets(release.Assets); assetVersion != "" {
		return assetVersion
	}
	if tagVersion != "" && !strings.EqualFold(tagVersion, updateDevReleaseTag) {
		return tagVersion
	}
	return ""
}

func extractVersionFromReleaseName(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return ""
	}

	if strings.HasPrefix(strings.ToLower(trimmed), "dev-") {
		return normalizeVersion(trimmed)
	}

	if left := strings.LastIndex(trimmed, "("); left >= 0 && strings.HasSuffix(trimmed, ")") {
		candidate := strings.TrimSpace(trimmed[left+1 : len(trimmed)-1])
		if candidate != "" {
			return normalizeVersion(candidate)
		}
	}
	return ""
}

func extractVersionFromReleaseAssets(assets []githubAsset) string {
	const assetPrefix = "GoNavi-"
	osMarkers := []string{"-Windows-", "-MacOS-", "-Linux-"}

	for _, asset := range assets {
		name := strings.TrimSpace(asset.Name)
		if !strings.HasPrefix(name, assetPrefix) {
			continue
		}
		rest := strings.TrimPrefix(name, assetPrefix)
		for _, marker := range osMarkers {
			index := strings.Index(rest, marker)
			if index <= 0 {
				continue
			}
			candidate := normalizeVersion(rest[:index])
			if candidate != "" {
				return candidate
			}
		}
	}
	return ""
}

func sanitizeVersionForPath(version string) string {
	trimmed := strings.TrimSpace(version)
	if trimmed == "" {
		return "latest"
	}

	var builder strings.Builder
	lastDash := false
	for _, r := range trimmed {
		isAllowed := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if isAllowed {
			builder.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			builder.WriteRune('-')
			lastDash = true
		}
	}

	result := strings.Trim(builder.String(), "-")
	if result == "" || result == "." || result == ".." {
		return "latest"
	}
	return result
}

func resolveUpdateWorkspaceDir(version string) string {
	return resolveUpdateWorkspaceDirForInstallMode(version, updateResolveInstallMode())
}

func resolveUpdateWorkspaceDirForInstallMode(version string, installMode updateInstallMode) string {
	cacheDir, _ := os.UserCacheDir()
	return resolveUpdateWorkspaceDirForPlatform(
		stdRuntime.GOOS,
		version,
		installMode,
		"",
		cacheDir,
	)
}

func resolveUpdateWorkspaceDirCandidatesForInstallMode(version string, installMode updateInstallMode) []string {
	preferredDir := resolveUpdateWorkspaceDirForInstallMode(version, installMode)
	fallbackDir := resolveUpdateWorkspaceDirForPlatform(stdRuntime.GOOS, version, installMode, "", "")
	candidates := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	for _, candidate := range []string{preferredDir, fallbackDir} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		key := normalizeUpdatePathForPrefixCheck(candidate)
		if stdRuntime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		candidates = append(candidates, candidate)
	}
	return candidates
}

func resolveUpdateWorkspaceDirForPlatform(_ string, version string, _ updateInstallMode, _ string, userCacheDir string) string {
	baseDir := strings.TrimSpace(userCacheDir)
	if baseDir == "" {
		baseDir = strings.TrimSpace(os.TempDir())
	}
	if baseDir == "" {
		return ""
	}
	return filepath.Join(baseDir, "GoNavi", "updates", sanitizeVersionForPath(version))
}

func prepareUpdateWorkspaceAndStagingDirs(workspaceCandidates []string, channel string, version string) (string, string, error) {
	var prepareErrors []error
	for _, candidate := range workspaceCandidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if err := os.MkdirAll(candidate, 0o755); err != nil {
			prepareErrors = append(prepareErrors, fmt.Errorf("create %s: %w", candidate, err))
			continue
		}

		stagedDir := resolveUpdateStagedDir(candidate, channel, version)
		stageBaseDir := filepath.Dir(stagedDir)
		// Windows 上文件可能被杀毒软件或索引服务短暂占用，需要重试。
		for retry := 0; retry < 5; retry++ {
			err := os.RemoveAll(stagedDir)
			if err == nil {
				break
			}
			if retry < 4 {
				time.Sleep(time.Duration(retry+1) * 500 * time.Millisecond)
			} else {
				stagedDir = filepath.Join(stageBaseDir, fmt.Sprintf("%s-%d", buildUpdateStageDirName(channel, version), time.Now().UnixNano()))
			}
		}
		if err := os.MkdirAll(stagedDir, 0o755); err != nil {
			prepareErrors = append(prepareErrors, fmt.Errorf("create %s: %w", stagedDir, err))
			continue
		}
		return candidate, stagedDir, nil
	}
	if len(prepareErrors) == 0 {
		return "", "", errors.New("no update workspace candidates")
	}
	return "", "", errors.Join(prepareErrors...)
}

func resolveUpdateAssetPath(workspaceDir string, stagedDir string, assetName string) string {
	name := strings.TrimSpace(assetName)
	if shouldStoreUpdateAssetInWorkspaceRoot(stdRuntime.GOOS) {
		return filepath.Join(workspaceDir, name)
	}
	return filepath.Join(stagedDir, name)
}

func shouldStoreUpdateAssetInWorkspaceRoot(goos string) bool {
	switch strings.TrimSpace(strings.ToLower(goos)) {
	case "darwin", "windows", "linux":
		return true
	default:
		return false
	}
}

func resolveUpdateStagedDir(workspaceDir string, channel string, version string) string {
	return resolveUpdateStagedDirForPlatform(stdRuntime.GOOS, workspaceDir, channel, version)
}

func resolveUpdateStagedDirForPlatform(goos string, workspaceDir string, channel string, version string) string {
	baseDir := strings.TrimSpace(workspaceDir)
	if baseDir == "" {
		return ""
	}
	return filepath.Join(baseDir, buildUpdateStageDirNameForPlatform(goos, channel, version))
}

func normalizeUpdatePathForPrefixCheck(path string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(path), "\\", "/")
	normalized = filepath.ToSlash(filepath.Clean(normalized))
	if normalized == "." {
		return ""
	}
	return strings.TrimRight(normalized, "/")
}

func updatePathsEqualForPlatform(goos string, left string, right string) bool {
	left = normalizeUpdatePathForPrefixCheck(left)
	right = normalizeUpdatePathForPrefixCheck(right)
	if left == "" || right == "" {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(goos), "windows") {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func absoluteUpdatePath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("path is empty")
	}
	cleaned := filepath.Clean(path)
	if cleaned == "." {
		return "", errors.New("path resolves to current directory")
	}
	absPath, err := filepath.Abs(cleaned)
	if err != nil {
		return "", err
	}
	return filepath.Clean(absPath), nil
}

func isUpdatePathStrictlyInsideDir(path string, dir string) bool {
	absPath, err := absoluteUpdatePath(path)
	if err != nil {
		return false
	}
	absDir, err := absoluteUpdatePath(dir)
	if err != nil {
		return false
	}
	relPath, err := filepath.Rel(absDir, absPath)
	if err != nil || relPath == "." || filepath.IsAbs(relPath) {
		return false
	}
	return relPath != ".." && !strings.HasPrefix(relPath, ".."+string(filepath.Separator))
}

func isDirectChildUpdatePath(path string, parentDir string) bool {
	absPath, err := absoluteUpdatePath(path)
	if err != nil {
		return false
	}
	absParent, err := absoluteUpdatePath(parentDir)
	if err != nil {
		return false
	}
	relPath, err := filepath.Rel(absParent, absPath)
	if err != nil || relPath == "." || relPath == ".." || filepath.IsAbs(relPath) {
		return false
	}
	return filepath.Dir(relPath) == "."
}

func allowedUpdateRootDirs() []string {
	cacheDir, _ := os.UserCacheDir()
	baseDirs := []string{cacheDir, os.TempDir()}
	roots := make([]string, 0, len(baseDirs))
	seen := make(map[string]struct{}, len(baseDirs))
	for _, baseDir := range baseDirs {
		baseDir = strings.TrimSpace(baseDir)
		if baseDir == "" {
			continue
		}
		rootDir := filepath.Join(baseDir, "GoNavi", "updates")
		key := normalizeUpdatePathForPrefixCheck(rootDir)
		if stdRuntime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		roots = append(roots, rootDir)
	}
	return roots
}

func validateStagedUpdateWorkspace(staged *stagedUpdate) error {
	if staged == nil {
		return errors.New("staged update is nil")
	}
	workspaceDir := strings.TrimSpace(staged.WorkspaceDir)
	version := strings.TrimSpace(staged.Version)
	if workspaceDir == "" || version == "" {
		return errors.New("update workspace or version is empty")
	}
	if filepath.Base(filepath.Clean(workspaceDir)) != sanitizeVersionForPath(version) {
		return fmt.Errorf("update workspace does not match version %q", version)
	}
	allowed := false
	for _, rootDir := range allowedUpdateRootDirs() {
		if isDirectChildUpdatePath(workspaceDir, rootDir) {
			allowed = true
			break
		}
	}
	if !allowed {
		return fmt.Errorf("update workspace %q is outside the cache roots", workspaceDir)
	}
	for label, path := range map[string]string{
		"package": staged.FilePath,
		"staging": staged.StagedDir,
		"log":     staged.InstallLogPath,
	} {
		if !isUpdatePathStrictlyInsideDir(path, workspaceDir) {
			return fmt.Errorf("%s path %q is outside update workspace %q", label, path, workspaceDir)
		}
	}
	return nil
}

func resolveUpdateCleanupDir(workspaceDir string) string {
	workspaceDir = strings.TrimSpace(workspaceDir)
	if workspaceDir == "" {
		return ""
	}
	return filepath.Dir(filepath.Clean(workspaceDir))
}

func isUpdateAssetPathInsideStagedDir(filePath string, stagedDir string) bool {
	normalizedFilePath := normalizeUpdatePathForPrefixCheck(filePath)
	normalizedStagedDir := normalizeUpdatePathForPrefixCheck(stagedDir)
	if normalizedFilePath == "" || normalizedStagedDir == "" {
		return false
	}
	return normalizedFilePath == normalizedStagedDir || strings.HasPrefix(normalizedFilePath, normalizedStagedDir+"/")
}

func buildReusableUpdatePathCandidatesForPlatform(goos string, preferredWorkspaceDir string, fallbackWorkspaceDir string, channel string, version string, assetName string) []updatePathCandidate {
	preferredWorkspaceDir = strings.TrimSpace(preferredWorkspaceDir)
	fallbackWorkspaceDir = strings.TrimSpace(fallbackWorkspaceDir)
	assetName = strings.TrimSpace(assetName)
	workspaceCandidates := []string{preferredWorkspaceDir, fallbackWorkspaceDir}
	seenWorkspace := make(map[string]struct{}, len(workspaceCandidates))
	candidates := make([]updatePathCandidate, 0, len(workspaceCandidates))

	for _, workspaceDir := range workspaceCandidates {
		workspaceDir = strings.TrimSpace(workspaceDir)
		if workspaceDir == "" {
			continue
		}
		if _, exists := seenWorkspace[workspaceDir]; exists {
			continue
		}
		seenWorkspace[workspaceDir] = struct{}{}
		if shouldStoreUpdateAssetInWorkspaceRoot(goos) {
			candidates = append(candidates, updatePathCandidate{
				workspaceDir: workspaceDir,
				stagedDir:    resolveUpdateStagedDirForPlatform(goos, workspaceDir, channel, version),
				assetPath:    filepath.Join(workspaceDir, assetName),
			})
		}
	}
	return candidates
}

func isExistingDownloadedAsset(filePath string, expectedSize int64) bool {
	path := strings.TrimSpace(filePath)
	if path == "" {
		return false
	}
	stat, err := os.Stat(path)
	if err != nil || stat.IsDir() {
		return false
	}
	if expectedSize > 0 && stat.Size() != expectedSize {
		return false
	}
	return true
}

func resolveReusableStagedUpdate(info UpdateInfo, current *stagedUpdate) *stagedUpdate {
	workspaceDirs := resolveUpdateWorkspaceDirCandidatesForInstallMode(strings.TrimSpace(info.LatestVersion), updateInstallMode(info.InstallMode))
	preferredWorkspaceDir := ""
	fallbackWorkspaceDir := ""
	if len(workspaceDirs) > 0 {
		preferredWorkspaceDir = workspaceDirs[0]
	}
	if len(workspaceDirs) > 1 {
		fallbackWorkspaceDir = workspaceDirs[1]
	}
	return resolveReusableStagedUpdateForPlatform(
		stdRuntime.GOOS,
		preferredWorkspaceDir,
		fallbackWorkspaceDir,
		info,
		current,
	)
}

func resolveReusableStagedUpdateForPlatform(goos string, preferredWorkspaceDir string, fallbackWorkspaceDir string, info UpdateInfo, current *stagedUpdate) *stagedUpdate {
	channel, err := normalizeUpdateChannel(info.Channel)
	if err != nil {
		channel = updateChannelLatest
	}
	version := strings.TrimSpace(info.LatestVersion)
	assetName := strings.TrimSpace(info.AssetName)
	if version == "" || assetName == "" {
		return nil
	}
	candidates := buildReusableUpdatePathCandidatesForPlatform(
		goos,
		preferredWorkspaceDir,
		fallbackWorkspaceDir,
		string(channel),
		version,
		assetName,
	)

	if current != nil {
		currentChannel := current.Channel
		if currentChannel == "" {
			currentChannel = updateChannelLatest
		}
		if currentChannel == channel && strings.TrimSpace(current.Version) == version &&
			strings.TrimSpace(current.AssetName) == assetName &&
			current.InstallMode == updateInstallMode(info.InstallMode) &&
			current.PackageType == updatePackageType(info.PackageType) {
			currentPath := strings.TrimSpace(current.FilePath)
			if isExistingDownloadedAsset(currentPath, info.AssetSize) {
				for _, candidate := range candidates {
					if !updatePathsEqualForPlatform(goos, currentPath, candidate.assetPath) ||
						!isUpdatePathStrictlyInsideDir(current.StagedDir, candidate.workspaceDir) {
						continue
					}
					current.WorkspaceDir = candidate.workspaceDir
					if !isUpdatePathStrictlyInsideDir(current.InstallLogPath, candidate.workspaceDir) {
						current.InstallLogPath = buildUpdateInstallLogPath(candidate.workspaceDir)
					}
					current.Channel = channel
					current.AssetName = assetName
					current.InstallMode = updateInstallMode(info.InstallMode)
					current.PackageType = updatePackageType(info.PackageType)
					current.AutoRelaunch = info.AutoRelaunch
					return current
				}
			}
		}
	}

	for _, candidate := range candidates {
		if !isExistingDownloadedAsset(candidate.assetPath, info.AssetSize) {
			continue
		}
		return &stagedUpdate{
			Channel:        channel,
			Version:        version,
			AssetName:      assetName,
			WorkspaceDir:   candidate.workspaceDir,
			FilePath:       candidate.assetPath,
			StagedDir:      candidate.stagedDir,
			InstallLogPath: buildUpdateInstallLogPath(candidate.workspaceDir),
			InstallMode:    updateInstallMode(info.InstallMode),
			PackageType:    updatePackageType(info.PackageType),
			AutoRelaunch:   info.AutoRelaunch,
		}
	}

	return nil
}

func resolveUpdateInstallTarget() string {
	exePath, err := resolveExecutablePath(os.Executable, filepath.EvalSymlinks)
	if err != nil {
		return ""
	}
	if stdRuntime.GOOS == "darwin" {
		return resolveMacUpdateTarget(exePath)
	}
	return exePath
}

func resolveExecutablePath(
	executable func() (string, error),
	evalSymlinks func(string) (string, error),
) (string, error) {
	exePath, err := executable()
	if err != nil {
		return "", err
	}
	exePath = strings.TrimSpace(exePath)
	if exePath == "" {
		return "", localizedUpdateError{key: "app.update.backend.error.install_target_unresolved"}
	}
	if resolved, evalErr := evalSymlinks(exePath); evalErr == nil {
		if resolved = strings.TrimSpace(resolved); resolved != "" {
			exePath = resolved
		}
	}
	return exePath, nil
}

func ensureWindowsUpdateTargetWritable(targetExe string) error {
	targetExe = strings.TrimSpace(targetExe)
	targetDir := strings.TrimSpace(filepath.Dir(targetExe))
	if targetExe == "" || targetDir == "" || targetDir == "." {
		return localizedUpdateError{key: "app.update.backend.error.install_target_unresolved"}
	}

	probePath := filepath.Join(targetDir, fmt.Sprintf(".gonavi-update-write-probe-%d.tmp", time.Now().UnixNano()))
	file, err := os.OpenFile(probePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return localizedUpdateError{
			key: "app.update.backend.error.install_target_not_writable",
			params: map[string]any{
				"path":   targetDir,
				"detail": err.Error(),
			},
		}
	}
	if closeErr := file.Close(); closeErr != nil {
		logger.Warnf("关闭 Windows 更新写入探针失败：%v", closeErr)
	}
	if removeErr := os.Remove(probePath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		logger.Warnf("清理 Windows 更新写入探针失败：%v", removeErr)
	}
	return nil
}

func (a *App) emitUpdateDownloadProgress(info *UpdateInfo, status string, downloaded, total int64, message string) {
	payload := updateDownloadProgressPayload{
		Status:     normalizeUpdateDownloadTaskStatus(status),
		Percent:    0,
		Downloaded: downloaded,
		Total:      total,
		Message:    strings.TrimSpace(message),
	}
	if payload.Status != "downloading" {
		payload.Info = snapshotUpdateInfo(info)
	}
	if total > 0 {
		payload.Percent = math.Min(100, (float64(downloaded)/float64(total))*100)
	}
	if payload.Status == "done" && payload.Percent < 100 {
		payload.Percent = 100
	}
	payload.TaskID = a.updateUpdateDownloadTaskProgress(info, payload)
	if a.ctx == nil {
		return
	}
	uievents.Emit(a.ctx, updateDownloadProgressEvent, payload)
}

func (a *App) updateUpdateDownloadTaskProgress(info *UpdateInfo, payload updateDownloadProgressPayload) string {
	if a == nil {
		return ""
	}
	a.updateMu.Lock()
	defer a.updateMu.Unlock()
	task := a.updateState.task
	if task == nil || !task.Running || !a.updateState.downloading {
		return ""
	}
	task.Status = normalizeUpdateDownloadTaskStatus(payload.Status)
	task.Percent = payload.Percent
	if task.Status == "start" {
		task.Percent = 0
	}
	if task.Status == "done" {
		task.Percent = 100
	}
	task.Downloaded = max(0, payload.Downloaded)
	task.Total = max(0, payload.Total)
	if task.Total > 0 && task.Downloaded > task.Total {
		task.Downloaded = task.Total
	}
	task.Message = strings.TrimSpace(payload.Message)
	if info != nil {
		task.Info = snapshotUpdateInfo(info)
	}
	return task.TaskID
}

func (a *App) emitUpdateDownloadTaskSnapshot(task UpdateDownloadTaskStatus) {
	if a == nil || a.ctx == nil {
		return
	}
	payload := updateDownloadProgressPayload{
		TaskID:     task.TaskID,
		Status:     normalizeUpdateDownloadTaskStatus(task.Status),
		Percent:    task.Percent,
		Downloaded: task.Downloaded,
		Total:      task.Total,
		Message:    task.Message,
	}
	if payload.Status != "downloading" {
		payload.Info = snapshotUpdateInfo(task.Info)
	}
	if payload.Status == "done" {
		payload.Percent = 100
		if payload.Total > 0 && payload.Downloaded < payload.Total {
			payload.Downloaded = payload.Total
		}
	}
	uievents.Emit(a.ctx, updateDownloadProgressEvent, payload)
}

func normalizeUpdateDownloadTaskStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "start", "downloading", "done", "error":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "downloading"
	}
}

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
