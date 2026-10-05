package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	stdRuntime "runtime"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestFetchLatestUpdateInfoSkipsChecksumWhenCurrentVersionIsAlreadyLatest(t *testing.T) {
	assetName, err := expectedAssetName(stdRuntime.GOOS, stdRuntime.GOARCH, "v0.6.5")
	if err != nil {
		t.Fatalf("expectedAssetName returned error: %v", err)
	}

	originalVersion := AppVersion
	AppVersion = "0.6.5"
	defer func() {
		AppVersion = originalVersion
	}()

	releaseCalled := false
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		// 单测走 API 路径，模拟尚无 latest.json 的历史 Release
		return nil, errors.New("static manifest unavailable in test")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchLatestRelease(func() (*githubRelease, error) {
		releaseCalled = true
		return &githubRelease{
			TagName:     "v0.6.5",
			Name:        "v0.6.5",
			HTMLURL:     "https://github.com/Syngnat/GoNavi/releases/tag/v0.6.5",
			PublishedAt: "2026-07-08T11:15:00Z",
			Assets: []githubAsset{
				{
					Name:               assetName,
					BrowserDownloadURL: "https://example.com/" + assetName,
					Size:               1024,
				},
			},
		}, nil
	})
	defer restoreRelease()

	checksumCalled := false
	restoreChecksum := swapUpdateFetchReleaseSHA256(func([]githubAsset) (map[string]string, error) {
		checksumCalled = true
		return nil, errors.New("checksum should not be fetched when no update is needed")
	})
	defer restoreChecksum()

	info, err := fetchLatestUpdateInfo(updateChannelLatest)
	if err != nil {
		t.Fatalf("fetchLatestUpdateInfo returned error: %v", err)
	}
	if !releaseCalled {
		t.Fatal("expected latest release metadata to be fetched")
	}
	if checksumCalled {
		t.Fatal("expected SHA256SUMS fetch to be skipped when current version is already latest")
	}
	if info.HasUpdate {
		t.Fatalf("expected HasUpdate=false, got %#v", info)
	}
	if info.LatestVersion != "0.6.5" || info.CurrentVersion != "0.6.5" {
		t.Fatalf("unexpected version info: %#v", info)
	}
	if info.InstallMode != string(updateResolveInstallMode()) ||
		info.PackageType != string(resolveUpdatePackageType(stdRuntime.GOOS, updateResolveInstallMode())) ||
		!info.AutoRelaunch {
		t.Fatalf("expected no-update result to include install contract, got %#v", info)
	}
}

func TestFetchLatestUpdateInfoUsesAssetDigestWhenUpdateIsAvailable(t *testing.T) {
	assetName, err := expectedAssetName(stdRuntime.GOOS, stdRuntime.GOARCH, "v0.6.5")
	if err != nil {
		t.Fatalf("expectedAssetName returned error: %v", err)
	}
	digest := strings.Repeat("A", 64)

	originalVersion := AppVersion
	AppVersion = "0.6.4"
	defer func() {
		AppVersion = originalVersion
	}()

	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		return nil, errors.New("static manifest unavailable in test")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchLatestRelease(func() (*githubRelease, error) {
		return &githubRelease{
			TagName:     "v0.6.5",
			Name:        "v0.6.5",
			HTMLURL:     "https://github.com/Syngnat/GoNavi/releases/tag/v0.6.5",
			PublishedAt: "2026-07-08T11:15:00Z",
			Assets: []githubAsset{
				{
					Name:               assetName,
					BrowserDownloadURL: "https://example.com/" + assetName,
					Digest:             "sha256:" + digest,
					Size:               4096,
				},
			},
		}, nil
	})
	defer restoreRelease()

	checksumCalled := false
	restoreChecksum := swapUpdateFetchReleaseSHA256(func([]githubAsset) (map[string]string, error) {
		checksumCalled = true
		return nil, errors.New("checksum should not be fetched when asset digest is available")
	})
	defer restoreChecksum()

	info, err := fetchLatestUpdateInfo(updateChannelLatest)
	if err != nil {
		t.Fatalf("fetchLatestUpdateInfo returned error: %v", err)
	}
	if checksumCalled {
		t.Fatal("expected SHA256SUMS fetch to be skipped when asset digest is available")
	}
	if !info.HasUpdate {
		t.Fatalf("expected HasUpdate=true, got %#v", info)
	}
	if info.SHA256 != strings.ToLower(digest) || info.AssetName != assetName {
		t.Fatalf("unexpected update info: %#v", info)
	}
	wantDispatcherURL := updateDispatcherAssetURL(updateChannelLatest, "v0.6.5", assetName)
	if info.AssetURL != wantDispatcherURL {
		t.Fatalf("stable asset URL = %q, want immutable dispatcher URL %q", info.AssetURL, wantDispatcherURL)
	}
	if strings.Contains(info.AssetURL, "github.com") {
		t.Fatalf("stable asset URL must not bypass Dispatcher: %q", info.AssetURL)
	}
	if info.ReleasePublishedAt != "2026-07-08T11:15:00Z" {
		t.Fatalf("expected release published time to be preserved, got %#v", info)
	}
}

func TestFetchLatestUpdateInfoFallsBackToChecksumFileWhenAssetDigestMissing(t *testing.T) {
	assetName, err := expectedAssetName(stdRuntime.GOOS, stdRuntime.GOARCH, "v0.6.5")
	if err != nil {
		t.Fatalf("expectedAssetName returned error: %v", err)
	}

	originalVersion := AppVersion
	AppVersion = "0.6.4"
	defer func() {
		AppVersion = originalVersion
	}()

	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		return nil, errors.New("static manifest unavailable in test")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchLatestRelease(func() (*githubRelease, error) {
		return &githubRelease{
			TagName: "v0.6.5",
			Name:    "v0.6.5",
			HTMLURL: "https://github.com/Syngnat/GoNavi/releases/tag/v0.6.5",
			Assets: []githubAsset{
				{
					Name:               assetName,
					BrowserDownloadURL: "https://example.com/" + assetName,
					Size:               4096,
				},
			},
		}, nil
	})
	defer restoreRelease()

	checksumCalled := false
	restoreChecksum := swapUpdateFetchReleaseSHA256(func([]githubAsset) (map[string]string, error) {
		checksumCalled = true
		return map[string]string{
			assetName: "abc123",
		}, nil
	})
	defer restoreChecksum()

	info, err := fetchLatestUpdateInfo(updateChannelLatest)
	if err != nil {
		t.Fatalf("fetchLatestUpdateInfo returned error: %v", err)
	}
	if !checksumCalled {
		t.Fatal("expected SHA256SUMS fetch when asset digest is missing")
	}
	if !info.HasUpdate {
		t.Fatalf("expected HasUpdate=true, got %#v", info)
	}
	if info.SHA256 != "abc123" || info.AssetName != assetName {
		t.Fatalf("unexpected update info: %#v", info)
	}
}

func TestCheckForUpdatesLogsFailuresForManualChecks(t *testing.T) {
	app := &App{configDir: t.TempDir()}
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())

	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		return nil, errors.New("static unavailable")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchLatestRelease(func() (*githubRelease, error) {
		return nil, errors.New("request timed out")
	})
	defer restoreRelease()

	logged := 0
	restoreLogger := swapUpdateCheckErrorLogger(func(error) {
		logged++
	})
	defer restoreLogger()

	result := app.CheckForUpdates()
	if result.Success {
		t.Fatalf("expected failure result, got %#v", result)
	}
	if logged != 1 {
		t.Fatalf("expected manual check to log once, got %d", logged)
	}
}

func TestCheckForUpdatesSilentlySkipsFailureLogs(t *testing.T) {
	app := &App{configDir: t.TempDir()}
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())

	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		return nil, errors.New("static unavailable")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchLatestRelease(func() (*githubRelease, error) {
		return nil, errors.New("request timed out")
	})
	defer restoreRelease()

	logged := 0
	restoreLogger := swapUpdateCheckErrorLogger(func(error) {
		logged++
	})
	defer restoreLogger()

	result := app.CheckForUpdatesSilently()
	if result.Success {
		t.Fatalf("expected failure result, got %#v", result)
	}
	if logged != 0 {
		t.Fatalf("expected silent check to skip error logging, got %d", logged)
	}
}

func TestCheckForUpdatesRestoresPersistedGlobalProxyRuntime(t *testing.T) {
	previousProxy := currentGlobalProxyConfig()
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(previousProxy.Enabled, previousProxy.Proxy)
	})

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	proxyCalled := false
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyCalled = true
		if !r.URL.IsAbs() {
			t.Fatalf("expected update request through HTTP proxy to use absolute URL, got %q", r.URL.String())
		}
		if r.URL.Host != "api.github.invalid" {
			t.Fatalf("expected proxied GitHub API host api.github.invalid, got %q", r.URL.Host)
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(githubRelease{
			TagName: updateDevReleaseTag,
			Name:    "Dev Build (dev-proxy123)",
			HTMLURL: "https://github.com/Syngnat/GoNavi/releases/tag/dev-latest",
		}); err != nil {
			t.Fatalf("Encode returned error: %v", err)
		}
	}))
	defer proxyServer.Close()

	host, port := parseTestServerHostPort(t, proxyServer.URL)
	if _, err := app.saveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled: true,
		Type:    "http",
		Host:    host,
		Port:    port,
	}); err != nil {
		t.Fatalf("saveGlobalProxy returned error: %v", err)
	}
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("setGlobalProxyConfig reset returned error: %v", err)
	}

	originalVersion := AppVersion
	AppVersion = "dev-proxy123"
	defer func() {
		AppVersion = originalVersion
	}()

	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		return nil, errors.New("static unavailable; exercise API proxy path")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchDevRelease(func() (*githubRelease, error) {
		return fetchReleaseByURL("http://api.github.invalid/repos/Syngnat/GoNavi/releases/tags/dev-latest")
	})
	defer restoreRelease()

	setChannelResult := app.SetUpdateChannel(string(updateChannelDev))
	if !setChannelResult.Success {
		t.Fatalf("SetUpdateChannel returned failure: %#v", setChannelResult)
	}

	result := app.CheckForUpdates()
	if !result.Success {
		t.Fatalf("expected update check through restored proxy to succeed, got %#v", result)
	}
	if !proxyCalled {
		t.Fatal("expected persisted global proxy to receive the update check request")
	}
}

func TestStrictUpdateTransportNeverEnablesInsecureTLSFallback(t *testing.T) {
	previousProxy := currentGlobalProxyConfig()
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(previousProxy.Enabled, previousProxy.Proxy)
	})
	if _, err := setGlobalProxyConfig(true, connection.ProxyConfig{
		Type: "http",
		Host: "127.0.0.1",
		Port: 18080,
	}); err != nil {
		t.Fatalf("configure loopback proxy: %v", err)
	}
	transport, ok := buildStrictHTTPTransportWithGlobalProxy().(*http.Transport)
	if !ok || transport == nil {
		t.Fatalf("unexpected strict update transport: %T", transport)
	}
	if transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("strict update transport must not skip TLS verification")
	}
}

func TestStrictUpdateClientRejectsHTTPSDowngradeRedirect(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "http://43.139.148.5/asset", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if err := strictHTTPSRedirectPolicy(req, []*http.Request{{}}); err == nil {
		t.Fatal("strict update redirect policy must reject plaintext destinations")
	}
}

func TestFetchLatestUpdateInfoMapsReleaseNotesFromStaticManifest(t *testing.T) {
	assetName, err := expectedAssetName(stdRuntime.GOOS, stdRuntime.GOARCH, "1.2.3")
	if err != nil {
		t.Fatalf("expectedAssetName returned error: %v", err)
	}

	originalVersion := AppVersion
	AppVersion = "1.0.0"
	defer func() {
		AppVersion = originalVersion
	}()

	const notes = "## ✨ 新功能\n\n- in-app release notes"
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		return &githubRelease{
			TagName:     "v1.2.3",
			Name:        "v1.2.3",
			HTMLURL:     "https://github.com/Syngnat/GoNavi/releases/tag/v1.2.3",
			PublishedAt: "2026-07-08T11:15:00Z",
			Body:        notes + "\n",
			Assets: []githubAsset{
				{
					Name:               assetName,
					BrowserDownloadURL: "https://example.com/" + assetName,
					Digest:             "sha256:" + strings.Repeat("a", 64),
					Size:               4096,
				},
			},
		}, nil
	})
	defer restoreStatic()

	info, err := fetchLatestUpdateInfo(updateChannelLatest)
	if err != nil {
		t.Fatalf("fetchLatestUpdateInfo returned error: %v", err)
	}
	if info.ReleaseNotes != notes {
		t.Fatalf("expected release notes body, got %#v", info.ReleaseNotes)
	}
	if info.ReleaseNotesURL != "https://github.com/Syngnat/GoNavi/releases/tag/v1.2.3" {
		t.Fatalf("unexpected release notes url: %#v", info.ReleaseNotesURL)
	}
}
