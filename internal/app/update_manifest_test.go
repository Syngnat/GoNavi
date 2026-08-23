package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func configureUpdateManifestHTTPTest(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
		"http_proxy", "https_proxy", "all_proxy",
	} {
		t.Setenv(name, "")
	}
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	t.Setenv("no_proxy", "127.0.0.1,localhost")
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
}

func TestDownloadUpdateAssetWithFallbackRetriesChecksumMismatch(t *testing.T) {
	goodPayload := []byte("verified update package")
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(goodPayload))
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("corrupted mirror object"))
	}))
	defer primary.Close()
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(goodPayload)
	}))
	defer fallback.Close()

	assetPath := filepath.Join(t.TempDir(), "GoNavi.bin")
	actualHash, err := downloadUpdateAssetWithFallback(
		[]string{primary.URL, fallback.URL},
		assetPath,
		expectedHash,
		int64(len(goodPayload)),
		nil,
	)
	if err != nil {
		t.Fatalf("expected checksum mismatch fallback to succeed: %v", err)
	}
	if actualHash != expectedHash {
		t.Fatalf("actual hash = %q, want %q", actualHash, expectedHash)
	}
	payload, err := os.ReadFile(assetPath)
	if err != nil {
		t.Fatalf("read downloaded asset: %v", err)
	}
	if string(payload) != string(goodPayload) {
		t.Fatalf("downloaded payload = %q", payload)
	}
}

func TestDownloadFileWithHashUsesEightParallelRanges(t *testing.T) {
	configureUpdateManifestHTTPTest(t)
	payload := make([]byte, parallelDownloadMinimumSize+3)
	for index := range payload {
		payload[index] = byte(index % 251)
	}
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))

	var probeHits atomic.Int32
	var rangeHits atomic.Int32
	started := make(chan struct{}, parallelDownloadWorkers)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		rawRange := req.Header.Get("Range")
		var start, end int64
		if count, err := fmt.Sscanf(rawRange, "bytes=%d-%d", &start, &end); err != nil || count != 2 || start < 0 || end < start || end >= int64(len(payload)) {
			http.Error(w, "invalid range", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		w.Header().Set("Content-Length", fmt.Sprintf("%d", end-start+1))
		w.WriteHeader(http.StatusPartialContent)
		if rawRange == fmt.Sprintf("bytes=0-%d", downloadCandidateProbeBytes-1) {
			probeHits.Add(1)
			_, _ = w.Write(payload[:downloadCandidateProbeBytes])
			return
		}

		rangeHits.Add(1)
		started <- struct{}{}
		select {
		case <-release:
		case <-req.Context().Done():
			return
		}
		_, _ = w.Write(payload[start : end+1])
	}))
	defer server.Close()

	type downloadOutcome struct {
		hash string
		err  error
	}
	assetPath := filepath.Join(t.TempDir(), "GoNavi.bin")
	var downloaded atomic.Int64
	var total atomic.Int64
	done := make(chan downloadOutcome, 1)
	go func() {
		hash, err := downloadFileWithHashWithTimeout(server.URL, assetPath, func(current, expected int64) {
			downloaded.Store(current)
			total.Store(expected)
		}, 5*time.Second)
		done <- downloadOutcome{hash: hash, err: err}
	}()

	for index := 0; index < parallelDownloadWorkers; index++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			close(release)
			t.Fatalf("only %d parallel range requests started", index)
		}
	}
	close(release)
	outcome := <-done
	if outcome.err != nil {
		t.Fatalf("parallel range download failed: %v", outcome.err)
	}
	if outcome.hash != expectedHash {
		t.Fatalf("hash = %q, want %q", outcome.hash, expectedHash)
	}
	if probeHits.Load() != 1 || rangeHits.Load() != parallelDownloadWorkers {
		t.Fatalf("request counts: probe=%d ranges=%d", probeHits.Load(), rangeHits.Load())
	}
	if downloaded.Load() != int64(len(payload)) || total.Load() != int64(len(payload)) {
		t.Fatalf("progress = %d/%d, want %d/%d", downloaded.Load(), total.Load(), len(payload), len(payload))
	}
	actual, err := os.ReadFile(assetPath)
	if err != nil {
		t.Fatalf("read downloaded asset: %v", err)
	}
	if !bytes.Equal(actual, payload) {
		t.Fatal("parallel range download reconstructed different content")
	}
}

func TestDownloadFileWithHashFallsBackWhenRangeIsUnsupported(t *testing.T) {
	configureUpdateManifestHTTPTest(t)
	payload := []byte("single request fallback payload")
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	var hits atomic.Int32
	var rangeHits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hits.Add(1)
		if req.Header.Get("Range") != "" {
			rangeHits.Add(1)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	assetPath := filepath.Join(t.TempDir(), "GoNavi.bin")
	actualHash, err := downloadFileWithHashWithTimeout(server.URL, assetPath, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("single request fallback failed: %v", err)
	}
	if actualHash != expectedHash {
		t.Fatalf("hash = %q, want %q", actualHash, expectedHash)
	}
	if hits.Load() != 2 || rangeHits.Load() != 1 {
		t.Fatalf("request counts: total=%d range=%d, want 2/1", hits.Load(), rangeHits.Load())
	}
	actual, err := os.ReadFile(assetPath)
	if err != nil {
		t.Fatalf("read downloaded asset: %v", err)
	}
	if !bytes.Equal(actual, payload) {
		t.Fatal("single request fallback wrote different content")
	}
}

func TestReleaseFromUpdateManifestMapsAssets(t *testing.T) {
	release := releaseFromUpdateManifest(&updateReleaseManifest{
		TagName:     "v1.2.3",
		Version:     "1.2.3",
		Name:        "GoNavi 1.2.3",
		HTMLURL:     "https://github.com/Syngnat/GoNavi/releases/tag/v1.2.3",
		PublishedAt: "2026-07-09T00:00:00Z",
		Assets: []updateManifestAsset{
			{
				Name:   "GoNavi-1.2.3-Windows-Amd64.exe",
				URL:    "https://example.com/app.exe",
				SHA256: "Aa" + strings.Repeat("b", 62),
				Size:   99,
			},
		},
	})
	if release == nil {
		t.Fatal("expected release")
	}
	if release.TagName != "v1.2.3" || len(release.Assets) != 1 {
		t.Fatalf("unexpected release: %#v", release)
	}
	if release.Assets[0].BrowserDownloadURL != "https://example.com/app.exe" {
		t.Fatalf("url = %q", release.Assets[0].BrowserDownloadURL)
	}
	if !strings.HasPrefix(release.Assets[0].Digest, "sha256:") {
		t.Fatalf("digest = %q", release.Assets[0].Digest)
	}
}

func TestUpdateManifestRemoteURLsPreferDispatcherThenGitHub(t *testing.T) {
	tests := []struct {
		channel updateChannel
		want    []string
	}{
		{updateChannelLatest, []string{updateMirrorLatestManifestURL, updateGitHubLatestManifestURL}},
		{updateChannelDev, []string{updateMirrorDevManifestURL, updateGitHubDevManifestURL}},
	}
	for _, test := range tests {
		got := updateManifestRemoteURLs(test.channel)
		if len(got) != len(test.want) {
			t.Fatalf("channel %s URLs = %v", test.channel, got)
		}
		for index := range test.want {
			if got[index] != test.want[index] {
				t.Fatalf("channel %s URLs = %v, want %v", test.channel, got, test.want)
			}
		}
	}
}

func TestFetchStaticUpdateManifestFromURLsStopsAfterDispatcherSuccess(t *testing.T) {
	configureUpdateManifestHTTPTest(t)

	const version = "9.9.9"
	expectedAsset, err := expectedAssetNameForInstallMode(
		stdRuntime.GOOS,
		stdRuntime.GOARCH,
		version,
		updateResolveInstallMode(),
	)
	if err != nil {
		t.Fatalf("resolve expected update asset: %v", err)
	}
	manifest := updateReleaseManifest{
		SchemaVersion: updateManifestSchemaVersion,
		Channel:       string(updateChannelLatest),
		TagName:       "v" + version,
		Version:       version,
		Assets: []updateManifestAsset{{
			Name:   expectedAsset,
			URL:    "https://download.example.test/" + expectedAsset,
			Size:   123,
			SHA256: strings.Repeat("a", 64),
		}},
	}

	var mirrorHits atomic.Int32
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mirrorHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(manifest)
	}))
	defer mirror.Close()
	var fallbackHits atomic.Int32
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fallbackHits.Add(1)
		http.Error(w, "fallback must not be requested", http.StatusInternalServerError)
	}))
	defer fallback.Close()

	release, err := fetchStaticUpdateManifestFromURLs(updateChannelLatest, []string{mirror.URL, fallback.URL})
	if err != nil {
		t.Fatalf("fetch mirror manifest: %v", err)
	}
	if release == nil || release.TagName != "v"+version {
		t.Fatalf("unexpected mirror release: %#v", release)
	}
	if mirrorHits.Load() != 1 || fallbackHits.Load() != 0 {
		t.Fatalf("manifest request counts: mirror=%d fallback=%d", mirrorHits.Load(), fallbackHits.Load())
	}
}

func TestFetchStaticUpdateManifestFromURLsFallsBackFromInvalidDispatcherManifests(t *testing.T) {
	for _, name := range []string{
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
		"http_proxy", "https_proxy", "all_proxy",
	} {
		t.Setenv(name, "")
	}
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	t.Setenv("no_proxy", "127.0.0.1,localhost")
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())

	const version = "9.9.9"
	expectedAsset, err := expectedAssetNameForInstallMode(
		stdRuntime.GOOS,
		stdRuntime.GOARCH,
		version,
		updateResolveInstallMode(),
	)
	if err != nil {
		t.Fatalf("resolve expected update asset: %v", err)
	}
	valid := updateReleaseManifest{
		SchemaVersion: updateManifestSchemaVersion,
		Channel:       string(updateChannelLatest),
		TagName:       "v" + version,
		Version:       version,
		Assets: []updateManifestAsset{{
			Name:   expectedAsset,
			URL:    "https://download.example.test/" + expectedAsset,
			APIURL: "https://github.example.test/" + expectedAsset,
			Size:   123,
			SHA256: strings.Repeat("a", 64),
		}},
	}
	wrongChannel := valid
	wrongChannel.Channel = string(updateChannelDev)
	missingTarget := valid
	missingTarget.Assets = []updateManifestAsset{{
		Name:   "GoNavi-9.9.9-Other-Platform.bin",
		URL:    "https://download.example.test/other.bin",
		Size:   123,
		SHA256: strings.Repeat("b", 64),
	}}

	serveManifest := func(manifest updateReleaseManifest, hits *atomic.Int32) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			hits.Add(1)
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(manifest); err != nil {
				t.Errorf("encode manifest: %v", err)
			}
		}))
	}
	var wrongChannelHits atomic.Int32
	var missingTargetHits atomic.Int32
	var validHits atomic.Int32
	wrongChannelServer := serveManifest(wrongChannel, &wrongChannelHits)
	defer wrongChannelServer.Close()
	missingTargetServer := serveManifest(missingTarget, &missingTargetHits)
	defer missingTargetServer.Close()
	validServer := serveManifest(valid, &validHits)
	defer validServer.Close()

	release, err := fetchStaticUpdateManifestFromURLs(updateChannelLatest, []string{
		wrongChannelServer.URL,
		missingTargetServer.URL,
		validServer.URL,
	})
	if err != nil {
		t.Fatalf("expected valid fallback manifest: %v", err)
	}
	if release == nil || release.TagName != "v"+version || len(release.Assets) != 1 || release.Assets[0].Name != expectedAsset {
		t.Fatalf("unexpected fallback release: %#v", release)
	}
	if wrongChannelHits.Load() != 1 || missingTargetHits.Load() != 1 || validHits.Load() != 1 {
		t.Fatalf(
			"unexpected manifest request counts: wrong-channel=%d missing-target=%d valid=%d",
			wrongChannelHits.Load(),
			missingTargetHits.Load(),
			validHits.Load(),
		)
	}
}

func TestDiskUpdateManifestRoundTrip(t *testing.T) {
	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", root)

	payload := &updateReleaseManifest{
		SchemaVersion: 1,
		Channel:       "latest",
		TagName:       "v9.9.9",
		Version:       "9.9.9",
		Name:          "v9.9.9",
		HTMLURL:       "https://github.com/Syngnat/GoNavi/releases/tag/v9.9.9",
		Assets: []updateManifestAsset{
			{Name: "app.bin", URL: "https://example.com/app.bin", SHA256: strings.Repeat("c", 64), Size: 1},
		},
		FetchedAt: time.Now().UTC(),
	}
	storeDiskUpdateManifest(updateChannelLatest, payload)
	loaded, stale := loadDiskUpdateManifest(updateChannelLatest)
	if loaded == nil || stale {
		t.Fatalf("expected fresh disk cache, got %#v stale=%v", loaded, stale)
	}
	if loaded.Version != "9.9.9" {
		t.Fatalf("version = %q", loaded.Version)
	}
	path := updateManifestCachePath(updateChannelLatest)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("cache file missing: %v", err)
	}
	if !strings.HasPrefix(path, root) {
		t.Fatalf("cache path not under data root: %s", path)
	}
}

func TestFetchReleaseForChannelPreferringStaticUsesStaticFirst(t *testing.T) {
	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", root)
	updateReleaseCache = sync.Map{}

	staticCalled := false
	apiCalled := false
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		staticCalled = true
		return &githubRelease{TagName: "v2.0.0", Name: "v2.0.0"}, nil
	})
	defer restoreStatic()
	restoreAPI := swapUpdateFetchLatestRelease(func() (*githubRelease, error) {
		apiCalled = true
		return nil, errors.New("api should not be called")
	})
	defer restoreAPI()

	release, err := fetchReleaseForChannelPreferringStatic(updateChannelLatest, true)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if !staticCalled || apiCalled {
		t.Fatalf("staticCalled=%v apiCalled=%v", staticCalled, apiCalled)
	}
	if release.TagName != "v2.0.0" {
		t.Fatalf("tag=%q", release.TagName)
	}
}

func TestFetchReleaseForChannelPreferringStaticUsesMirrorFirstForDevChecks(t *testing.T) {
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
	updateReleaseCache = sync.Map{}
	updateNetworkCheckMu.Lock()
	updateLastNetworkCheck = updateNetworkCheckMemory{}
	updateNetworkCheckMu.Unlock()

	staticCalls := 0
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		staticCalls++
		return &githubRelease{TagName: updateDevReleaseTag, Name: "Dev Build (dev-mirror)"}, nil
	})
	defer restoreStatic()
	apiCalls := 0
	restoreAPI := swapUpdateFetchDevRelease(func() (*githubRelease, error) {
		apiCalls++
		return &githubRelease{TagName: updateDevReleaseTag, Name: "Dev Build (dev-github)"}, nil
	})
	defer restoreAPI()

	silentRelease, err := fetchReleaseForChannelPreferringStatic(updateChannelDev, false)
	if err != nil {
		t.Fatalf("silent static fetch: %v", err)
	}
	if got := resolveReleaseVersion(updateChannelDev, silentRelease); got != "dev-mirror" {
		t.Fatalf("silent version = %q, want mirror", got)
	}
	if staticCalls != 1 || apiCalls != 0 {
		t.Fatalf("silent calls: static=%d api=%d", staticCalls, apiCalls)
	}

	manualRelease, err := fetchReleaseForChannelPreferringStatic(updateChannelDev, true)
	if err != nil {
		t.Fatalf("manual static fetch: %v", err)
	}
	if got := resolveReleaseVersion(updateChannelDev, manualRelease); got != "dev-mirror" {
		t.Fatalf("manual version = %q, want mirror", got)
	}
	if staticCalls != 2 || apiCalls != 0 {
		t.Fatalf("manual calls: static=%d api=%d", staticCalls, apiCalls)
	}
}

func TestFetchReleaseForChannelPreferringStaticFallsBackAPIThenDisk(t *testing.T) {
	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", root)
	updateReleaseCache = sync.Map{}

	storeDiskUpdateManifest(updateChannelLatest, &updateReleaseManifest{
		SchemaVersion: 1,
		TagName:       "v1.0.0",
		Version:       "1.0.0",
		Assets:        []updateManifestAsset{{Name: "a", URL: "https://example.com/a"}},
		FetchedAt:     time.Now().UTC(),
	})

	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		return nil, errors.New("static 404")
	})
	defer restoreStatic()
	restoreAPI := swapUpdateFetchLatestRelease(func() (*githubRelease, error) {
		return nil, errors.New("api rate limit")
	})
	defer restoreAPI()

	release, err := fetchReleaseForChannelPreferringStatic(updateChannelLatest, true)
	if err != nil {
		t.Fatalf("expected disk fallback, err=%v", err)
	}
	if release.TagName != "v1.0.0" {
		t.Fatalf("tag=%q", release.TagName)
	}
}

func TestSilentCheckThrottleReusesDisk(t *testing.T) {
	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", root)
	updateReleaseCache = sync.Map{}
	storeDiskUpdateManifest(updateChannelLatest, &updateReleaseManifest{
		SchemaVersion: 1,
		TagName:       "v3.0.0",
		Version:       "3.0.0",
		Assets:        []updateManifestAsset{{Name: "a", URL: "u"}},
		FetchedAt:     time.Now().UTC(),
	})
	markUpdateNetworkCheck(updateChannelLatest)

	staticCalls := 0
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		staticCalls++
		return nil, errors.New("should not hit network")
	})
	defer restoreStatic()
	restoreAPI := swapUpdateFetchLatestRelease(func() (*githubRelease, error) {
		t.Fatal("api should not be called during throttle")
		return nil, nil
	})
	defer restoreAPI()

	release, err := fetchReleaseForChannelPreferringStatic(updateChannelLatest, false)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if release.TagName != "v3.0.0" {
		t.Fatalf("tag=%q", release.TagName)
	}
	if staticCalls != 0 {
		t.Fatalf("staticCalls=%d", staticCalls)
	}
}

func TestUpdateManifestFromGitHubRelease(t *testing.T) {
	release := &githubRelease{
		TagName: "v1.0.1",
		Name:    "v1.0.1",
		HTMLURL: "https://github.com/Syngnat/GoNavi/releases/tag/v1.0.1",
		Assets: []githubAsset{
			{Name: "a.exe", BrowserDownloadURL: "https://x/a.exe", Digest: "sha256:" + strings.Repeat("d", 64), Size: 10},
		},
	}
	m := updateManifestFromGitHubRelease(updateChannelLatest, release, nil)
	if m == nil || m.Version == "" || len(m.Assets) != 1 {
		t.Fatalf("manifest=%#v", m)
	}
	_ = json.Marshal
}
