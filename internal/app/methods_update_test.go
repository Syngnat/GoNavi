package app

import (
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
