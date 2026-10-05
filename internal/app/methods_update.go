package app

import (
	"errors"
	"os"
	"sync"
	"time"

	"GoNavi-Wails/internal/logger"
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
