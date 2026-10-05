package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/logger"
)

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
