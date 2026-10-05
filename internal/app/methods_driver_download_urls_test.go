package app

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/db"
)

func TestDriverVersionSupportRangeForMongoDB(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	if err := validateDriverSelectedVersion(definition, "1.17.4"); err != nil {
		t.Fatalf("expected 1.17.4 to stay supported, got %v", err)
	}
	if err := validateDriverSelectedVersion(definition, "2.5.0"); err != nil {
		t.Fatalf("expected 2.5.0 to stay supported, got %v", err)
	}
	if err := validateDriverSelectedVersion(definition, "1.16.1"); err == nil {
		t.Fatal("expected 1.16.1 to be rejected by MongoDB support range")
	}
}

func TestResolveVersionedDriverOptionSkipsMongoV1WithoutPublishedReleaseOrSourceBuild(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	version := "1.17.4"
	seedReleaseAssetSizeCache(t, "tag:v"+version, map[string]int64{})
	chdirTemp(t)

	_, _, ok = resolveVersionedDriverOption(definition, version, "history")
	if ok {
		t.Fatal("expected unpublished mongodb v1 option to be filtered out when source build is unavailable")
	}
}

func TestResolveVersionedDriverOptionRejectsUnsupportedMongoV1Range(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	seedReleaseAssetSizeCache(t, "tag:v1.16.1", map[string]int64{
		mongoVersionedReleaseAssetName(1): 24 << 20,
	})

	_, _, ok = resolveVersionedDriverOption(definition, "1.16.1", "history")
	if ok {
		t.Fatal("expected MongoDB 1.16.1 to be hidden from the selectable version list")
	}
}

func TestResolveDriverVersionPackageSizeBytesReadsMongoV1VersionedAsset(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	version := "1.17.4"
	assetName := optionalDriverReleaseZipAssetName(mongoVersionedReleaseAssetName(1))
	const wantSize int64 = 31 << 20
	seedReleaseAssetSizeCache(t, "tag:v"+version, map[string]int64{
		assetName: wantSize,
	})

	got := resolveDriverVersionPackageSizeBytes(definition, driverVersionOptionItem{
		Version: version,
		Source:  "history",
	})
	if got != wantSize {
		t.Fatalf("expected size %d, got %d", wantSize, got)
	}
}

func TestResolveOptionalDriverAgentDownloadURLsDoesNotFallbackForHistoricalVersion(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	zipAssetName := optionalDriverReleaseZipAssetName(mongoVersionedReleaseAssetName(1))
	explicitURL := driverReleaseDownloadURL("v1.17.4", zipAssetName)
	urls := resolveOptionalDriverAgentDownloadURLs(
		definition,
		explicitURL,
		"1.17.4",
	)
	if len(urls) != 2 {
		t.Fatalf("expected mirror plus explicit historical URL, got %d candidates: %v", len(urls), urls)
	}
	if urls[0] != driverMirrorReleaseDownloadURL("v1.17.4", zipAssetName) || urls[1] != explicitURL {
		t.Fatalf("unexpected historical URL candidate: %v", urls)
	}
}

func TestKeepOptionalDriverDownloadURLOrderExpandsDispatcherAndDeduplicatesGitHub(t *testing.T) {
	assetName := "sqlserver-driver-agent-darwin-arm64.zip"
	dispatcherURL := downloadDispatcherURLForPath("/drivers/dev/releases/download/dev-5b7ef3c/" + assetName)
	githubURL := driverReleaseDownloadURL(driverReleaseDevTag, assetName)

	got := keepOptionalDriverDownloadURLOrder([]string{
		dispatcherURL,
		githubURL,
		githubURL + "#" + assetName,
	})
	want := []string{
		"https://download.syngnat.top/drivers/dev/releases/download/dev-5b7ef3c/" + assetName,
		"https://origin-download.syngnat.top:8443/drivers/dev/releases/download/dev-5b7ef3c/" + assetName,
		githubURL,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected canonical Cst -> Bero -> GitHub candidates, got %v", got)
	}
	expanded, err := expandOptionalDriverDownloadCandidates([]string{
		dispatcherURL,
		githubURL,
		githubURL + "#" + assetName,
	})
	if err != nil {
		t.Fatalf("expand driver candidates: %v", err)
	}
	if len(expanded) != len(want) {
		t.Fatalf("expected %d expanded candidates, got %#v", len(want), expanded)
	}
	for index, candidate := range expanded {
		if candidate.URL != want[index] {
			t.Fatalf("candidate %d URL = %q, want %q", index, candidate.URL, want[index])
		}
		if candidate.MetadataURL != dispatcherURL {
			t.Fatalf("candidate %d metadata URL = %q, want dispatcher %q", index, candidate.MetadataURL, dispatcherURL)
		}
	}
}

func TestEnsureOptionalDriverAgentBinaryRejectsMalformedDispatcherWithoutDownloadFallback(t *testing.T) {
	originalDownload := downloadOptionalDriverAgentBinaryForInstall
	t.Cleanup(func() {
		downloadOptionalDriverAgentBinaryForInstall = originalDownload
	})
	var attempts int
	downloadOptionalDriverAgentBinaryForInstall = func(
		_ context.Context,
		_ *App,
		_ driverDefinition,
		_ string,
		_ string,
		_ string,
		_ string,
	) (string, error) {
		attempts++
		return "", errors.New("download must not run")
	}

	definition, ok := resolveDriverDefinition("sqlserver")
	if !ok {
		t.Fatal("expected SQL Server driver definition")
	}
	validPath := "%2Fdrivers%2Fdev%2Freleases%2Fdownload%2Fdev-5b7ef3c%2Fsqlserver-driver-agent-darwin-arm64.zip"
	malformedURL := "https://download-dispatch.syngnat.top/v1/resolve?path=" + validPath + "&path=" + validPath
	_, _, err := ensureOptionalDriverAgentBinary(
		context.Background(),
		nil,
		definition,
		filepath.Join(t.TempDir(), optionalDriverExecutableBaseName("sqlserver")),
		malformedURL,
		"1.9.7",
	)
	if !errors.Is(err, errInvalidDownloadDispatcherURL) {
		t.Fatalf("malformed Dispatcher install error = %v, want typed invalid URL", err)
	}
	if attempts != 0 {
		t.Fatalf("malformed Dispatcher install attempted %d downloads", attempts)
	}
}

func TestDownloadDriverPackageFallsBackToGitHubAndPersistsActualSource(t *testing.T) {
	originalDownload := downloadOptionalDriverAgentBinaryForInstall
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		downloadOptionalDriverAgentBinaryForInstall = originalDownload
		optionalDriverAgentMetadataProbe = originalProbe
	})
	chdirTemp(t)

	const selectedVersion = "1.9.7"
	assetName := optionalDriverReleaseZipAssetNameForVersion("sqlserver", selectedVersion)
	dispatcherURL := downloadDispatcherURLForPath("/drivers/dev/releases/download/dev-5b7ef3c/" + assetName)
	expectedURLs, err := staticDriverDispatcherDownloadCandidates(dispatcherURL)
	if err != nil {
		t.Fatalf("resolve expected driver fallback candidates: %v", err)
	}
	if len(expectedURLs) != 3 {
		t.Fatalf("expected Cst, Bero, and GitHub candidates, got %v", expectedURLs)
	}

	type downloadAttempt struct {
		URL         string
		MetadataURL string
	}
	attempts := make([]downloadAttempt, 0, len(expectedURLs))
	downloadOptionalDriverAgentBinaryForInstall = func(
		_ context.Context,
		_ *App,
		_ driverDefinition,
		urlText string,
		metadataURL string,
		executablePath string,
		_ string,
	) (string, error) {
		attempts = append(attempts, downloadAttempt{URL: urlText, MetadataURL: metadataURL})
		if urlText != expectedURLs[2] {
			return "", fmt.Errorf("simulated unavailable driver source: %s", urlText)
		}
		if err := os.WriteFile(executablePath, []byte("github-sqlserver-driver-agent"), 0o755); err != nil {
			return "", err
		}
		return strings.Repeat("a", 64), nil
	}
	optionalDriverAgentMetadataProbe = func(driverType string, _ string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: db.OptionalDriverAgentRevision(driverType),
		}, nil
	}

	driverRoot := filepath.Join(t.TempDir(), "drivers")
	result := NewApp().DownloadDriverPackage("sqlserver", selectedVersion, dispatcherURL, driverRoot)
	if !result.Success {
		t.Fatalf("expected GitHub fallback install to succeed, got %q", result.Message)
	}

	wantAttempts := make([]downloadAttempt, 0, len(expectedURLs))
	for _, candidateURL := range expectedURLs {
		wantAttempts = append(wantAttempts, downloadAttempt{
			URL:         candidateURL,
			MetadataURL: dispatcherURL,
		})
	}
	if !reflect.DeepEqual(attempts, wantAttempts) {
		t.Fatalf("unexpected driver fallback attempts: got %#v, want %#v", attempts, wantAttempts)
	}

	pkg, ok := readInstalledDriverPackage(driverRoot, "sqlserver")
	if !ok {
		t.Fatal("expected installed.json after GitHub fallback")
	}
	if pkg.DownloadURL != expectedURLs[2] {
		t.Fatalf("installed download URL = %q, want actual GitHub source %q", pkg.DownloadURL, expectedURLs[2])
	}
	if pkg.SHA256 != strings.Repeat("a", 64) {
		t.Fatalf("installed SHA256 = %q, want downloader result", pkg.SHA256)
	}
	installed, err := os.ReadFile(pkg.ExecutablePath)
	if err != nil {
		t.Fatalf("read installed fallback driver: %v", err)
	}
	if string(installed) != "github-sqlserver-driver-agent" {
		t.Fatalf("unexpected installed fallback driver: %q", string(installed))
	}
	assertNoDriverInstallStagingDirs(t, filepath.Dir(pkg.FilePath))
}

func TestValidateDownloadedDriverAssetMetadataChecksSizeAndSHA256(t *testing.T) {
	payload := []byte("verified driver archive")
	path := filepath.Join(t.TempDir(), "driver.zip")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(payload))
	if err := validateDownloadedDriverAssetMetadata(path, digest, int64(len(payload)), digest); err != nil {
		t.Fatalf("valid driver metadata rejected: %v", err)
	}
	if err := validateDownloadedDriverAssetMetadata(path, digest, int64(len(payload))+1, digest); err == nil {
		t.Fatal("expected size mismatch")
	}
	if err := validateDownloadedDriverAssetMetadata(path, digest, int64(len(payload)), strings.Repeat("0", 64)); err == nil {
		t.Fatal("expected SHA256 mismatch")
	}
}

func TestFetchDriverBundleAssetIndexCandidateRequiresCompleteSHA256Metadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"assets":{"driver.zip":12},"assetSha256":{}}`)
	}))
	defer server.Close()

	if _, err := fetchDriverBundleAssetIndexCandidate(server.Client(), server.URL); err == nil {
		t.Fatal("expected incomplete driver SHA256 metadata to be rejected")
	}
}

func TestResolveOptionalDriverAgentDownloadURLsUsesMongoV1AssetForCompatibleDefault(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	originalVersion := AppVersion
	AppVersion = "0.7.9"
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	assetName := optionalDriverReleaseZipAssetName(mongoVersionedReleaseAssetName(1))
	seedReleaseAssetSizeCache(t, "tag:v0.7.9", map[string]int64{
		assetName: 24 << 20,
	})
	seedReleaseAssetSizeCache(t, "latest", map[string]int64{})

	urls := resolveOptionalDriverAgentDownloadURLs(
		definition,
		"builtin://activate/mongodb",
		"1.17.9",
	)
	want := driverReleaseDownloadURL("v0.7.9", assetName)
	for _, got := range urls {
		if got == want {
			return
		}
	}
	t.Fatalf("expected MongoDB v1 release asset %q in candidates, got %v", want, urls)
}

func TestResolveOptionalDriverAgentDownloadURLsAddsDevMirrorCandidatesWhenGitHubURLProvided(t *testing.T) {
	originalFetch := fetchMirrorDriverReleaseByTagForDriverDownload
	originalCache := cloneReleaseAssetSizeCache(driverReleaseSizeMap)
	t.Cleanup(func() {
		fetchMirrorDriverReleaseByTagForDriverDownload = originalFetch
		driverReleaseSizeMu.Lock()
		driverReleaseSizeMap = originalCache
		driverReleaseSizeMu.Unlock()
	})

	driverReleaseSizeMu.Lock()
	driverReleaseSizeMap = map[string]driverReleaseAssetSizeCacheEntry{}
	driverReleaseSizeMu.Unlock()

	const selectedVersion = "1.9.6"
	assetName := optionalDriverReleaseZipAssetNameForVersion("sqlserver", selectedVersion)
	githubURL := driverReleaseDownloadURL(driverReleaseDevTag, assetName)
	physicalTag := "dev-33153267878-1"
	mirrorURL := driverMirrorDevReleaseDownloadURL(physicalTag, assetName)
	fetchMirrorDriverReleaseByTagForDriverDownload = func(tag string) (*githubRelease, error) {
		if tag != driverReleaseDevTag {
			t.Fatalf("unexpected mirror release tag %q", tag)
		}
		return &githubRelease{TagName: driverReleaseDevTag, Assets: []githubAsset{{
			Name:               assetName,
			BrowserDownloadURL: mirrorURL,
			URL:                githubURL,
		}}}, nil
	}

	definition, ok := resolveDriverDefinition("sqlserver")
	if !ok {
		t.Fatal("expected SQL Server driver definition")
	}
	got := resolveOptionalDriverAgentDownloadURLs(definition, githubURL, selectedVersion)
	if len(got) < 2 {
		t.Fatalf("expected mirror and GitHub candidates, got %v", got)
	}
	if got[0] != mirrorURL {
		t.Fatalf("expected dev mirror candidate first, got %q", got[0])
	}
	if got[1] != githubURL {
		t.Fatalf("expected original GitHub candidate second, got %q", got[1])
	}

	expanded, err := expandOptionalDriverDownloadCandidates(got[:2])
	if err != nil {
		t.Fatalf("expand mirror candidates: %v", err)
	}
	expectedExpanded, err := staticDriverDispatcherDownloadCandidates(mirrorURL)
	if err != nil {
		t.Fatalf("expand expected mirror candidates: %v", err)
	}
	if len(expanded) != len(expectedExpanded) {
		t.Fatalf("expected Cst/Bero/GitHub candidates with duplicate GitHub removed, got %#v", expanded)
	}
	for index, expected := range expectedExpanded {
		if expanded[index].URL != expected {
			t.Fatalf("expanded candidate %d = %q, want %q", index, expanded[index].URL, expected)
		}
	}
}

func TestResolveOptionalDriverAgentDownloadURLsAddsDevMirrorCandidatesForBuiltinURL(t *testing.T) {
	originalVersion := AppVersion
	originalFetch := fetchMirrorDriverReleaseByTagForDriverDownload
	driverReleaseSizeMu.Lock()
	originalCache := cloneReleaseAssetSizeCache(driverReleaseSizeMap)
	driverReleaseSizeMu.Unlock()
	t.Cleanup(func() {
		AppVersion = originalVersion
		fetchMirrorDriverReleaseByTagForDriverDownload = originalFetch
		driverReleaseSizeMu.Lock()
		driverReleaseSizeMap = originalCache
		driverReleaseSizeMu.Unlock()
	})

	AppVersion = "dev-test123"
	const selectedVersion = "1.9.6"
	assetName := optionalDriverReleaseZipAssetNameForVersion("sqlserver", selectedVersion)
	githubURL := driverReleaseDownloadURL(driverReleaseDevTag, assetName)
	physicalTag := "dev-test123"
	mirrorURL := driverMirrorDevReleaseDownloadURL(physicalTag, assetName)
	now := time.Now()
	driverReleaseSizeMu.Lock()
	driverReleaseSizeMap = map[string]driverReleaseAssetSizeCacheEntry{
		"tag:" + driverReleaseDevTag: {LoadedAt: now, Err: "mirror index unavailable"},
		"latest":                     {LoadedAt: now, Err: "mirror index unavailable"},
	}
	driverReleaseSizeMu.Unlock()

	var fetches int
	fetchMirrorDriverReleaseByTagForDriverDownload = func(tag string) (*githubRelease, error) {
		fetches++
		if tag != driverReleaseDevTag {
			t.Fatalf("unexpected mirror release tag %q", tag)
		}
		return &githubRelease{TagName: driverReleaseDevTag, Assets: []githubAsset{{
			Name:               assetName,
			BrowserDownloadURL: mirrorURL,
			URL:                githubURL,
		}}}, nil
	}

	definition := driverDefinition{Type: "sqlserver", PinnedVersion: selectedVersion}
	got := resolveOptionalDriverAgentDownloadURLs(definition, "builtin://activate/sqlserver", selectedVersion)
	want := []string{mirrorURL, githubURL}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected dev mirror then GitHub for builtin URL, got %v, want %v", got, want)
	}
	if fetches == 0 {
		t.Fatal("expected cold dev mirror metadata to be resolved from the mirror index")
	}
}

func TestResolveOptionalDriverAgentDownloadURLsKeepsGitHubWhenDevMirrorLookupFails(t *testing.T) {
	originalFetch := fetchMirrorDriverReleaseByTagForDriverDownload
	t.Cleanup(func() {
		fetchMirrorDriverReleaseByTagForDriverDownload = originalFetch
	})

	fetchMirrorDriverReleaseByTagForDriverDownload = func(string) (*githubRelease, error) {
		return nil, errors.New("mirror index unavailable")
	}
	const selectedVersion = "1.9.7"
	assetName := optionalDriverReleaseZipAssetNameForVersion("sqlserver", selectedVersion)
	githubURL := driverReleaseDownloadURL(driverReleaseDevTag, assetName)
	definition := driverDefinition{Type: "sqlserver", PinnedVersion: "1.9.6"}
	got := resolveOptionalDriverAgentDownloadURLs(definition, githubURL, selectedVersion)
	if !reflect.DeepEqual(got, []string{githubURL}) {
		t.Fatalf("expected original GitHub URL to remain as final fallback, got %v", got)
	}
}

func TestResolveOptionalDriverAgentDownloadURLsDoesNotUseMongoV2BaseForCompatibleDefault(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	originalVersion := AppVersion
	AppVersion = "0.7.9"
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	baseAssetName := optionalDriverReleaseAssetNameForType("mongodb", runtime.GOOS, runtime.GOARCH)
	seedReleaseAssetSizeCache(t, "tag:v0.7.9", map[string]int64{
		baseAssetName: 24 << 20,
	})
	seedReleaseAssetSizeCache(t, "latest", map[string]int64{
		baseAssetName: 24 << 20,
	})

	urls := resolveOptionalDriverAgentDownloadURLs(
		definition,
		"builtin://activate/mongodb",
		"1.17.9",
	)
	for _, got := range urls {
		if strings.Contains(got, baseAssetName) {
			t.Fatalf("expected MongoDB v1 install not to use ambiguous base asset %q, got %v", baseAssetName, urls)
		}
	}
}

func TestMongoDBVersionedAssetNamesDoNotFallbackToBaseForV1(t *testing.T) {
	v1AssetName := mongoVersionedReleaseAssetName(1)
	baseAssetName := optionalDriverReleaseAssetNameForType("mongodb", runtime.GOOS, runtime.GOARCH)

	v1Names := optionalDriverReleaseAssetNamesForVersion("mongodb", "1.17.9")
	if len(v1Names) != 1 || v1Names[0] != v1AssetName {
		t.Fatalf("expected MongoDB v1 to use only %q, got %v", v1AssetName, v1Names)
	}
	for _, name := range v1Names {
		if name == baseAssetName {
			t.Fatalf("MongoDB v1 must not fallback to ambiguous base asset %q", baseAssetName)
		}
	}

	v2Names := optionalDriverReleaseAssetNamesForVersion("mongodb", "2.5.0")
	if len(v2Names) < 2 || v2Names[0] != mongoVersionedReleaseAssetName(2) || v2Names[1] != baseAssetName {
		t.Fatalf("expected MongoDB v2 to prefer versioned asset then base compatibility asset, got %v", v2Names)
	}
}

func TestResolveOptionalDriverAgentDownloadURLsUsesDamengZipAsset(t *testing.T) {
	definition, ok := resolveDriverDefinition("dameng")
	if !ok {
		t.Fatal("expected dameng driver definition")
	}

	version := normalizeVersion(definition.PinnedVersion)
	assetName := optionalDriverReleaseZipAssetNameForVersion("dameng", version)
	seedReleaseAssetCacheEntry(t, "tag:v"+version, map[string]int64{
		assetName: 23 << 20,
	}, map[string]int64{assetName: 23 << 20})
	seedReleaseAssetCacheEntry(t, "latest", map[string]int64{
		assetName: 23 << 20,
	}, map[string]int64{assetName: 23 << 20})

	urls := resolveOptionalDriverAgentDownloadURLs(definition, "builtin://activate/dameng", version)
	if len(urls) == 0 {
		t.Fatal("expected Dameng install to use the published standalone zip")
	}
	for _, candidate := range urls {
		if !isOptionalDriverDownloadZipURL(candidate) {
			t.Fatalf("expected zip-only Dameng candidates, got %v", urls)
		}
	}
}

func TestShouldUseOptionalDriverBundleFallbackSkipsWhenDirectAssetExists(t *testing.T) {
	if shouldUseOptionalDriverBundleFallback("sqlserver", false, 1) {
		t.Fatal("expected published single-file driver asset to avoid 497MB bundle fallback")
	}
}

func TestShouldUseOptionalDriverBundleFallbackStaysDisabledWhenZipMissing(t *testing.T) {
	if shouldUseOptionalDriverBundleFallback("dameng", false, 0) {
		t.Fatal("expected ZIP-only installs not to download the CI driver bundle")
	}
	if shouldUseOptionalDriverBundleFallback("dameng", true, 0) {
		t.Fatal("expected explicit version artifact installs to skip bundle fallback")
	}
}

func TestFormatOptionalDriverAttemptErrorRemovesDuplicatedSourcePrefix(t *testing.T) {
	source := "https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/kingbase-driver-agent-darwin-arm64"
	err := fmt.Errorf("%s: kingbase 驱动代理 revision 不匹配（已安装：src-old，当前需要：src-new），请安装当前版本对应的 driver-agent", source)

	got := formatOptionalDriverAttemptError(nil, source, err)
	if strings.Count(got, source) != 1 {
		t.Fatalf("expected source to appear once, got %q", got)
	}
	if !strings.Contains(got, "kingbase 驱动代理 revision 不匹配") {
		t.Fatalf("expected revision mismatch detail, got %q", got)
	}
}

func TestAppendOptionalDriverAttemptErrorDeduplicatesIdenticalEntries(t *testing.T) {
	source := "https://github.com/Syngnat/GoNavi-DriverAgents/releases/latest/download/GoNavi-DriverAgents.zip#MacOS/kingbase-driver-agent-darwin-arm64"
	err := fmt.Errorf("kingbase 驱动代理 revision 不匹配（已安装：src-old，当前需要：src-new），请安装当前版本对应的 driver-agent")

	entries := appendOptionalDriverAttemptError(nil, nil, source, err)
	entries = appendOptionalDriverAttemptError(nil, entries, source, err)
	if len(entries) != 1 {
		t.Fatalf("expected duplicate driver attempt error to be collapsed, got %d entries: %v", len(entries), entries)
	}
}

func TestResolveDriverInstallVersionUsesPinnedVersionForBuiltinActivateURL(t *testing.T) {
	definition, ok := resolveDriverDefinition("sqlserver")
	if !ok {
		t.Fatal("expected sqlserver driver definition")
	}
	if normalizeVersion(definition.PinnedVersion) == "" {
		t.Fatal("expected sqlserver default definition to include builtin manifest pinned version")
	}

	got := resolveDriverInstallVersion("", "builtin://activate/sqlserver", definition)
	want := normalizeVersion(definition.PinnedVersion)
	if got != want {
		t.Fatalf("expected builtin activate URL to fall back to pinned version %q, got %q", want, got)
	}
}

func TestBuiltinActivatePinnedVersionDoesNotRestrictBundleFallback(t *testing.T) {
	definition, ok := resolveDriverDefinition("sqlserver")
	if !ok {
		t.Fatal("expected sqlserver driver definition")
	}

	selectedVersion := resolveDriverInstallVersion("", "builtin://activate/sqlserver", definition)
	if shouldRestrictToExplicitVersionArtifact(definition, selectedVersion) {
		t.Fatalf("expected builtin activate default version %q not to restrict bundle fallback", selectedVersion)
	}
}
