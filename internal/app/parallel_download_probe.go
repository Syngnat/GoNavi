package app

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

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
	if transport := cloneTransportWithResponseHeaderTimeout(client.Transport, parallelDownloadHeaderTimeout); transport != nil {
		rangeClient.Transport = transport
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
