package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDownloadFileWithHashParallelAwareFallsBackWhenRangeIsUnsupported(t *testing.T) {
	payload := bytes.Repeat([]byte("sequential"), 1024)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = writer.Write(payload)
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "driver.zip")
	gotHash, err := downloadFileWithHashFromCandidates(
		&http.Client{Timeout: 30 * time.Second}, []string{server.URL + "/driver.zip"}, target, nil, nil,
	)
	if err != nil {
		t.Fatalf("sequential fallback: %v", err)
	}
	want := sha256.Sum256(payload)
	if gotHash != hex.EncodeToString(want[:]) {
		t.Fatalf("hash mismatch: %s", gotHash)
	}
}

func TestDownloadFileWithHashParallelAwareRejectsInvalidRangeMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Range", "bytes 0-0/999")
		writer.Header().Set("Content-Length", "2")
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write([]byte("xx"))
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "invalid.zip")
	if _, err := downloadFileWithHashFromCandidates(
		&http.Client{Timeout: 5 * time.Second}, []string{server.URL}, target, nil, nil,
	); err == nil {
		t.Fatal("expected invalid range probe to fail")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("invalid range download must not leave final file: %v", err)
	}
}

func TestDownloadFileWithHashParallelAwarePinsRedirectTargetForAllRanges(t *testing.T) {
	payload := bytes.Repeat([]byte("redirect-pinned"), (parallelDownloadMinimumSize/len("redirect-pinned"))+1)
	payload = payload[:parallelDownloadMinimumSize]
	var targetRequests int
	var targetMu sync.Mutex
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		targetMu.Lock()
		targetRequests++
		targetMu.Unlock()
		rawRange := strings.TrimPrefix(request.Header.Get("Range"), "bytes=")
		parts := strings.Split(rawRange, "-")
		start, _ := strconv.ParseInt(parts[0], 10, 64)
		end, _ := strconv.ParseInt(parts[1], 10, 64)
		body := payload[start : end+1]
		writer.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write(body)
	}))
	defer target.Close()
	var dispatcherRequests int
	dispatcher := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		dispatcherRequests++
		http.Redirect(writer, request, target.URL+"/asset.zip", http.StatusFound)
	}))
	defer dispatcher.Close()

	filePath := filepath.Join(t.TempDir(), "asset.zip")
	if _, err := downloadFileWithHashFromCandidates(
		&http.Client{Timeout: 30 * time.Second}, []string{dispatcher.URL + "/resolve"}, filePath, nil, nil,
	); err != nil {
		t.Fatalf("redirected parallel download: %v", err)
	}
	if dispatcherRequests != 1 {
		t.Fatalf("dispatcher must be resolved once per task, got %d requests", dispatcherRequests)
	}
	targetMu.Lock()
	defer targetMu.Unlock()
	if targetRequests != parallelDownloadWorkers+1 {
		t.Fatalf("expected probe plus %d pinned ranges, got %d", parallelDownloadWorkers, targetRequests)
	}
}

func TestDownloadFileWithHashFromCandidatesExpectedSizeFollowsRedirectsWithoutProbe(t *testing.T) {
	payload := bytes.Repeat([]byte("expected-size-redirect"), (parallelDownloadMinimumSize/len("expected-size-redirect"))+1)
	payload = payload[:parallelDownloadMinimumSize]
	var dispatcherRequests atomic.Int32
	var intermediateRequests atomic.Int32
	var targetRequests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		targetRequests.Add(1)
		rawRange := strings.TrimPrefix(request.Header.Get("Range"), "bytes=")
		parts := strings.Split(rawRange, "-")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			http.Error(writer, "missing range", http.StatusBadRequest)
			return
		}
		start, startErr := strconv.ParseInt(parts[0], 10, 64)
		end, endErr := strconv.ParseInt(parts[1], 10, 64)
		if startErr != nil || endErr != nil || start < 0 || end < start || end >= int64(len(payload)) {
			http.Error(writer, "invalid range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		body := payload[start : end+1]
		writer.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write(body)
	}))
	defer target.Close()
	intermediate := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		intermediateRequests.Add(1)
		http.Redirect(writer, request, target.URL+"/asset.zip", http.StatusFound)
	}))
	defer intermediate.Close()
	dispatcher := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		dispatcherRequests.Add(1)
		http.Redirect(writer, request, intermediate.URL+"/release", http.StatusFound)
	}))
	defer dispatcher.Close()

	targetPath := filepath.Join(t.TempDir(), "expected-size-redirect.zip")
	gotHash, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		&http.Client{Timeout: 30 * time.Second},
		[]string{dispatcher.URL + "/resolve"},
		targetPath,
		nil,
		nil,
		int64(len(payload)),
	)
	if err != nil {
		t.Fatalf("expected-size redirected download: %v", err)
	}
	wantHash := sha256.Sum256(payload)
	if gotHash != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("hash mismatch: got %s want %s", gotHash, hex.EncodeToString(wantHash[:]))
	}
	if got := dispatcherRequests.Load(); got != parallelDownloadWorkers {
		t.Fatalf("expected %d dispatcher range requests without an independent probe, got %d", parallelDownloadWorkers, got)
	}
	if got := intermediateRequests.Load(); got != parallelDownloadWorkers {
		t.Fatalf("expected %d intermediate range requests without an independent probe, got %d", parallelDownloadWorkers, got)
	}
	if got := targetRequests.Load(); got != parallelDownloadWorkers {
		t.Fatalf("expected %d target range requests without an independent probe, got %d", parallelDownloadWorkers, got)
	}
}

func TestDownloadFileWithHashFromCandidatesFailsOverWholeTask(t *testing.T) {
	payload := bytes.Repeat([]byte("candidate-failover"), 1024)
	failing := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "unavailable", http.StatusServiceUnavailable)
	}))
	defer failing.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = writer.Write(payload)
	}))
	defer healthy.Close()

	target := filepath.Join(t.TempDir(), "fallback.zip")
	client := &http.Client{Timeout: 30 * time.Second}
	gotHash, err := downloadFileWithHashFromCandidates(
		client,
		[]string{failing.URL + "/asset.zip", healthy.URL + "/asset.zip"},
		target,
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("candidate failover: %v", err)
	}
	wantHashBytes := sha256.Sum256(payload)
	if gotHash != hex.EncodeToString(wantHashBytes[:]) {
		t.Fatalf("hash mismatch after failover: got %s", gotHash)
	}
}

func TestDownloadFileWithHashFromCandidatesUsesFirstHealthyCandidateBeforeFallbackProbe(t *testing.T) {
	payload := bytes.Repeat([]byte("cst-first"), (parallelDownloadMinimumSize/len("cst-first"))+1)
	payload = payload[:parallelDownloadMinimumSize]
	wantHash := sha256.Sum256(payload)

	cst := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		rawRange := strings.TrimPrefix(request.Header.Get("Range"), "bytes=")
		parts := strings.Split(rawRange, "-")
		if len(parts) != 2 {
			http.Error(writer, "bad range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		start, startErr := strconv.ParseInt(parts[0], 10, 64)
		end, endErr := strconv.ParseInt(parts[1], 10, 64)
		if startErr != nil || endErr != nil || start < 0 || end < start || end >= int64(len(payload)) {
			http.Error(writer, "bad range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		body := payload[start : end+1]
		writer.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write(body)
	}))
	defer cst.Close()

	var fallbackRequests atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		fallbackRequests.Add(1)
		http.Error(writer, "fallback should not be probed", http.StatusServiceUnavailable)
	}))
	defer fallback.Close()

	target := filepath.Join(t.TempDir(), "cst-first.zip")
	gotHash, err := downloadFileWithHashFromCandidates(
		&http.Client{Timeout: 30 * time.Second},
		[]string{cst.URL + "/asset.zip", fallback.URL + "/asset.zip"},
		target,
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("download first healthy candidate: %v", err)
	}
	if gotHash != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("hash mismatch: got %s", gotHash)
	}
	if got := fallbackRequests.Load(); got != 0 {
		t.Fatalf("fallback must not be probed after Cst succeeds, got %d requests", got)
	}
}

func TestRangeFailoverKeepsCompletedSegmentsWhenMetadataMatches(t *testing.T) {
	payload := bytes.Repeat([]byte("range-resume"), (parallelDownloadMinimumSize/len("range-resume"))+1)
	payload = payload[:parallelDownloadMinimumSize]
	serveRange := func(writer http.ResponseWriter, request *http.Request) {
		rawRange := strings.TrimPrefix(request.Header.Get("Range"), "bytes=")
		parts := strings.Split(rawRange, "-")
		if len(parts) != 2 {
			http.Error(writer, "bad range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		start, startErr := strconv.ParseInt(parts[0], 10, 64)
		end, endErr := strconv.ParseInt(parts[1], 10, 64)
		if startErr != nil || endErr != nil || start < 0 || end < start || end >= int64(len(payload)) {
			http.Error(writer, "bad range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		body := payload[start : end+1]
		writer.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write(body)
	}
	var secondDataRanges int
	var secondMu sync.Mutex
	second := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		secondMu.Lock()
		secondDataRanges++
		secondMu.Unlock()
		serveRange(writer, request)
	}))
	defer second.Close()

	target := filepath.Join(t.TempDir(), "resumed.zip")
	session, err := newPersistentRangeDownload(target, int64(len(payload)), nil)
	if err != nil {
		t.Fatalf("create range session: %v", err)
	}
	defer session.closeAndRemove()
	precompleted := 3
	for index := 0; index < precompleted; index++ {
		start := int64(index) * session.chunkSize
		end := start + session.chunkSize
		if end > session.total {
			end = session.total
		}
		if _, err := session.file.WriteAt(payload[start:end], start); err != nil {
			t.Fatalf("seed completed range %d: %v", index, err)
		}
		session.completed[index] = true
	}
	client := &http.Client{Timeout: 30 * time.Second}
	complete, err := session.attempt(client, second.URL)
	if err != nil || !complete {
		t.Fatalf("continue range session on second source: complete=%v err=%v", complete, err)
	}
	gotHash, err := session.finish()
	if err != nil {
		t.Fatalf("finish resumed ranges: %v", err)
	}
	wantHash := sha256.Sum256(payload)
	if gotHash != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("hash mismatch after resumed ranges: %s", gotHash)
	}
	secondMu.Lock()
	defer secondMu.Unlock()
	wantSecondRanges := parallelDownloadWorkers - precompleted
	if secondDataRanges != wantSecondRanges {
		t.Fatalf("expected %d unfinished ranges from second source, got %d", wantSecondRanges, secondDataRanges)
	}
}

func TestPrioritizeDownloadCandidateProbesKeepsRegionalCandidateWithinTwentyPercent(t *testing.T) {
	regional := downloadCandidateProbe{candidate: "regional", supportsRange: true, estimated: 12 * time.Second}
	fastest := downloadCandidateProbe{candidate: "fastest", supportsRange: true, estimated: 10 * time.Second}

	ranked := prioritizeDownloadCandidateProbes([]downloadCandidateProbe{regional, fastest})

	if ranked[0].candidate != "regional" {
		t.Fatalf("expected regional candidate within 20%% to remain first, got %q", ranked[0].candidate)
	}
}

func TestPrioritizeDownloadCandidateProbesChoosesMeasuredFastestOutsideBias(t *testing.T) {
	regional := downloadCandidateProbe{candidate: "regional", supportsRange: true, estimated: 13 * time.Second}
	fastest := downloadCandidateProbe{candidate: "fastest", supportsRange: true, estimated: 10 * time.Second}

	ranked := prioritizeDownloadCandidateProbes([]downloadCandidateProbe{regional, fastest})

	if ranked[0].candidate != "fastest" {
		t.Fatalf("expected measured fastest candidate, got %q", ranked[0].candidate)
	}
}

func TestDownloadCandidateProbeCacheExpiresAfterSixHours(t *testing.T) {
	downloadCandidateProbeCache.Lock()
	downloadCandidateProbeCache.entries = make(map[string]downloadCandidateProbe)
	downloadCandidateProbeCache.Unlock()
	probe := downloadCandidateProbe{candidate: "https://edge.example/asset", checkedAt: time.Now()}
	storeDownloadCandidateProbe(probe)

	if _, ok := cachedDownloadCandidateProbe(probe.candidate, probe.checkedAt.Add(downloadCandidateCacheTTL-time.Second)); !ok {
		t.Fatal("expected fresh probe cache entry")
	}
	if _, ok := cachedDownloadCandidateProbe(probe.candidate, probe.checkedAt.Add(downloadCandidateCacheTTL)); ok {
		t.Fatal("expected six-hour-old probe cache entry to expire")
	}
}
