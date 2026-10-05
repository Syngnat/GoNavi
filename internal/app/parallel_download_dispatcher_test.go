package app

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

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
