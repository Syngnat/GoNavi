package app

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	stdRuntime "runtime"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

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
