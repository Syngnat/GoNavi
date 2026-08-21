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
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func localDispatcherClient(t *testing.T, serverURL string) *http.Client {
	t.Helper()
	target, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse local Dispatcher server URL: %v", err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &http.Client{Timeout: 30 * time.Second, Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Hostname() != downloadDispatcherHostname {
			return nil, fmt.Errorf("unexpected Dispatcher request host %q", request.URL.Hostname())
		}
		forwarded := request.Clone(request.Context())
		rewrittenURL := *request.URL
		rewrittenURL.Scheme = target.Scheme
		rewrittenURL.Host = target.Host
		forwarded.URL = &rewrittenURL
		forwarded.Host = ""
		return transport.RoundTrip(forwarded)
	})}
}

func TestParseValidatedContentRange(t *testing.T) {
	parsed, err := parseValidatedContentRange("bytes 10-19/100")
	if err != nil {
		t.Fatalf("parse valid content range: %v", err)
	}
	if parsed.start != 10 || parsed.end != 19 || parsed.total != 100 {
		t.Fatalf("unexpected parsed range: %#v", parsed)
	}
	for _, value := range []string{"", "bytes */100", "bytes 20-10/100", "items 0-1/2", "bytes 0-2/2"} {
		if _, err := parseValidatedContentRange(value); err == nil {
			t.Fatalf("expected invalid content range %q to fail", value)
		}
	}
}

func TestValidatedHTTPSDownloadCandidatesAcceptsPublicIPTLSURL(t *testing.T) {
	got := validatedHTTPSDownloadCandidates(dispatcherDownloadResponse{Candidates: []dispatcherDownloadCandidate{
		{Source: "public-ip", URL: "https://192.0.2.1/gonavi/releases/download/v1/GoNavi.zip"},
		{Source: "plaintext", URL: "http://192.0.2.1/gonavi/releases/download/v1/GoNavi.zip"},
		{Source: "credentials", URL: "https://user:secret@example.com/file"},
		{Source: "duplicate", URL: "https://192.0.2.1/gonavi/releases/download/v1/GoNavi.zip"},
	}})
	want := []string{"https://192.0.2.1/gonavi/releases/download/v1/GoNavi.zip"}
	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("unexpected validated candidates: %#v", got)
	}
}

func TestDevDispatcherURLIsRecognizedWithoutCurrentQuery(t *testing.T) {
	devAsset := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi-dev-abc1234-Windows-Amd64-Portable.zip"
	parsed, err := url.Parse(devAsset)
	if err != nil {
		t.Fatalf("parse dev URL: %v", err)
	}
	if parsed.Query().Get("require-current") != "" {
		t.Fatalf("dev URL unexpectedly carries current-gating query: %q", parsed.String())
	}
	if !isDevDispatcherAssetURL(devAsset) {
		t.Fatal("dev Dispatcher asset was not recognized")
	}

	stableAsset := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Freleases%2Fdownload%2Fv1.2.3%2FGoNavi-1.2.3-Windows-Amd64-Portable.zip"
	if isDevDispatcherAssetURL(stableAsset) {
		t.Fatalf("stable URL incorrectly recognized as dev asset: %q", stableAsset)
	}
}

func TestDownloadRangeClientSetsResponseHeaderTimeoutForStandardTransport(t *testing.T) {
	client := &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone()}
	rangeClient := downloadRangeClient(client)
	if rangeClient == client {
		t.Fatal("expected a distinct range client")
	}
	transport, ok := rangeClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("range transport = %T, want *http.Transport", rangeClient.Transport)
	}
	if transport.ResponseHeaderTimeout != parallelDownloadHeaderTimeout {
		t.Fatalf("header timeout = %s, want %s", transport.ResponseHeaderTimeout, parallelDownloadHeaderTimeout)
	}
}

func TestShouldResolveDispatcherFallbackAllowsDevAsset(t *testing.T) {
	dev := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip"
	if !shouldResolveDispatcherFallback(dev, parallelDownloadMinimumSize, errors.New("DMIT unavailable")) {
		t.Fatal("dev asset must resolve JSON fallback candidates")
	}

	stable := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Freleases%2Fdownload%2Fv1.2.3%2FGoNavi.zip"
	if !shouldResolveDispatcherFallback(stable, parallelDownloadMinimumSize, errors.New("DMIT unavailable")) {
		t.Fatal("stable dispatcher asset should retain JSON fallback candidates")
	}
}

func TestStaticDispatcherDownloadCandidatesKeepFixedMirrorOrder(t *testing.T) {
	cases := []struct {
		name string
		path string
		want []string
	}{
		{
			name: "stable app",
			path: "/gonavi/releases/download/v1.2.3/GoNavi-Windows.zip",
			want: []string{
				"https://download.syngnat.top/gonavi/releases/download/v1.2.3/GoNavi-Windows.zip",
				"https://origin-download.syngnat.top:8443/gonavi/releases/download/v1.2.3/GoNavi-Windows.zip",
				"https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi-Windows.zip",
			},
		},
		{
			name: "development driver",
			path: "/drivers/dev/releases/download/dev-a1b2c3/pg-driver-agent.zip",
			want: []string{
				"https://download.syngnat.top/drivers/dev/releases/download/dev-a1b2c3/pg-driver-agent.zip",
				"https://origin-download.syngnat.top:8443/drivers/dev/releases/download/dev-a1b2c3/pg-driver-agent.zip",
				"https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/pg-driver-agent.zip",
			},
		},
		{
			name: "stable app manifest",
			path: "/gonavi/releases/latest/latest.json",
			want: []string{
				"https://download.syngnat.top/gonavi/releases/latest/latest.json",
				"https://origin-download.syngnat.top:8443/gonavi/releases/latest/latest.json",
				"https://github.com/Syngnat/GoNavi/releases/latest/download/latest.json",
			},
		},
		{
			name: "development app manifest",
			path: "/gonavi/dev/releases/latest/latest-dev.json",
			want: []string{
				"https://download.syngnat.top/gonavi/dev/releases/latest/latest-dev.json",
				"https://origin-download.syngnat.top:8443/gonavi/dev/releases/latest/latest-dev.json",
				"https://github.com/Syngnat/GoNavi/releases/download/dev-latest/latest-dev.json",
			},
		},
		{
			name: "stable driver index",
			path: "/drivers/releases/latest/GoNavi-DriverAgents-Index.json",
			want: []string{
				"https://download.syngnat.top/drivers/releases/latest/GoNavi-DriverAgents-Index.json",
				"https://origin-download.syngnat.top:8443/drivers/releases/latest/GoNavi-DriverAgents-Index.json",
				"https://github.com/Syngnat/GoNavi-DriverAgents/releases/latest/download/GoNavi-DriverAgents-Index.json",
			},
		},
		{
			name: "development driver index",
			path: "/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json",
			want: []string{
				"https://download.syngnat.top/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json",
				"https://origin-download.syngnat.top:8443/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json",
				"https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/GoNavi-DriverAgents-Index.json",
			},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := staticDispatcherDownloadCandidates(downloadDispatcherURLForPath(test.path))
			if err != nil {
				t.Fatalf("static Dispatcher candidates: %v", err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("static Dispatcher candidates = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestKnownDispatcherPathUsesStaticCandidatesWithoutControlPlane(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		// This is the response an older Worker can produce when its KV control
		// state is empty. It must not influence the local fixed source chain.
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"candidates":[{"source":"github","url":"https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi-Windows.zip"}]}`)
	}))
	defer server.Close()
	client := localDispatcherClient(t, server.URL)
	rawURL := downloadDispatcherURLForPath("/gonavi/releases/download/v1.2.3/GoNavi-Windows.zip")
	candidates, err := resolveDispatcherDownloadCandidatesFailOpen(client, rawURL)
	if err != nil {
		t.Fatalf("resolve static Dispatcher candidates: %v", err)
	}
	want, err := staticDispatcherDownloadCandidates(rawURL)
	if err != nil {
		t.Fatalf("static Dispatcher candidates: %v", err)
	}
	if !reflect.DeepEqual(candidates, want) {
		t.Fatalf("static candidates = %#v, want %#v", candidates, want)
	}
	if requests.Load() != 0 {
		t.Fatalf("known Dispatcher path performed %d control-plane requests", requests.Load())
	}
}

func TestDispatcherFailureResolvesAndTriesBeroThenGitHubCandidates(t *testing.T) {
	payload := []byte("fallback candidate payload")
	expectedSize := int64(len(payload))
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	dev := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip"

	var requestsMu sync.Mutex
	requests := make(map[string]int)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestsMu.Lock()
		switch request.URL.Path {
		case downloadDispatcherPath:
			requests["dispatcher"]++
		case "/dmit/asset.zip":
			requests["dmit"]++
		case "/bero/asset.zip":
			requests["bero"]++
		case "/github/asset.zip":
			requests["github"]++
		}
		requestsMu.Unlock()

		switch request.URL.Path {
		case downloadDispatcherPath:
			if request.URL.Query().Get("format") != "json" {
				http.Error(writer, "DMIT unavailable", http.StatusServiceUnavailable)
				return
			}
			if request.URL.Query().Get("require-current") != "" {
				http.Error(writer, "legacy current-gating query must be absent", http.StatusBadRequest)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"candidates":[`+
				`{"source":"dmit","url":"https://dmit.test/dmit/asset.zip"},`+
				`{"source":"bero","url":"https://bero.test/bero/asset.zip"},`+
				`{"source":"github","url":"https://github.test/github/asset.zip"}`+
				`]}`)
		case "/dmit/asset.zip", "/bero/asset.zip":
			http.Error(writer, "edge unavailable", http.StatusServiceUnavailable)
		case "/github/asset.zip":
			if request.Header.Get("Range") != "" {
				t.Fatalf("small fallback candidate unexpectedly used a range request: %q", request.Header.Get("Range"))
			}
			writer.Header().Set("Content-Length", strconv.FormatInt(expectedSize, 10))
			_, _ = writer.Write(payload)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse local candidate server URL: %v", err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			forwarded := request.Clone(request.Context())
			rewritten := *request.URL
			rewritten.Scheme = target.Scheme
			rewritten.Host = target.Host
			forwarded.URL = &rewritten
			forwarded.Host = ""
			return transport.RoundTrip(forwarded)
		}),
	}

	targetPath := filepath.Join(t.TempDir(), "fallback.zip")
	_, firstErr := downloadFileWithHashFromCandidatesWithExpectedSize(
		client,
		[]string{dev},
		targetPath,
		nil,
		nil,
		expectedSize,
	)
	if firstErr == nil {
		t.Fatal("expected the initial DMIT Dispatcher request to fail")
	}
	if !shouldResolveDispatcherFallback(dev, expectedSize, firstErr) {
		t.Fatalf("Dispatcher failure must resolve JSON fallback candidates: %v", firstErr)
	}

	candidates, err := resolveDispatcherDownloadCandidates(client, dev)
	if err != nil {
		t.Fatalf("resolve Dispatcher candidates: %v", err)
	}
	wantCandidates := []string{
		"https://dmit.test/dmit/asset.zip",
		"https://bero.test/bero/asset.zip",
		"https://github.test/github/asset.zip",
	}
	if !reflect.DeepEqual(candidates, wantCandidates) {
		t.Fatalf("resolved candidates = %#v, want %#v", candidates, wantCandidates)
	}

	gotHash, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		client,
		candidates,
		targetPath,
		nil,
		firstErr,
		expectedSize,
	)
	if err != nil {
		t.Fatalf("fallback candidates download: %v", err)
	}
	if gotHash != expectedHash {
		t.Fatalf("fallback hash = %q, want %q", gotHash, expectedHash)
	}
	requestsMu.Lock()
	defer requestsMu.Unlock()
	if requests["dispatcher"] != 2 {
		t.Fatalf("Dispatcher requests = %d, want initial 302 path plus JSON resolution", requests["dispatcher"])
	}
	if requests["dmit"] != 1 || requests["bero"] != 1 || requests["github"] != 1 {
		t.Fatalf("candidate requests = %#v, want one DMIT, Bero, and GitHub attempt", requests)
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

func TestDownloadFileWithHashFromCandidatesExpectedSizeKeepsConflictAsHTTPError(t *testing.T) {
	var rangeRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != downloadDispatcherPath || request.URL.Query().Get("require-current") != "" {
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
	dev := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip"

	_, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		client,
		[]string{dev},
		filepath.Join(t.TempDir(), "missing.zip"),
		nil,
		nil,
		parallelDownloadMinimumSize,
	)
	if err == nil {
		t.Fatal("expected superseded expected-size asset to fail")
	}
	var localized localizedUpdateError
	if !errors.As(err, &localized) || localized.httpStatus != http.StatusConflict {
		t.Fatalf("expected HTTP conflict, got %T %v", err, err)
	}
	if got := rangeRequests.Load(); got == 0 {
		t.Fatal("expected at least one range request")
	}
}

func TestDownloadFileWithHashFromCandidatesSequentialConflictAsHTTPError(t *testing.T) {
	var sequentialRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != downloadDispatcherPath || request.URL.Query().Get("require-current") != "" {
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
	dev := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip"

	_, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		localDispatcherClient(t, server.URL),
		[]string{dev},
		filepath.Join(t.TempDir(), "superseded-small.zip"),
		nil,
		nil,
		1024,
	)
	if err == nil {
		t.Fatal("expected superseded sequential asset to fail")
	}
	var localized localizedUpdateError
	if !errors.As(err, &localized) || localized.httpStatus != http.StatusConflict {
		t.Fatalf("expected HTTP conflict, got %T %v", err, err)
	}
	if got := sequentialRequests.Load(); got != 1 {
		t.Fatalf("sequential requests = %d, want 1", got)
	}
}

func TestDownloadFileWithHashFromCandidatesKeepsConflictAsHTTPError(t *testing.T) {
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
	dev := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip"

	_, err := downloadFileWithHashFromCandidatesWithExpectedSize(
		localDispatcherClient(t, server.URL),
		[]string{dev},
		filepath.Join(t.TempDir(), "ordinary-conflict.zip"),
		nil,
		nil,
		1024,
	)
	if err == nil {
		t.Fatal("expected ordinary conflict to fail")
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
	payload := bytes.Repeat([]byte("dmit-first"), (parallelDownloadMinimumSize/len("dmit-first"))+1)
	payload = payload[:parallelDownloadMinimumSize]
	wantHash := sha256.Sum256(payload)

	dmit := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
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
	defer dmit.Close()

	var fallbackRequests atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		fallbackRequests.Add(1)
		http.Error(writer, "fallback should not be probed", http.StatusServiceUnavailable)
	}))
	defer fallback.Close()

	target := filepath.Join(t.TempDir(), "dmit-first.zip")
	gotHash, err := downloadFileWithHashFromCandidates(
		&http.Client{Timeout: 30 * time.Second},
		[]string{dmit.URL + "/asset.zip", fallback.URL + "/asset.zip"},
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
		t.Fatalf("fallback must not be probed after DMIT succeeds, got %d requests", got)
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
