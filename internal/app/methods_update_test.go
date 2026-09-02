package app

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	stdRuntime "runtime"
	"strings"
	"sync"
	"testing"
	"time"

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

func TestFetchLatestUpdateInfoForDevChannelUsesReleaseBuildVersion(t *testing.T) {
	assetName, err := expectedAssetName(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-a1b2c3d")
	if err != nil {
		t.Fatalf("expectedAssetName returned error: %v", err)
	}

	originalVersion := AppVersion
	AppVersion = "0.6.5"
	defer func() {
		AppVersion = originalVersion
	}()

	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		return nil, errors.New("static unavailable in test")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchDevRelease(func() (*githubRelease, error) {
		return &githubRelease{
			TagName: "dev-latest",
			Name:    "🧪 Dev Build (dev-a1b2c3d)",
			HTMLURL: "https://github.com/Syngnat/GoNavi/releases/tag/dev-latest",
			Assets: []githubAsset{
				{
					Name:               assetName,
					BrowserDownloadURL: "https://example.com/" + assetName,
					Size:               8192,
				},
			},
		}, nil
	})
	defer restoreRelease()

	checksumCalled := false
	restoreChecksum := swapUpdateFetchReleaseSHA256(func([]githubAsset) (map[string]string, error) {
		checksumCalled = true
		return map[string]string{
			assetName: "def456",
		}, nil
	})
	defer restoreChecksum()

	info, err := fetchLatestUpdateInfo(updateChannelDev)
	if err != nil {
		t.Fatalf("fetchLatestUpdateInfo returned error: %v", err)
	}
	if !checksumCalled {
		t.Fatal("expected dev channel update check to fetch SHA256 when build version differs")
	}
	if !info.HasUpdate {
		t.Fatalf("expected HasUpdate=true, got %#v", info)
	}
	if info.Channel != string(updateChannelDev) {
		t.Fatalf("expected dev channel, got %#v", info)
	}
	if info.LatestVersion != "dev-a1b2c3d" {
		t.Fatalf("expected dev build version from release metadata, got %#v", info)
	}
	if info.AssetName != assetName || info.SHA256 != "def456" {
		t.Fatalf("unexpected dev update info: %#v", info)
	}
	wantDispatcherURL := devUpdateDispatcherAssetURL("dev-a1b2c3d", assetName)
	if info.AssetURL != wantDispatcherURL {
		t.Fatalf("dev asset URL = %q, want immutable dispatcher URL %q", info.AssetURL, wantDispatcherURL)
	}
	if info.AssetAPIURL != "" {
		t.Fatalf("dev API fallback URL = %q, want empty when API omitted", info.AssetAPIURL)
	}
}

func TestFetchLatestUpdateInfoForDevChannelNormalizesDiskCachedGitHubAssetURL(t *testing.T) {
	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", root)

	const latestVersion = "dev-disk-cache"
	assetName, err := expectedAssetName(stdRuntime.GOOS, stdRuntime.GOARCH, latestVersion)
	if err != nil {
		t.Fatalf("expectedAssetName returned error: %v", err)
	}

	originalVersion := AppVersion
	AppVersion = "dev-previous"
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	githubURL := "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/" + assetName
	apiURL := "https://api.github.com/repos/Syngnat/GoNavi/releases/assets/123"
	storeDiskUpdateManifest(updateChannelDev, &updateReleaseManifest{
		SchemaVersion: updateManifestSchemaVersion,
		Channel:       string(updateChannelDev),
		TagName:       updateDevReleaseTag,
		Version:       latestVersion,
		Name:          "Dev Build (" + latestVersion + ")",
		Assets: []updateManifestAsset{{
			Name:   assetName,
			URL:    githubURL,
			APIURL: apiURL,
			Size:   8192,
			SHA256: strings.Repeat("d", 64),
		}},
		FetchedAt: time.Now().UTC(),
	})

	restoreStatic := swapUpdateFetchStaticManifest(func(updateChannel) (*githubRelease, error) {
		return nil, errors.New("static manifest unavailable in test")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchDevRelease(func() (*githubRelease, error) {
		return nil, errors.New("GitHub API unavailable in test")
	})
	defer restoreRelease()

	info, err := fetchLatestUpdateInfo(updateChannelDev)
	if err != nil {
		t.Fatalf("fetchLatestUpdateInfo returned error: %v", err)
	}
	wantDispatcherURL := devUpdateDispatcherAssetURL(latestVersion, assetName)
	if info.AssetURL != wantDispatcherURL {
		t.Fatalf("disk-cached dev asset URL = %q, want immutable dispatcher URL %q", info.AssetURL, wantDispatcherURL)
	}
	if strings.Contains(info.AssetURL, "github.com") {
		t.Fatalf("disk-cached dev asset URL must not bypass Dispatcher: %q", info.AssetURL)
	}
	if !dispatcherURLRequiresCurrentDevAsset(downloadDispatcherURLRequiringCurrentDevAsset(info.AssetURL)) {
		t.Fatalf("disk-cached dev asset URL was not eligible for require-current: %q", info.AssetURL)
	}
	if info.AssetAPIURL != apiURL {
		t.Fatalf("dev asset API URL = %q, want %q", info.AssetAPIURL, apiURL)
	}
}

func TestFetchLatestUpdateInfoForDevChannelSkipsChecksumWhenBuildMatches(t *testing.T) {
	assetName, err := expectedAssetName(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-a1b2c3d")
	if err != nil {
		t.Fatalf("expectedAssetName returned error: %v", err)
	}

	originalVersion := AppVersion
	AppVersion = "dev-a1b2c3d"
	defer func() {
		AppVersion = originalVersion
	}()

	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		return nil, errors.New("static unavailable in test")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchDevRelease(func() (*githubRelease, error) {
		return &githubRelease{
			TagName: "dev-latest",
			Name:    "🧪 Dev Build (dev-a1b2c3d)",
			HTMLURL: "https://github.com/Syngnat/GoNavi/releases/tag/dev-latest",
			Assets: []githubAsset{
				{
					Name:               assetName,
					BrowserDownloadURL: "https://example.com/" + assetName,
					Size:               2048,
				},
			},
		}, nil
	})
	defer restoreRelease()

	checksumCalled := false
	restoreChecksum := swapUpdateFetchReleaseSHA256(func([]githubAsset) (map[string]string, error) {
		checksumCalled = true
		return nil, errors.New("checksum should not be fetched when dev build is already current")
	})
	defer restoreChecksum()

	info, err := fetchLatestUpdateInfo(updateChannelDev)
	if err != nil {
		t.Fatalf("fetchLatestUpdateInfo returned error: %v", err)
	}
	if checksumCalled {
		t.Fatal("expected dev channel checksum fetch to be skipped when build already matches")
	}
	if info.HasUpdate {
		t.Fatalf("expected HasUpdate=false, got %#v", info)
	}
	if info.Channel != string(updateChannelDev) || info.LatestVersion != "dev-a1b2c3d" {
		t.Fatalf("unexpected dev latest info: %#v", info)
	}
}

func TestSetUpdateChannelPersistsAndClearsCachedUpdateState(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	app.updateState.lastCheck = &UpdateInfo{
		HasUpdate:     true,
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.6.5",
	}
	app.updateState.staged = &stagedUpdate{
		Channel:   updateChannelLatest,
		Version:   "0.6.5",
		AssetName: "GoNavi-0.6.5-Windows-Amd64.exe",
	}

	result := app.SetUpdateChannel("dev")
	if !result.Success {
		t.Fatalf("SetUpdateChannel returned failure: %#v", result)
	}

	stored, err := app.loadStoredUpdateChannel()
	if err != nil {
		t.Fatalf("loadStoredUpdateChannel returned error: %v", err)
	}
	if stored != updateChannelDev {
		t.Fatalf("expected stored dev channel, got %q", stored)
	}
	if app.updateState.lastCheck != nil || app.updateState.staged != nil {
		t.Fatalf("expected update cache to be cleared after channel switch, got %#v %#v", app.updateState.lastCheck, app.updateState.staged)
	}
}

func TestResolveReusableStagedUpdateDoesNotReuseDifferentChannelPackage(t *testing.T) {
	tempDir := t.TempDir()
	assetPath := filepath.Join(tempDir, "GoNavi-0.6.5-Windows-Amd64.exe")
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	reused := resolveReusableStagedUpdate(
		UpdateInfo{
			Channel:       string(updateChannelLatest),
			LatestVersion: "0.6.5",
			AssetName:     filepath.Base(assetPath),
			AssetSize:     8,
		},
		&stagedUpdate{
			Channel:   updateChannelDev,
			Version:   "0.6.5",
			AssetName: filepath.Base(assetPath),
			FilePath:  assetPath,
		},
	)
	if reused != nil {
		t.Fatalf("expected staged update from another channel to be ignored, got %#v", reused)
	}
}

func TestCheckForUpdatesDoesNotMutatePublishedStagedUpdate(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())

	installMode := updateResolveInstallMode()
	packageType := resolveUpdatePackageType(stdRuntime.GOOS, installMode)
	latestVersion := fmt.Sprintf("0.8.6-test-%d", time.Now().UnixNano())
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "v"+latestVersion, installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode returned error: %v", err)
	}
	workspaceDir := resolveUpdateWorkspaceDirForPlatform(stdRuntime.GOOS, latestVersion, installMode, "", "")
	t.Cleanup(func() { _ = os.RemoveAll(workspaceDir) })
	stagedDir := resolveUpdateStagedDirForPlatform(stdRuntime.GOOS, workspaceDir, string(updateChannelLatest), latestVersion)
	if err := os.MkdirAll(stagedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll staged directory: %v", err)
	}
	assetPath := filepath.Join(workspaceDir, assetName)
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	published := &stagedUpdate{
		Channel:      updateChannelLatest,
		Version:      latestVersion,
		AssetName:    assetName,
		WorkspaceDir: workspaceDir,
		FilePath:     assetPath,
		StagedDir:    stagedDir,
		InstallMode:  installMode,
		PackageType:  packageType,
		AutoRelaunch: true,
	}
	app.updateState.staged = published

	originalVersion := AppVersion
	AppVersion = "0.8.5"
	t.Cleanup(func() {
		AppVersion = originalVersion
	})
	restoreStatic := swapUpdateFetchStaticManifest(func(updateChannel) (*githubRelease, error) {
		return nil, errors.New("static manifest unavailable in test")
	})
	defer restoreStatic()
	restoreRelease := swapUpdateFetchLatestRelease(func() (*githubRelease, error) {
		return &githubRelease{
			TagName: "v" + latestVersion,
			Name:    "v" + latestVersion,
			HTMLURL: "https://example.com/releases/v" + latestVersion,
			Assets: []githubAsset{{
				Name:               assetName,
				BrowserDownloadURL: "https://example.com/" + assetName,
				Digest:             "sha256:" + strings.Repeat("a", 64),
				Size:               8,
			}},
		}, nil
	})
	defer restoreRelease()

	result := app.CheckForUpdates()
	if !result.Success {
		t.Fatalf("CheckForUpdates returned failure: %#v", result)
	}
	if published.InstallLogPath != "" {
		t.Fatalf("published staged update was mutated outside updateMu: %#v", published)
	}
	if app.updateState.staged == published {
		t.Fatal("expected refreshed update state to publish an immutable staged snapshot")
	}
	if app.updateState.staged == nil || app.updateState.staged.InstallLogPath == "" {
		t.Fatalf("expected refreshed snapshot to include install log path, got %#v", app.updateState.staged)
	}
}

func TestPublishUpdateCheckSnapshotRejectsStaleRevision(t *testing.T) {
	app := NewApp()
	downloaded := &stagedUpdate{
		Channel:     updateChannelLatest,
		Version:     "0.8.7",
		AssetName:   "downloaded.zip",
		FilePath:    filepath.Join(t.TempDir(), "downloaded.zip"),
		InstallMode: updateInstallModePortable,
		PackageType: updatePackageTypePortable,
	}
	app.updateState.staged = downloaded
	app.updateState.revision = 2

	published := app.publishUpdateCheckSnapshot(1, UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.6",
	}, &stagedUpdate{
		Channel:   updateChannelLatest,
		Version:   "0.8.6",
		FilePath:  filepath.Join(t.TempDir(), "stale.zip"),
		AssetName: "stale.zip",
	})
	if published {
		t.Fatal("stale update check unexpectedly overwrote newer state")
	}
	if app.updateState.staged != downloaded {
		t.Fatalf("newer downloaded package was replaced: %#v", app.updateState.staged)
	}
	if app.updateState.lastCheck != nil {
		t.Fatalf("stale check published lastCheck: %#v", app.updateState.lastCheck)
	}
	if app.updateState.revision != 2 {
		t.Fatalf("stale publish changed revision to %d", app.updateState.revision)
	}
}

func TestPublishUpdateCheckSnapshotRejectsChecksDuringDownload(t *testing.T) {
	app := NewApp()
	existing := &UpdateInfo{
		HasUpdate:     true,
		Channel:       string(updateChannelDev),
		LatestVersion: "dev-downloading",
	}
	app.updateState.lastCheck = existing
	app.updateState.downloading = true
	app.updateState.revision = 4

	published := app.publishUpdateCheckSnapshot(4, UpdateInfo{
		HasUpdate:     true,
		Channel:       string(updateChannelDev),
		LatestVersion: "dev-background-check",
	}, nil)
	if published {
		t.Fatal("background check published while a download lease was active")
	}
	if app.updateState.lastCheck != existing || app.updateState.revision != 4 {
		t.Fatalf("background check changed active download state: %#v", app.updateState)
	}
}

func TestCheckForUpdatesRejectsResultWhenStateChangesDuringFetch(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	app.SetLanguage("en-US")
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())

	installMode := updateResolveInstallMode()
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "v0.8.6", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode returned error: %v", err)
	}
	originalVersion := AppVersion
	AppVersion = "0.8.5"
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	var mutateOnce sync.Once
	restoreStatic := swapUpdateFetchStaticManifest(func(updateChannel) (*githubRelease, error) {
		mutateOnce.Do(func() {
			app.updateMu.Lock()
			app.updateState.revision++
			app.updateMu.Unlock()
		})
		return &githubRelease{
			TagName: "v0.8.6",
			Name:    "v0.8.6",
			HTMLURL: "https://example.com/releases/v0.8.6",
			Assets: []githubAsset{{
				Name:               assetName,
				BrowserDownloadURL: "https://example.com/" + assetName,
				Digest:             "sha256:" + strings.Repeat("a", 64),
				Size:               8,
			}},
		}, nil
	})
	defer restoreStatic()

	result := app.CheckForUpdates()
	if result.Success {
		t.Fatalf("stale update check unexpectedly succeeded: %#v", result)
	}
	if !strings.Contains(result.Message, "state changed") {
		t.Fatalf("expected stale-state message, got %q", result.Message)
	}
	if app.updateState.lastCheck != nil || app.updateState.staged != nil {
		t.Fatalf("stale check changed update state: %#v", app.updateState)
	}
}

func TestCheckForUpdatesDoesNotRaceWithInstallSnapshot(t *testing.T) {
	if stdRuntime.GOOS != "windows" {
		t.Skip("windows-only updater concurrency coverage")
	}

	app := NewApp()
	app.configDir = t.TempDir()
	app.SetLanguage("en-US")
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())

	stagedDir := t.TempDir()
	assetName := "GoNavi-0.8.6-Windows-Amd64-Portable.zip"
	assetPath := filepath.Join(stagedDir, assetName)
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	published := &stagedUpdate{
		Channel:        updateChannelLatest,
		Version:        "0.8.6",
		AssetName:      assetName,
		FilePath:       assetPath,
		StagedDir:      stagedDir,
		InstallLogPath: filepath.Join(stagedDir, "install.log"),
		InstallMode:    updateInstallModePortable,
		PackageType:    updatePackageTypePortable,
		AutoRelaunch:   true,
	}
	app.updateState.staged = published

	originalVersion := AppVersion
	originalResolveInstallTarget := updateResolveInstallTarget
	originalResolveInstallMode := updateResolveInstallMode
	originalAcquireMaintenance := updateAcquireWindowsMaintenance
	originalFindOtherInstances := updateFindOtherWindowsInstances
	originalLaunchInstallScript := updateLaunchInstallScript
	t.Cleanup(func() {
		AppVersion = originalVersion
		updateResolveInstallTarget = originalResolveInstallTarget
		updateResolveInstallMode = originalResolveInstallMode
		updateAcquireWindowsMaintenance = originalAcquireMaintenance
		updateFindOtherWindowsInstances = originalFindOtherInstances
		updateLaunchInstallScript = originalLaunchInstallScript
	})
	AppVersion = "0.8.5"
	updateResolveInstallTarget = func() string {
		return filepath.Join(stagedDir, "GoNavi.exe")
	}
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModePortable }
	updateAcquireWindowsMaintenance = func(string) (windowsUpdateMaintenanceLease, error) {
		return windowsUpdateMaintenanceLease{}, nil
	}
	updateFindOtherWindowsInstances = func([]string, int) ([]windowsUpdateProcess, error) {
		return nil, nil
	}

	installStarted := make(chan struct{})
	startMutation := make(chan struct{})
	checkDone := make(chan struct{})
	launcherErr := errors.New("stop after snapshot race probe")
	updateLaunchInstallScript = func(staged *stagedUpdate) error {
		close(installStarted)
		<-startMutation
		for {
			select {
			case <-checkDone:
				return launcherErr
			default:
				staged.FilePath = assetPath
				staged.InstallLogPath = filepath.Join(stagedDir, "install.log")
				stdRuntime.Gosched()
			}
		}
	}

	restoreStatic := swapUpdateFetchStaticManifest(func(updateChannel) (*githubRelease, error) {
		<-installStarted
		close(startMutation)
		return &githubRelease{
			TagName: "v0.8.6",
			Name:    "v0.8.6",
			HTMLURL: "https://example.com/releases/v0.8.6",
			Assets: []githubAsset{{
				Name:               assetName,
				BrowserDownloadURL: "https://example.com/" + assetName,
				Digest:             "sha256:" + strings.Repeat("a", 64),
				Size:               8,
			}},
		}, nil
	})
	defer restoreStatic()

	installResult := make(chan connection.QueryResult, 1)
	go func() {
		installResult <- app.InstallUpdateAndRestart(true)
	}()

	checkResult := app.CheckForUpdates()
	close(checkDone)
	if !checkResult.Success {
		t.Fatalf("CheckForUpdates returned failure: %#v", checkResult)
	}
	result := <-installResult
	if result.Success || !strings.Contains(result.Message, launcherErr.Error()) {
		t.Fatalf("expected injected installer failure, got %#v", result)
	}
	if published.FilePath != assetPath || published.InstallLogPath != filepath.Join(stagedDir, "install.log") {
		t.Fatalf("published staged update changed during concurrent check/install: %#v", published)
	}
}

func TestResolveExecutablePathKeepsOriginalWhenEvalSymlinksFails(t *testing.T) {
	original := filepath.Join(t.TempDir(), "GoNavi.exe")
	cases := []struct {
		name string
		eval func(string) (string, error)
	}{
		{
			name: "evaluation fails",
			eval: func(string) (string, error) { return "", errors.New("broken symlink") },
		},
		{
			name: "evaluation is empty",
			eval: func(string) (string, error) { return "", nil },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveExecutablePath(
				func() (string, error) { return original, nil },
				tc.eval,
			)
			if err != nil {
				t.Fatalf("resolveExecutablePath returned error: %v", err)
			}
			if got != original {
				t.Fatalf("resolveExecutablePath = %q, want original %q", got, original)
			}
		})
	}
}

func TestResolveReusableStagedUpdateForPlatformSkipsLegacyWindowsExeStagedAsset(t *testing.T) {
	preferredWorkspaceDir := t.TempDir()
	legacyWorkspaceDir := t.TempDir()
	info := UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.4",
		AssetName:     "GoNavi-0.8.4-Windows-Amd64-Portable.exe",
		AssetSize:     8,
	}

	legacyStagedDir := filepath.Join(
		legacyWorkspaceDir,
		buildUpdateStageDirNameForPlatform("windows", info.Channel, info.LatestVersion),
	)
	if err := os.MkdirAll(legacyStagedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	legacyAssetPath := filepath.Join(legacyStagedDir, info.AssetName)
	if err := os.WriteFile(legacyAssetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	reused := resolveReusableStagedUpdateForPlatform("windows", preferredWorkspaceDir, legacyWorkspaceDir, info, nil)
	if reused != nil {
		t.Fatalf("expected legacy staged windows exe to be ignored, got %#v", reused)
	}
}

func TestResolveReusableStagedUpdateForPlatformPrefersAssetInCacheWorkspace(t *testing.T) {
	preferredWorkspaceDir := t.TempDir()
	legacyWorkspaceDir := t.TempDir()
	info := UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.4",
		AssetName:     "GoNavi-0.8.4-Windows-Amd64-Portable.exe",
		AssetSize:     8,
	}

	preferredAssetPath := filepath.Join(preferredWorkspaceDir, info.AssetName)
	if err := os.WriteFile(preferredAssetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	legacyStagedDir := filepath.Join(
		legacyWorkspaceDir,
		buildUpdateStageDirNameForPlatform("windows", info.Channel, info.LatestVersion),
	)
	if err := os.MkdirAll(legacyStagedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	legacyAssetPath := filepath.Join(legacyStagedDir, info.AssetName)
	if err := os.WriteFile(legacyAssetPath, []byte("87654321"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	reused := resolveReusableStagedUpdateForPlatform("windows", preferredWorkspaceDir, legacyWorkspaceDir, info, nil)
	if reused == nil {
		t.Fatal("expected cache workspace windows exe to be reused")
	}
	if reused.FilePath != preferredAssetPath {
		t.Fatalf("expected preferred cache asset %q, got %q", preferredAssetPath, reused.FilePath)
	}
	if reused.WorkspaceDir != preferredWorkspaceDir {
		t.Fatalf("expected workspace %q, got %q", preferredWorkspaceDir, reused.WorkspaceDir)
	}
}

func TestResolveReusableStagedUpdateForPlatformDoesNotReuseCurrentWindowsExeInsideStagedDir(t *testing.T) {
	preferredWorkspaceDir := t.TempDir()
	legacyWorkspaceDir := t.TempDir()
	info := UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.4",
		AssetName:     "GoNavi-0.8.4-Windows-Amd64-Portable.exe",
		AssetSize:     8,
	}

	legacyStagedDir := filepath.Join(
		legacyWorkspaceDir,
		buildUpdateStageDirNameForPlatform("windows", info.Channel, info.LatestVersion),
	)
	if err := os.MkdirAll(legacyStagedDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	legacyAssetPath := filepath.Join(legacyStagedDir, info.AssetName)
	if err := os.WriteFile(legacyAssetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	reused := resolveReusableStagedUpdateForPlatform("windows", preferredWorkspaceDir, legacyWorkspaceDir, info, &stagedUpdate{
		Channel:   updateChannelLatest,
		Version:   info.LatestVersion,
		AssetName: info.AssetName,
		FilePath:  legacyAssetPath,
		StagedDir: legacyStagedDir,
	})
	if reused != nil {
		t.Fatalf("expected current staged windows exe inside staging dir to be ignored, got %#v", reused)
	}
}

func TestResolveReusableStagedUpdateForPlatformReusesPortableZipFromFallbackWorkspaceRoot(t *testing.T) {
	preferredWorkspaceDir := t.TempDir()
	legacyWorkspaceDir := t.TempDir()
	info := UpdateInfo{
		Channel:       string(updateChannelLatest),
		LatestVersion: "0.8.5",
		AssetName:     "GoNavi-0.8.5-Windows-Amd64-Portable.zip",
		AssetSize:     8,
		InstallMode:   string(updateInstallModePortable),
		PackageType:   string(updatePackageTypePortable),
		AutoRelaunch:  true,
	}

	assetPath := filepath.Join(legacyWorkspaceDir, info.AssetName)
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	reused := resolveReusableStagedUpdateForPlatform("windows", preferredWorkspaceDir, legacyWorkspaceDir, info, nil)
	if reused == nil {
		t.Fatal("expected fallback workspace portable ZIP to be reused")
	}
	if reused.FilePath != assetPath || reused.WorkspaceDir != legacyWorkspaceDir || reused.PackageType != updatePackageTypePortable {
		t.Fatalf("unexpected reused portable ZIP: %#v", reused)
	}
}

func TestDownloadUpdateUsesCurrentLanguageForBackendMessage(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	result := app.DownloadUpdate()
	if result.Success {
		t.Fatalf("expected failure result, got %#v", result)
	}
	if result.Message != "Check for updates first" {
		t.Fatalf("expected localized message, got %q", result.Message)
	}
}

func TestDownloadUpdateRefreshesDevReleaseAfterCachedAssetExpires(t *testing.T) {
	app, installMode := newDevUpdateDownloadTestApp(t)

	staleAssetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-stale", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode stale: %v", err)
	}
	freshAssetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-fresh", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode fresh: %v", err)
	}
	staleHits := 0
	freshPayload := []byte("fresh dev update package")
	freshHash := fmt.Sprintf("%x", sha256.Sum256(freshPayload))
	freshHits := 0
	staleURL := devUpdateDispatcherAssetURL("dev-stale", staleAssetName)
	freshURL := devUpdateDispatcherAssetURL("dev-fresh", freshAssetName)
	stubDevUpdateDownloadFile(t, func(rawURL string, assetPath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
		if !dispatcherURLRequiresCurrentDevAsset(rawURL) {
			t.Fatalf("dev download is not gated: %q", rawURL)
		}
		switch rawURL {
		case downloadDispatcherURLRequiringCurrentDevAsset(staleURL):
			staleHits++
			return "", downloadCurrentAssetTerminalError{
				cause: localizedUpdateError{httpStatus: http.StatusNotFound},
			}
		case downloadDispatcherURLRequiringCurrentDevAsset(freshURL):
			freshHits++
			if err := os.WriteFile(assetPath, freshPayload, 0o644); err != nil {
				return "", err
			}
			if onProgress != nil {
				onProgress(int64(len(freshPayload)), expectedSize)
			}
			return freshHash, nil
		default:
			t.Fatalf("unexpected Dispatcher asset URL: %q", rawURL)
			return "", nil
		}
	})

	app.updateState.lastCheck = &UpdateInfo{
		HasUpdate:      true,
		Channel:        string(updateChannelDev),
		CurrentVersion: AppVersion,
		LatestVersion:  "dev-stale",
		AssetName:      staleAssetName,
		AssetURL:       staleURL,
		AssetAPIURL:    "https://api.github.com/repos/Syngnat/GoNavi/releases/assets/123",
		AssetSize:      5,
		SHA256:         strings.Repeat("a", 64),
		InstallMode:    string(installMode),
		PackageType:    string(resolveUpdatePackageType(stdRuntime.GOOS, installMode)),
		AutoRelaunch:   true,
	}
	app.updateState.staged = &stagedUpdate{
		Channel:   updateChannelDev,
		Version:   "dev-stale",
		AssetName: staleAssetName,
		FilePath:  filepath.Join(t.TempDir(), staleAssetName),
	}

	staticCalls := 0
	leaseObserved := false
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		staticCalls++
		if channel != updateChannelDev {
			t.Fatalf("update channel = %q, want dev", channel)
		}
		app.updateMu.Lock()
		leaseObserved = app.updateState.downloading
		stagedDuringRefresh := app.updateState.staged
		app.updateMu.Unlock()
		if !leaseObserved || stagedDuringRefresh != nil {
			t.Fatalf("download lease did not clear the stale package before refresh: %#v", app.updateState)
		}
		return &githubRelease{
			TagName: updateDevReleaseTag,
			Name:    "Dev Build (dev-fresh)",
			Assets: []githubAsset{{
				Name:               freshAssetName,
				BrowserDownloadURL: freshURL,
				URL:                "https://api.github.com/repos/Syngnat/GoNavi/releases/assets/456",
				Digest:             "sha256:" + freshHash,
				Size:               int64(len(freshPayload)),
			}},
		}, nil
	})
	defer restoreStatic()

	result := app.DownloadUpdate()
	if !result.Success {
		t.Fatalf("DownloadUpdate returned failure: %#v", result)
	}
	if staticCalls != 1 {
		t.Fatalf("static manifest calls = %d, want 1", staticCalls)
	}
	if !leaseObserved {
		t.Fatal("download lease was not visible during the dev refresh")
	}
	if staleHits != 1 {
		t.Fatalf("stale asset hits = %d, want 1", staleHits)
	}
	if freshHits == 0 {
		t.Fatal("fresh asset was not requested")
	}
	if app.updateState.lastCheck == nil || app.updateState.lastCheck.LatestVersion != "dev-fresh" {
		t.Fatalf("lastCheck was not refreshed: %#v", app.updateState.lastCheck)
	}
	if app.updateState.staged == nil || app.updateState.staged.Version != "dev-fresh" {
		t.Fatalf("fresh package was not staged: %#v", app.updateState.staged)
	}
	payload, err := os.ReadFile(app.updateState.staged.FilePath)
	if err != nil {
		t.Fatalf("ReadFile downloaded update: %v", err)
	}
	if string(payload) != string(freshPayload) {
		t.Fatalf("downloaded payload = %q, want %q", payload, freshPayload)
	}
}

func stubDevUpdateDownloadFile(t *testing.T, handler func(url string, assetPath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error)) {
	t.Helper()
	original := updateDownloadFileWithExpectedSize
	updateDownloadFileWithExpectedSize = func(url string, assetPath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
		return handler(url, assetPath, onProgress, expectedSize)
	}
	t.Cleanup(func() {
		updateDownloadFileWithExpectedSize = original
	})
}

func TestDownloadUpdateUsesHealthyCachedDevAssetWithoutRefreshingManifest(t *testing.T) {
	app, installMode := newDevUpdateDownloadTestApp(t)

	payload := []byte("healthy cached dev update package")
	hits := 0
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-cached", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode: %v", err)
	}
	assetURL := devUpdateDispatcherAssetURL("dev-cached", assetName)
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))
	stubDevUpdateDownloadFile(t, func(rawURL string, assetPath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
		if rawURL != downloadDispatcherURLRequiringCurrentDevAsset(assetURL) {
			t.Fatalf("cached dev asset URL = %q, want gated Dispatcher URL", rawURL)
		}
		hits++
		if err := os.WriteFile(assetPath, payload, 0o644); err != nil {
			return "", err
		}
		if onProgress != nil {
			onProgress(int64(len(payload)), expectedSize)
		}
		return hash, nil
	})
	app.updateState.lastCheck = updateInfoFromReleaseForTest(
		t,
		devUpdateReleaseForTest(t, "dev-cached", assetURL, payload, installMode),
		installMode,
	)

	staticCalls := 0
	restoreStatic := swapUpdateFetchStaticManifest(func(updateChannel) (*githubRelease, error) {
		staticCalls++
		return nil, errors.New("manifest must not be refreshed for a healthy cached dev asset")
	})
	defer restoreStatic()

	result := app.DownloadUpdate()
	if !result.Success {
		t.Fatalf("DownloadUpdate returned failure: %#v", result)
	}
	if staticCalls != 0 {
		t.Fatalf("static manifest calls = %d, want 0", staticCalls)
	}
	if hits == 0 {
		t.Fatal("cached dev asset was not requested")
	}
	if app.updateState.staged == nil || app.updateState.staged.Version != "dev-cached" {
		t.Fatalf("cached dev package was not staged: %#v", app.updateState.staged)
	}
}

func TestPrepareUpdateDownloadCandidateRecognizesAlreadyGatedDevAsset(t *testing.T) {
	alreadyGated := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip&require-current=1"
	candidate, requiresCurrent := prepareUpdateDownloadCandidate(alreadyGated, true)
	if candidate != alreadyGated || !requiresCurrent {
		t.Fatalf("already-gated candidate = %q, requiresCurrent=%v", candidate, requiresCurrent)
	}

	plainDev := "https://download-dispatch.syngnat.top/v1/resolve?path=%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-abc1234%2FGoNavi.zip"
	candidate, requiresCurrent = prepareUpdateDownloadCandidate(plainDev, true)
	if !requiresCurrent || !strings.Contains(candidate, "require-current=1") {
		t.Fatalf("plain dev candidate was not gated: %q requiresCurrent=%v", candidate, requiresCurrent)
	}

	secondary, requiresCurrent := prepareUpdateDownloadCandidate(alreadyGated, false)
	if secondary != alreadyGated || requiresCurrent {
		t.Fatalf("secondary candidate = %q, requiresCurrent=%v", secondary, requiresCurrent)
	}
}

func TestDownloadUpdateAssetWithFallbackRejectsMalformedDispatcherWithoutUsingNextURL(t *testing.T) {
	original := updateDownloadFileWithExpectedSize
	t.Cleanup(func() {
		updateDownloadFileWithExpectedSize = original
	})
	var attempts []string
	updateDownloadFileWithExpectedSize = func(rawURL string, _ string, _ func(downloaded, total int64), _ int64) (string, error) {
		attempts = append(attempts, rawURL)
		if len(attempts) == 1 {
			return "", errInvalidDownloadDispatcherURL
		}
		return strings.Repeat("a", 64), nil
	}

	validPath := "%2Fgonavi%2Fdev%2Freleases%2Fdownload%2Fdev-current%2FGoNavi.zip"
	malformedURL := "https://download-dispatch.syngnat.top/v1/resolve?path=" + validPath + "&path=" + validPath
	_, err := downloadUpdateAssetWithFallback(
		[]string{malformedURL, "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip"},
		filepath.Join(t.TempDir(), "GoNavi.zip"),
		"",
		0,
		nil,
	)
	if !errors.Is(err, errInvalidDownloadDispatcherURL) {
		t.Fatalf("malformed Dispatcher update error = %v, want typed invalid URL", err)
	}
	if len(attempts) != 1 || attempts[0] != malformedURL {
		t.Fatalf("malformed Dispatcher update attempts = %#v, want only the invalid primary URL", attempts)
	}
}

func TestDownloadUpdateAssetWithFallbackContinuesAfterGatedNetworkFailure(t *testing.T) {
	payload := []byte("update package from GitHub")
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	assetPath := filepath.Join(t.TempDir(), "GoNavi.zip")
	asset := "/gonavi/dev/releases/download/dev-current/GoNavi.zip"
	gated := downloadDispatcherURLRequiringCurrentDevAsset(downloadDispatcherURLForPath(asset))
	cst := "https://download.syngnat.top" + asset
	bero := "https://origin-download.syngnat.top:8443" + asset
	github := "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip"

	var attempts []string
	stubDevUpdateDownloadFile(t, func(rawURL string, path string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
		attempts = append(attempts, rawURL)
		switch rawURL {
		case gated:
			return "", errors.New("Cst Dispatcher connection refused")
		case cst, bero:
			return "", errors.New("mirror unavailable")
		case github:
			if err := os.WriteFile(path, payload, 0o644); err != nil {
				return "", err
			}
			if onProgress != nil {
				onProgress(int64(len(payload)), expectedSize)
			}
			return expectedHash, nil
		default:
			t.Fatalf("unexpected update candidate: %q", rawURL)
			return "", nil
		}
	})

	gotHash, err := downloadUpdateAssetWithFallback(
		[]string{downloadDispatcherURLForPath(asset), cst, bero, github},
		assetPath,
		expectedHash,
		int64(len(payload)),
		nil,
	)
	if err != nil {
		t.Fatalf("gated network failure did not fall back: %v", err)
	}
	if gotHash != expectedHash {
		t.Fatalf("actual hash = %q, want %q", gotHash, expectedHash)
	}
	wantAttempts := []string{gated, cst, bero, github}
	if !reflect.DeepEqual(attempts, wantAttempts) {
		t.Fatalf("update candidate order = %#v, want %#v", attempts, wantAttempts)
	}
	gotPayload, err := os.ReadFile(assetPath)
	if err != nil {
		t.Fatalf("read downloaded update: %v", err)
	}
	if string(gotPayload) != string(payload) {
		t.Fatalf("downloaded payload = %q, want %q", gotPayload, payload)
	}
}

func TestDownloadUpdateRefreshesDevReleaseOnceAfterExpiredAsset(t *testing.T) {
	app, installMode := newDevUpdateDownloadTestApp(t)

	expiredAssetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-expired", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode expired: %v", err)
	}
	freshAssetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-replacement", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode replacement: %v", err)
	}
	expiredHits := 0
	freshPayload := []byte("replacement dev update package")
	freshHash := fmt.Sprintf("%x", sha256.Sum256(freshPayload))
	freshHits := 0
	expiredURL := devUpdateDispatcherAssetURL("dev-expired", expiredAssetName)
	freshURL := devUpdateDispatcherAssetURL("dev-replacement", freshAssetName)
	stubDevUpdateDownloadFile(t, func(rawURL string, assetPath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
		if !dispatcherURLRequiresCurrentDevAsset(rawURL) {
			t.Fatalf("dev download is not gated: %q", rawURL)
		}
		switch rawURL {
		case downloadDispatcherURLRequiringCurrentDevAsset(expiredURL):
			expiredHits++
			return "", downloadCurrentAssetTerminalError{
				cause: localizedUpdateError{httpStatus: http.StatusNotFound},
			}
		case downloadDispatcherURLRequiringCurrentDevAsset(freshURL):
			freshHits++
			if err := os.WriteFile(assetPath, freshPayload, 0o644); err != nil {
				return "", err
			}
			if onProgress != nil {
				onProgress(int64(len(freshPayload)), expectedSize)
			}
			return freshHash, nil
		default:
			t.Fatalf("unexpected Dispatcher asset URL: %q", rawURL)
			return "", nil
		}
	})

	expiredRelease := devUpdateReleaseForTest(t, "dev-expired", expiredURL, []byte("expired payload"), installMode)
	freshRelease := devUpdateReleaseForTest(t, "dev-replacement", freshURL, freshPayload, installMode)
	app.updateState.lastCheck = updateInfoFromReleaseForTest(t, expiredRelease, installMode)

	staticCalls := 0
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		staticCalls++
		if channel != updateChannelDev {
			t.Fatalf("update channel = %q, want dev", channel)
		}
		return freshRelease, nil
	})
	defer restoreStatic()

	result := app.DownloadUpdate()
	if !result.Success {
		t.Fatalf("DownloadUpdate returned failure: %#v", result)
	}
	if staticCalls != 1 {
		t.Fatalf("static manifest calls = %d, want 1", staticCalls)
	}
	if expiredHits != 1 {
		t.Fatalf("expired asset hits = %d, want 1", expiredHits)
	}
	if freshHits == 0 {
		t.Fatal("replacement asset was not requested")
	}
	if app.updateState.staged == nil || app.updateState.staged.Version != "dev-replacement" {
		t.Fatalf("replacement package was not staged: %#v", app.updateState.staged)
	}
}

func TestDownloadUpdateDoesNotRetryUnchangedExpiredDevAsset(t *testing.T) {
	app, installMode := newDevUpdateDownloadTestApp(t)

	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-expired", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode expired: %v", err)
	}
	assetURL := devUpdateDispatcherAssetURL("dev-expired", assetName)
	expiredHits := 0
	stubDevUpdateDownloadFile(t, func(rawURL string, _ string, _ func(downloaded, total int64), _ int64) (string, error) {
		if rawURL != downloadDispatcherURLRequiringCurrentDevAsset(assetURL) {
			t.Fatalf("expired dev asset URL = %q", rawURL)
		}
		expiredHits++
		return "", downloadCurrentAssetTerminalError{
			cause: localizedUpdateError{httpStatus: http.StatusNotFound},
		}
	})

	expiredRelease := devUpdateReleaseForTest(t, "dev-expired", assetURL, []byte("expired payload"), installMode)
	app.updateState.lastCheck = updateInfoFromReleaseForTest(t, expiredRelease, installMode)

	staticCalls := 0
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		staticCalls++
		return expiredRelease, nil
	})
	defer restoreStatic()

	result := app.DownloadUpdate()
	if result.Success {
		t.Fatalf("DownloadUpdate unexpectedly succeeded: %#v", result)
	}
	if staticCalls != 1 {
		t.Fatalf("static manifest calls = %d, want 1", staticCalls)
	}
	if expiredHits != 1 {
		t.Fatalf("expired asset hits = %d, want exactly 1", expiredHits)
	}
	if result.Message != "" {
		t.Fatalf("DownloadUpdate message = %q, want empty test-only stub message", result.Message)
	}
}

func TestDownloadUpdateWaitsForFutureDevAssetControlToConverge(t *testing.T) {
	app, installMode := newDevUpdateDownloadTestApp(t)

	payload := []byte("activated dev update package")
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-activating", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode activating: %v", err)
	}
	assetURL := devUpdateDispatcherAssetURL("dev-activating", assetName)
	expectedHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	assetHits := 0
	stubDevUpdateDownloadFile(t, func(rawURL string, assetPath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
		if rawURL != downloadDispatcherURLRequiringCurrentDevAsset(assetURL) {
			t.Fatalf("activating dev asset URL = %q", rawURL)
		}
		assetHits++
		if assetHits <= 2 {
			return "", downloadCurrentAssetMismatchError{}
		}
		if err := os.WriteFile(assetPath, payload, 0o644); err != nil {
			return "", err
		}
		if onProgress != nil {
			onProgress(int64(len(payload)), expectedSize)
		}
		return expectedHash, nil
	})

	pendingRelease := devUpdateReleaseForTest(t, "dev-activating", assetURL, payload, installMode)
	app.updateState.lastCheck = updateInfoFromReleaseForTest(t, pendingRelease, installMode)
	currentAssetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, AppVersion, installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode current: %v", err)
	}
	currentRelease := devUpdateReleaseForTest(
		t,
		AppVersion,
		devUpdateDispatcherAssetURL(AppVersion, currentAssetName),
		[]byte("already installed dev package"),
		installMode,
	)

	staticCalls := 0
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		staticCalls++
		if channel != updateChannelDev {
			t.Fatalf("update channel = %q, want dev", channel)
		}
		return currentRelease, nil
	})
	defer restoreStatic()

	originalSleep := updateCurrentDevAssetRetrySleep
	var retryDelays []time.Duration
	updateCurrentDevAssetRetrySleep = func(delay time.Duration) {
		retryDelays = append(retryDelays, delay)
	}
	t.Cleanup(func() {
		updateCurrentDevAssetRetrySleep = originalSleep
	})

	result := app.DownloadUpdate()
	if !result.Success {
		t.Fatalf("DownloadUpdate returned failure: %#v", result)
	}
	if assetHits != 3 {
		t.Fatalf("activating asset hits = %d, want 3", assetHits)
	}
	if staticCalls != 2 {
		t.Fatalf("static manifest calls = %d, want 2", staticCalls)
	}
	if !reflect.DeepEqual(retryDelays, []time.Duration{time.Second, 2 * time.Second}) {
		t.Fatalf("retry delays = %v, want [1s 2s]", retryDelays)
	}
	if app.updateState.staged == nil || app.updateState.staged.Version != "dev-activating" {
		t.Fatalf("activated package was not staged: %#v", app.updateState.staged)
	}
}

func TestDownloadUpdateStopsWaitingWhenDevAssetControlDoesNotConverge(t *testing.T) {
	app, installMode := newDevUpdateDownloadTestApp(t)

	payload := []byte("never activated dev update package")
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-not-activated", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode not activated: %v", err)
	}
	assetURL := devUpdateDispatcherAssetURL("dev-not-activated", assetName)
	assetHits := 0
	stubDevUpdateDownloadFile(t, func(rawURL string, _ string, _ func(downloaded, total int64), _ int64) (string, error) {
		if rawURL != downloadDispatcherURLRequiringCurrentDevAsset(assetURL) {
			t.Fatalf("not activated dev asset URL = %q", rawURL)
		}
		assetHits++
		return "", downloadCurrentAssetMismatchError{}
	})

	pendingRelease := devUpdateReleaseForTest(t, "dev-not-activated", assetURL, payload, installMode)
	app.updateState.lastCheck = updateInfoFromReleaseForTest(t, pendingRelease, installMode)
	currentAssetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, AppVersion, installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode current: %v", err)
	}
	currentRelease := devUpdateReleaseForTest(
		t,
		AppVersion,
		devUpdateDispatcherAssetURL(AppVersion, currentAssetName),
		[]byte("already installed dev package"),
		installMode,
	)

	staticCalls := 0
	restoreStatic := swapUpdateFetchStaticManifest(func(channel updateChannel) (*githubRelease, error) {
		staticCalls++
		if channel != updateChannelDev {
			t.Fatalf("update channel = %q, want dev", channel)
		}
		return currentRelease, nil
	})
	defer restoreStatic()

	originalSleep := updateCurrentDevAssetRetrySleep
	var retryDelays []time.Duration
	updateCurrentDevAssetRetrySleep = func(delay time.Duration) {
		retryDelays = append(retryDelays, delay)
	}
	t.Cleanup(func() {
		updateCurrentDevAssetRetrySleep = originalSleep
	})

	result := app.DownloadUpdate()
	if result.Success {
		t.Fatalf("DownloadUpdate unexpectedly succeeded: %#v", result)
	}
	if assetHits != 1+updateCurrentDevAssetRetryLimit {
		t.Fatalf("not activated asset hits = %d, want %d", assetHits, 1+updateCurrentDevAssetRetryLimit)
	}
	if staticCalls != 1+updateCurrentDevAssetRetryLimit {
		t.Fatalf("static manifest calls = %d, want %d", staticCalls, 1+updateCurrentDevAssetRetryLimit)
	}
	wantDelays := []time.Duration{
		time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		16 * time.Second,
		32 * time.Second,
		time.Minute,
		time.Minute,
	}
	if !reflect.DeepEqual(retryDelays, wantDelays) {
		t.Fatalf("retry delays = %v, want %v", retryDelays, wantDelays)
	}
	if app.updateState.staged != nil {
		t.Fatalf("not activated package was staged: %#v", app.updateState.staged)
	}
	if app.updateState.lastCheck == nil || !app.updateState.lastCheck.HasUpdate || app.updateState.lastCheck.LatestVersion != "dev-not-activated" {
		t.Fatalf("pending update was discarded after retries: %#v", app.updateState.lastCheck)
	}
}

func TestDownloadUpdateKeepsSingleLeaseWhileRefreshingAndDownloadingDevAsset(t *testing.T) {
	app, installMode := newDevUpdateDownloadTestApp(t)

	payload := []byte("blocking dev update package")
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-blocked", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode: %v", err)
	}
	assetURL := devUpdateDispatcherAssetURL("dev-blocked", assetName)
	requestStarted := make(chan struct{}, 1)
	releaseRequest := make(chan struct{})
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))
	stubDevUpdateDownloadFile(t, func(rawURL string, assetPath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
		if rawURL != downloadDispatcherURLRequiringCurrentDevAsset(assetURL) {
			t.Fatalf("blocked dev asset URL = %q", rawURL)
		}
		select {
		case requestStarted <- struct{}{}:
		default:
		}
		<-releaseRequest
		if err := os.WriteFile(assetPath, payload, 0o644); err != nil {
			return "", err
		}
		if onProgress != nil {
			onProgress(int64(len(payload)), expectedSize)
		}
		return hash, nil
	})

	release := devUpdateReleaseForTest(t, "dev-blocked", assetURL, payload, installMode)
	app.updateState.lastCheck = updateInfoFromReleaseForTest(t, release, installMode)
	restoreStatic := swapUpdateFetchStaticManifest(func(updateChannel) (*githubRelease, error) {
		return release, nil
	})
	defer restoreStatic()

	firstResult := make(chan connection.QueryResult, 1)
	go func() {
		firstResult <- app.DownloadUpdate()
	}()

	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		close(releaseRequest)
		t.Fatal("first download did not reach the asset server")
	}

	second := app.DownloadUpdate()
	if second.Success || second.Message != app.appText("app.update.backend.message.download_in_progress", nil) {
		close(releaseRequest)
		t.Fatalf("second DownloadUpdate should be rejected as in progress: %#v", second)
	}
	close(releaseRequest)

	select {
	case result := <-firstResult:
		if !result.Success {
			t.Fatalf("first DownloadUpdate returned failure: %#v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first DownloadUpdate did not finish")
	}
}

func TestStartUpdateDownloadKeepsTaskQueryableAfterStarterReturns(t *testing.T) {
	app, installMode := newDevUpdateDownloadTestApp(t)

	payload := []byte(strings.Repeat("x", 100))
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, "dev-background", installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode: %v", err)
	}
	assetURL := devUpdateDispatcherAssetURL("dev-background", assetName)
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))
	downloadReached := make(chan struct{}, 1)
	downloadURLMismatch := make(chan error, 1)
	releaseDownload := make(chan struct{})
	stubDevUpdateDownloadFile(t, func(rawURL string, assetPath string, onProgress func(downloaded, total int64), expectedSize int64) (string, error) {
		if rawURL != downloadDispatcherURLRequiringCurrentDevAsset(assetURL) {
			err := fmt.Errorf("background download URL = %q, want gated Dispatcher URL", rawURL)
			select {
			case downloadURLMismatch <- err:
			default:
			}
			return "", err
		}
		if onProgress != nil {
			onProgress(45, expectedSize)
		}
		select {
		case downloadReached <- struct{}{}:
		default:
		}
		<-releaseDownload
		if err := os.WriteFile(assetPath, payload, 0o644); err != nil {
			return "", err
		}
		if onProgress != nil {
			onProgress(int64(len(payload)), expectedSize)
		}
		return hash, nil
	})
	app.updateState.lastCheck = updateInfoFromReleaseForTest(
		t,
		devUpdateReleaseForTest(t, "dev-background", assetURL, payload, installMode),
		installMode,
	)

	start := app.StartUpdateDownload()
	if !start.Success {
		t.Fatalf("StartUpdateDownload returned failure: %#v", start)
	}
	startedTask := updateDownloadTaskFromResult(t, start)
	if startedTask.TaskID == "" || !startedTask.Running || startedTask.Status != "start" {
		t.Fatalf("unexpected initial background task: %#v", startedTask)
	}

	select {
	case <-downloadReached:
	case err := <-downloadURLMismatch:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		close(releaseDownload)
		t.Fatal("background update did not reach the download seam")
	}

	query := app.GetUpdateDownloadTask()
	if !query.Success {
		close(releaseDownload)
		t.Fatalf("GetUpdateDownloadTask returned failure: %#v", query)
	}
	inFlightTask := updateDownloadTaskFromResult(t, query)
	if inFlightTask.TaskID != startedTask.TaskID || !inFlightTask.Running || inFlightTask.Status != "downloading" || inFlightTask.Percent != 45 || inFlightTask.Downloaded != 45 || inFlightTask.Total != int64(len(payload)) {
		close(releaseDownload)
		t.Fatalf("query did not restore the in-flight task: %#v", inFlightTask)
	}

	reused := app.StartUpdateDownload()
	if !reused.Success {
		close(releaseDownload)
		t.Fatalf("second StartUpdateDownload returned failure: %#v", reused)
	}
	if reusedData, ok := reused.Data.(map[string]interface{}); !ok || reusedData["alreadyRunning"] != true {
		close(releaseDownload)
		t.Fatalf("second StartUpdateDownload did not reuse the active task: %#v", reused)
	}
	if reusedTask := updateDownloadTaskFromResult(t, reused); reusedTask.TaskID != startedTask.TaskID {
		close(releaseDownload)
		t.Fatalf("reused task ID = %q, want %q", reusedTask.TaskID, startedTask.TaskID)
	}

	close(releaseDownload)
	deadline := time.Now().Add(2 * time.Second)
	for {
		finished := updateDownloadTaskFromResult(t, app.GetUpdateDownloadTask())
		if !finished.Running {
			if finished.TaskID != startedTask.TaskID || finished.Status != "done" || finished.Percent != 100 || finished.Result == nil || !finished.Result.Info.Downloaded {
				t.Fatalf("unexpected completed background task: %#v", finished)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("background task did not finish: %#v", finished)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func updateDownloadTaskFromResult(t *testing.T, result connection.QueryResult) UpdateDownloadTaskStatus {
	t.Helper()
	data, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("update task result data type = %T, want map", result.Data)
	}
	switch task := data["task"].(type) {
	case *UpdateDownloadTaskStatus:
		if task == nil {
			t.Fatal("update task is nil")
		}
		return *snapshotUpdateDownloadTask(task)
	case UpdateDownloadTaskStatus:
		return task
	default:
		t.Fatalf("update task type = %T, want UpdateDownloadTaskStatus", data["task"])
		return UpdateDownloadTaskStatus{}
	}
}

func newDevUpdateDownloadTestApp(t *testing.T) (*App, updateInstallMode) {
	t.Helper()
	configureUpdateManifestHTTPTest(t)
	proxySnapshot := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatalf("disable global proxy: %v", err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy)
	})
	cacheRoot := t.TempDir()
	t.Setenv("HOME", cacheRoot)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(cacheRoot, "cache"))
	t.Setenv("LocalAppData", filepath.Join(cacheRoot, "cache"))

	originalVersion := AppVersion
	originalResolveInstallMode := updateResolveInstallMode
	AppVersion = "dev-current"
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModePortable }
	t.Cleanup(func() {
		AppVersion = originalVersion
		updateResolveInstallMode = originalResolveInstallMode
	})

	app := NewApp()
	app.configDir = t.TempDir()
	app.SetLanguage("en-US")
	if result := app.SetUpdateChannel(string(updateChannelDev)); !result.Success {
		t.Fatalf("SetUpdateChannel returned failure: %#v", result)
	}
	return app, updateInstallModePortable
}

func devUpdateReleaseForTest(t *testing.T, version string, assetURL string, payload []byte, installMode updateInstallMode) *githubRelease {
	t.Helper()
	assetName, err := expectedAssetNameForInstallMode(stdRuntime.GOOS, stdRuntime.GOARCH, version, installMode)
	if err != nil {
		t.Fatalf("expectedAssetNameForInstallMode %s: %v", version, err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(payload))
	return &githubRelease{
		TagName: updateDevReleaseTag,
		Name:    "Dev Build (" + version + ")",
		Assets: []githubAsset{{
			Name:               assetName,
			BrowserDownloadURL: assetURL,
			URL:                assetURL,
			Digest:             "sha256:" + digest,
			Size:               int64(len(payload)),
		}},
	}
}

func updateInfoFromReleaseForTest(t *testing.T, release *githubRelease, installMode updateInstallMode) *UpdateInfo {
	t.Helper()
	if release == nil || len(release.Assets) != 1 {
		t.Fatalf("invalid test release: %#v", release)
	}
	version := resolveReleaseVersion(updateChannelDev, release)
	asset := release.Assets[0]
	return &UpdateInfo{
		HasUpdate:      true,
		Channel:        string(updateChannelDev),
		CurrentVersion: AppVersion,
		LatestVersion:  version,
		AssetName:      asset.Name,
		AssetURL:       firstNonEmptyString(asset.BrowserDownloadURL, asset.URL),
		AssetAPIURL:    asset.URL,
		AssetSize:      asset.Size,
		SHA256:         normalizeGitHubAssetSHA256(asset.Digest),
		InstallMode:    string(installMode),
		PackageType:    string(resolveUpdatePackageType(stdRuntime.GOOS, installMode)),
		AutoRelaunch:   true,
	}
}

func TestEnsureWindowsUpdateTargetWritableAcceptsWritableDirectory(t *testing.T) {
	if stdRuntime.GOOS != "windows" {
		t.Skip("windows-only update target validation")
	}

	target := filepath.Join(t.TempDir(), "GoNavi.exe")
	if err := ensureWindowsUpdateTargetWritable(target); err != nil {
		t.Fatalf("ensureWindowsUpdateTargetWritable returned error: %v", err)
	}
}

func TestInstallUpdateAndRestartFailsBeforeLaunchWhenWindowsTargetDirIsNotWritable(t *testing.T) {
	if stdRuntime.GOOS != "windows" {
		t.Skip("windows-only update target validation")
	}

	stagedDir := t.TempDir()
	assetPath := filepath.Join(stagedDir, "GoNavi-0.8.2-Windows-Amd64-Portable.exe")
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	app := NewApp()
	app.updateState.staged = &stagedUpdate{
		Channel:      updateChannelLatest,
		Version:      "0.8.2",
		AssetName:    filepath.Base(assetPath),
		FilePath:     assetPath,
		StagedDir:    stagedDir,
		InstallMode:  updateInstallModePortable,
		PackageType:  updatePackageTypePortable,
		AutoRelaunch: true,
	}

	originalResolveInstallTarget := updateResolveInstallTarget
	originalLaunchInstallScript := updateLaunchInstallScript
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveInstallTarget
		updateLaunchInstallScript = originalLaunchInstallScript
	})

	updateResolveInstallTarget = func() string {
		return filepath.Join(stagedDir, "missing", "GoNavi.exe")
	}

	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		launched = true
		return nil
	}

	result := app.InstallUpdateAndRestart(true)
	if result.Success {
		t.Fatalf("expected InstallUpdateAndRestart to fail, got %#v", result)
	}
	if launched {
		t.Fatal("expected launch script to be skipped when install target is not writable")
	}
	if !strings.Contains(result.Message, "not writable") {
		t.Fatalf("expected install target write failure in message, got %q", result.Message)
	}
}

func TestInstallUpdateAndRestartRejectsUnresolvedWindowsTargetBeforeMaintenance(t *testing.T) {
	if stdRuntime.GOOS != "windows" {
		t.Skip("windows-only install target validation")
	}

	stagedDir := t.TempDir()
	assetPath := filepath.Join(stagedDir, "GoNavi-0.8.6-Windows-Amd64-Portable.zip")
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	app := NewApp()
	app.SetLanguage("en-US")
	app.updateState.staged = &stagedUpdate{
		Channel:      updateChannelLatest,
		Version:      "0.8.6",
		AssetName:    filepath.Base(assetPath),
		FilePath:     assetPath,
		StagedDir:    stagedDir,
		InstallMode:  updateInstallModePortable,
		PackageType:  updatePackageTypePortable,
		AutoRelaunch: true,
	}

	originalResolveInstallTarget := updateResolveInstallTarget
	originalResolveInstallMode := updateResolveInstallMode
	originalAcquireMaintenance := updateAcquireWindowsMaintenance
	originalLaunchInstallScript := updateLaunchInstallScript
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveInstallTarget
		updateResolveInstallMode = originalResolveInstallMode
		updateAcquireWindowsMaintenance = originalAcquireMaintenance
		updateLaunchInstallScript = originalLaunchInstallScript
	})
	updateResolveInstallTarget = func() string { return "" }
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModePortable }
	maintenanceCalled := false
	updateAcquireWindowsMaintenance = func(string) (windowsUpdateMaintenanceLease, error) {
		maintenanceCalled = true
		return windowsUpdateMaintenanceLease{}, nil
	}
	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		launched = true
		return nil
	}

	result := app.InstallUpdateAndRestart(true)
	if result.Success {
		t.Fatalf("expected unresolved install target failure, got %#v", result)
	}
	if maintenanceCalled {
		t.Fatal("maintenance must not be acquired for an unresolved install target")
	}
	if launched {
		t.Fatal("installer must not launch for an unresolved install target")
	}
	if !strings.Contains(result.Message, "Unable to determine") {
		t.Fatalf("expected localized unresolved target detail, got %q", result.Message)
	}
}

func TestInstallUpdateAndRestartMSISkipsPortableTargetWriteProbe(t *testing.T) {
	if stdRuntime.GOOS != "windows" {
		t.Skip("windows-only MSI launch validation")
	}

	stagedDir := t.TempDir()
	assetPath := filepath.Join(stagedDir, "GoNavi-0.8.2-Windows-Amd64-Installer.msi")
	if err := os.WriteFile(assetPath, []byte("12345678"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	app := NewApp()
	app.updateState.staged = &stagedUpdate{
		Channel:      updateChannelLatest,
		Version:      "0.8.2",
		AssetName:    filepath.Base(assetPath),
		FilePath:     assetPath,
		StagedDir:    stagedDir,
		InstallMode:  updateInstallModeMSI,
		PackageType:  updatePackageTypeMSI,
		AutoRelaunch: true,
	}

	originalResolveInstallTarget := updateResolveInstallTarget
	originalResolveInstallMode := updateResolveInstallMode
	originalLaunchInstallScript := updateLaunchInstallScript
	t.Cleanup(func() {
		updateResolveInstallTarget = originalResolveInstallTarget
		updateResolveInstallMode = originalResolveInstallMode
		updateLaunchInstallScript = originalLaunchInstallScript
	})
	updateResolveInstallTarget = func() string {
		return filepath.Join(stagedDir, "missing", "GoNavi.exe")
	}
	updateResolveInstallMode = func() updateInstallMode { return updateInstallModeMSI }
	launched := false
	updateLaunchInstallScript = func(*stagedUpdate) error {
		launched = true
		return errors.New("stop after MSI launcher reached")
	}

	result := app.InstallUpdateAndRestart(true)
	if result.Success {
		t.Fatalf("expected injected launcher error, got %#v", result)
	}
	if !launched {
		t.Fatal("expected MSI launcher to run without probing target directory writability")
	}
}

func TestResolveUpdateWorkspaceDirUsesVersionedUserCacheDirectory(t *testing.T) {
	cacheDir, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(cacheDir) == "" {
		t.Skip("user cache directory is unavailable")
	}
	got := resolveUpdateWorkspaceDir("0.8.2")
	want := filepath.Join(cacheDir, "GoNavi", "updates", "0.8.2")
	if got != want {
		t.Fatalf("expected workspace dir %q, got %q", want, got)
	}
}

func TestSanitizeVersionForPathRejectsDotSegments(t *testing.T) {
	for _, version := range []string{"", ".", "..", " / "} {
		if got := sanitizeVersionForPath(version); got != "latest" {
			t.Fatalf("sanitizeVersionForPath(%q) = %q, want latest", version, got)
		}
	}
}

func TestShouldStoreUpdateAssetInWorkspaceRoot(t *testing.T) {
	cases := []struct {
		goos string
		want bool
	}{
		{goos: "windows", want: true},
		{goos: "darwin", want: true},
		{goos: "linux", want: true},
		{goos: "freebsd", want: false},
	}

	for _, tc := range cases {
		if got := shouldStoreUpdateAssetInWorkspaceRoot(tc.goos); got != tc.want {
			t.Fatalf("shouldStoreUpdateAssetInWorkspaceRoot(%q) = %v, want %v", tc.goos, got, tc.want)
		}
	}
}

func TestResolveUpdateStagedDirForPlatformStaysInsideWorkspaceOnWindows(t *testing.T) {
	workspaceDir := filepath.Join("C:\\GoNavi", "app")
	got := resolveUpdateStagedDirForPlatform("windows", workspaceDir, "dev", "dev-93dc696")
	want := filepath.Join(workspaceDir, buildUpdateStageDirNameForPlatform("windows", "dev", "dev-93dc696"))
	if got != want {
		t.Fatalf("expected windows staged dir %q, got %q", want, got)
	}
}

func TestPrepareUpdateWorkspaceAndStagingDirsFallsBackWhenPreferredIsUnavailable(t *testing.T) {
	rootDir := t.TempDir()
	preferredDir := filepath.Join(rootDir, "unavailable")
	if err := os.WriteFile(preferredDir, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("WriteFile preferred path: %v", err)
	}
	fallbackDir := filepath.Join(rootDir, "GoNavi", "updates", "1.2.3")

	workspaceDir, stagedDir, err := prepareUpdateWorkspaceAndStagingDirs(
		[]string{preferredDir, fallbackDir},
		string(updateChannelLatest),
		"1.2.3",
	)
	if err != nil {
		t.Fatalf("prepareUpdateWorkspaceAndStagingDirs returned error: %v", err)
	}
	if workspaceDir != fallbackDir {
		t.Fatalf("workspace = %q, want fallback %q", workspaceDir, fallbackDir)
	}
	if !isUpdatePathStrictlyInsideDir(stagedDir, fallbackDir) {
		t.Fatalf("staging directory %q must be inside fallback workspace %q", stagedDir, fallbackDir)
	}
	if stat, err := os.Stat(stagedDir); err != nil || !stat.IsDir() {
		t.Fatalf("fallback staging directory was not created: stat=%v err=%v", stat, err)
	}
}

func TestValidateStagedUpdateWorkspaceAllowsVersionDirectoryUnderTempRoot(t *testing.T) {
	workspaceDir := filepath.Join(os.TempDir(), "GoNavi", "updates", "1.2.3")
	staged := &stagedUpdate{
		Version:        "1.2.3",
		WorkspaceDir:   workspaceDir,
		FilePath:       filepath.Join(workspaceDir, "GoNavi-1.2.3.dmg"),
		StagedDir:      filepath.Join(workspaceDir, ".gonavi-update-darwin-latest-1.2.3"),
		InstallLogPath: filepath.Join(workspaceDir, "gonavi-update-macos.log"),
	}
	if err := validateStagedUpdateWorkspace(staged); err != nil {
		t.Fatalf("valid update workspace rejected: %v", err)
	}
	wantCleanupDir := filepath.Join(os.TempDir(), "GoNavi", "updates")
	if got := resolveUpdateCleanupDir(staged.WorkspaceDir); got != wantCleanupDir {
		t.Fatalf("cleanup directory = %q, want entire updates directory %q", got, wantCleanupDir)
	}
}

func TestValidateStagedUpdateWorkspaceRejectsUnsafeCleanupTargets(t *testing.T) {
	updateRoot := filepath.Join(os.TempDir(), "GoNavi", "updates")
	validWorkspace := filepath.Join(updateRoot, "1.2.3")
	newStaged := func(workspaceDir string) *stagedUpdate {
		return &stagedUpdate{
			Version:        "1.2.3",
			WorkspaceDir:   workspaceDir,
			FilePath:       filepath.Join(workspaceDir, "GoNavi-1.2.3.dmg"),
			StagedDir:      filepath.Join(workspaceDir, "stage"),
			InstallLogPath: filepath.Join(workspaceDir, "update.log"),
		}
	}

	cases := []struct {
		name   string
		staged *stagedUpdate
	}{
		{name: "update root itself", staged: newStaged(updateRoot)},
		{name: "nested version directory", staged: newStaged(filepath.Join(updateRoot, "nested", "1.2.3"))},
		{name: "desktop directory", staged: newStaged(filepath.Join(os.TempDir(), "Desktop", "GoNavi-1.2.3"))},
		{name: "empty workspace", staged: newStaged("")},
	}
	outsidePackage := newStaged(validWorkspace)
	outsidePackage.FilePath = filepath.Join(os.TempDir(), "GoNavi-1.2.3.dmg")
	cases = append(cases, struct {
		name   string
		staged *stagedUpdate
	}{name: "package outside workspace", staged: outsidePackage})

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateStagedUpdateWorkspace(tc.staged); err == nil {
				t.Fatalf("unsafe workspace accepted: %#v", tc.staged)
			}
		})
	}
}

func TestExpectedAssetNameForExecutableUsesWindowsPortableSuffix(t *testing.T) {
	cases := []struct {
		name    string
		goarch  string
		version string
		want    string
	}{
		{
			name:    "amd64 release",
			goarch:  "amd64",
			version: "v1.2.3",
			want:    "GoNavi-1.2.3-Windows-Amd64-Portable.zip",
		},
		{
			name:    "arm64 dev",
			goarch:  "arm64",
			version: "dev-a1b2c3d",
			want:    "GoNavi-dev-a1b2c3d-Windows-Arm64-Portable.zip",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := expectedAssetNameForExecutable("windows", tc.goarch, tc.version, "")
			if err != nil {
				t.Fatalf("expectedAssetNameForExecutable returned error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("expectedAssetNameForExecutable() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBuildWindowsPowerShellScriptReplacesTargetWithDownloadedExe(t *testing.T) {
	script := buildWindowsPowerShellScript()

	mustContain := []string{
		`Move-Item -LiteralPath $Target -Destination $TargetOld -Force`,
		`Copy-Item -LiteralPath $SourceExe -Destination $Target -Force`,
		`Start-Process -FilePath $Target -WorkingDirectory $TargetDir`,
		`package kept for manual install`,
		`Remove-UpdateArtifact $Source`,
	}
	for _, want := range mustContain {
		if !strings.Contains(script, want) {
			t.Fatalf("windows update script missing required token: %s\nscript:\n%s", want, script)
		}
	}
	// relaunch 必须在删除安装包之前
	startIdx := strings.Index(script, `Start-Process -FilePath $Target -WorkingDirectory $TargetDir`)
	delIdx := strings.LastIndex(script, `Remove-UpdateArtifact $Source`)
	if startIdx < 0 || delIdx < 0 || delIdx < startIdx {
		t.Fatalf("source package must be deleted only after relaunch attempt (start=%d del=%d)", startIdx, delIdx)
	}
}

func TestExpectedAssetNameForExecutableUsesLinuxWebKit41Suffix(t *testing.T) {
	assetName, err := expectedAssetNameForExecutable(
		"linux",
		"amd64",
		"v0.6.5",
		"/opt/GoNavi/gonavi-build-linux-amd64-webkit41",
	)
	if err != nil {
		t.Fatalf("expectedAssetNameForExecutable returned error: %v", err)
	}

	want := "GoNavi-0.6.5-Linux-Amd64-WebKit41.tar.gz"
	if assetName != want {
		t.Fatalf("unexpected linux webkit41 asset name: got %q want %q", assetName, want)
	}
}

func TestExpectedAssetNameForExecutableSupportsLinuxArm64(t *testing.T) {
	assetName, err := expectedAssetNameForExecutable(
		"linux",
		"arm64",
		"v0.6.5",
		"/opt/GoNavi/gonavi-build-linux-arm64",
	)
	if err != nil {
		t.Fatalf("expectedAssetNameForExecutable returned error: %v", err)
	}

	want := "GoNavi-0.6.5-Linux-Arm64.tar.gz"
	if assetName != want {
		t.Fatalf("unexpected linux arm64 asset name: got %q want %q", assetName, want)
	}
}

func TestBuildLinuxScriptPrefersTargetExecutableBasename(t *testing.T) {
	script := buildLinuxScript(
		"/tmp/GoNavi/updates/0.6.5/GoNavi-0.6.5-Linux-Amd64-WebKit41.tar.gz",
		"/opt/GoNavi/gonavi-build-linux-amd64-webkit41",
		"/tmp/GoNavi/updates",
		"/tmp/GoNavi/updates/0.6.5/.gonavi-update-linux-0.6.5",
		"/tmp/GoNavi/updates/0.6.5/update.log",
		12345,
	)

	mustContain := []string{
		`TARGET_NAME="$(basename "$TARGET")"`,
		`NEWBIN="$UPDATE_TMP_DIR/$TARGET_NAME"`,
		`NEWBIN=$(find "$UPDATE_TMP_DIR" -type f -name "$TARGET_NAME" | head -n 1)`,
		`NEWBIN=$(find "$UPDATE_TMP_DIR" -type f -name "GoNavi" | head -n 1)`,
		`if ! kill -0 "$NEW_PID" 2>/dev/null; then`,
		`exec rm -rf "$UPDATES_DIR"`,
	}
	for _, want := range mustContain {
		if !strings.Contains(script, want) {
			t.Fatalf("linux update script missing required token: %s\nscript:\n%s", want, script)
		}
	}
	launchIdx := strings.Index(script, `"$TARGET" >/dev/null 2>&1 &`)
	cleanupIdx := strings.Index(script, `exec rm -rf "$UPDATES_DIR"`)
	if launchIdx < 0 || cleanupIdx < launchIdx {
		t.Fatalf("linux updates cleanup must follow successful relaunch (launch=%d cleanup=%d)\n%s", launchIdx, cleanupIdx, script)
	}
}

func TestApplyGitHubAPIRequestHeadersUsesTokenAndVersion(t *testing.T) {
	t.Setenv("GONAVI_GITHUB_TOKEN", "ghp_test_token")
	req, err := http.NewRequest(http.MethodGet, "https://api.github.com/repos/Syngnat/GoNavi/releases/latest", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	applyGitHubAPIRequestHeaders(req)
	if got := req.Header.Get("Authorization"); got != "Bearer ghp_test_token" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("X-GitHub-Api-Version"); got != updateGitHubAPIVersion {
		t.Fatalf("X-GitHub-Api-Version = %q", got)
	}
	if !strings.HasPrefix(req.Header.Get("User-Agent"), "GoNavi-Updater/") {
		t.Fatalf("User-Agent = %q", req.Header.Get("User-Agent"))
	}
}

func TestClassifyGitHubUpdateHTTPErrorRateLimit(t *testing.T) {
	headers := http.Header{}
	headers.Set("X-RateLimit-Remaining", "0")
	headers.Set("X-RateLimit-Reset", "1783562945")
	body := []byte(`{"message":"API rate limit exceeded for 1.2.3.4."}`)
	err := classifyGitHubUpdateHTTPError(http.StatusForbidden, body, headers, true)
	var localized localizedUpdateError
	if !errors.As(err, &localized) {
		t.Fatalf("expected localizedUpdateError, got %T %v", err, err)
	}
	if localized.key != "app.update.backend.error.check_http_rate_limited" {
		t.Fatalf("unexpected key: %s", localized.key)
	}
	if detail, _ := localized.params["detail"].(string); !strings.Contains(detail, "rate limit") {
		t.Fatalf("detail should include rate limit message: %q", detail)
	}
}

func TestFetchReleaseByURLFallsBackToCacheOn403(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"API rate limit exceeded"}`))
	}))
	defer server.Close()

	updateReleaseCache = sync.Map{}
	storeCachedGitHubRelease(server.URL, &githubRelease{
		TagName: "v9.9.9",
		Name:    "cached",
		HTMLURL: "https://example.com",
	})

	release, err := fetchReleaseByURL(server.URL)
	if err != nil {
		t.Fatalf("expected cache fallback, got err=%v", err)
	}
	if release.TagName != "v9.9.9" {
		t.Fatalf("unexpected release: %#v", release)
	}
}
