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
	downloadCstBaseURL            = "https://download.syngnat.top"
	downloadBeroBaseURL           = "https://origin-download.syngnat.top:8443"
)

var errParallelRangeUnsupported = errors.New("download source does not support validated byte ranges")
var errNotImmutableDriverDispatcherAsset = errors.New("not an immutable driver dispatcher asset")
var errNotStaticDispatcherAsset = errors.New("not a static dispatcher asset")
var errInvalidDownloadDispatcherURL = errors.New("invalid download dispatcher URL")

type downloadCurrentAssetMismatchError struct{}

func (downloadCurrentAssetMismatchError) Error() string {
	return "download dispatcher reports that the dev asset is no longer current"
}

// downloadCurrentAssetTerminalError marks an HTTP status returned by the
// Dispatcher itself for a gated dev asset. A Dispatcher 404/410 means that the
// immutable tag is stale and should refresh the manifest; the same status from
// a redirected Cst/Bero origin is an ordinary source failure and must continue
// through the fallback chain.
type downloadCurrentAssetTerminalError struct {
	cause error
}

func (e downloadCurrentAssetTerminalError) Error() string {
	if e.cause == nil {
		return "download dispatcher reports that the dev asset is unavailable"
	}
	return e.cause.Error()
}

func (e downloadCurrentAssetTerminalError) Unwrap() error {
	return e.cause
}

func responseIsFromDownloadDispatcher(response *http.Response) bool {
	if response == nil || response.Request == nil || response.Request.URL == nil {
		// A custom RoundTripper may omit Request. Treat the response as direct so
		// malformed or test transports cannot accidentally bypass the stale-asset
		// protection.
		return true
	}
	return strings.EqualFold(response.Request.URL.Hostname(), downloadDispatcherHostname)
}

func gatedDispatcherResponse(rawURL string, response *http.Response) bool {
	return dispatcherURLRequiresCurrentDevAsset(rawURL) && responseIsFromDownloadDispatcher(response)
}

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

func parseDownloadDispatcherAssetPath(rawURL string) (string, bool, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed == nil || !strings.EqualFold(parsed.Hostname(), downloadDispatcherHostname) {
		return "", false, nil
	}
	if !strings.EqualFold(parsed.Scheme, "https") || parsed.User != nil || parsed.Port() != "" ||
		parsed.EscapedPath() != downloadDispatcherPath || parsed.Fragment != "" {
		return "", true, fmt.Errorf("%w: invalid endpoint", errInvalidDownloadDispatcherURL)
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return "", true, fmt.Errorf("%w: invalid query", errInvalidDownloadDispatcherURL)
	}
	pathValues := query["path"]
	if len(pathValues) != 1 {
		return "", true, fmt.Errorf("%w: exactly one path parameter is required", errInvalidDownloadDispatcherURL)
	}
	assetPath := strings.TrimSpace(pathValues[0])
	if err := validateDownloadDispatcherAssetPath(assetPath); err != nil {
		return "", true, err
	}
	return assetPath, true, nil
}

func validateDownloadDispatcherAssetPath(assetPath string) error {
	if !strings.HasPrefix(assetPath, "/") || strings.HasPrefix(assetPath, "//") || strings.HasSuffix(assetPath, "/") ||
		strings.Contains(assetPath, "%") || strings.Contains(assetPath, "\\") || strings.ContainsRune(assetPath, '\x00') {
		return fmt.Errorf("%w: invalid asset path", errInvalidDownloadDispatcherURL)
	}
	parts := strings.Split(strings.TrimPrefix(assetPath, "/"), "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("%w: invalid asset path segment", errInvalidDownloadDispatcherURL)
		}
	}
	isMutable := assetPath == "/gonavi/releases/latest/latest.json" ||
		assetPath == "/gonavi/dev/releases/latest/latest-dev.json" ||
		assetPath == "/drivers/releases/latest/GoNavi-DriverAgents-Index.json" ||
		assetPath == "/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json"
	isStableImmutable := len(parts) == 5 && (parts[0] == "gonavi" || parts[0] == "drivers") &&
		parts[1] == "releases" && parts[2] == "download"
	isDevImmutable := len(parts) == 6 && (parts[0] == "gonavi" || parts[0] == "drivers") &&
		parts[1] == "dev" && parts[2] == "releases" && parts[3] == "download"
	if !isMutable && !isStableImmutable && !isDevImmutable {
		return fmt.Errorf("%w: unsupported asset path", errInvalidDownloadDispatcherURL)
	}
	return nil
}

func downloadDispatcherAssetPath(rawURL string) (string, bool) {
	assetPath, recognized, err := parseDownloadDispatcherAssetPath(rawURL)
	return assetPath, recognized && err == nil
}

// staticDriverDispatcherDownloadCandidates derives the immutable driver data
// plane locally. Driver release URLs already contain the exact tag and asset,
// so stale Dispatcher health/KV state must not collapse the fallback chain to
// GitHub only.
func staticDispatcherDownloadCandidates(rawURL string) ([]string, error) {
	assetPath, recognized, err := parseDownloadDispatcherAssetPath(rawURL)
	if !recognized {
		return nil, errNotStaticDispatcherAsset
	}
	if err != nil {
		return nil, err
	}
	var relativePath string
	var githubURL string
	switch assetPath {
	case "/gonavi/releases/latest/latest.json":
		relativePath = assetPath
		githubURL = "https://github.com/Syngnat/GoNavi/releases/latest/download/latest.json"
	case "/gonavi/dev/releases/latest/latest-dev.json":
		relativePath = assetPath
		githubURL = "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/latest-dev.json"
	case "/drivers/releases/latest/GoNavi-DriverAgents-Index.json":
		relativePath = assetPath
		githubURL = "https://github.com/Syngnat/GoNavi-DriverAgents/releases/latest/download/GoNavi-DriverAgents-Index.json"
	case "/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json":
		relativePath = assetPath
		githubURL = "https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/GoNavi-DriverAgents-Index.json"
	default:
		parts := strings.Split(strings.TrimPrefix(assetPath, "/"), "/")
		isDriver := parts[0] == "drivers"
		isDev := len(parts) == 6 && parts[1] == "dev" && parts[2] == "releases" && parts[3] == "download"
		isStable := len(parts) == 5 && parts[1] == "releases" && parts[2] == "download"
		if (!isDev && !isStable) || (!isDriver && parts[0] != "gonavi") {
			return nil, errNotStaticDispatcherAsset
		}
		tagIndex := 3
		githubTag := parts[tagIndex]
		if isDev {
			tagIndex = 4
			githubTag = "dev-latest"
		}
		assetName := parts[len(parts)-1]
		relativeParts := make([]string, 0, len(parts))
		for _, part := range parts {
			relativeParts = append(relativeParts, url.PathEscape(part))
		}
		relativePath = "/" + strings.Join(relativeParts, "/")
		repository := "Syngnat/GoNavi"
		if isDriver {
			repository = "Syngnat/GoNavi-DriverAgents"
		}
		githubURL = "https://github.com/" + repository + "/releases/download/" +
			url.PathEscape(githubTag) + "/" + url.PathEscape(assetName)
	}
	return []string{
		downloadCstBaseURL + relativePath,
		downloadBeroBaseURL + relativePath,
		githubURL,
	}, nil
}

func staticDriverDispatcherDownloadCandidates(rawURL string) ([]string, error) {
	assetPath, recognized, err := parseDownloadDispatcherAssetPath(rawURL)
	if !recognized {
		return nil, errNotImmutableDriverDispatcherAsset
	}
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.TrimPrefix(assetPath, "/"), "/")
	isDev := len(parts) == 6 && parts[0] == "drivers" && parts[1] == "dev" && parts[2] == "releases" && parts[3] == "download"
	isStable := len(parts) == 5 && parts[0] == "drivers" && parts[1] == "releases" && parts[2] == "download"
	if !isDev && !isStable {
		return nil, errNotImmutableDriverDispatcherAsset
	}
	return staticDispatcherDownloadCandidates(rawURL)
}

func downloadDispatcherURLRequiringCurrentDevAsset(rawURL string) string {
	assetPath, ok := downloadDispatcherAssetPath(rawURL)
	if !ok || !strings.HasPrefix(assetPath, "/gonavi/dev/releases/download/") {
		return strings.TrimSpace(rawURL)
	}
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return strings.TrimSpace(rawURL)
	}
	query := parsed.Query()
	query.Set("require-current", "1")
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func dispatcherURLRequiresCurrentDevAsset(rawURL string) bool {
	assetPath, ok := downloadDispatcherAssetPath(rawURL)
	if !ok || !strings.HasPrefix(assetPath, "/gonavi/dev/releases/download/") {
		return false
	}
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	return err == nil && parsed.Query().Get("require-current") == "1"
}

func isCurrentDevAssetTerminalError(downloadErr error) bool {
	if downloadErr == nil {
		return false
	}
	if errors.Is(downloadErr, errInvalidDownloadDispatcherURL) {
		return true
	}
	var terminal downloadCurrentAssetTerminalError
	if errors.As(downloadErr, &terminal) {
		return true
	}
	var currentAssetMismatch downloadCurrentAssetMismatchError
	if errors.As(downloadErr, &currentAssetMismatch) {
		return true
	}
	return false
}

func isCurrentAssetTerminalHTTPStatus(status int) bool {
	return status == http.StatusConflict || status == http.StatusNotFound || status == http.StatusGone
}

// markGatedDispatcherTerminalError preserves the current-asset gate when the
// resolver itself answers with an identity status. Errors from redirected
// origins are classified at the response boundary and remain ordinary
// candidate failures so the caller can continue through Cst/Bero/GitHub.
func markGatedDispatcherTerminalError(rawURL string, downloadErr error) (error, bool) {
	if downloadErr == nil || !dispatcherURLRequiresCurrentDevAsset(rawURL) {
		return downloadErr, false
	}
	var terminal downloadCurrentAssetTerminalError
	if errors.As(downloadErr, &terminal) {
		return downloadErr, true
	}
	var localized localizedUpdateError
	if errors.As(downloadErr, &localized) && isCurrentAssetTerminalHTTPStatus(localized.httpStatus) {
		return downloadCurrentAssetTerminalError{cause: downloadErr}, true
	}
	return downloadErr, false
}

func shouldResolveDispatcherFallback(rawURL string, expectedSize int64, downloadErr error) bool {
	if expectedSize <= 0 {
		return false
	}
	if isCurrentDevAssetTerminalError(downloadErr) {
		// A missing or gone gated asset is an identity failure, not a source
		// outage. Keep the existing manifest-refresh path for those responses.
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
	_, recognized, parseErr := parseDownloadDispatcherAssetPath(rawURL)
	if !recognized {
		return []string{strings.TrimSpace(rawURL)}, nil
	}
	if parseErr != nil {
		return nil, parseErr
	}
	if candidates, err := staticDriverDispatcherDownloadCandidates(rawURL); err == nil {
		return candidates, nil
	} else if !errors.Is(err, errNotImmutableDriverDispatcherAsset) {
		return nil, err
	}
	staticFallback := func(primaryErr error, response *http.Response) ([]string, error) {
		// A gated dev 409/404/410 is an asset-identity signal. Do not bypass it
		// with a locally derived URL; the caller must refresh the manifest first.
		// A response that followed the Dispatcher redirect belongs to the mirror,
		// not to the Dispatcher itself, so its 404/410 must remain an ordinary
		// candidate failure. Network errors have no response and are attributed to
		// the logical Dispatcher request.
		markedErr := primaryErr
		if response == nil || gatedDispatcherResponse(rawURL, response) {
			var terminal bool
			markedErr, terminal = markGatedDispatcherTerminalError(rawURL, primaryErr)
			if terminal {
				return nil, markedErr
			}
		}
		if candidates, staticErr := staticDispatcherDownloadCandidates(rawURL); staticErr == nil {
			return candidates, nil
		}
		return nil, markedErr
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
		return staticFallback(err, nil)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, downloadDispatcherMaxResponse))
		return staticFallback(classifyGitHubUpdateHTTPError(resp.StatusCode, body, resp.Header, false), resp)
	}
	var value dispatcherDownloadResponse
	decoder := json.NewDecoder(io.LimitReader(resp.Body, downloadDispatcherMaxResponse))
	if err := decoder.Decode(&value); err != nil {
		return staticFallback(fmt.Errorf("decode download dispatcher response: %w", err), resp)
	}
	candidates := validatedHTTPSDownloadCandidates(value)
	if len(candidates) == 0 {
		return staticFallback(errors.New("download dispatcher returned no valid HTTPS candidates"), resp)
	}
	return candidates, nil
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
