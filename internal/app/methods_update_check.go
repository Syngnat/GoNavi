package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (a *App) CheckForUpdates() connection.QueryResult {
	// 用户手动检查：强制联网，并按下载来源设置选择元数据入口。
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

	info, err := fetchLatestUpdateInfoWithOptions(channel, forceNetwork, a.preferredDownloadSource())
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
