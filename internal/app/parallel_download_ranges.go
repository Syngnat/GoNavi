package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type rangeDownloadProgress struct {
	mu         sync.Mutex
	segments   []int64
	reported   int64
	lastEmit   time.Time
	total      int64
	onProgress func(downloaded, total int64)
}

func (p *rangeDownloadProgress) update(index int, downloaded int64, force bool) {
	if p == nil || p.onProgress == nil {
		return
	}
	p.mu.Lock()
	p.segments[index] = downloaded
	current := int64(0)
	for _, value := range p.segments {
		current += value
	}
	if current < p.reported {
		current = p.reported
	} else {
		p.reported = current
	}
	now := time.Now()
	if force || p.lastEmit.IsZero() || now.Sub(p.lastEmit) >= parallelDownloadProgressEvery {
		p.lastEmit = now
		p.mu.Unlock()
		p.onProgress(current, p.total)
		return
	}
	p.mu.Unlock()
}

type rangeProgressWriter struct {
	segmentIndex int
	written      int64
	progress     *rangeDownloadProgress
}

func (w *rangeProgressWriter) Write(data []byte) (int, error) {
	w.written += int64(len(data))
	w.progress.update(w.segmentIndex, w.written, false)
	return len(data), nil
}

func downloadOneValidatedRange(
	ctx context.Context,
	client *http.Client,
	rawURL string,
	file *os.File,
	segmentIndex int,
	start int64,
	end int64,
	total int64,
	progress *rangeDownloadProgress,
) error {
	wantLength := end - start + 1
	var lastErr error
	for attempt := 1; attempt <= parallelDownloadRangeRetries; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		progress.update(segmentIndex, 0, false)
		req, err := newDownloadRangeRequest(ctx, rawURL, start, end)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = wrapUpdateNetworkError(err)
		} else {
			parsed, rangeErr := parseValidatedContentRange(resp.Header.Get("Content-Range"))
			if resp.StatusCode != http.StatusPartialContent || rangeErr != nil || parsed.start != start || parsed.end != end || parsed.total != total || resp.ContentLength != wantLength {
				status := resp.StatusCode
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
				_ = resp.Body.Close()
				if status == http.StatusOK {
					return errParallelRangeUnsupported
				}
				if status == http.StatusConflict && gatedDispatcherResponse(rawURL, resp) {
					return downloadCurrentAssetMismatchError{}
				}
				if gatedDispatcherResponse(rawURL, resp) &&
					(status == http.StatusBadRequest || status == http.StatusNotFound || status == http.StatusGone) {
					return downloadCurrentAssetTerminalError{
						cause: classifyGitHubUpdateHTTPError(status, body, resp.Header, false),
					}
				}
				if status == http.StatusBadRequest || status == http.StatusNotFound || status == http.StatusGone || status == http.StatusConflict {
					return classifyGitHubUpdateHTTPError(status, body, resp.Header, false)
				} else {
					lastErr = fmt.Errorf("range response validation failed: status=%d content-range=%q content-length=%d", status, resp.Header.Get("Content-Range"), resp.ContentLength)
				}
			} else {
				writer := io.NewOffsetWriter(file, start)
				progressWriter := &rangeProgressWriter{segmentIndex: segmentIndex, progress: progress}
				written, copyErr := io.Copy(io.MultiWriter(writer, progressWriter), resp.Body)
				closeErr := resp.Body.Close()
				if copyErr == nil && closeErr == nil && written == wantLength {
					progress.update(segmentIndex, wantLength, true)
					return nil
				}
				lastErr = firstNonNilError(copyErr, closeErr)
				if lastErr == nil {
					lastErr = fmt.Errorf("range body size mismatch: expected=%d actual=%d", wantLength, written)
				}
			}
		}
		if attempt < parallelDownloadRangeRetries {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * updateNetworkRetryDelay):
			}
		}
	}
	return lastErr
}

func firstNonNilError(values ...error) error {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func sha256Path(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func replaceDownloadedFile(temporaryPath string, filePath string) error {
	_ = os.Remove(filePath)
	for attempt := 0; attempt < 5; attempt++ {
		if err := os.Rename(temporaryPath, filePath); err == nil {
			return nil
		} else if attempt == 4 {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 250 * time.Millisecond)
	}
	return nil
}

type persistentRangeDownload struct {
	file          *os.File
	temporaryPath string
	filePath      string
	total         int64
	workerCount   int
	chunkSize     int64
	completed     []bool
	progress      *rangeDownloadProgress
}

func newPersistentRangeDownload(filePath string, total int64, onProgress func(downloaded, total int64)) (*persistentRangeDownload, error) {
	if total < parallelDownloadMinimumSize {
		return nil, errParallelRangeUnsupported
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(filepath.Dir(filePath), "."+filepath.Base(filePath)+".ranges-*")
	if err != nil {
		return nil, err
	}
	if err := file.Truncate(total); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, err
	}
	workerCount := parallelDownloadWorkers
	if total < int64(workerCount) {
		workerCount = int(total)
	}
	session := &persistentRangeDownload{
		file:          file,
		temporaryPath: file.Name(),
		filePath:      filePath,
		total:         total,
		workerCount:   workerCount,
		chunkSize:     (total + int64(workerCount) - 1) / int64(workerCount),
		completed:     make([]bool, workerCount),
		progress: &rangeDownloadProgress{
			segments:   make([]int64, workerCount),
			total:      total,
			onProgress: onProgress,
		},
	}
	if onProgress != nil {
		onProgress(0, total)
	}
	return session, nil
}

func (session *persistentRangeDownload) closeAndRemove() {
	if session == nil {
		return
	}
	if session.file != nil {
		_ = session.file.Close()
		session.file = nil
	}
	if session.temporaryPath != "" {
		_ = os.Remove(session.temporaryPath)
		session.temporaryPath = ""
	}
}

type rangeDownloadOutcome struct {
	index int
	err   error
}

func (session *persistentRangeDownload) attempt(client *http.Client, rawURL string) (bool, error) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rangeClient := downloadRangeClient(client)
	outcomes := make(chan rangeDownloadOutcome, session.workerCount)
	launched := 0
	for index := 0; index < session.workerCount; index++ {
		if session.completed[index] {
			continue
		}
		start := int64(index) * session.chunkSize
		end := start + session.chunkSize - 1
		if end >= session.total {
			end = session.total - 1
		}
		launched++
		go func(index int, start int64, end int64) {
			outcomes <- rangeDownloadOutcome{
				index: index,
				err: downloadOneValidatedRange(
					ctx, rangeClient, rawURL, session.file, index, start, end, session.total, session.progress,
				),
			}
		}(index, start, end)
	}
	var firstErr error
	var unsupportedErr error
	var terminalAssetError error
	for count := 0; count < launched; count++ {
		outcome := <-outcomes
		if outcome.err == nil {
			session.completed[outcome.index] = true
			continue
		}
		if errors.Is(outcome.err, errParallelRangeUnsupported) {
			// Other workers may observe context.Canceled after this worker
			// cancels the group. Preserve the decisive unsupported-range error
			// so the caller can perform the sequential fallback.
			unsupportedErr = errParallelRangeUnsupported
		}
		var mismatch downloadCurrentAssetMismatchError
		var terminal downloadCurrentAssetTerminalError
		if errors.As(outcome.err, &mismatch) || errors.As(outcome.err, &terminal) {
			// Cancellation races must not hide an expired or superseded dev asset.
			terminalAssetError = outcome.err
		}
		if firstErr == nil {
			firstErr = outcome.err
			cancel()
		}
	}
	if terminalAssetError != nil {
		return false, terminalAssetError
	}
	if unsupportedErr != nil {
		return false, unsupportedErr
	}
	if firstErr != nil {
		return false, firstErr
	}
	for _, completed := range session.completed {
		if !completed {
			return false, errors.New("range download stopped with incomplete segments")
		}
	}
	return true, nil
}

func (session *persistentRangeDownload) finish() (string, error) {
	if err := session.file.Sync(); err != nil {
		return "", err
	}
	if err := session.file.Close(); err != nil {
		return "", err
	}
	session.file = nil
	hash, err := sha256Path(session.temporaryPath)
	if err != nil {
		return "", err
	}
	if err := replaceDownloadedFile(session.temporaryPath, session.filePath); err != nil {
		return "", err
	}
	session.temporaryPath = ""
	if session.progress.onProgress != nil {
		session.progress.onProgress(session.total, session.total)
	}
	return hash, nil
}

func downloadFileWithValidatedRanges(
	client *http.Client,
	rawURL string,
	filePath string,
	total int64,
	onProgress func(downloaded, total int64),
) (string, error) {
	session, err := newPersistentRangeDownload(filePath, total, onProgress)
	if err != nil {
		return "", err
	}
	defer session.closeAndRemove()
	complete, err := session.attempt(client, rawURL)
	if err != nil {
		return "", err
	}
	if !complete {
		return "", errors.New("range download is incomplete")
	}
	return session.finish()
}
