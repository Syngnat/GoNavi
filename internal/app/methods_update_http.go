package app

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	urlpkg "net/url"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"sync"
	"time"
)

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
