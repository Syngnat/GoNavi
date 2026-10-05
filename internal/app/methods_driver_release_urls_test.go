package app

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestResolveVersionedDriverOptionUsesPublishedMongoV1Release(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	version := "1.17.4"
	assetName := optionalDriverReleaseZipAssetName(mongoVersionedReleaseAssetName(1))
	seedReleaseAssetSizeCache(t, "tag:v"+version, map[string]int64{
		assetName: 24 << 20,
	})
	chdirTemp(t)

	gotVersion, gotURL, ok := resolveVersionedDriverOption(definition, version, "history")
	if !ok {
		t.Fatal("expected published mongodb v1 option to remain available")
	}
	if gotVersion != version {
		t.Fatalf("expected version %q, got %q", version, gotVersion)
	}

	wantURL := fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", driverReleaseRepo, version, assetName)
	if gotURL != wantURL {
		t.Fatalf("expected published release URL %q, got %q", wantURL, gotURL)
	}
}

func TestMongoDBDefaultDriverVersionUsesLegacyCompatibleLine(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	if definition.PinnedVersion != "1.17.9" {
		t.Fatalf("expected MongoDB default driver version 1.17.9, got %q", definition.PinnedVersion)
	}
	if got := resolveDriverInstallVersion("", definition.DefaultDownloadURL, definition); got != "1.17.9" {
		t.Fatalf("expected builtin MongoDB install to resolve version 1.17.9, got %q", got)
	}
}

func TestCurrentDriverReleaseTagUsesDevLatestForDevBuild(t *testing.T) {
	originalVersion := AppVersion
	AppVersion = "dev-abc1234"
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	if got := currentDriverReleaseTag(); got != driverReleaseDevTag {
		t.Fatalf("expected dev driver release tag %q, got %q", driverReleaseDevTag, got)
	}
}

func TestCurrentDriverReleaseTagUsesDevLatestForLocalTestBuild(t *testing.T) {
	originalVersion := AppVersion
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	for _, version := range []string{"0.0.1-test", "0.7.9-dev", "0.7.9-local", "0.7.9-SNAPSHOT"} {
		AppVersion = version
		if got := currentDriverReleaseTag(); got != driverReleaseDevTag {
			t.Fatalf("expected %s to use dev driver release tag %q, got %q", version, driverReleaseDevTag, got)
		}
	}
}

func TestCurrentDriverReleaseTagUsesVersionedReleaseForStableBuild(t *testing.T) {
	originalVersion := AppVersion
	AppVersion = "0.7.9"
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	if got := currentDriverReleaseTag(); got != "v0.7.9" {
		t.Fatalf("expected stable driver release tag v0.7.9, got %q", got)
	}
}

func TestDriverReleaseLatestDownloadURLForCurrentChannelUsesDevLatest(t *testing.T) {
	originalVersion := AppVersion
	AppVersion = "dev-a1b2c3d"
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	const assetName = "sqlserver-driver-agent-windows-amd64.exe"
	got := driverReleaseLatestDownloadURLForCurrentChannel(assetName)
	want := driverReleaseDownloadURL(driverReleaseDevTag, assetName)
	if got != want {
		t.Fatalf("dev latest fallback URL = %q, want %q", got, want)
	}
}

func TestOptionalDriverReleaseZipAssetNamesArePlatformNeutralArchives(t *testing.T) {
	if got := optionalDriverReleaseZipAssetName("mariadb-driver-agent-windows-amd64.exe"); got != "mariadb-driver-agent-windows-amd64.zip" {
		t.Fatalf("unexpected Windows ZIP asset name: %q", got)
	}
	if got := optionalDriverReleaseZipAssetName("mariadb-driver-agent-darwin-arm64"); got != "mariadb-driver-agent-darwin-arm64.zip" {
		t.Fatalf("unexpected Darwin ZIP asset name: %q", got)
	}
	MongoNames := optionalDriverReleaseZipAssetNamesForVersion("mongodb", "1.17.9")
	if len(MongoNames) != 1 || !strings.Contains(MongoNames[0], "mongodb-driver-agent-v1-") || !strings.HasSuffix(MongoNames[0], ".zip") {
		t.Fatalf("expected MongoDB v1 to resolve one versioned ZIP, got %v", MongoNames)
	}
}

func TestResolveOptionalDriverBundleDownloadURLsUsesDriverReleaseRepo(t *testing.T) {
	originalVersion := AppVersion
	AppVersion = "0.7.4"
	t.Cleanup(func() {
		AppVersion = originalVersion
	})

	urls := resolveOptionalDriverBundleDownloadURLs()
	wantMirror := driverMirrorReleaseDownloadURL("v0.7.4", optionalDriverBundleAssetName)
	wantTagged := driverReleaseDownloadURL("v0.7.4", optionalDriverBundleAssetName)
	wantLatest := driverReleaseLatestDownloadURL(optionalDriverBundleAssetName)
	if len(urls) < 2 {
		t.Fatalf("expected at least tagged and latest bundle URLs, got %v", urls)
	}
	foundTagged := false
	foundLatest := false
	foundMirror := false
	for _, candidate := range urls {
		if candidate == wantMirror {
			foundMirror = true
		}
		if candidate == wantTagged {
			foundTagged = true
		}
		if candidate == wantLatest {
			foundLatest = true
		}
	}
	if !foundMirror || !foundTagged || !foundLatest {
		t.Fatalf("expected bundle URLs to include mirror=%q, tagged=%q and latest=%q, got %v", wantMirror, wantTagged, wantLatest, urls)
	}
	if urls[0] != wantMirror {
		t.Fatalf("expected mirror first, got %v", urls)
	}
}

func TestDriverReleaseDownloadCoordinates(t *testing.T) {
	tag, asset, ok := driverReleaseDownloadCoordinates("https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/v1.2.3/driver%20agent.exe")
	if !ok || tag != "v1.2.3" || asset != "driver agent.exe" {
		t.Fatalf("unexpected GitHub coordinates: tag=%q asset=%q ok=%v", tag, asset, ok)
	}
	tag, asset, ok = driverReleaseDownloadCoordinates(driverMirrorReleaseDownloadURL("dev-latest", "driver agent.exe"))
	if !ok || tag != "dev-latest" || asset != "driver agent.exe" {
		t.Fatalf("unexpected mirror coordinates: tag=%q asset=%q ok=%v", tag, asset, ok)
	}
	if _, _, ok := driverReleaseDownloadCoordinates("https://example.com/releases/download/v1.2.3/driver.exe"); ok {
		t.Fatal("expected unrelated release URL not to be rewritten to the GoNavi mirror")
	}
}

func TestFetchDriverReleaseIndexByURLBuildsMirrorAssets(t *testing.T) {
	disableGlobalProxyForTest(t)
	assetSHA256 := strings.Repeat("a", 64)

	for _, name := range []string{
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
		"http_proxy", "https_proxy", "all_proxy",
	} {
		t.Setenv(name, "")
	}
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	t.Setenv("no_proxy", "127.0.0.1,localhost")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"assets":{"sqlserver-driver-agent-windows-amd64.exe":12345},"assetSha256":{"sqlserver-driver-agent-windows-amd64.exe":%q}}`, assetSHA256)
	}))
	defer server.Close()

	release, err := fetchDriverReleaseIndexByURL("v1.2.3", server.URL)
	if err != nil {
		t.Fatalf("fetch driver index: %v", err)
	}
	if release.TagName != "v1.2.3" || len(release.Assets) != 1 {
		t.Fatalf("unexpected synthetic release: %#v", release)
	}
	asset := release.Assets[0]
	if asset.Name != "sqlserver-driver-agent-windows-amd64.exe" || asset.Size != 12345 {
		t.Fatalf("unexpected synthetic asset: %#v", asset)
	}
	if asset.BrowserDownloadURL != driverMirrorReleaseDownloadURL("v1.2.3", asset.Name) {
		t.Fatalf("unexpected mirror URL: %q", asset.BrowserDownloadURL)
	}
	if asset.URL != driverReleaseDownloadURL("v1.2.3", asset.Name) {
		t.Fatalf("unexpected GitHub fallback URL: %q", asset.URL)
	}

	latestServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"tagName":"v1.2.2","assets":{"sqlserver-driver-agent-windows-amd64.exe":12345},"assetSha256":{"sqlserver-driver-agent-windows-amd64.exe":%q}}`, assetSHA256)
	}))
	defer latestServer.Close()
	latestRelease, err := fetchDriverReleaseIndexByURL("", latestServer.URL)
	if err != nil {
		t.Fatalf("fetch latest driver index: %v", err)
	}
	if latestRelease.TagName != "v1.2.2" || len(latestRelease.Assets) != 1 {
		t.Fatalf("unexpected latest synthetic release: %#v", latestRelease)
	}
	latestAsset := latestRelease.Assets[0]
	if latestAsset.BrowserDownloadURL != driverMirrorReleaseDownloadURL("v1.2.2", latestAsset.Name) ||
		latestAsset.URL != driverReleaseDownloadURL("v1.2.2", latestAsset.Name) {
		t.Fatalf("latest pointer did not preserve source tag: %#v", latestAsset)
	}

	devServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"tagName":"dev-stale-logical-tag","mirrorTagName":"dev-a1b2c3d","assets":{"sqlserver-driver-agent-windows-amd64.exe":12345},"assetSha256":{"sqlserver-driver-agent-windows-amd64.exe":%q}}`, assetSHA256)
	}))
	defer devServer.Close()
	devRelease, err := fetchDriverReleaseIndexByURL(driverReleaseDevTag, devServer.URL)
	if err != nil {
		t.Fatalf("fetch dev driver index: %v", err)
	}
	if devRelease.TagName != driverReleaseDevTag || len(devRelease.Assets) != 1 {
		t.Fatalf("unexpected dev synthetic release: %#v", devRelease)
	}
	devAsset := devRelease.Assets[0]
	if devAsset.BrowserDownloadURL != driverMirrorDevReleaseDownloadURL("dev-a1b2c3d", devAsset.Name) {
		t.Fatalf("dev mirror URL did not use the physical mirror tag: %#v", devAsset)
	}
	if devAsset.URL != driverReleaseDownloadURL(driverReleaseDevTag, devAsset.Name) {
		t.Fatalf("dev GitHub fallback did not retain dev-latest: %#v", devAsset)
	}
}

func TestResolvePublishedDriverDownloadURLForTagUsesDevMirrorTag(t *testing.T) {
	definition := driverDefinition{Type: "sqlserver"}
	assetNames := optionalDriverReleaseZipAssetNamesForVersion(definition.Type, "")
	if len(assetNames) == 0 {
		t.Fatal("expected sqlserver release asset names")
	}
	assetName := assetNames[0]
	want := driverMirrorDevReleaseDownloadURL("dev-a1b2c3d", assetName)

	driverReleaseSizeMu.Lock()
	original := cloneReleaseAssetSizeCache(driverReleaseSizeMap)
	driverReleaseSizeMap["tag:"+driverReleaseDevTag] = driverReleaseAssetSizeCacheEntry{
		LoadedAt:           time.Now(),
		SizeByKey:          map[string]int64{assetName: 12345},
		PublishedAssets:    map[string]bool{assetName: true},
		MirrorDownloadURLs: map[string]string{assetName: want},
	}
	driverReleaseSizeMu.Unlock()
	t.Cleanup(func() {
		driverReleaseSizeMu.Lock()
		driverReleaseSizeMap = original
		driverReleaseSizeMu.Unlock()
	})

	got, ok := resolvePublishedDriverDownloadURLForTag(definition, "", driverReleaseDevTag)
	if !ok || got != want {
		t.Fatalf("dev published URL = %q, ok=%v, want mirror %q", got, ok, want)
	}
}

func TestResolveLatestPublishedDriverDownloadURLFallsBackWhenMirrorIndexMissesAsset(t *testing.T) {
	seedReleaseAssetSizeCache(t, "latest", map[string]int64{
		"unrelated-driver-agent-windows-amd64.zip": 123,
	})
	definition := driverDefinition{Type: "sqlserver"}
	assetNames := optionalDriverReleaseZipAssetNamesForVersion(definition.Type, "")
	if len(assetNames) == 0 {
		t.Fatal("expected sqlserver release asset names")
	}
	got, ok := resolveLatestPublishedDriverDownloadURLForVersion(definition, "")
	if !ok {
		t.Fatal("expected GitHub latest fallback for an incomplete mirror index")
	}
	want := driverReleaseLatestDownloadURL(assetNames[0])
	if got != want {
		t.Fatalf("latest fallback URL = %q, want %q", got, want)
	}
}

func TestDriverReleaseAssetAPIURLUsesReleaseAssetEndpoint(t *testing.T) {
	asset := githubAsset{
		Name:               "kingbase-driver-agent-darwin-arm64",
		BrowserDownloadURL: "https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/kingbase-driver-agent-darwin-arm64",
		URL:                "https://api.github.com/repos/Syngnat/GoNavi-DriverAgents/releases/assets/123456",
		Size:               18 << 20,
	}
	if got := driverReleaseAssetAPIURL(asset); got != "https://api.github.com/repos/Syngnat/GoNavi-DriverAgents/releases/assets/123456#kingbase-driver-agent-darwin-arm64" {
		t.Fatalf("expected release asset API URL, got %q", got)
	}
}

func TestOptionalDriverDownloadZipURLAcceptsAssetAPIFragment(t *testing.T) {
	urlText := "https://api.github.com/repos/Syngnat/GoNavi-DriverAgents/releases/assets/123456#duckdb-driver.zip"
	if !isOptionalDriverDownloadZipURL(urlText) {
		t.Fatalf("expected asset API URL with zip fragment to be treated as zip download: %q", urlText)
	}
}
