package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

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
