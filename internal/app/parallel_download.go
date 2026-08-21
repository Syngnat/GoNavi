package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	parallelDownloadWorkers       = 8
	parallelDownloadRangeRetries  = 3
	parallelDownloadMinimumSize   = 8 << 20
	parallelDownloadProgressEvery = 120 * time.Millisecond
	parallelDownloadHeaderTimeout = 15 * time.Second
	downloadDispatcherHostname    = "download-dispatch.syngnat.top"
	downloadDispatcherPath        = "/v1/resolve"
	downloadDispatcherMaxResponse = 64 << 10
	downloadCandidateProbeBytes   = 256 << 10
	downloadCandidateProbeTimeout = 15 * time.Second
	downloadCandidateCacheTTL     = 6 * time.Hour
	downloadRegionalBiasRatio     = 1.20
	downloadDMITBaseURL           = "https://download.syngnat.top"
	downloadBeroBaseURL           = "https://origin-download.syngnat.top:8443"
)

var errParallelRangeUnsupported = errors.New("download source does not support validated byte ranges")

type dispatcherDownloadCandidate struct {
	Source string `json:"source"`
	URL    string `json:"url"`
}

type dispatcherDownloadResponse struct {
	Candidates []dispatcherDownloadCandidate `json:"candidates"`
}

func downloadDispatcherURLForPath(assetPath string) string {
	assetPath = strings.TrimSpace(assetPath)
	if assetPath == "" || !strings.HasPrefix(assetPath, "/") {
		return ""
	}
	query := url.Values{}
	query.Set("path", assetPath)
	return "https://" + downloadDispatcherHostname + downloadDispatcherPath + "?" + query.Encode()
}

func downloadDispatcherAssetPath(rawURL string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.User != nil ||
		!strings.EqualFold(parsed.Hostname(), downloadDispatcherHostname) || parsed.EscapedPath() != downloadDispatcherPath {
		return "", false
	}
	assetPath := strings.TrimSpace(parsed.Query().Get("path"))
	return assetPath, strings.HasPrefix(assetPath, "/")
}

func isDevDispatcherAssetURL(rawURL string) bool {
	assetPath, ok := downloadDispatcherAssetPath(rawURL)
	return ok && strings.HasPrefix(assetPath, "/gonavi/dev/releases/download/")
}

func shouldResolveDispatcherFallback(rawURL string, expectedSize int64, _ error) bool {
	if expectedSize <= 0 {
		return false
	}
	_, isDispatcher := downloadDispatcherAssetPath(rawURL)
	return isDispatcher
}

func validatedHTTPSDownloadCandidates(value dispatcherDownloadResponse) []string {
	result := make([]string, 0, len(value.Candidates))
	seen := make(map[string]struct{}, len(value.Candidates))
	for _, candidate := range value.Candidates {
		if len(result) >= 8 {
			break
		}
		rawURL := strings.TrimSpace(candidate.URL)
		parsed, err := url.Parse(rawURL)
		if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
			continue
		}
		if _, ok := seen[rawURL]; ok {
			continue
		}
		seen[rawURL] = struct{}{}
		result = append(result, rawURL)
	}
	return result
}

func resolveDispatcherDownloadCandidates(client *http.Client, rawURL string) ([]string, error) {
	if _, ok := downloadDispatcherAssetPath(rawURL); !ok {
		return []string{strings.TrimSpace(rawURL)}, nil
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	query := parsed.Query()
	query.Set("format", "json")
	parsed.RawQuery = query.Encode()
	req, err := http.NewRequest(http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := doUpdateRequest(client, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, downloadDispatcherMaxResponse))
		return nil, classifyGitHubUpdateHTTPError(resp.StatusCode, body, resp.Header, false)
	}
	var value dispatcherDownloadResponse
	decoder := json.NewDecoder(io.LimitReader(resp.Body, downloadDispatcherMaxResponse))
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("decode download dispatcher response: %w", err)
	}
	candidates := validatedHTTPSDownloadCandidates(value)
	if len(candidates) == 0 {
		return nil, errors.New("download dispatcher returned no valid HTTPS candidates")
	}
	return candidates, nil
}

// staticDispatcherDownloadCandidates keeps downloads fail-open when the
// Dispatcher control plane is unavailable. The asset path is already present
// in the signed manifest URL, so derive the fixed mirror chain locally and
// keep GitHub as the final fallback.
func staticDispatcherDownloadCandidates(rawURL string) ([]string, error) {
	assetPath, ok := downloadDispatcherAssetPath(rawURL)
	if !ok {
		return nil, errors.New("invalid download dispatcher URL")
	}
	parts := strings.Split(strings.Trim(assetPath, "/"), "/")
	if len(parts) != 4 && len(parts) != 5 && len(parts) != 6 {
		return nil, errors.New("invalid download dispatcher asset path")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.Contains(part, "\\") {
			return nil, errors.New("invalid download dispatcher asset path segment")
		}
	}
	isDriver := parts[0] == "drivers"
	isDev := len(parts) == 6 && parts[1] == "dev"
	githubRepo := "Syngnat/GoNavi"
	githubTag := ""
	githubLatest := false
	asset := strings.TrimSpace(parts[len(parts)-1])
	if asset == "" {
		return nil, errors.New("download dispatcher asset coordinates are incomplete")
	}

	// Mutable manifest/index paths have no release tag in the URL. Keep their
	// exact coordinate mapping in sync with the Worker so a control-plane
	// failure can still reach both mirrors and the matching GitHub release.
	switch assetPath {
	case "/gonavi/releases/latest/latest.json":
		githubTag = "latest"
		githubLatest = true
	case "/gonavi/dev/releases/latest/latest-dev.json":
		githubTag = "dev-latest"
	case "/drivers/releases/latest/GoNavi-DriverAgents-Index.json":
		isDriver = true
		githubRepo = "Syngnat/GoNavi-DriverAgents"
		githubTag = "latest"
		githubLatest = true
	case "/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json":
		isDriver = true
		githubRepo = "Syngnat/GoNavi-DriverAgents"
		githubTag = "dev-latest"
	default:
		if parts[0] != "gonavi" && !isDriver {
			return nil, errors.New("unsupported download dispatcher asset path")
		}
		if isDev {
			if parts[2] != "releases" || parts[3] != "download" {
				return nil, errors.New("invalid development download dispatcher asset path")
			}
		} else if len(parts) != 5 || parts[1] != "releases" || parts[2] != "download" {
			return nil, errors.New("invalid stable download dispatcher asset path")
		}
		tagIndex := 3
		if isDev {
			tagIndex = 4
		}
		tag := strings.TrimSpace(parts[tagIndex])
		if tag == "" {
			return nil, errors.New("download dispatcher asset coordinates are incomplete")
		}
		if isDriver {
			githubRepo = "Syngnat/GoNavi-DriverAgents"
		}
		githubTag = tag
		if isDev {
			githubTag = "dev-latest"
		}
	}
	if githubTag == "" {
		return nil, errors.New("unsupported download dispatcher asset path")
	}
	encodedParts := make([]string, 0, len(parts))
	for _, part := range parts {
		encodedParts = append(encodedParts, url.PathEscape(part))
	}
	relativePath := "/" + strings.Join(encodedParts, "/")
	githubURL := "https://github.com/" + githubRepo + "/releases/download/" + url.PathEscape(githubTag) + "/" + url.PathEscape(asset)
	if githubLatest {
		githubURL = "https://github.com/" + githubRepo + "/releases/latest/download/" + url.PathEscape(asset)
	}
	return []string{
		downloadDMITBaseURL + relativePath,
		downloadBeroBaseURL + relativePath,
		githubURL,
	}, nil
}

func resolveDispatcherDownloadCandidatesFailOpen(client *http.Client, rawURL string) ([]string, error) {
	staticCandidates, staticErr := staticDispatcherDownloadCandidates(rawURL)
	if staticErr == nil {
		// Known app, driver, and mutable index paths have a fixed public source
		// chain. Derive it locally instead of accepting a legacy Dispatcher JSON
		// response whose KV state may contain only GitHub (or be stale).
		return staticCandidates, nil
	}
	candidates, err := resolveDispatcherDownloadCandidates(client, rawURL)
	if err == nil {
		return candidates, nil
	}
	return nil, errors.Join(staticErr, err)
}

type validatedDownloadRange struct {
	start int64
	end   int64
	total int64
}

func parseValidatedContentRange(value string) (validatedDownloadRange, error) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(strings.ToLower(value), "bytes ") {
		return validatedDownloadRange{}, fmt.Errorf("invalid Content-Range %q", value)
	}
	rangeAndTotal := strings.TrimSpace(value[len("bytes "):])
	rangeText, totalText, ok := strings.Cut(rangeAndTotal, "/")
	if !ok || totalText == "*" {
		return validatedDownloadRange{}, fmt.Errorf("invalid Content-Range %q", value)
	}
	startText, endText, ok := strings.Cut(rangeText, "-")
	if !ok {
		return validatedDownloadRange{}, fmt.Errorf("invalid Content-Range %q", value)
	}
	start, startErr := strconv.ParseInt(startText, 10, 64)
	end, endErr := strconv.ParseInt(endText, 10, 64)
	total, totalErr := strconv.ParseInt(totalText, 10, 64)
	if startErr != nil || endErr != nil || totalErr != nil || start < 0 || end < start || total <= end {
		return validatedDownloadRange{}, fmt.Errorf("invalid Content-Range %q", value)
	}
	return validatedDownloadRange{start: start, end: end, total: total}, nil
}

func newDownloadRangeRequest(ctx context.Context, rawURL string, start, end int64) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSpace(rawURL), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	applyGitHubDownloadRequestHeaders(req, isGitHubReleaseAssetAPIURL(rawURL))
	return req, nil
}

func downloadRangeClient(client *http.Client) *http.Client {
	rangeClient := *client
	if transport, ok := client.Transport.(*http.Transport); ok && transport != nil {
		cloned := transport.Clone()
		cloned.ResponseHeaderTimeout = parallelDownloadHeaderTimeout
		rangeClient.Transport = cloned
	}
	return &rangeClient
}

type downloadCandidateProbe struct {
	candidate          string
	resolvedURL        string
	total              int64
	supportsRange      bool
	ttfb               time.Duration
	throughputBytesSec float64
	estimated          time.Duration
	checkedAt          time.Time
	fromCache          bool
}

var downloadCandidateProbeCache = struct {
	sync.Mutex
	entries map[string]downloadCandidateProbe
}{entries: make(map[string]downloadCandidateProbe)}

func measureValidatedDownloadRange(client *http.Client, rawURL string) (downloadCandidateProbe, error) {
	ctx, cancel := context.WithTimeout(context.Background(), downloadCandidateProbeTimeout)
	defer cancel()
	requestEnd := int64(downloadCandidateProbeBytes - 1)
	req, err := newDownloadRangeRequest(ctx, rawURL, 0, requestEnd)
	if err != nil {
		return downloadCandidateProbe{}, err
	}
	started := time.Now()
	resp, err := doUpdateRequest(client, req)
	headersAt := time.Now()
	if err != nil {
		return downloadCandidateProbe{}, err
	}
	defer resp.Body.Close()
	probe := downloadCandidateProbe{
		candidate:   strings.TrimSpace(rawURL),
		resolvedURL: resp.Request.URL.String(),
		ttfb:        headersAt.Sub(started),
		checkedAt:   time.Now(),
	}
	if resp.StatusCode == http.StatusOK {
		probe.total = resp.ContentLength
		return probe, nil
	}
	if resp.StatusCode != http.StatusPartialContent {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return downloadCandidateProbe{}, classifyGitHubUpdateHTTPError(resp.StatusCode, body, resp.Header, false)
	}
	parsed, err := parseValidatedContentRange(resp.Header.Get("Content-Range"))
	expectedEnd := requestEnd
	if err == nil && parsed.total > 0 && expectedEnd >= parsed.total {
		expectedEnd = parsed.total - 1
	}
	expectedLength := expectedEnd + 1
	if err != nil || parsed.start != 0 || parsed.end != expectedEnd || parsed.total <= 0 || resp.ContentLength != expectedLength {
		return downloadCandidateProbe{}, fmt.Errorf("range probe validation failed: content-range=%q content-length=%d", resp.Header.Get("Content-Range"), resp.ContentLength)
	}
	bodyStarted := time.Now()
	probeBody, readErr := io.ReadAll(io.LimitReader(resp.Body, expectedLength+1))
	bodyElapsed := time.Since(bodyStarted)
	if readErr != nil || int64(len(probeBody)) != expectedLength {
		return downloadCandidateProbe{}, fmt.Errorf("range probe body validation failed: expected=%d actual=%d", expectedLength, len(probeBody))
	}
	if bodyElapsed < time.Millisecond {
		bodyElapsed = time.Millisecond
	}
	probe.total = parsed.total
	probe.supportsRange = true
	probe.throughputBytesSec = float64(expectedLength) / bodyElapsed.Seconds()
	estimatedSeconds := probe.ttfb.Seconds() + float64(parsed.total)/probe.throughputBytesSec
	probe.estimated = time.Duration(estimatedSeconds * float64(time.Second))
	return probe, nil
}

func cachedDownloadCandidateProbe(rawURL string, now time.Time) (downloadCandidateProbe, bool) {
	downloadCandidateProbeCache.Lock()
	defer downloadCandidateProbeCache.Unlock()
	probe, ok := downloadCandidateProbeCache.entries[strings.TrimSpace(rawURL)]
	if !ok || now.Sub(probe.checkedAt) >= downloadCandidateCacheTTL {
		if ok {
			delete(downloadCandidateProbeCache.entries, strings.TrimSpace(rawURL))
		}
		return downloadCandidateProbe{}, false
	}
	probe.fromCache = true
	return probe, true
}

func storeDownloadCandidateProbe(probe downloadCandidateProbe) {
	downloadCandidateProbeCache.Lock()
	defer downloadCandidateProbeCache.Unlock()
	probe.fromCache = false
	downloadCandidateProbeCache.entries[probe.candidate] = probe
}

func invalidateDownloadCandidateProbe(rawURL string) {
	downloadCandidateProbeCache.Lock()
	defer downloadCandidateProbeCache.Unlock()
	delete(downloadCandidateProbeCache.entries, strings.TrimSpace(rawURL))
	for key, probe := range downloadCandidateProbeCache.entries {
		if probe.resolvedURL == strings.TrimSpace(rawURL) {
			delete(downloadCandidateProbeCache.entries, key)
		}
	}
}

type downloadCandidateProbeOutcome struct {
	index int
	probe downloadCandidateProbe
	err   error
}

func rankDownloadCandidates(client *http.Client, candidates []string) ([]downloadCandidateProbe, []error) {
	now := time.Now()
	probes := make([]downloadCandidateProbe, len(candidates))
	valid := make([]bool, len(candidates))
	outcomes := make(chan downloadCandidateProbeOutcome, len(candidates))
	pending := 0
	for index, candidate := range candidates {
		if cached, ok := cachedDownloadCandidateProbe(candidate, now); ok {
			probes[index] = cached
			valid[index] = true
			continue
		}
		pending++
		go func(index int, candidate string) {
			probe, err := measureValidatedDownloadRange(client, candidate)
			outcomes <- downloadCandidateProbeOutcome{index: index, probe: probe, err: err}
		}(index, candidate)
	}
	errorsBySource := make([]error, 0, pending)
	for count := 0; count < pending; count++ {
		outcome := <-outcomes
		if outcome.err != nil {
			errorsBySource = append(errorsBySource, fmt.Errorf(
				"download source %s probe failed: %w",
				redactDownloadURL(candidates[outcome.index]), outcome.err,
			))
			continue
		}
		probes[outcome.index] = outcome.probe
		valid[outcome.index] = true
		storeDownloadCandidateProbe(outcome.probe)
	}

	ranked := make([]downloadCandidateProbe, 0, len(candidates))
	for index, probe := range probes {
		if valid[index] {
			ranked = append(ranked, probe)
		}
	}
	return prioritizeDownloadCandidateProbes(ranked), errorsBySource
}

func prioritizeDownloadCandidateProbes(probes []downloadCandidateProbe) []downloadCandidateProbe {
	ranked := append([]downloadCandidateProbe(nil), probes...)
	if len(ranked) < 2 {
		return ranked
	}
	fastest := -1
	for index := range ranked {
		if !ranked[index].supportsRange || ranked[index].estimated <= 0 {
			continue
		}
		if fastest < 0 || ranked[index].estimated < ranked[fastest].estimated {
			fastest = index
		}
	}
	if fastest < 0 {
		return ranked
	}
	selected := fastest
	// The dispatcher's first candidate expresses the request.cf.country bias.
	// Keep it when its expected completion time is within 20% of the fastest.
	if ranked[0].supportsRange && ranked[0].estimated > 0 &&
		float64(ranked[0].estimated) <= float64(ranked[fastest].estimated)*downloadRegionalBiasRatio {
		selected = 0
	}
	first := ranked[selected]
	rest := append([]downloadCandidateProbe(nil), ranked[:selected]...)
	rest = append(rest, ranked[selected+1:]...)
	sort.SliceStable(rest, func(i, j int) bool {
		left, right := rest[i], rest[j]
		if left.supportsRange != right.supportsRange {
			return left.supportsRange
		}
		if !left.supportsRange || left.estimated == right.estimated {
			return false
		}
		return left.estimated < right.estimated
	})
	return append([]downloadCandidateProbe{first}, rest...)
}

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
				if status == http.StatusNotFound || status == http.StatusGone || status == http.StatusConflict {
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
		var localized localizedUpdateError
		if errors.As(outcome.err, &localized) &&
			(localized.httpStatus == http.StatusNotFound || localized.httpStatus == http.StatusGone) {
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
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
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
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	client := newStrictHTTPClientWithGlobalProxy(timeout)
	var candidates []string
	var dispatcherErr error
	if expectedSize > 0 && func() bool {
		_, ok := downloadDispatcherAssetPath(rawURL)
		return ok
	}() {
		// The manifest already authenticates the asset size. Resolve the dispatcher
		// redirect only after the Range path starts, avoiding JSON resolution and a
		// separate 256 KiB probe on the healthy path.
		candidates = []string{strings.TrimSpace(rawURL)}
	} else {
		candidates, dispatcherErr = resolveDispatcherDownloadCandidatesFailOpen(client, rawURL)
		if dispatcherErr != nil {
			// The 302 endpoint remains a compatibility fallback when JSON resolution
			// is temporarily unavailable. It still uses normal TLS.
			candidates = []string{strings.TrimSpace(rawURL)}
		}
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
	// without adding latency to healthy DMIT downloads.
	fallbackCandidates, resolveErr := resolveDispatcherDownloadCandidatesFailOpen(client, candidates[0])
	if resolveErr != nil {
		return result, errors.Join(err, resolveErr)
	}
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
		// otherwise healthy DMIT download at 0%.
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
			return hash, nil
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
