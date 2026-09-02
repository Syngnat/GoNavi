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
		response, err := transport.RoundTrip(forwarded)
		if response != nil {
			// Preserve the logical Dispatcher URL for source-aware status handling;
			// the forwarding target is only an in-process test implementation.
			response.Request = request
		}
		return response, err
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

func TestStaticDriverDispatcherDownloadCandidatesMapsStableAndDev(t *testing.T) {
	tests := []struct {
		name      string
		assetPath string
		want      []string
	}{
		{
			name:      "stable",
			assetPath: "/drivers/releases/download/v1.9.6/sqlserver-driver-agent-darwin-arm64.zip",
			want: []string{
				"https://download.syngnat.top/drivers/releases/download/v1.9.6/sqlserver-driver-agent-darwin-arm64.zip",
				"https://origin-download.syngnat.top:8443/drivers/releases/download/v1.9.6/sqlserver-driver-agent-darwin-arm64.zip",
				"https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/v1.9.6/sqlserver-driver-agent-darwin-arm64.zip",
			},
		},
		{
			name:      "dev",
			assetPath: "/drivers/dev/releases/download/dev-5b7ef3c/sqlserver-driver-agent-darwin-arm64.zip",
			want: []string{
				"https://download.syngnat.top/drivers/dev/releases/download/dev-5b7ef3c/sqlserver-driver-agent-darwin-arm64.zip",
				"https://origin-download.syngnat.top:8443/drivers/dev/releases/download/dev-5b7ef3c/sqlserver-driver-agent-darwin-arm64.zip",
				"https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/sqlserver-driver-agent-darwin-arm64.zip",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := staticDriverDispatcherDownloadCandidates(downloadDispatcherURLForPath(test.assetPath))
			if err != nil {
				t.Fatalf("resolve static driver candidates: %v", err)
			}
			if len(got) != len(test.want) {
				t.Fatalf("candidate count = %d, want %d: %#v", len(got), len(test.want), got)
			}
			for index := range test.want {
				if got[index] != test.want[index] {
					t.Fatalf("candidate %d = %q, want %q", index, got[index], test.want[index])
				}
			}
		})
	}
}

func TestStaticDispatcherDownloadCandidatesMapsApplicationAssets(t *testing.T) {
	tests := []struct {
		name      string
		assetPath string
		want      []string
	}{
		{
			name:      "latest manifest",
			assetPath: "/gonavi/releases/latest/latest.json",
			want: []string{
				"https://download.syngnat.top/gonavi/releases/latest/latest.json",
				"https://origin-download.syngnat.top:8443/gonavi/releases/latest/latest.json",
				"https://github.com/Syngnat/GoNavi/releases/latest/download/latest.json",
			},
		},
		{
			name:      "dev latest manifest",
			assetPath: "/gonavi/dev/releases/latest/latest-dev.json",
			want: []string{
				"https://download.syngnat.top/gonavi/dev/releases/latest/latest-dev.json",
				"https://origin-download.syngnat.top:8443/gonavi/dev/releases/latest/latest-dev.json",
				"https://github.com/Syngnat/GoNavi/releases/download/dev-latest/latest-dev.json",
			},
		},
		{
			name:      "stable package",
			assetPath: "/gonavi/releases/download/v1.2.3/GoNavi-1.2.3.zip",
			want: []string{
				"https://download.syngnat.top/gonavi/releases/download/v1.2.3/GoNavi-1.2.3.zip",
				"https://origin-download.syngnat.top:8443/gonavi/releases/download/v1.2.3/GoNavi-1.2.3.zip",
				"https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi-1.2.3.zip",
			},
		},
		{
			name:      "dev package",
			assetPath: "/gonavi/dev/releases/download/dev-abc1234/GoNavi-dev.zip",
			want: []string{
				"https://download.syngnat.top/gonavi/dev/releases/download/dev-abc1234/GoNavi-dev.zip",
				"https://origin-download.syngnat.top:8443/gonavi/dev/releases/download/dev-abc1234/GoNavi-dev.zip",
				"https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi-dev.zip",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := staticDispatcherDownloadCandidates(downloadDispatcherURLForPath(test.assetPath))
			if err != nil {
				t.Fatalf("resolve static application candidates: %v", err)
			}
			if len(got) != len(test.want) {
				t.Fatalf("candidate count = %d, want %d: %#v", len(got), len(test.want), got)
			}
			for index := range test.want {
				if got[index] != test.want[index] {
					t.Fatalf("candidate %d = %q, want %q", index, got[index], test.want[index])
				}
			}
		})
	}
}

func TestStaticDriverDispatcherDownloadCandidatesRejectsUnrecognizedOrAmbiguousURL(t *testing.T) {
	validPath := "%2Fdrivers%2Freleases%2Fdownload%2Fv1.9.6%2Fsqlserver-driver-agent-darwin-arm64.zip"
	tests := []struct {
		name   string
		rawURL string
	}{
		{
			name:   "non dispatcher host",
			rawURL: "https://example.com/v1/resolve?path=" + validPath,
		},
		{
			name:   "dispatcher suffix host",
			rawURL: "https://download-dispatch.syngnat.top.example.com/v1/resolve?path=" + validPath,
		},
		{
			name:   "non https dispatcher",
			rawURL: "http://download-dispatch.syngnat.top/v1/resolve?path=" + validPath,
		},
		{
			name:   "dispatcher credentials",
			rawURL: "https://user:secret@download-dispatch.syngnat.top/v1/resolve?path=" + validPath,
		},
		{
			name:   "wrong dispatcher endpoint",
			rawURL: "https://download-dispatch.syngnat.top/v1/other?path=" + validPath,
		},
		{
			name:   "encoded dispatcher endpoint",
			rawURL: "https://download-dispatch.syngnat.top/v1/%72esolve?path=" + validPath,
		},
		{
			name:   "missing path query",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?format=json",
		},
		{
			name:   "relative asset path",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=drivers%2Freleases%2Fdownload%2Fv1.9.6%2Fasset.zip",
		},
		{
			name:   "non driver release path",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Freleases%2Fdownload%2Fv1.9.6%2FGoNavi.zip",
		},
		{
			name:   "driver index path",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Freleases%2Flatest%2FGoNavi-DriverAgents-Index.json",
		},
		{
			name:   "stable parent traversal",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Freleases%2Fdownload%2F..%2Fasset.zip",
		},
		{
			name:   "dev current directory traversal",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Fdev%2Freleases%2Fdownload%2F.%2Fasset.zip",
		},
		{
			name:   "encoded backslash in tag",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Freleases%2Fdownload%2Fv1.9.6%5C..%2Fasset.zip",
		},
		{
			name:   "encoded nul in asset",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Freleases%2Fdownload%2Fv1.9.6%2Fasset%00.zip",
		},
		{
			name:   "double encoded parent traversal",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Freleases%2Fdownload%2F%252e%252e%2Fasset.zip",
		},
		{
			name:   "double encoded slash in tag",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Freleases%2Fdownload%2Fv1.9.6%252F..%2Fasset.zip",
		},
		{
			name:   "duplicate path query",
			rawURL: "https://download-dispatch.syngnat.top/v1/resolve?path=" + validPath + "&path=%2Fdrivers%2Freleases%2Fdownload%2F..%2Fasset.zip",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := staticDriverDispatcherDownloadCandidates(test.rawURL)
			if err == nil {
				t.Fatalf("expected URL to be rejected, got candidates %#v", got)
			}
			if len(got) != 0 {
				t.Fatalf("rejected URL returned candidates %#v", got)
			}
		})
	}
}

func TestResolveDispatcherDownloadCandidatesRejectsMalformedRecognizedURLWithoutFallback(t *testing.T) {
	var requests atomic.Int32
	client := &http.Client{Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		requests.Add(1)
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"candidates":[{"source":"cst","url":"https://download.syngnat.top/gonavi/releases/download/v1/GoNavi.zip"}]}`)),
			Request:    request,
		}, nil
	})}

	malformed := []string{
		"https://download-dispatch.syngnat.top/v1/resolve?path=%2Fdrivers%2Freleases%2Fdownload%2F%252e%252e%2Fasset.zip",
		"https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-current%2FGoNavi.zip&path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-stale%2FGoNavi.zip",
	}
	for _, rawURL := range malformed {
		candidates, err := resolveDispatcherDownloadCandidates(client, rawURL)
		if !errors.Is(err, errInvalidDownloadDispatcherURL) {
			t.Fatalf("malformed Dispatcher URL error = %v, want typed invalid URL", err)
		}
		if len(candidates) != 0 {
			t.Fatalf("malformed Dispatcher URL fell back to candidates %#v", candidates)
		}
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("malformed Dispatcher URLs issued %d requests", got)
	}
	_, err := downloadFileWithHashParallelAwareAndExpectedSize(
		malformed[1],
		filepath.Join(t.TempDir(), "must-not-download.zip"),
		nil,
		time.Second,
		1024,
	)
	if !errors.Is(err, errInvalidDownloadDispatcherURL) {
		t.Fatalf("common downloader error = %v, want typed invalid Dispatcher URL", err)
	}

	directURL := "https://example.com/driver.zip"
	candidates, err := resolveDispatcherDownloadCandidates(client, directURL)
	if err != nil || len(candidates) != 1 || candidates[0] != directURL {
		t.Fatalf("ordinary non-Dispatcher URL = %#v, %v", candidates, err)
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("ordinary URL unexpectedly issued %d resolver requests", got)
	}

	appURL := downloadDispatcherURLForPath("/gonavi/releases/download/v1/GoNavi.zip")
	candidates, err = resolveDispatcherDownloadCandidates(client, appURL)
	if err != nil || len(candidates) != 1 || candidates[0] != "https://download.syngnat.top/gonavi/releases/download/v1/GoNavi.zip" {
		t.Fatalf("valid app Dispatcher URL = %#v, %v", candidates, err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("valid app Dispatcher URL issued %d resolver requests, want 1", got)
	}
}

func TestResolveDispatcherDownloadCandidatesDistinguishesRedirectedMirrorStatus(t *testing.T) {
	assetPath := "/gonavi/dev/releases/download/dev-current/GoNavi.zip"
	gated := downloadDispatcherURLRequiringCurrentDevAsset(downloadDispatcherURLForPath(assetPath))

	for _, test := range []struct {
		name           string
		responseHost   string
		wantCandidates bool
	}{
		{name: "dispatcher not found", responseHost: downloadDispatcherHostname, wantCandidates: false},
		{name: "cst not found after redirect", responseHost: "download.syngnat.top", wantCandidates: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
				if request.URL.Query().Get("format") != "json" {
					return nil, fmt.Errorf("unexpected resolver request: %s", request.URL)
				}
				responseRequest := request
				if test.responseHost != downloadDispatcherHostname {
					responseRequest = request.Clone(request.Context())
					responseURL := *request.URL
					responseURL.Host = test.responseHost
					responseRequest.URL = &responseURL
				}
				return &http.Response{
					StatusCode: http.StatusNotFound,
					Header:     make(http.Header),
					Body:       io.NopCloser(strings.NewReader("missing asset")),
					Request:    responseRequest,
				}, nil
			})}

			candidates, err := resolveDispatcherDownloadCandidates(client, gated)
			if test.wantCandidates {
				if err != nil {
					t.Fatalf("redirected mirror status returned error: %v", err)
				}
				want, wantErr := staticDispatcherDownloadCandidates(gated)
				if wantErr != nil || !reflect.DeepEqual(candidates, want) {
					t.Fatalf("redirected mirror candidates = %#v, want %#v (err=%v)", candidates, want, wantErr)
				}
				return
			}
			if len(candidates) != 0 {
				t.Fatalf("Dispatcher identity failure returned candidates %#v", candidates)
			}
			if err == nil {
				t.Fatal("expected Dispatcher identity failure")
			}
			var terminal downloadCurrentAssetTerminalError
			if !errors.As(err, &terminal) {
				t.Fatalf("expected terminal current-asset error, got %T %v", err, err)
			}
			var localized localizedUpdateError
			if !errors.As(err, &localized) || localized.httpStatus != http.StatusNotFound {
				t.Fatalf("expected wrapped HTTP 404, got %T %v", err, err)
			}
		})
	}
}

func TestDownloadDispatcherURLRequiringCurrentDevAsset(t *testing.T) {
	devAsset := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi-dev-abc1234-Windows-Amd64-Portable.zip"
	parsed, err := url.Parse(downloadDispatcherURLRequiringCurrentDevAsset(devAsset))
	if err != nil {
		t.Fatalf("parse gated dev URL: %v", err)
	}
	if parsed.Query().Get("require-current") != "1" {
		t.Fatalf("gated dev URL = %q", parsed.String())
	}

	stableAsset := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Freleases%2Fdownload%2Fv1.2.3%2FGoNavi-1.2.3-Windows-Amd64-Portable.zip"
	if got := downloadDispatcherURLRequiringCurrentDevAsset(stableAsset); got != stableAsset {
		t.Fatalf("stable URL changed: %q", got)
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

func TestShouldResolveDispatcherFallbackClassifiesGatedDevAssetErrors(t *testing.T) {
	gated := downloadDispatcherURLRequiringCurrentDevAsset(
		"https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip",
	)
	for _, test := range []struct {
		name string
		err  error
		want bool
	}{
		{name: "network failure", err: errors.New("Cst connection refused"), want: true},
		{name: "upstream unavailable", err: localizedUpdateError{httpStatus: http.StatusServiceUnavailable}, want: true},
		{name: "current asset mismatch", err: downloadCurrentAssetMismatchError{}, want: false},
		{name: "localized missing source", err: localizedUpdateError{httpStatus: http.StatusNotFound}, want: true},
		{name: "localized gone source", err: localizedUpdateError{httpStatus: http.StatusGone}, want: true},
		{name: "missing current asset", err: downloadCurrentAssetTerminalError{cause: localizedUpdateError{httpStatus: http.StatusNotFound}}, want: false},
		{name: "gone current asset", err: downloadCurrentAssetTerminalError{cause: localizedUpdateError{httpStatus: http.StatusGone}}, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldResolveDispatcherFallback(gated, parallelDownloadMinimumSize, test.err); got != test.want {
				t.Fatalf("shouldResolveDispatcherFallback = %v, want %v for %T", got, test.want, test.err)
			}
		})
	}

	stable := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Freleases%2Fdownload%2Fv1.2.3%2FGoNavi.zip"
	if !shouldResolveDispatcherFallback(stable, parallelDownloadMinimumSize, errors.New("Cst unavailable")) {
		t.Fatal("stable dispatcher asset should retain JSON fallback candidates")
	}
}

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
