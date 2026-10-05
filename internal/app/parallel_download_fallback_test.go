package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDownloadFileWithHashParallelAwareResolvesGatedDevFallbackAfterNetworkFailure(t *testing.T) {
	payload := []byte("gated dev fallback payload")
	expectedSize := int64(len(payload))
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	assetPath := "/gonavi/dev/releases/download/dev-current/GoNavi.zip"
	gated := downloadDispatcherURLRequiringCurrentDevAsset(downloadDispatcherURLForPath(assetPath))
	cstURL := "https://download.syngnat.top" + assetPath
	beroURL := "https://origin-download.syngnat.top:8443" + assetPath
	githubURL := "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip"

	var requests []string
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			requests = append(requests, request.URL.String())
			response := func(status int, body io.Reader) *http.Response {
				return &http.Response{
					StatusCode: status,
					Header:     make(http.Header),
					Body:       io.NopCloser(body),
					Request:    request,
				}
			}
			switch request.URL.Hostname() {
			case downloadDispatcherHostname:
				query := request.URL.Query()
				if query.Get("require-current") != "1" {
					return response(http.StatusBadRequest, strings.NewReader("missing gated query")), nil
				}
				if query.Get("format") != "json" {
					return response(http.StatusServiceUnavailable, strings.NewReader("gated Dispatcher unavailable")), nil
				}
				return response(http.StatusOK, strings.NewReader(fmt.Sprintf(`{"candidates":[{"source":"cst","url":%q},{"source":"bero","url":%q},{"source":"github","url":%q}]}`, cstURL, beroURL, githubURL))), nil
			case "download.syngnat.top", "origin-download.syngnat.top":
				return response(http.StatusServiceUnavailable, strings.NewReader("Cst/Bero unavailable")), nil
			case "github.com":
				response := response(http.StatusOK, bytes.NewReader(payload))
				response.Header.Set("Content-Length", strconv.FormatInt(expectedSize, 10))
				return response, nil
			default:
				return response(http.StatusNotFound, strings.NewReader("unexpected candidate")), nil
			}
		}),
	}

	target := filepath.Join(t.TempDir(), "GoNavi.zip")
	gotHash, err := downloadFileWithHashParallelAwareAndExpectedSizeWithClient(
		client,
		gated,
		target,
		nil,
		expectedSize,
	)
	if err != nil {
		t.Fatalf("gated dev fallback failed: %v", err)
	}
	if gotHash != expectedHash {
		t.Fatalf("hash = %q, want %q", gotHash, expectedHash)
	}
	gotPayload, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read fallback payload: %v", err)
	}
	if !bytes.Equal(gotPayload, payload) {
		t.Fatalf("fallback payload = %q, want %q", gotPayload, payload)
	}
	if len(requests) != 5 {
		t.Fatalf("request count = %d, want 5 (gated, JSON, Cst, Bero, GitHub): %#v", len(requests), requests)
	}
	if !strings.Contains(requests[0], "require-current=1") || strings.Contains(requests[0], "format=json") {
		t.Fatalf("first request was not the gated asset request: %q", requests[0])
	}
	if !strings.Contains(requests[1], "require-current=1") || !strings.Contains(requests[1], "format=json") {
		t.Fatalf("second request was not the gated JSON fallback request: %q", requests[1])
	}
	if requests[2] != cstURL || requests[3] != beroURL || requests[4] != githubURL {
		t.Fatalf("fallback request order = %#v, want Cst -> Bero -> GitHub", requests[2:])
	}
}

func TestDownloadFileWithHashParallelAwarePreferredBeroKeepsGatedResolverAndReordersCandidates(t *testing.T) {
	payload := []byte("preferred Bero fallback payload")
	expectedSize := int64(len(payload))
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	assetPath := "/gonavi/dev/releases/download/dev-current/GoNavi.zip"
	gated := downloadDispatcherURLRequiringCurrentDevAsset(downloadDispatcherURLForPath(assetPath))
	cstURL := "https://download.syngnat.top" + assetPath
	beroURL := "https://origin-download.syngnat.top:8443" + assetPath
	githubURL := "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip"

	var requests []string
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			requests = append(requests, request.URL.String())
			response := func(status int, body io.Reader) *http.Response {
				return &http.Response{
					StatusCode: status,
					Header:     make(http.Header),
					Body:       io.NopCloser(body),
					Request:    request,
				}
			}
			switch request.URL.Hostname() {
			case downloadDispatcherHostname:
				query := request.URL.Query()
				if query.Get("require-current") != "1" || query.Get("format") != "json" {
					return response(http.StatusBadRequest, strings.NewReader("missing gated resolver query")), nil
				}
				// Return canonical Cst-first data to verify the user preference is applied
				// after the Dispatcher gate resolves the immutable asset.
				return response(http.StatusOK, strings.NewReader(fmt.Sprintf(`{"candidates":[{"source":"cst","url":%q},{"source":"bero","url":%q},{"source":"github","url":%q}]}`, cstURL, beroURL, githubURL))), nil
			case "origin-download.syngnat.top":
				return response(http.StatusServiceUnavailable, strings.NewReader("Bero unavailable")), nil
			case "download.syngnat.top":
				response := response(http.StatusOK, bytes.NewReader(payload))
				response.Header.Set("Content-Length", strconv.FormatInt(expectedSize, 10))
				return response, nil
			default:
				return response(http.StatusNotFound, strings.NewReader("unexpected candidate")), nil
			}
		}),
	}

	target := filepath.Join(t.TempDir(), "GoNavi.zip")
	gotHash, err := downloadFileWithHashParallelAwareAndExpectedSizeWithClientPreferred(
		client,
		gated,
		target,
		nil,
		expectedSize,
		DownloadSourceBero,
	)
	if err != nil {
		t.Fatalf("preferred Bero fallback failed: %v", err)
	}
	if gotHash != expectedHash {
		t.Fatalf("hash = %q, want %q", gotHash, expectedHash)
	}
	if len(requests) != 3 {
		t.Fatalf("request count = %d, want 3 (JSON, Bero, Cst): %#v", len(requests), requests)
	}
	// Query.Encode may place format before require-current; inspect parsed values.
	parsed, parseErr := url.Parse(requests[0])
	if parseErr != nil || parsed.Query().Get("require-current") != "1" || parsed.Query().Get("format") != "json" {
		t.Fatalf("first request was not the gated JSON resolver: %q", requests[0])
	}
	if requests[0] == beroURL || requests[0] == cstURL || requests[0] == githubURL {
		t.Fatalf("preferred download bypassed Dispatcher JSON resolution: %#v", requests)
	}
	if requests[1] != beroURL || requests[2] != cstURL {
		t.Fatalf("preferred fallback request order = %#v, want JSON -> Bero -> Cst", requests)
	}
}

func TestDownloadFileWithHashParallelAwareFallsBackToCstWhenApplicationDispatcherAndJSONAreUnavailable(t *testing.T) {
	payload := []byte("application update package from Cst")
	expectedSize := int64(len(payload))
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	assetPath := "/gonavi/releases/download/v1.2.3/GoNavi.zip"
	dispatcherURL := downloadDispatcherURLForPath(assetPath)
	cstURL := "https://download.syngnat.top" + assetPath

	var requests []string
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			requests = append(requests, request.URL.String())
			switch request.URL.Hostname() {
			case downloadDispatcherHostname:
				return nil, errors.New("Dispatcher unavailable")
			case "download.syngnat.top":
				response := &http.Response{
					StatusCode:    http.StatusOK,
					Header:        make(http.Header),
					Body:          io.NopCloser(bytes.NewReader(payload)),
					Request:       request,
					ContentLength: expectedSize,
				}
				return response, nil
			default:
				return nil, fmt.Errorf("unexpected download host %q", request.URL.Hostname())
			}
		}),
	}

	target := filepath.Join(t.TempDir(), "GoNavi.zip")
	gotHash, err := downloadFileWithHashParallelAwareAndExpectedSizeWithClient(
		client,
		dispatcherURL,
		target,
		nil,
		expectedSize,
	)
	if err != nil {
		t.Fatalf("application package did not fall back to Cst: %v", err)
	}
	if gotHash != expectedHash {
		t.Fatalf("hash = %q, want %q", gotHash, expectedHash)
	}
	gotPayload, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read Cst fallback payload: %v", err)
	}
	if !bytes.Equal(gotPayload, payload) {
		t.Fatalf("fallback payload = %q, want %q", gotPayload, payload)
	}
	if len(requests) != 3 {
		t.Fatalf("request count = %d, want 3 (Dispatcher, JSON, Cst): %#v", len(requests), requests)
	}
	if requests[0] != dispatcherURL || requests[2] != cstURL {
		t.Fatalf("request order = %#v, want Dispatcher -> JSON -> Cst", requests)
	}
	parsedJSON, err := url.Parse(requests[1])
	if err != nil || parsedJSON.Hostname() != downloadDispatcherHostname || parsedJSON.Query().Get("path") != assetPath || parsedJSON.Query().Get("format") != "json" {
		t.Fatalf("second request was not the Dispatcher JSON resolver: %q", requests[1])
	}
}

func TestDownloadFileWithHashParallelAwareFallsBackAfterApplicationCandidateSizeMismatch(t *testing.T) {
	payload := []byte("application update package from Bero")
	wrongPayload := []byte("truncated")
	expectedSize := int64(len(payload))
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	assetPath := "/gonavi/releases/download/v1.2.3/GoNavi.zip"
	dispatcherURL := downloadDispatcherURLForPath(assetPath)
	cstURL := "https://download.syngnat.top" + assetPath
	beroURL := "https://origin-download.syngnat.top:8443" + assetPath

	var requests []string
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			requests = append(requests, request.URL.String())
			switch request.URL.Hostname() {
			case downloadDispatcherHostname:
				return nil, errors.New("Dispatcher unavailable")
			case "download.syngnat.top":
				return &http.Response{
					StatusCode:    http.StatusOK,
					Header:        make(http.Header),
					Body:          io.NopCloser(bytes.NewReader(wrongPayload)),
					Request:       request,
					ContentLength: int64(len(wrongPayload)),
				}, nil
			case "origin-download.syngnat.top":
				return &http.Response{
					StatusCode:    http.StatusOK,
					Header:        make(http.Header),
					Body:          io.NopCloser(bytes.NewReader(payload)),
					Request:       request,
					ContentLength: expectedSize,
				}, nil
			default:
				return nil, fmt.Errorf("unexpected download host %q", request.URL.Hostname())
			}
		}),
	}

	target := filepath.Join(t.TempDir(), "GoNavi.zip")
	gotHash, err := downloadFileWithHashParallelAwareAndExpectedSizeWithClient(
		client,
		dispatcherURL,
		target,
		nil,
		expectedSize,
	)
	if err != nil {
		t.Fatalf("size-mismatched Cst did not fall back to Bero: %v", err)
	}
	if gotHash != expectedHash {
		t.Fatalf("hash = %q, want %q", gotHash, expectedHash)
	}
	if len(requests) != 4 {
		t.Fatalf("request count = %d, want 4 (Dispatcher, JSON, Cst, Bero): %#v", len(requests), requests)
	}
	if requests[0] != dispatcherURL || requests[2] != cstURL || requests[3] != beroURL {
		t.Fatalf("request order = %#v, want Dispatcher -> JSON -> Cst -> Bero", requests)
	}
}

func TestDownloadFileWithHashParallelAwareFallsBackWhenRedirectedCstReturnsNotFound(t *testing.T) {
	payload := []byte("github fallback after redirected cst missing")
	expectedSize := int64(len(payload))
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	assetPath := "/gonavi/dev/releases/download/dev-current/GoNavi.zip"
	gated := downloadDispatcherURLRequiringCurrentDevAsset(downloadDispatcherURLForPath(assetPath))

	var dispatcherRequests atomic.Int32
	var cstRequests atomic.Int32
	var githubRequests atomic.Int32
	dispatcher := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		dispatcherRequests.Add(1)
		if request.URL.Query().Get("format") == "json" {
			writer.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(writer, `{"candidates":[{"source":"cst","url":"https://download.syngnat.top%s"},{"source":"github","url":"https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip"}]}`, assetPath)
			return
		}
		// The test transport rewrites this logical redirect to the Cst test
		// server while retaining the original Dispatcher request metadata.
		http.Redirect(writer, request, "https://download.syngnat.top"+assetPath, http.StatusFound)
	}))
	defer dispatcher.Close()
	cst := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		cstRequests.Add(1)
		http.Error(writer, "asset is absent on Cst", http.StatusNotFound)
	}))
	defer cst.Close()
	github := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		githubRequests.Add(1)
		writer.Header().Set("Content-Length", strconv.FormatInt(expectedSize, 10))
		_, _ = writer.Write(payload)
	}))
	defer github.Close()

	dispatcherTarget, _ := url.Parse(dispatcher.URL)
	cstTarget, _ := url.Parse(cst.URL)
	githubTarget, _ := url.Parse(github.URL)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	client := &http.Client{Timeout: 10 * time.Second, Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		var target *url.URL
		switch request.URL.Hostname() {
		case downloadDispatcherHostname:
			target = dispatcherTarget
		case "download.syngnat.top":
			target = cstTarget
		case "github.com":
			target = githubTarget
		default:
			return nil, fmt.Errorf("unexpected download host %q", request.URL.Hostname())
		}
		forwarded := request.Clone(request.Context())
		rewritten := *request.URL
		rewritten.Scheme = target.Scheme
		rewritten.Host = target.Host
		forwarded.URL = &rewritten
		forwarded.Host = ""
		response, err := transport.RoundTrip(forwarded)
		if response != nil {
			response.Request = request
		}
		return response, err
	})}

	target := filepath.Join(t.TempDir(), "GoNavi.zip")
	gotHash, err := downloadFileWithHashParallelAwareAndExpectedSizeWithClient(client, gated, target, nil, expectedSize)
	if err != nil {
		t.Fatalf("redirected Cst failure did not fall back: %v", err)
	}
	if gotHash != expectedHash {
		t.Fatalf("hash = %q, want %q", gotHash, expectedHash)
	}
	if dispatcherRequests.Load() < 2 {
		t.Fatalf("Dispatcher requests = %d, want gated request plus JSON resolution", dispatcherRequests.Load())
	}
	if cstRequests.Load() == 0 {
		t.Fatal("expected redirected Cst request")
	}
	if githubRequests.Load() == 0 {
		t.Fatal("expected GitHub fallback request")
	}
}

func TestDownloadFileWithHashParallelAwareUsesEightValidatedRanges(t *testing.T) {
	payload := bytes.Repeat([]byte("gonavi-range-test"), (parallelDownloadMinimumSize/len("gonavi-range-test"))+1)
	payload = payload[:parallelDownloadMinimumSize]
	wantHashBytes := sha256.Sum256(payload)
	wantHash := hex.EncodeToString(wantHashBytes[:])

	var mu sync.Mutex
	requested := make(map[string]int)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		rawRange := request.Header.Get("Range")
		if rawRange == "" {
			writer.Header().Set("Content-Length", strconv.Itoa(len(payload)))
			_, _ = writer.Write(payload)
			return
		}
		parts := strings.Split(strings.TrimPrefix(rawRange, "bytes="), "-")
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
		mu.Lock()
		requested[rawRange]++
		mu.Unlock()
		body := payload[start : end+1]
		writer.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write(body)
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "GoNavi.zip")
	gotHash, err := downloadFileWithHashFromCandidates(
		&http.Client{Timeout: 30 * time.Second}, []string{server.URL + "/GoNavi.zip"}, target, nil, nil,
	)
	if err != nil {
		t.Fatalf("parallel download: %v", err)
	}
	if gotHash != wantHash {
		t.Fatalf("hash mismatch: got %s want %s", gotHash, wantHash)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("downloaded payload mismatch")
	}

	mu.Lock()
	defer mu.Unlock()
	probeRange := fmt.Sprintf("bytes=0-%d", downloadCandidateProbeBytes-1)
	if requested[probeRange] != 1 {
		t.Fatalf("expected one range probe, got %d", requested[probeRange])
	}
	delete(requested, probeRange)
	if len(requested) != parallelDownloadWorkers {
		t.Fatalf("expected %d parallel ranges, got %d: %#v", parallelDownloadWorkers, len(requested), requested)
	}
}

func TestDownloadFileWithHashFromCandidatesUsesExpectedSizeWithoutProbe(t *testing.T) {
	payload := bytes.Repeat([]byte("expected-size-range"), (parallelDownloadMinimumSize/len("expected-size-range"))+1)
	payload = payload[:parallelDownloadMinimumSize]
	wantHashBytes := sha256.Sum256(payload)
	wantHash := hex.EncodeToString(wantHashBytes[:])
	var probeHits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		rawRange := request.Header.Get("Range")
		if rawRange == fmt.Sprintf("bytes=0-%d", downloadCandidateProbeBytes-1) {
			probeHits.Add(1)
			http.Error(writer, "standalone probe must not be requested", http.StatusServiceUnavailable)
			return
		}
		parts := strings.Split(strings.TrimPrefix(rawRange, "bytes="), "-")
		if len(parts) != 2 {
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
		writer.Header().Set("Content-Length", strconv.FormatInt(int64(len(body)), 10))
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write(body)
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "expected-size.zip")
	gotHash, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		&http.Client{Timeout: 30 * time.Second},
		[]string{server.URL + "/asset.zip"},
		target,
		nil,
		nil,
		int64(len(payload)),
	)
	if err != nil {
		t.Fatalf("expected-size parallel download: %v", err)
	}
	if gotHash != wantHash {
		t.Fatalf("hash mismatch: got %s want %s", gotHash, wantHash)
	}
	if got := probeHits.Load(); got != 0 {
		t.Fatalf("expected no standalone range probe, got %d", got)
	}
}

func TestDownloadFileWithHashFromCandidatesExpectedSizeFallsBackWhenRangeIsUnsupported(t *testing.T) {
	payload := bytes.Repeat([]byte("expected-size-sequential"), (parallelDownloadMinimumSize/len("expected-size-sequential"))+1)
	payload = payload[:parallelDownloadMinimumSize]
	var rangeRequests atomic.Int32
	var sequentialRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Range") != "" {
			rangeRequests.Add(1)
			writer.WriteHeader(http.StatusOK)
			return
		}
		sequentialRequests.Add(1)
		writer.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = writer.Write(payload)
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "expected-size-sequential.zip")
	gotHash, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		&http.Client{Timeout: 30 * time.Second},
		[]string{server.URL + "/asset.zip"},
		target,
		nil,
		nil,
		int64(len(payload)),
	)
	if err != nil {
		t.Fatalf("expected sequential fallback to succeed: %v", err)
	}
	wantHash := sha256.Sum256(payload)
	if gotHash != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("hash mismatch: got %s want %s", gotHash, hex.EncodeToString(wantHash[:]))
	}
	if got := sequentialRequests.Load(); got != 1 {
		t.Fatalf("expected one sequential fallback request, got %d", got)
	}
	if got := rangeRequests.Load(); got < 1 {
		t.Fatalf("expected range workers to detect unsupported ranges, got %d requests", got)
	}
}

func TestDownloadFileWithHashFromCandidatesExpectedSizePreservesNotFoundStatus(t *testing.T) {
	var rangeRequests atomic.Int32
	var nonRangeRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Range") == "" {
			nonRangeRequests.Add(1)
		} else {
			rangeRequests.Add(1)
		}
		http.NotFound(writer, request)
	}))
	defer server.Close()

	_, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		&http.Client{Timeout: 30 * time.Second},
		[]string{server.URL + "/missing.zip"},
		filepath.Join(t.TempDir(), "missing.zip"),
		nil,
		nil,
		parallelDownloadMinimumSize,
	)
	if err == nil {
		t.Fatal("expected missing expected-size asset to fail")
	}
	if got := rangeRequests.Load(); got == 0 {
		t.Fatal("expected the range workers to request the missing asset")
	}
	if got := nonRangeRequests.Load(); got != 0 {
		t.Fatalf("expected no sequential or probe request, got %d", got)
	}
	var localized localizedUpdateError
	if !errors.As(err, &localized) {
		t.Fatalf("expected typed HTTP error, got %T %v", err, err)
	}
	if localized.httpStatus != http.StatusNotFound {
		t.Fatalf("HTTP status = %d, want %d", localized.httpStatus, http.StatusNotFound)
	}
}

func TestDownloadFileWithHashParallelAwarePreservesGatedBadRequestStatus(t *testing.T) {
	var rangeRequests atomic.Int32
	var jsonRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("format") == "json" {
			jsonRequests.Add(1)
		}
		if request.Header.Get("Range") == "" {
			t.Errorf("expected-size gated download must use a range request")
		}
		rangeRequests.Add(1)
		http.Error(writer, "invalid gated request", http.StatusBadRequest)
	}))
	defer server.Close()
	gated := downloadDispatcherURLRequiringCurrentDevAsset(
		"https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip",
	)

	_, err := downloadFileWithHashParallelAwareAndExpectedSizeWithClient(
		localDispatcherClient(t, server.URL),
		gated,
		filepath.Join(t.TempDir(), "bad-request.zip"),
		nil,
		parallelDownloadMinimumSize,
	)
	if err == nil {
		t.Fatal("expected gated HTTP 400 to fail")
	}
	var localized localizedUpdateError
	if !errors.As(err, &localized) {
		t.Fatalf("expected typed HTTP error, got %T %v", err, err)
	}
	if localized.httpStatus != http.StatusBadRequest {
		t.Fatalf("HTTP status = %d, want %d", localized.httpStatus, http.StatusBadRequest)
	}
	if rangeRequests.Load() == 0 {
		t.Fatal("expected at least one gated range request")
	}
	if jsonRequests.Load() != 0 {
		t.Fatalf("gated HTTP 400 must not trigger JSON fallback, got %d requests", jsonRequests.Load())
	}
}

func TestDownloadFileWithHashFromCandidatesExpectedSizePreservesGatedCurrentAssetMismatch(t *testing.T) {
	var rangeRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != downloadDispatcherPath || request.URL.Query().Get("require-current") != "1" {
			http.Error(writer, "unexpected Dispatcher request", http.StatusBadRequest)
			return
		}
		if request.Header.Get("Range") == "" {
			t.Errorf("expected-size download must not fall back to a sequential request")
		}
		rangeRequests.Add(1)
		http.Error(writer, "current dev asset changed", http.StatusConflict)
	}))
	defer server.Close()
	client := localDispatcherClient(t, server.URL)
	gated := downloadDispatcherURLRequiringCurrentDevAsset(
		"https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip",
	)

	_, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		client,
		[]string{gated},
		filepath.Join(t.TempDir(), "missing.zip"),
		nil,
		nil,
		parallelDownloadMinimumSize,
	)
	if err == nil {
		t.Fatal("expected superseded expected-size asset to fail")
	}
	var mismatch downloadCurrentAssetMismatchError
	if !errors.As(err, &mismatch) {
		t.Fatalf("expected current dev asset mismatch, got %T %v", err, err)
	}
	if got := rangeRequests.Load(); got == 0 {
		t.Fatal("expected at least one gated range request")
	}
}

func TestDownloadFileWithHashFromCandidatesSequentialGatedCurrentAssetMismatch(t *testing.T) {
	var sequentialRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != downloadDispatcherPath || request.URL.Query().Get("require-current") != "1" {
			http.Error(writer, "unexpected Dispatcher request", http.StatusBadRequest)
			return
		}
		if request.Header.Get("Range") != "" {
			t.Errorf("small package must use the sequential request path")
		}
		sequentialRequests.Add(1)
		http.Error(writer, "current dev asset changed", http.StatusConflict)
	}))
	defer server.Close()
	gated := downloadDispatcherURLRequiringCurrentDevAsset(
		"https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip",
	)

	_, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		localDispatcherClient(t, server.URL),
		[]string{gated},
		filepath.Join(t.TempDir(), "superseded-small.zip"),
		nil,
		nil,
		1024,
	)
	if err == nil {
		t.Fatal("expected superseded sequential asset to fail")
	}
	var mismatch downloadCurrentAssetMismatchError
	if !errors.As(err, &mismatch) {
		t.Fatalf("expected current dev asset mismatch, got %T %v", err, err)
	}
	if got := sequentialRequests.Load(); got != 1 {
		t.Fatalf("sequential requests = %d, want 1", got)
	}
}

func TestDownloadFileWithHashFromCandidatesKeepsUngatedConflictAsHTTPError(t *testing.T) {
	var sequentialRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("require-current") != "" {
			http.Error(writer, "ungated request unexpectedly required current asset", http.StatusBadRequest)
			return
		}
		if request.Header.Get("Range") != "" {
			t.Errorf("small package must use the sequential request path")
		}
		sequentialRequests.Add(1)
		http.Error(writer, "ordinary conflict", http.StatusConflict)
	}))
	defer server.Close()
	ungated := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip"

	_, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		localDispatcherClient(t, server.URL),
		[]string{ungated},
		filepath.Join(t.TempDir(), "ordinary-conflict.zip"),
		nil,
		nil,
		1024,
	)
	if err == nil {
		t.Fatal("expected ordinary conflict to fail")
	}
	var mismatch downloadCurrentAssetMismatchError
	if errors.As(err, &mismatch) {
		t.Fatalf("ungated conflict incorrectly became current asset mismatch: %v", err)
	}
	var localized localizedUpdateError
	if !errors.As(err, &localized) {
		t.Fatalf("expected typed HTTP error, got %T %v", err, err)
	}
	if localized.httpStatus != http.StatusConflict {
		t.Fatalf("HTTP status = %d, want %d", localized.httpStatus, http.StatusConflict)
	}
	if got := sequentialRequests.Load(); got != 1 {
		t.Fatalf("sequential requests = %d, want 1", got)
	}
}
