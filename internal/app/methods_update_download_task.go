package app

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	stdRuntime "runtime"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/uievents"

	"github.com/google/uuid"
)

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

// CancelUpdateDownload stops the active update package download so a stalled
// network read can be abandoned and retried. The task is marked terminal before
// the worker is interrupted, which keeps late progress from the canceled
// download from overwriting the canceled snapshot; the partial package and
// staging directory are removed by the download path itself.
func (a *App) CancelUpdateDownload() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}
	a.updateMu.Lock()
	task := a.updateState.task
	if !a.updateState.downloading || task == nil {
		a.updateMu.Unlock()
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.download_not_running", nil)}
	}
	if !task.Running || task.Status == "done" || task.Status == "error" || task.Status == "canceled" {
		// A worker that already reached a terminal state did the real work;
		// reporting it as canceled would misrepresent a finished download.
		a.updateMu.Unlock()
		return connection.QueryResult{Success: true, Data: map[string]interface{}{
			"task":            snapshotUpdateDownloadTask(task),
			"alreadyFinished": true,
		}}
	}
	cancel := a.updateState.taskCancel
	a.updateState.taskCancel = nil
	task.Status = "canceled"
	task.Message = a.appText("app.update.backend.message.download_canceled", nil)
	task.Running = false
	task.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	// Advancing the revision invalidates the in-flight download's staging checks,
	// so a canceled download can never publish a staged package.
	a.updateState.downloading = false
	a.updateState.revision++
	snapshot := snapshotUpdateDownloadTask(task)
	a.updateMu.Unlock()

	if cancel != nil {
		cancel()
	}
	a.emitUpdateDownloadTaskSnapshot(*snapshot)
	return connection.QueryResult{Success: true, Data: map[string]interface{}{
		"task": snapshot,
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
	parentContext := a.ctx
	if parentContext == nil {
		parentContext = context.Background()
	}
	taskContext, cancel := context.WithCancel(parentContext)
	a.updateState.taskCancel = cancel
	work := &updateDownloadTaskWork{
		taskID:   task.TaskID,
		info:     *info,
		channel:  channel,
		revision: a.updateState.revision,
		ctx:      taskContext,
		cancel:   cancel,
	}
	a.updateMu.Unlock()
	return work, snapshotUpdateDownloadTask(task), nil, false
}

func (a *App) runUpdateDownloadTask(work updateDownloadTaskWork) (result connection.QueryResult) {
	result = connection.QueryResult{Success: false, Message: "update download did not run"}
	ctx := work.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			result = connection.QueryResult{Success: false, Message: fmt.Sprintf("update download panic: %v", recovered)}
		}
		// Read the context error before releasing it: a user cancellation must be
		// recorded as "canceled" rather than as a generic download failure.
		a.finishUpdateDownloadTask(work.taskID, result, ctx.Err())
		if work.cancel != nil {
			work.cancel()
		}
	}()

	info := snapshotUpdateInfo(&work.info)
	downloadRevision := work.revision
	a.emitUpdateDownloadProgress(info, "start", 0, info.AssetSize, "")
	result, downloadErr := a.downloadAndStageUpdate(ctx, *info, downloadRevision)
	mismatchRetries := 0
	waitForCurrentAssetRetry := func() bool {
		if mismatchRetries >= updateCurrentDevAssetRetryLimit {
			return false
		}
		// A cancellation must not sit through the dev-channel retry backoff.
		if ctx.Err() != nil {
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
			result, downloadErr = a.downloadAndStageUpdate(ctx, *info, downloadRevision)
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
		result, downloadErr = a.downloadAndStageUpdate(ctx, *info, downloadRevision)
	}
	// A canceled download is not a failure to report: the canceled snapshot is
	// published by CancelUpdateDownload, and an "error" event here would fight it.
	if !result.Success && !errors.Is(ctx.Err(), context.Canceled) {
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

func (a *App) finishUpdateDownloadTask(taskID string, result connection.QueryResult, contextErr error) {
	if a == nil {
		return
	}
	a.updateMu.Lock()
	task := a.updateState.task
	if task == nil || task.TaskID != strings.TrimSpace(taskID) {
		a.updateMu.Unlock()
		return
	}
	if task.Running && errors.Is(contextErr, context.Canceled) {
		task.Status = "canceled"
		task.Message = a.appText("app.update.backend.message.download_canceled", nil)
	}
	terminalAlreadyEmitted := task.Status == "done" || task.Status == "error" || task.Status == "canceled"
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
	a.updateState.taskCancel = nil
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
	info, err := fetchLatestUpdateInfoWithOptions(updateChannelDev, true, a.preferredDownloadSource())
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
	case "start", "downloading", "done", "error", "canceled":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "downloading"
	}
}
