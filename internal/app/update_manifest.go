package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/logger"
)

const (
	// 静态清单优先走自建下载镜像，GitHub Release 作为故障回退。
	updateMirrorLatestManifestURL = "https://download.syngnat.top/gonavi/releases/latest/latest.json"
	updateMirrorDevManifestURL    = "https://download.syngnat.top/gonavi/dev/releases/latest/latest-dev.json"
	updateGitHubLatestManifestURL = "https://github.com/" + updateRepo + "/releases/latest/download/latest.json"
	updateGitHubDevManifestURL    = "https://github.com/" + updateRepo + "/releases/download/" + updateDevReleaseTag + "/latest-dev.json"

	updateManifestSchemaVersion = 1
	updateManifestFileName      = "latest.json"
	updateDevManifestFileName   = "latest-dev.json"
	// 磁盘缓存：跨重启保留；过期后仍可作为限流/网络失败时的 stale 回退
	updateDiskCacheMaxAge = 7 * 24 * time.Hour
	// 静默检查最短间隔，避免启动/前台切换反复打网
	updateSilentCheckMinInterval = time.Hour
)

// updateReleaseManifest 是面向终端用户的静态更新清单（不依赖 GitHub REST API）。
type updateReleaseManifest struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Channel       string                `json:"channel"`
	TagName       string                `json:"tagName"`
	Version       string                `json:"version"`
	Name          string                `json:"name,omitempty"`
	HTMLURL       string                `json:"htmlUrl,omitempty"`
	PublishedAt   string                `json:"publishedAt,omitempty"`
	// ReleaseNotes 为 Markdown 更新日志（可选；旧清单无此字段时客户端走空态+外链）。
	ReleaseNotes string                `json:"releaseNotes,omitempty"`
	Assets       []updateManifestAsset `json:"assets"`
	FetchedAt    time.Time             `json:"fetchedAt,omitempty"` // 仅本地缓存写入
	Source       string                `json:"source,omitempty"`    // static | api | disk-cache
}

type updateManifestAsset struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	APIURL string `json:"apiUrl,omitempty"`
	Size   int64  `json:"size,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}

type updateNetworkCheckMemory struct {
	at      time.Time
	channel updateChannel
}

var (
	updateFetchStaticManifest         = fetchStaticUpdateManifest
	updateFetchFreshestStaticManifest = fetchFreshestStaticUpdateManifest
	updateNetworkCheckMu              sync.Mutex
	updateLastNetworkCheck            updateNetworkCheckMemory
)

func swapUpdateFetchStaticManifest(next func(updateChannel) (*githubRelease, error)) func() {
	originalStatic := updateFetchStaticManifest
	originalFreshest := updateFetchFreshestStaticManifest
	updateFetchStaticManifest = next
	updateFetchFreshestStaticManifest = next
	return func() {
		updateFetchStaticManifest = originalStatic
		updateFetchFreshestStaticManifest = originalFreshest
	}
}

func swapUpdateFetchFreshestStaticManifest(next func(updateChannel) (*githubRelease, error)) func() {
	original := updateFetchFreshestStaticManifest
	updateFetchFreshestStaticManifest = next
	return func() {
		updateFetchFreshestStaticManifest = original
	}
}

func updateManifestRemoteURLs(channel updateChannel) []string {
	if channel == updateChannelDev {
		return []string{updateMirrorDevManifestURL, updateGitHubDevManifestURL}
	}
	return []string{updateMirrorLatestManifestURL, updateGitHubLatestManifestURL}
}

func updateManifestCachePath(channel updateChannel) string {
	name := updateManifestFileName
	if channel == updateChannelDev {
		name = updateDevManifestFileName
	}
	return filepath.Join(appdata.MustResolveActiveRoot(), "update-cache", name)
}

func releaseFromUpdateManifest(manifest *updateReleaseManifest) *githubRelease {
	if manifest == nil {
		return nil
	}
	assets := make([]githubAsset, 0, len(manifest.Assets))
	for _, item := range manifest.Assets {
		name := strings.TrimSpace(item.Name)
		if name == "" {
			continue
		}
		url := strings.TrimSpace(item.URL)
		apiURL := strings.TrimSpace(item.APIURL)
		digest := ""
		if sha := normalizeGitHubAssetSHA256(item.SHA256); sha != "" {
			digest = "sha256:" + sha
		}
		assets = append(assets, githubAsset{
			Name:               name,
			BrowserDownloadURL: url,
			URL:                firstNonEmptyString(apiURL, url),
			Digest:             digest,
			Size:               item.Size,
		})
	}
	tagName := strings.TrimSpace(manifest.TagName)
	if tagName == "" && strings.TrimSpace(manifest.Version) != "" {
		tagName = "v" + strings.TrimPrefix(strings.TrimSpace(manifest.Version), "v")
	}
	name := strings.TrimSpace(manifest.Name)
	if name == "" {
		name = tagName
	}
	return &githubRelease{
		TagName:      tagName,
		Name:         name,
		HTMLURL:      strings.TrimSpace(manifest.HTMLURL),
		PublishedAt:  strings.TrimSpace(manifest.PublishedAt),
		Body:         strings.TrimSpace(manifest.ReleaseNotes),
		Assets:       assets,
	}
}

func updateManifestFromGitHubRelease(channel updateChannel, release *githubRelease, hashes map[string]string) *updateReleaseManifest {
	if release == nil {
		return nil
	}
	version := resolveReleaseVersion(channel, release)
	assets := make([]updateManifestAsset, 0, len(release.Assets))
	for _, asset := range release.Assets {
		name := strings.TrimSpace(asset.Name)
		if name == "" {
			continue
		}
		sha := normalizeGitHubAssetSHA256(asset.Digest)
		if sha == "" && hashes != nil {
			sha = normalizeGitHubAssetSHA256(hashes[name])
		}
		assets = append(assets, updateManifestAsset{
			Name:   name,
			URL:    firstNonEmptyString(asset.BrowserDownloadURL, asset.URL),
			APIURL: strings.TrimSpace(asset.URL),
			Size:   asset.Size,
			SHA256: sha,
		})
	}
	return &updateReleaseManifest{
		SchemaVersion: updateManifestSchemaVersion,
		Channel:       string(channel),
		TagName:       strings.TrimSpace(release.TagName),
		Version:       version,
		Name:          strings.TrimSpace(release.Name),
		HTMLURL:       strings.TrimSpace(release.HTMLURL),
		PublishedAt:   strings.TrimSpace(release.PublishedAt),
		ReleaseNotes:  strings.TrimSpace(release.Body),
		Assets:        assets,
		FetchedAt:     time.Now().UTC(),
		Source:        "api",
	}
}

func loadDiskUpdateManifest(channel updateChannel) (*updateReleaseManifest, bool /*stale*/) {
	path := updateManifestCachePath(channel)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var manifest updateReleaseManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, false
	}
	if manifest.SchemaVersion != 0 && manifest.SchemaVersion != updateManifestSchemaVersion {
		return nil, false
	}
	if strings.TrimSpace(manifest.TagName) == "" && strings.TrimSpace(manifest.Version) == "" {
		return nil, false
	}
	stale := false
	if !manifest.FetchedAt.IsZero() {
		stale = time.Since(manifest.FetchedAt) > updateDiskCacheMaxAge
	}
	manifest.Source = "disk-cache"
	return &manifest, stale
}

func storeDiskUpdateManifest(channel updateChannel, manifest *updateReleaseManifest) {
	if manifest == nil {
		return
	}
	path := updateManifestCachePath(channel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logger.Warnf("写入更新清单缓存目录失败：%v", err)
		return
	}
	clone := *manifest
	if clone.FetchedAt.IsZero() {
		clone.FetchedAt = time.Now().UTC()
	}
	if strings.TrimSpace(clone.Source) == "" {
		clone.Source = "static"
	}
	payload, err := json.MarshalIndent(clone, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		logger.Warnf("写入更新清单缓存失败：%v", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		logger.Warnf("提交更新清单缓存失败：%v", err)
	}
}

func fetchStaticUpdateManifest(channel updateChannel) (*githubRelease, error) {
	return fetchStaticUpdateManifestFromURLs(channel, updateManifestRemoteURLs(channel))
}

func fetchFreshestStaticUpdateManifest(channel updateChannel) (*githubRelease, error) {
	return fetchFreshestStaticUpdateManifestFromURLs(channel, updateManifestRemoteURLs(channel))
}

func fetchStaticUpdateManifestFromURLs(channel updateChannel, manifestURLs []string) (*githubRelease, error) {
	var failures []string
	for _, manifestURL := range manifestURLs {
		release, err := fetchStaticUpdateManifestFromURL(channel, manifestURL)
		if err == nil && release != nil {
			return release, nil
		}
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", manifestURL, err))
		}
	}
	if len(failures) == 0 {
		return nil, fmt.Errorf("no static update manifest URL configured")
	}
	return nil, fmt.Errorf("static update manifests unavailable: %s", strings.Join(failures, "; "))
}

func fetchStaticUpdateManifestFromURL(channel updateChannel, manifestURL string) (*githubRelease, error) {
	manifest, err := fetchStaticUpdateManifestPayloadFromURL(channel, manifestURL)
	if err != nil {
		return nil, err
	}
	return commitStaticUpdateManifest(channel, manifest), nil
}

func fetchFreshestStaticUpdateManifestFromURLs(channel updateChannel, manifestURLs []string) (*githubRelease, error) {
	type fetchResult struct {
		index    int
		manifest *updateReleaseManifest
		err      error
	}

	results := make([]fetchResult, len(manifestURLs))
	resultCh := make(chan fetchResult, len(manifestURLs))
	for index, manifestURL := range manifestURLs {
		go func(index int, manifestURL string) {
			manifest, err := fetchStaticUpdateManifestPayloadFromURL(channel, manifestURL)
			resultCh <- fetchResult{index: index, manifest: manifest, err: err}
		}(index, manifestURL)
	}
	for range manifestURLs {
		result := <-resultCh
		results[result.index] = result
	}

	var selected *updateReleaseManifest
	var failures []string
	for index, result := range results {
		if result.err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", manifestURLs[index], result.err))
			continue
		}
		if shouldPreferUpdateManifest(channel, selected, result.manifest) {
			selected = result.manifest
		}
	}
	if selected != nil {
		return commitStaticUpdateManifest(channel, selected), nil
	}
	if len(failures) == 0 {
		return nil, fmt.Errorf("no static update manifest URL configured")
	}
	return nil, fmt.Errorf("static update manifests unavailable: %s", strings.Join(failures, "; "))
}

func shouldPreferUpdateManifest(channel updateChannel, current *updateReleaseManifest, candidate *updateReleaseManifest) bool {
	if candidate == nil {
		return false
	}
	if current == nil {
		return true
	}
	comparison, comparable := compareUpdateManifestRecency(channel, current, candidate)
	return comparable && comparison < 0
}

// compareUpdateManifestRecency follows compareVersion: -1 means current is older.
// A false comparable result keeps source order stable, so the mirror wins ties.
func compareUpdateManifestRecency(channel updateChannel, current *updateReleaseManifest, candidate *updateReleaseManifest) (int, bool) {
	if current == nil || candidate == nil {
		return 0, false
	}

	if channel != updateChannelDev {
		currentVersion := normalizeVersion(firstNonEmptyString(current.Version, current.TagName))
		candidateVersion := normalizeVersion(firstNonEmptyString(candidate.Version, candidate.TagName))
		if currentVersion != "" && candidateVersion != "" {
			if comparison := compareVersion(currentVersion, candidateVersion); comparison != 0 {
				return comparison, true
			}
		}
	}

	currentPublishedAt, currentErr := time.Parse(time.RFC3339, strings.TrimSpace(current.PublishedAt))
	candidatePublishedAt, candidateErr := time.Parse(time.RFC3339, strings.TrimSpace(candidate.PublishedAt))
	if currentErr == nil && candidateErr == nil {
		switch {
		case currentPublishedAt.Before(candidatePublishedAt):
			return -1, true
		case currentPublishedAt.After(candidatePublishedAt):
			return 1, true
		default:
			return 0, true
		}
	}
	return 0, false
}

func fetchStaticUpdateManifestPayloadFromURL(channel updateChannel, manifestURL string) (*updateReleaseManifest, error) {
	url := strings.TrimSpace(manifestURL)
	if url == "" {
		return nil, fmt.Errorf("static update manifest URL is empty")
	}
	client := newHTTPClientWithGlobalProxy(15 * time.Second)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoNavi-Updater/"+strings.TrimSpace(getCurrentVersion()))
	req.Header.Set("Accept", "application/json")

	resp, err := doUpdateRequest(client, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if readErr != nil {
		return nil, wrapUpdateNetworkError(readErr)
	}
	if resp.StatusCode != http.StatusOK {
		// 静态资产 404：尚未发布 latest.json 的旧版本 Release，正常回退 API
		if resp.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("static update manifest not found: %s", url)
		}
		return nil, classifyGitHubUpdateHTTPError(resp.StatusCode, body, resp.Header, true)
	}

	var manifest updateReleaseManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return nil, wrapUpdateNetworkError(err)
	}
	if strings.TrimSpace(manifest.TagName) == "" && strings.TrimSpace(manifest.Version) == "" {
		return nil, localizedUpdateError{key: "app.update.backend.error.latest_version_unparseable"}
	}
	if manifest.SchemaVersion != 0 && manifest.SchemaVersion != updateManifestSchemaVersion {
		return nil, fmt.Errorf("unsupported update manifest schema: %d", manifest.SchemaVersion)
	}
	if err := validateRemoteUpdateManifest(channel, &manifest); err != nil {
		return nil, fmt.Errorf("invalid static update manifest %s: %w", url, err)
	}
	manifest.FetchedAt = time.Now().UTC()
	manifest.Source = "static"
	if strings.TrimSpace(manifest.Channel) == "" {
		manifest.Channel = string(channel)
	}
	return &manifest, nil
}

func commitStaticUpdateManifest(channel updateChannel, manifest *updateReleaseManifest) *githubRelease {
	if manifest == nil {
		return nil
	}
	storeDiskUpdateManifest(channel, manifest)
	release := releaseFromUpdateManifest(manifest)
	// 同步进进程内 API 缓存，供限流回退
	if channel == updateChannelDev {
		storeCachedGitHubRelease(updateDevAPIURL, release)
	} else {
		storeCachedGitHubRelease(updateLatestAPIURL, release)
	}
	return release
}

func validateRemoteUpdateManifest(channel updateChannel, manifest *updateReleaseManifest) error {
	if manifest == nil {
		return fmt.Errorf("manifest is empty")
	}
	expectedChannel := string(updateChannelLatest)
	if channel == updateChannelDev {
		expectedChannel = string(updateChannelDev)
	}
	manifestChannel := strings.TrimSpace(manifest.Channel)
	if manifestChannel != "" && !strings.EqualFold(manifestChannel, expectedChannel) {
		return fmt.Errorf("channel %q does not match requested channel %q", manifestChannel, expectedChannel)
	}
	if len(manifest.Assets) == 0 {
		return fmt.Errorf("manifest has no assets")
	}

	assetNames := make(map[string]struct{}, len(manifest.Assets))
	for _, asset := range manifest.Assets {
		name := strings.TrimSpace(asset.Name)
		if name == "" {
			return fmt.Errorf("manifest contains an unnamed asset")
		}
		nameKey := strings.ToLower(name)
		if _, exists := assetNames[nameKey]; exists {
			return fmt.Errorf("manifest contains duplicate asset %q", name)
		}
		assetNames[nameKey] = struct{}{}
		if asset.Size <= 0 {
			return fmt.Errorf("asset %q has invalid size", name)
		}
		if normalizeGitHubAssetSHA256(asset.SHA256) == "" {
			return fmt.Errorf("asset %q has invalid sha256", name)
		}
		for label, rawURL := range map[string]string{"url": asset.URL, "apiUrl": asset.APIURL} {
			value := strings.TrimSpace(rawURL)
			if value == "" {
				if label == "url" {
					return fmt.Errorf("asset %q has no download URL", name)
				}
				continue
			}
			parsed, err := neturl.ParseRequestURI(value)
			if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				return fmt.Errorf("asset %q has invalid %s", name, label)
			}
		}
	}

	assetVersion := strings.TrimSpace(manifest.TagName)
	if assetVersion == "" || strings.EqualFold(normalizeVersion(assetVersion), updateDevReleaseTag) {
		assetVersion = strings.TrimSpace(manifest.Version)
	}
	expectedAsset, err := expectedAssetNameForInstallMode(
		stdRuntime.GOOS,
		stdRuntime.GOARCH,
		assetVersion,
		updateResolveInstallMode(),
	)
	if err != nil {
		return err
	}
	if _, exists := assetNames[strings.ToLower(expectedAsset)]; !exists {
		return fmt.Errorf("manifest does not contain current platform asset %q", expectedAsset)
	}
	return nil
}

// fetchReleaseForChannel prefers static manifest → GitHub API → disk cache.
// forceNetwork=false 时：静默检查若距上次成功拉网过近，直接用磁盘缓存。
func fetchReleaseForChannelPreferringStatic(channel updateChannel, forceNetwork bool) (*githubRelease, error) {
	if channel != updateChannelDev {
		channel = updateChannelLatest
	}

	if !forceNetwork {
		if release := loadRecentNetworkOrDiskRelease(channel); release != nil {
			return release, nil
		}
	}

	staticFetcher := updateFetchStaticManifest
	if forceNetwork {
		staticFetcher = updateFetchFreshestStaticManifest
	}

	var staticErr error
	if release, err := staticFetcher(channel); err == nil && release != nil {
		markUpdateNetworkCheck(channel)
		return release, nil
	} else {
		staticErr = err
		if err != nil {
			logger.Warnf("静态更新清单不可用，回退 GitHub API：channel=%s err=%v", channel, err)
		}
	}

	var apiErr error
	release, err := fetchReleaseForChannel(channel)
	if err == nil && release != nil {
		// API 成功时落盘，供下次静态失败/限流时使用
		storeDiskUpdateManifest(channel, updateManifestFromGitHubRelease(channel, release, nil))
		markUpdateNetworkCheck(channel)
		return release, nil
	}
	apiErr = err

	if cached, stale := loadDiskUpdateManifest(channel); cached != nil {
		logger.Warnf("更新检查回退磁盘清单：channel=%s stale=%v staticErr=%v apiErr=%v", channel, stale, staticErr, apiErr)
		return releaseFromUpdateManifest(cached), nil
	}

	if apiErr != nil {
		return nil, apiErr
	}
	if staticErr != nil {
		return nil, staticErr
	}
	return nil, localizedUpdateError{key: "app.update.backend.error.latest_version_unparseable"}
}

func loadRecentNetworkOrDiskRelease(channel updateChannel) *githubRelease {
	updateNetworkCheckMu.Lock()
	last := updateLastNetworkCheck
	updateNetworkCheckMu.Unlock()
	if last.channel == channel && !last.at.IsZero() && time.Since(last.at) < updateSilentCheckMinInterval {
		if cached, stale := loadDiskUpdateManifest(channel); cached != nil && !stale {
			logger.Warnf("静默更新检查节流：复用磁盘清单 channel=%s age=%s", channel, time.Since(last.at))
			return releaseFromUpdateManifest(cached)
		}
		// 内存 API 缓存
		apiURL := updateLatestAPIURL
		if channel == updateChannelDev {
			apiURL = updateDevAPIURL
		}
		if mem := loadCachedGitHubRelease(apiURL); mem != nil {
			return mem
		}
	}
	return nil
}

func markUpdateNetworkCheck(channel updateChannel) {
	updateNetworkCheckMu.Lock()
	updateLastNetworkCheck = updateNetworkCheckMemory{at: time.Now(), channel: channel}
	updateNetworkCheckMu.Unlock()
}
