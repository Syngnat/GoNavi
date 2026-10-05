package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func downloadFileWithHashSequential(
	client *http.Client,
	rawURL string,
	filePath string,
	onProgress func(downloaded, total int64),
) (string, error) {
	resp, err := doGitHubDownload(client, rawURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusConflict && gatedDispatcherResponse(rawURL, resp) {
			return "", downloadCurrentAssetMismatchError{}
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		if gatedDispatcherResponse(rawURL, resp) &&
			(resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone) {
			return "", downloadCurrentAssetTerminalError{
				cause: classifyGitHubUpdateHTTPError(resp.StatusCode, body, resp.Header, false),
			}
		}
		return "", classifyGitHubUpdateHTTPError(resp.StatusCode, body, resp.Header, false)
	}
	_ = os.Remove(filePath)
	var out *os.File
	for retry := 0; retry < 5; retry++ {
		out, err = os.Create(filePath)
		if err == nil {
			break
		}
		if retry < 4 {
			time.Sleep(time.Duration(retry+1) * 500 * time.Millisecond)
		}
	}
	if err != nil {
		return "", localizedUpdateError{key: "app.update.backend.error.package_file_busy", params: map[string]any{"detail": err.Error()}}
	}
	hasher := sha256.New()
	total := resp.ContentLength
	progressWriter := &downloadProgressWriter{total: total, emitEvery: parallelDownloadProgressEvery, onProgress: onProgress}
	if onProgress != nil {
		onProgress(0, total)
	}
	if _, err := io.Copy(io.MultiWriter(out, hasher, progressWriter), resp.Body); err != nil {
		_ = out.Close()
		return "", wrapUpdateNetworkError(err)
	}
	if onProgress != nil {
		onProgress(progressWriter.written, total)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func downloadFileWithHashParallelAware(
	rawURL string,
	filePath string,
	onProgress func(downloaded, total int64),
	timeout time.Duration,
) (string, error) {
	return downloadFileWithHashParallelAwareAndExpectedSize(rawURL, filePath, onProgress, timeout, 0)
}

func downloadFileWithHashParallelAwareAndExpectedSize(
	rawURL string,
	filePath string,
	onProgress func(downloaded, total int64),
	timeout time.Duration,
	expectedSize int64,
) (string, error) {
	return downloadFileWithHashParallelAwareAndExpectedSizePreferred(rawURL, filePath, onProgress, timeout, expectedSize, DownloadSourceCst)
}

func downloadFileWithHashParallelAwareAndExpectedSizePreferred(
	rawURL string,
	filePath string,
	onProgress func(downloaded, total int64),
	timeout time.Duration,
	expectedSize int64,
	preferred DownloadSource,
) (string, error) {
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	client := newStrictHTTPClientWithGlobalProxy(timeout)
	return downloadFileWithHashParallelAwareAndExpectedSizeWithClientPreferred(client, rawURL, filePath, onProgress, expectedSize, preferred)
}

// downloadFileWithHashParallelAwareAndExpectedSizeWithClient keeps the
// transport injectable for deterministic fallback tests and callers that
// already own a configured HTTP client.
func downloadFileWithHashParallelAwareAndExpectedSizeWithClient(
	client *http.Client,
	rawURL string,
	filePath string,
	onProgress func(downloaded, total int64),
	expectedSize int64,
) (string, error) {
	return downloadFileWithHashParallelAwareAndExpectedSizeWithClientPreferred(client, rawURL, filePath, onProgress, expectedSize, DownloadSourceCst)
}

func downloadFileWithHashParallelAwareAndExpectedSizeWithClientPreferred(
	client *http.Client,
	rawURL string,
	filePath string,
	onProgress func(downloaded, total int64),
	expectedSize int64,
	preferred DownloadSource,
) (string, error) {
	if client == nil {
		return "", errors.New("download HTTP client is nil")
	}
	preferred = normalizeDownloadSource(string(preferred))
	var candidates []string
	var dispatcherErr error
	if expectedSize > 0 && func() bool {
		_, ok := downloadDispatcherAssetPath(rawURL)
		return ok
	}() {
		if preferred == DownloadSourceCst {
			// Cst remains the zero-latency default: the manifest already authenticates
			// the asset size, so start the real Range requests through the Dispatcher.
			candidates = []string{strings.TrimSpace(rawURL)}
		} else {
			// A non-Cst preference must resolve through the same Dispatcher gate first.
			// This preserves require-current=1 for dev assets while allowing the user
			// to select Bero or GitHub before any bytes are downloaded.
			resolved, resolveErr := resolveDispatcherDownloadCandidates(client, rawURL)
			if resolveErr != nil {
				if errors.Is(resolveErr, errInvalidDownloadDispatcherURL) || isCurrentDevAssetTerminalError(resolveErr) {
					return "", resolveErr
				}
				candidates = []string{strings.TrimSpace(rawURL)}
				dispatcherErr = resolveErr
			} else {
				candidates = reorderDownloadCandidates(resolved, preferred)
			}
		}
	} else {
		candidates, dispatcherErr = resolveDispatcherDownloadCandidates(client, rawURL)
		if dispatcherErr != nil {
			if errors.Is(dispatcherErr, errInvalidDownloadDispatcherURL) {
				return "", dispatcherErr
			}
			if isCurrentDevAssetTerminalError(dispatcherErr) {
				return "", dispatcherErr
			}
			// The 302 endpoint remains a compatibility fallback when JSON resolution
			// is temporarily unavailable. It still uses normal TLS.
			candidates = []string{strings.TrimSpace(rawURL)}
		}
		candidates = reorderDownloadCandidates(candidates, preferred)
	}
	result, err := downloadFileWithHashFromCandidatesWithExpectedSize(client, candidates, filePath, onProgress, dispatcherErr, expectedSize)
	if err == nil || len(candidates) != 1 || expectedSize <= 0 {
		return result, err
	}
	if !shouldResolveDispatcherFallback(candidates[0], expectedSize, err) {
		return result, err
	}
	// Older cached manifests may omit AssetAPIURL. Only pay for the dispatcher
	// JSON fallback after the zero-probe path fails, so GitHub remains available
	// without adding latency to healthy Cst downloads.
	fallbackCandidates, resolveErr := resolveDispatcherDownloadCandidates(client, candidates[0])
	if resolveErr != nil {
		return result, errors.Join(err, resolveErr)
	}
	fallbackCandidates = reorderDownloadCandidates(fallbackCandidates, preferred)
	return downloadFileWithHashFromCandidatesWithExpectedSize(client, fallbackCandidates, filePath, onProgress, err, expectedSize)
}

func downloadFileWithHashFromCandidates(
	client *http.Client,
	candidates []string,
	filePath string,
	onProgress func(downloaded, total int64),
	initialErr error,
) (string, error) {
	return downloadFileWithHashFromCandidatesWithExpectedSize(client, candidates, filePath, onProgress, initialErr, 0)
}

func downloadFileWithHashFromCandidatesWithExpectedSize(
	client *http.Client,
	candidates []string,
	filePath string,
	onProgress func(downloaded, total int64),
	initialErr error,
	expectedSize int64,
) (string, error) {
	errorsBySource := make([]error, 0, len(candidates)+1)
	if initialErr != nil {
		errorsBySource = append(errorsBySource, initialErr)
	}
	var rangeSession *persistentRangeDownload
	defer func() {
		if rangeSession != nil {
			rangeSession.closeAndRemove()
		}
	}()
	for _, candidate := range candidates {
		// The Dispatcher order is strict: probe and download a candidate before
		// touching its fallback, so an unreachable GitHub endpoint cannot hold an
		// otherwise healthy Cst download at 0%.
		var ranked []downloadCandidateProbe
		var probeErrors []error
		if expectedSize > 0 {
			// The manifest authenticates the size, so workers can issue their real
			// requests through the Dispatcher immediately. Do not serially probe
			// bytes=0-0 first: a slow redirect was leaving the UI at 0% for seconds.
			ranked = []downloadCandidateProbe{{
				candidate:     strings.TrimSpace(candidate),
				resolvedURL:   strings.TrimSpace(candidate),
				total:         expectedSize,
				supportsRange: true,
			}}
		}
		if len(ranked) == 0 {
			ranked, probeErrors = rankDownloadCandidates(client, []string{candidate})
		}
		errorsBySource = append(errorsBySource, probeErrors...)
		if len(ranked) == 0 {
			continue
		}
		probe := ranked[0]
		candidate = probe.candidate
		if probe.fromCache {
			refreshed, refreshErr := measureValidatedDownloadRange(client, candidate)
			if refreshErr != nil {
				invalidateDownloadCandidateProbe(candidate)
				errorsBySource = append(errorsBySource, fmt.Errorf(
					"download source %s cached probe refresh failed: %w",
					redactDownloadURL(candidate), refreshErr,
				))
				continue
			}
			probe = refreshed
			storeDownloadCandidateProbe(refreshed)
		}
		total := probe.total
		resolvedURL := probe.resolvedURL
		if probe.supportsRange && total >= parallelDownloadMinimumSize {
			if rangeSession == nil {
				var err error
				rangeSession, err = newPersistentRangeDownload(filePath, total, onProgress)
				if err != nil {
					return "", err
				}
			} else if rangeSession.total != total {
				rangeSession.closeAndRemove()
				return "", fmt.Errorf("download source metadata changed: expected size %d, got %d", rangeSession.total, total)
			}
			complete, rangeErr := rangeSession.attempt(client, resolvedURL)
			if rangeErr == nil && complete {
				return rangeSession.finish()
			}
			errorsBySource = append(errorsBySource, fmt.Errorf("download source %s failed: %w", redactDownloadURL(resolvedURL), rangeErr))
			invalidateDownloadCandidateProbe(candidate)
			if !errors.Is(rangeErr, errParallelRangeUnsupported) {
				continue
			}
		}
		if rangeSession != nil {
			rangeSession.closeAndRemove()
			rangeSession = nil
		}
		hash, sequentialErr := downloadFileWithHashSequential(client, resolvedURL, filePath, onProgress)
		if sequentialErr == nil {
			if expectedSize > 0 {
				stat, statErr := os.Stat(filePath)
				if statErr != nil {
					sequentialErr = statErr
				} else if stat.Size() != expectedSize {
					sequentialErr = fmt.Errorf("download source size mismatch: expected=%d actual=%d", expectedSize, stat.Size())
				}
			}
			if sequentialErr == nil {
				return hash, nil
			}
		}
		errorsBySource = append(errorsBySource, fmt.Errorf("download source %s failed: %w", redactDownloadURL(resolvedURL), sequentialErr))
		invalidateDownloadCandidateProbe(candidate)
		_ = os.Remove(filePath)
	}
	return "", errors.Join(errorsBySource...)
}

func redactDownloadURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "invalid-url"
	}
	return parsed.Scheme + "://" + parsed.Host + parsed.EscapedPath()
}
