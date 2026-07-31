package app

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

func TestDriverStatusItemJSONIncludesStableReasonCode(t *testing.T) {
	item := driverStatusItem{
		Type:       "clickhouse",
		Name:       "ClickHouse",
		ReasonCode: driverStatusReasonSlimBuildMissingDriver,
	}

	payload, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal driver status item: %v", err)
	}

	if !strings.Contains(string(payload), `"reasonCode":"slim_build_missing_driver"`) {
		t.Fatalf("expected stable reasonCode in payload, got %s", string(payload))
	}
}

func TestDriverNetworkProbeItemJSONIncludesStableProbeCode(t *testing.T) {
	item := driverNetworkProbeItem{
		ProbeCode: driverNetworkProbeCodeGitHubRelease,
		Name:      "GitHub driver release",
		URL:       "https://github.com/example/release",
	}

	payload, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal driver network probe item: %v", err)
	}

	if !strings.Contains(string(payload), `"probeCode":"github_release"`) {
		t.Fatalf("expected stable probeCode in payload, got %s", string(payload))
	}
}

func TestDriverDownloadMirrorProbeUsesProviderNeutralIdentity(t *testing.T) {
	item := driverNetworkProbeItem{
		ProbeCode: driverNetworkProbeCodeDownloadMirror,
		Name:      driverNetworkProbeNameDownloadMirror,
		URL:       "https://download.syngnat.top/health.txt",
	}

	payload, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal download mirror network probe item: %v", err)
	}

	serialized := string(payload)
	if !strings.Contains(serialized, `"probeCode":"download_mirror"`) {
		t.Fatalf("expected provider-neutral mirror probeCode, got %s", serialized)
	}
	if !strings.Contains(serialized, `"name":"GoNavi Mirror"`) {
		t.Fatalf("expected provider-neutral mirror name, got %s", serialized)
	}
}

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

func TestReorderOptionalDriverDownloadURLsBySpeedPrefersClearlyFasterGitHub(t *testing.T) {
	mirrorURL := driverMirrorReleaseDownloadURL("v1.2.3", "mariadb-driver-agent-darwin-arm64.zip")
	githubURL := driverReleaseDownloadURL("v1.2.3", "mariadb-driver-agent-darwin-arm64.zip")
	got := reorderOptionalDriverDownloadURLsBySpeedWithProbe(
		[]string{mirrorURL, githubURL},
		func(_ context.Context, _ *http.Client, rawURL string) optionalDriverDownloadProbeResult {
			duration := 2 * time.Second
			if optionalDriverDownloadSource(rawURL) == "github" {
				duration = 500 * time.Millisecond
			}
			return optionalDriverDownloadProbeResult{URL: rawURL, Bytes: optionalDriverDownloadProbeBytes, Duration: duration, OK: true}
		},
	)
	if len(got) != 2 || got[0] != githubURL || got[1] != mirrorURL {
		t.Fatalf("expected faster GitHub ZIP first without dropping mirror fallback, got %v", got)
	}
}

func TestReorderOptionalDriverDownloadURLsBySpeedKeepsMirrorForSimilarOrFailedGitHub(t *testing.T) {
	mirrorURL := driverMirrorReleaseDownloadURL("v1.2.3", "mariadb-driver-agent-darwin-arm64.zip")
	githubURL := driverReleaseDownloadURL("v1.2.3", "mariadb-driver-agent-darwin-arm64.zip")
	for name, githubResult := range map[string]optionalDriverDownloadProbeResult{
		"similar": {Bytes: optionalDriverDownloadProbeBytes, Duration: 900 * time.Millisecond, OK: true},
		"failed":  {},
	} {
		t.Run(name, func(t *testing.T) {
			got := reorderOptionalDriverDownloadURLsBySpeedWithProbe(
				[]string{mirrorURL, githubURL},
				func(_ context.Context, _ *http.Client, rawURL string) optionalDriverDownloadProbeResult {
					if optionalDriverDownloadSource(rawURL) == "github" {
						githubResult.URL = rawURL
						return githubResult
					}
					return optionalDriverDownloadProbeResult{URL: rawURL, Bytes: optionalDriverDownloadProbeBytes, Duration: time.Second, OK: true}
				},
			)
			if len(got) != 2 || got[0] != mirrorURL || got[1] != githubURL {
				t.Fatalf("expected mirror-first order to remain unchanged, got %v", got)
			}
		})
	}
}

func TestProbeOptionalDriverDownloadURLUsesBoundedRange(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Range"); got != "bytes=0-262143" {
			t.Errorf("unexpected Range header: %q", got)
		}
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(make([]byte, optionalDriverDownloadProbeBytes+1024))
	}))
	defer server.Close()

	result := probeOptionalDriverDownloadURL(context.Background(), server.Client(), server.URL+"/driver.zip")
	if !result.OK || result.Bytes != optionalDriverDownloadProbeBytes {
		t.Fatalf("expected a valid bounded probe, got %#v", result)
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
		_, _ = io.WriteString(w, `{"assets":{"sqlserver-driver-agent-windows-amd64.exe":12345}}`)
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
		_, _ = io.WriteString(w, `{"tagName":"v1.2.2","assets":{"sqlserver-driver-agent-windows-amd64.exe":12345}}`)
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
		_, _ = io.WriteString(w, `{"tagName":"dev-stale-logical-tag","mirrorTagName":"dev-a1b2c3d","assets":{"sqlserver-driver-agent-windows-amd64.exe":12345}}`)
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

func TestOptionalDriverAgentDownloadAndBuildErrorsUseI18nWrappers(t *testing.T) {
	source := methodsDriverSource(t)

	functionNames := []string{
		"ensureOptionalDriverAgentBinary",
		"downloadOptionalDriverAgentBinary",
		"downloadOptionalDriverAgentFromBundle",
		"buildOptionalDriverAgentFromSource",
	}
	functionSource := ""
	for _, name := range functionNames {
		start := strings.Index(source, "func "+name)
		if start < 0 {
			t.Fatalf("methods_driver.go missing %s", name)
		}
		rest := source[start+len("func "+name):]
		end := strings.Index(rest, "\nfunc ")
		if end < 0 {
			t.Fatalf("%s function boundary not found", name)
		}
		functionSource += rest[:end]
	}

	rawWrappers := []string{
		`fmt.Errorf("下载地址为空")`,
		`fmt.Errorf("下载失败：%w"`,
		`fmt.Errorf("安装预编译驱动包失败：%w"`,
		`fmt.Errorf("计算驱动代理摘要失败：%w"`,
		`fmt.Errorf("%s 当前平台需要随包提供运行时依赖`,
		`fmt.Errorf("驱动总包下载地址为空")`,
		`fmt.Errorf("下载驱动总包失败：%w"`,
		`fmt.Errorf("打开驱动总包失败：%w"`,
		`fmt.Errorf("驱动总包内未找到 %s`,
		`fmt.Errorf("读取驱动总包条目失败：%w"`,
		`fmt.Errorf("当前环境未安装 Go`,
		`fmt.Errorf("构建 %s 驱动代理超时`,
		`fmt.Errorf("构建 %s 驱动代理失败`,
		`fmt.Errorf("复制 %s 运行时依赖失败`,
		`fmt.Errorf("设置 %s 驱动代理权限失败`,
		`fmt.Errorf("计算 %s 驱动代理摘要失败`,
		`fmt.Errorf("清理已安装 %s 驱动代理失败`,
		`fmt.Errorf("%s 驱动代理路径被目录占用`,
		`fmt.Errorf("创建 %s 驱动目录失败`,
		`fmt.Errorf("复制预置 %s 驱动代理失败`,
		`fmt.Errorf("计算预置 %s 驱动代理摘要失败`,
	}
	for _, rawWrapper := range rawWrappers {
		if strings.Contains(functionSource, rawWrapper) {
			t.Fatalf("optional driver agent flow still contains raw error wrapper %s", rawWrapper)
		}
	}

	requiredKeys := []string{
		"driver_manager.backend.error.download_url_empty",
		"driver_manager.backend.error.download_failed",
		"driver_manager.backend.error.bundle_url_empty",
		"driver_manager.backend.error.bundle_download_failed",
		"driver_manager.backend.error.open_bundle_failed",
		"driver_manager.backend.error.read_bundle_entry_failed",
		"driver_manager.backend.error.source_build_failed",
		"driver_manager.backend.error.remove_installed_agent_failed",
		"driver_manager.backend.error.agent_path_occupied_by_directory",
		"driver_manager.backend.error.create_named_directory_failed",
		"driver_manager.backend.error.copy_bundled_agent_failed",
		"driver_manager.backend.error.bundled_agent_hash_failed",
	}
	for _, key := range requiredKeys {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("optional driver agent flow does not reference i18n key %q", key)
		}
	}
}

func TestInstallOptionalDriverAgentPackageUsesLocalizedNamedHashFailure(t *testing.T) {
	source := methodsDriverSource(t)

	start := strings.Index(source, "func installOptionalDriverAgentPackage")
	if start < 0 {
		t.Fatal("methods_driver.go missing installOptionalDriverAgentPackage")
	}
	rest := source[start+len("func installOptionalDriverAgentPackage"):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		t.Fatal("installOptionalDriverAgentPackage function boundary not found")
	}
	functionSource := rest[:end]

	if strings.Contains(functionSource, `fmt.Errorf("计算 %s 驱动代理摘要失败：%w"`) {
		t.Fatal("installOptionalDriverAgentPackage still contains raw driver agent hash wrapper")
	}
	if !strings.Contains(functionSource, `newLocalizedDriverBackendError("driver_manager.backend.error.named_agent_hash_failed"`) {
		t.Fatal("installOptionalDriverAgentPackage missing localized named agent hash wrapper")
	}
}

func TestEnsureOptionalDriverAgentBinaryUsesCurrentLanguageForPrebuiltPathErrors(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	executablePath := filepath.Join(t.TempDir(), optionalDriverExecutableBaseName("kingbase"))
	if err := os.MkdirAll(executablePath, 0o755); err != nil {
		t.Fatalf("create occupied executable directory failed: %v", err)
	}

	_, _, err := ensureOptionalDriverAgentBinary(
		app,
		driverDefinition{Type: "kingbase", Name: "Kingbase"},
		executablePath,
		"builtin://activate/kingbase",
		"0.0.0-test",
	)
	if err == nil {
		t.Fatal("expected occupied executable path to fail")
	}
	message := localizedDriverBackendErrorMessage(app, err)
	if !strings.Contains(message, "Kingbase driver-agent path is occupied by a directory") {
		t.Fatalf("expected English path occupied message, got %q", message)
	}
	if strings.Contains(message, "驱动代理路径被目录占用") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", message)
	}
	if !strings.Contains(message, executablePath) {
		t.Fatalf("expected raw executable path to stay in detail, got %q", message)
	}
}

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

func TestVerifyInstalledOptionalDriverAgentRevisionLocalizesMetadataUnavailable(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
	})
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		if driverType != "sqlserver" {
			t.Fatalf("unexpected driver type %q", driverType)
		}
		if executablePath != `C:\raw\driver-agent.exe` {
			t.Fatalf("unexpected executable path %q", executablePath)
		}
		return db.OptionalDriverAgentMetadata{}, fmt.Errorf("probe raw detail")
	}

	_, err := verifyInstalledOptionalDriverAgentRevision("sqlserver", `C:\raw\driver-agent.exe`)
	if err == nil {
		t.Fatal("expected metadata unavailable error")
	}

	app := NewApp()
	app.SetLanguage("en-US")
	got := localizedDriverBackendErrorMessage(app, err)
	if !strings.Contains(got, "driver-agent version metadata is unavailable") {
		t.Fatalf("expected English metadata wrapper, got %q", got)
	}
	if !strings.Contains(got, "probe raw detail") {
		t.Fatalf("expected raw probe detail to pass through, got %q", got)
	}
	for _, forbidden := range []string{"驱动代理", "不可用", "请安装"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("expected no Chinese wrapper fragment %q in %q", forbidden, got)
		}
	}
}

func TestVerifyInstalledOptionalDriverAgentRevisionLocalizesRevisionMismatch(t *testing.T) {
	expectedRevision := strings.TrimSpace(db.OptionalDriverAgentRevision("sqlserver"))
	if expectedRevision == "" {
		t.Fatal("expected sqlserver to define optional driver agent revision")
	}

	cases := []struct {
		name       string
		revision   string
		wantActual string
	}{
		{name: "raw actual revision", revision: "src-old", wantActual: "src-old"},
		{name: "empty actual revision", revision: "", wantActual: "empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			originalProbe := optionalDriverAgentMetadataProbe
			t.Cleanup(func() {
				optionalDriverAgentMetadataProbe = originalProbe
			})
			optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
				return db.OptionalDriverAgentMetadata{
					DriverType:    driverType,
					AgentRevision: tc.revision,
				}, nil
			}

			_, err := verifyInstalledOptionalDriverAgentRevision("sqlserver", `C:\raw\driver-agent.exe`)
			if err == nil {
				t.Fatal("expected revision mismatch error")
			}

			app := NewApp()
			app.SetLanguage("en-US")
			got := localizedDriverBackendErrorMessage(app, err)
			if !strings.Contains(got, "driver-agent revision does not match") {
				t.Fatalf("expected English revision mismatch wrapper, got %q", got)
			}
			if !strings.Contains(got, "installed: "+tc.wantActual) {
				t.Fatalf("expected installed revision %q to pass through, got %q", tc.wantActual, got)
			}
			if !strings.Contains(got, "required: "+expectedRevision) {
				t.Fatalf("expected required revision %q to pass through, got %q", expectedRevision, got)
			}
			for _, forbidden := range []string{"驱动代理", "不匹配", "已安装", "当前需要", "请安装", "空"} {
				if strings.Contains(got, forbidden) {
					t.Fatalf("expected no Chinese wrapper fragment %q in %q", forbidden, got)
				}
			}
		})
	}
}

func TestVerifyInstalledOptionalDriverAgentRevisionUsesI18nWrappers(t *testing.T) {
	source := methodsDriverSource(t)
	start := strings.Index(source, "func verifyInstalledOptionalDriverAgentRevision")
	if start < 0 {
		t.Fatal("methods_driver.go missing verifyInstalledOptionalDriverAgentRevision")
	}
	rest := source[start:]
	end := strings.Index(rest[len("func verifyInstalledOptionalDriverAgentRevision"):], "\nfunc ")
	if end < 0 {
		t.Fatal("verifyInstalledOptionalDriverAgentRevision function boundary not found")
	}
	functionSource := rest[:len("func verifyInstalledOptionalDriverAgentRevision")+end]

	for _, rawWrapper := range []string{
		`驱动代理版本元数据不可用，请安装当前版本对应的 driver-agent`,
		`驱动代理 revision 不匹配（已安装：`,
		`actualLabel = "空"`,
	} {
		if strings.Contains(functionSource, rawWrapper) {
			t.Fatalf("verifyInstalledOptionalDriverAgentRevision still contains raw wrapper %s", rawWrapper)
		}
	}
	for _, key := range []string{
		"driver_manager.backend.error.agent_metadata_unavailable",
		"driver_manager.backend.error.agent_revision_mismatch",
		"driver_manager.backend.error.agent_revision_mismatch_empty_actual",
	} {
		if !strings.Contains(functionSource, key) {
			t.Fatalf("verifyInstalledOptionalDriverAgentRevision does not reference i18n key %q", key)
		}
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

func TestIRISDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("iris")
	if !ok {
		t.Fatal("expected iris driver definition")
	}
	if definition.Name != "InterSystems IRIS" {
		t.Fatalf("unexpected iris driver name: %q", definition.Name)
	}
	if driverGoModulePathMap["iris"] != "github.com/caretdev/go-irisnative" {
		t.Fatalf("unexpected iris go module path: %q", driverGoModulePathMap["iris"])
	}
	if definition.PinnedVersion != "0.2.1" {
		t.Fatalf("unexpected iris definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/iris" {
		t.Fatalf("unexpected iris default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["iris"] != "0.2.1" {
		t.Fatalf("unexpected iris pinned version: %q", latestDriverVersionMap["iris"])
	}

	tags, err := optionalDriverBuildTags("iris", "")
	if err != nil {
		t.Fatalf("resolve iris build tags failed: %v", err)
	}
	if tags != "gonavi_iris_driver" {
		t.Fatalf("unexpected iris build tag: %q", tags)
	}
}

func TestElasticsearchDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("elasticsearch")
	if !ok {
		t.Fatal("expected elasticsearch driver definition")
	}
	if definition.Name != "Elasticsearch" {
		t.Fatalf("unexpected elasticsearch driver name: %q", definition.Name)
	}
	if definition.BuiltIn {
		t.Fatal("expected elasticsearch to be an optional driver agent")
	}
	if driverGoModulePathMap["elasticsearch"] != "github.com/elastic/go-elasticsearch/v8" {
		t.Fatalf("unexpected elasticsearch go module path: %q", driverGoModulePathMap["elasticsearch"])
	}
	if definition.PinnedVersion != "8.19.6" {
		t.Fatalf("unexpected elasticsearch definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/elasticsearch" {
		t.Fatalf("unexpected elasticsearch default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["elasticsearch"] != "8.19.6" {
		t.Fatalf("unexpected elasticsearch pinned version: %q", latestDriverVersionMap["elasticsearch"])
	}

	tags, err := optionalDriverBuildTags("elasticsearch", "")
	if err != nil {
		t.Fatalf("resolve elasticsearch build tags failed: %v", err)
	}
	if tags != "gonavi_elasticsearch_driver" {
		t.Fatalf("unexpected elasticsearch build tag: %q", tags)
	}
}

func TestTrinoDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("trino")
	if !ok {
		t.Fatal("expected trino driver definition")
	}
	if definition.Name != "Trino" {
		t.Fatalf("unexpected trino driver name: %q", definition.Name)
	}
	if definition.BuiltIn {
		t.Fatal("expected trino to be an optional driver agent")
	}
	if driverGoModulePathMap["trino"] != "github.com/trinodb/trino-go-client" {
		t.Fatalf("unexpected trino go module path: %q", driverGoModulePathMap["trino"])
	}
	if definition.PinnedVersion != "0.333.0" {
		t.Fatalf("unexpected trino definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/trino" {
		t.Fatalf("unexpected trino default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["trino"] != "0.333.0" {
		t.Fatalf("unexpected trino pinned version: %q", latestDriverVersionMap["trino"])
	}

	tags, err := optionalDriverBuildTags("trino", "")
	if err != nil {
		t.Fatalf("resolve trino build tags failed: %v", err)
	}
	if tags != "gonavi_trino_driver" {
		t.Fatalf("unexpected trino build tag: %q", tags)
	}
}

func TestIoTDBDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("iotdb")
	if !ok {
		t.Fatal("expected iotdb driver definition")
	}
	if definition.Name != "Apache IoTDB" {
		t.Fatalf("unexpected iotdb driver name: %q", definition.Name)
	}
	if definition.BuiltIn {
		t.Fatal("expected iotdb to be an optional driver agent")
	}
	if driverGoModulePathMap["iotdb"] != "github.com/apache/iotdb-client-go" {
		t.Fatalf("unexpected iotdb go module path: %q", driverGoModulePathMap["iotdb"])
	}
	if definition.PinnedVersion != "1.3.7" {
		t.Fatalf("unexpected iotdb definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/iotdb" {
		t.Fatalf("unexpected iotdb default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["iotdb"] != "1.3.7" {
		t.Fatalf("unexpected iotdb pinned version: %q", latestDriverVersionMap["iotdb"])
	}

	tags, err := optionalDriverBuildTags("iotdb", "")
	if err != nil {
		t.Fatalf("resolve iotdb build tags failed: %v", err)
	}
	if tags != "gonavi_iotdb_driver" {
		t.Fatalf("unexpected iotdb build tag: %q", tags)
	}
}

func TestKafkaDriverDefinitionIsBuiltIn(t *testing.T) {
	definition, ok := resolveDriverDefinition("apache-kafka")
	if !ok {
		t.Fatal("expected kafka driver definition")
	}
	if definition.Name != "Kafka" {
		t.Fatalf("unexpected kafka driver name: %q", definition.Name)
	}
	if !definition.BuiltIn {
		t.Fatal("expected kafka to be a built-in driver")
	}
	if definition.PinnedVersion != "" || definition.DefaultDownloadURL != "" {
		t.Fatalf("expected kafka builtin definition to omit optional-agent metadata: %#v", definition)
	}
}

func TestMQTTDriverDefinitionIsBuiltIn(t *testing.T) {
	definition, ok := resolveDriverDefinition("mqtts")
	if !ok {
		t.Fatal("expected mqtt driver definition")
	}
	if definition.Name != "MQTT" {
		t.Fatalf("unexpected mqtt driver name: %q", definition.Name)
	}
	if !definition.BuiltIn {
		t.Fatal("expected mqtt to be a built-in driver")
	}
	if definition.PinnedVersion != "" || definition.DefaultDownloadURL != "" {
		t.Fatalf("expected mqtt builtin definition to omit optional-agent metadata: %#v", definition)
	}
}

func TestRocketMQDriverDefinitionIsBuiltIn(t *testing.T) {
	definition, ok := resolveDriverDefinition("rmq")
	if !ok {
		t.Fatal("expected rocketmq driver definition")
	}
	if definition.Name != "RocketMQ" {
		t.Fatalf("unexpected rocketmq driver name: %q", definition.Name)
	}
	if !definition.BuiltIn {
		t.Fatal("expected rocketmq to be a built-in driver")
	}
	if definition.PinnedVersion != "" || definition.DefaultDownloadURL != "" {
		t.Fatalf("expected rocketmq builtin definition to omit optional-agent metadata: %#v", definition)
	}
}

func TestRabbitMQDriverDefinitionIsBuiltIn(t *testing.T) {
	definition, ok := resolveDriverDefinition("rabbit-mq")
	if !ok {
		t.Fatal("expected rabbitmq driver definition")
	}
	if definition.Name != "RabbitMQ" {
		t.Fatalf("unexpected rabbitmq driver name: %q", definition.Name)
	}
	if !definition.BuiltIn {
		t.Fatal("expected rabbitmq to be a built-in driver")
	}
	if definition.PinnedVersion != "" || definition.DefaultDownloadURL != "" {
		t.Fatalf("expected rabbitmq builtin definition to omit optional-agent metadata: %#v", definition)
	}
}

func TestGoldenDBDriverDefinitionIsBuiltIn(t *testing.T) {
	definition, ok := resolveDriverDefinition("greatdb")
	if !ok {
		t.Fatal("expected goldendb driver definition")
	}
	if definition.Name != "GoldenDB" {
		t.Fatalf("unexpected goldendb driver name: %q", definition.Name)
	}
	if !definition.BuiltIn {
		t.Fatal("expected goldendb to be a built-in driver")
	}
	if definition.PinnedVersion != "" || definition.DefaultDownloadURL != "" {
		t.Fatalf("expected goldendb builtin definition to omit optional metadata: %#v", definition)
	}
	if latestDriverVersionMap["goldendb"] != "1.9.3" {
		t.Fatalf("unexpected goldendb pinned version: %q", latestDriverVersionMap["goldendb"])
	}
	if driverGoModulePathMap["goldendb"] != "github.com/go-sql-driver/mysql" {
		t.Fatalf("unexpected goldendb go module path: %q", driverGoModulePathMap["goldendb"])
	}
}

func TestGaussDBDriverDefinitionUsesOptionalAgent(t *testing.T) {
	definition, ok := resolveDriverDefinition("gaussdb")
	if !ok {
		t.Fatal("expected gaussdb driver definition")
	}
	if definition.Name != "GaussDB" {
		t.Fatalf("unexpected gaussdb driver name: %q", definition.Name)
	}
	if definition.BuiltIn {
		t.Fatal("expected gaussdb to be an optional driver agent")
	}
	if driverGoModulePathMap["gaussdb"] != "github.com/HuaweiCloudDeveloper/gaussdb-go" {
		t.Fatalf("unexpected gaussdb go module path: %q", driverGoModulePathMap["gaussdb"])
	}
	if definition.PinnedVersion != "v1.0.0-rc1" {
		t.Fatalf("unexpected gaussdb definition pinned version: %q", definition.PinnedVersion)
	}
	if definition.DefaultDownloadURL != "builtin://activate/gaussdb" {
		t.Fatalf("unexpected gaussdb default download URL: %q", definition.DefaultDownloadURL)
	}
	if latestDriverVersionMap["gaussdb"] != "v1.0.0-rc1" {
		t.Fatalf("unexpected gaussdb pinned version: %q", latestDriverVersionMap["gaussdb"])
	}

	tags, err := optionalDriverBuildTags("gaussdb", "")
	if err != nil {
		t.Fatalf("resolve gaussdb build tags failed: %v", err)
	}
	if tags != "gonavi_gaussdb_driver" {
		t.Fatalf("unexpected gaussdb build tag: %q", tags)
	}
}

func TestBuildOptionalDriverInstallPlanMessagePrefersDirectThenBundle(t *testing.T) {
	message := buildOptionalDriverInstallPlanMessage(zhCNDriverProgressText(t), "SQL Server", "1.9.6", false, false, false, false, 1, 2)
	if !strings.Contains(message, "先尝试 1 个预编译直链") {
		t.Fatalf("expected direct-download hint, got %q", message)
	}
	if !strings.Contains(message, "失败后转入 2 个驱动总包源") {
		t.Fatalf("expected bundle fallback hint, got %q", message)
	}
}

func TestBuildOptionalDriverFallbackProgressMessageReportsBundleFallback(t *testing.T) {
	message := buildOptionalDriverFallbackProgressMessage(zhCNDriverProgressText(t), "SQL Server", 1, 2, false)
	if !strings.Contains(message, "预编译直链未命中") {
		t.Fatalf("expected direct miss hint, got %q", message)
	}
	if !strings.Contains(message, "转入驱动总包兜底") {
		t.Fatalf("expected bundle fallback hint, got %q", message)
	}
}

func TestOptionalDriverProgressNewCatalogKeysResolve(t *testing.T) {
	text := zhCNDriverProgressText(t)
	plan := buildOptionalDriverInstallPlanMessage(text, "SQL Server", "1.9.6", false, false, true, false, 1, 2)
	if !strings.Contains(plan, "开发态使用本地源码构建") || strings.Contains(plan, "driver_manager.progress.plan.require_source_first") {
		t.Fatalf("expected localized require-source-first plan message, got %q", plan)
	}

	prebuilt := text("driver_manager.progress.download_prebuilt_package", map[string]any{"name": "SQL Server"})
	if !strings.Contains(prebuilt, "下载预编译 SQL Server 驱动包") {
		t.Fatalf("expected localized prebuilt package progress, got %q", prebuilt)
	}

	waitBundle := text("driver_manager.progress.wait_bundle", map[string]any{"name": "SQL Server"})
	if !strings.Contains(waitBundle, "等待 SQL Server 驱动总包下载完成") {
		t.Fatalf("expected localized wait bundle progress, got %q", waitBundle)
	}
}

func zhCNDriverProgressText(t *testing.T) func(string, map[string]any) string {
	t.Helper()
	localizer := newAppLocalizer()
	if localizer == nil {
		t.Fatal("expected app localizer")
	}
	localizer.SetLanguage(i18n.LanguageZhCN)
	return localizer.T
}

func TestOptionalDriverAgentProgressMessagesUseLocalizedText(t *testing.T) {
	source := methodsDriverSource(t)

	rawMessages := []string{
		`"准备安装 %s 驱动代理`,
		`"预编译直链未命中`,
		`"直链不可用`,
		`"发布资产未命中`,
		`"优先使用本地源码构建 %s 驱动代理"`,
		`"下载预编译 %s 驱动代理"`,
		`"从驱动总包提取 %s 代理"`,
		`"未命中预编译包，尝试开发态本地构建"`,
		`"下载 %s 驱动总包"`,
		`"等待 %s 驱动总包下载完成"`,
		`"解压 %s 驱动代理"`,
	}
	for _, rawMessage := range rawMessages {
		if strings.Contains(source, rawMessage) {
			t.Fatalf("methods_driver.go still contains raw optional driver progress message %s", rawMessage)
		}
	}

	keys := []string{
		"driver_manager.progress.plan.direct_then_bundle",
		"driver_manager.progress.plan.require_source_first",
		"driver_manager.progress.fallback.direct_to_bundle",
		"driver_manager.progress.source_build_preferred",
		"driver_manager.progress.download_prebuilt_agent",
		"driver_manager.progress.download_prebuilt_package",
		"driver_manager.progress.extract_agent_from_bundle",
		"driver_manager.progress.dev_build_fallback",
		"driver_manager.progress.download_bundle",
		"driver_manager.progress.wait_bundle",
		"driver_manager.progress.unzip_agent",
	}
	for _, key := range keys {
		if !strings.Contains(source, key) {
			t.Fatalf("methods_driver.go does not reference optional driver progress i18n key %q", key)
		}
	}
}

func TestDuckDBWindowsBuildUsesDynamicLibraryTag(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("DuckDB Windows dynamic library flow only applies on windows/amd64")
	}

	tags, err := optionalDriverBuildTags("duckdb", "")
	if err != nil {
		t.Fatalf("resolve DuckDB build tags failed: %v", err)
	}
	if !strings.Contains(tags, "gonavi_duckdb_driver") || !strings.Contains(tags, "duckdb_use_lib") {
		t.Fatalf("expected DuckDB Windows build tags to include dynamic library tag, got %q", tags)
	}
	if !shouldPreferSourceBuildBeforeDownload("duckdb", "") {
		t.Fatal("expected DuckDB Windows install to try local dynamic-library build before downloads")
	}
	if !shouldSkipReusableAgentCandidate("duckdb", "") {
		t.Fatal("expected DuckDB Windows install to skip reusable static agent candidates")
	}
	zipAssetName := optionalDriverReleaseZipAssetNameForVersion("duckdb", "")
	seedReleaseAssetCacheEntry(t, "latest", map[string]int64{
		zipAssetName: 19 << 20,
	}, map[string]int64{
		zipAssetName: 19 << 20,
	})
	legacyDirectURL := "https://example.com/duckdb-driver-agent-windows-amd64.exe"
	urls := resolveOptionalDriverAgentDownloadURLs(driverDefinition{Type: "duckdb"}, legacyDirectURL, "")
	if len(urls) != 1 {
		t.Fatalf("expected DuckDB Windows install to use only the dedicated zip, got %v", urls)
	}
	if urls[0] != driverReleaseLatestDownloadURL(zipAssetName) {
		t.Fatalf("expected DuckDB Windows dedicated zip candidate first, got %v", urls)
	}
}

func TestDuckDBWindowsDynamicLibraryCGOLDFlagsIncludeSupportLibraries(t *testing.T) {
	flags := duckDBWindowsDynamicLibraryCGOLDFlags(`C:\tmp\duckdb lib`)
	for _, expected := range []string{
		`-LC:/tmp/duckdb lib`,
		"-lduckdb",
		"-lstdc++",
		"-lm",
		"-lws2_32",
		"-lwsock32",
		"-lrstrtmgr",
	} {
		if !strings.Contains(flags, expected) {
			t.Fatalf("expected flags %q to contain %q", flags, expected)
		}
	}
}

func TestInstallOptionalDriverAgentFromLocalZipExtractsDuckDBDLL(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("DuckDB DLL support file is only required on windows/amd64")
	}

	tmpDir := t.TempDir()
	zipPath := filepath.Join(tmpDir, "duckdb-driver.zip")
	zipFile, err := os.Create(zipPath)
	if err != nil {
		t.Fatalf("create zip failed: %v", err)
	}
	zw := zip.NewWriter(zipFile)
	for name, content := range map[string]string{
		"Windows/duckdb-driver-agent-windows-amd64.exe": "agent",
		"Windows/duckdb.dll":                            "dll",
	} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create zip entry %s failed: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("write zip entry %s failed: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip writer failed: %v", err)
	}
	if err := zipFile.Close(); err != nil {
		t.Fatalf("close zip file failed: %v", err)
	}

	target := filepath.Join(tmpDir, "install", "duckdb-driver-agent.exe")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("create install dir failed: %v", err)
	}
	entryName, err := installOptionalDriverAgentFromLocalZip(zipPath, driverDefinition{Type: "duckdb", Name: "DuckDB"}, target, "")
	if err != nil {
		t.Fatalf("install local DuckDB zip failed: %v", err)
	}
	if entryName != "Windows/duckdb-driver-agent-windows-amd64.exe" {
		t.Fatalf("unexpected extracted agent entry: %q", entryName)
	}
	dllBytes, err := os.ReadFile(filepath.Join(filepath.Dir(target), "duckdb.dll"))
	if err != nil {
		t.Fatalf("expected duckdb.dll to be extracted: %v", err)
	}
	if string(dllBytes) != "dll" {
		t.Fatalf("unexpected duckdb.dll content: %q", string(dllBytes))
	}
}

func TestDownloadOptionalDriverAgentBinaryInstallsDuckDBDedicatedZip(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("DuckDB dedicated zip flow only applies on windows/amd64")
	}

	originalValidateFunc := validateOptionalDriverAgentExecutableFunc
	validateOptionalDriverAgentExecutableFunc = func(driverType string, executablePath string) error {
		return nil
	}
	t.Cleanup(func() {
		validateOptionalDriverAgentExecutableFunc = originalValidateFunc
	})

	tmpDir := t.TempDir()
	zipAssetName := optionalDriverReleaseZipAssetNameForVersion("duckdb", "")
	zipPath := filepath.Join(tmpDir, zipAssetName)
	zipFile, err := os.Create(zipPath)
	if err != nil {
		t.Fatalf("create zip failed: %v", err)
	}
	zw := zip.NewWriter(zipFile)
	for name, content := range map[string]string{
		"Windows/duckdb-driver-agent-windows-amd64.exe": "agent",
		"Windows/duckdb.dll":                            "dll",
	} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create zip entry %s failed: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("write zip entry %s failed: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip writer failed: %v", err)
	}
	if err := zipFile.Close(); err != nil {
		t.Fatalf("close zip file failed: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, zipPath)
	}))
	defer server.Close()
	proxySnapshot := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy)
	})

	target := filepath.Join(tmpDir, "install", "duckdb-driver-agent.exe")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("create install dir failed: %v", err)
	}

	hash, err := downloadOptionalDriverAgentBinary(nil, driverDefinition{Type: "duckdb", Name: "DuckDB"}, server.URL+"/"+zipAssetName+"?source=release", target, "")
	if err != nil {
		t.Fatalf("download dedicated zip failed: %v", err)
	}
	if strings.TrimSpace(hash) == "" {
		t.Fatal("expected hash for installed duckdb agent")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("expected duckdb agent to be installed: %v", err)
	}
	dllBytes, err := os.ReadFile(filepath.Join(filepath.Dir(target), "duckdb.dll"))
	if err != nil {
		t.Fatalf("expected duckdb.dll to be installed: %v", err)
	}
	if string(dllBytes) != "dll" {
		t.Fatalf("unexpected duckdb.dll content: %q", string(dllBytes))
	}
}

func TestDownloadOptionalDriverAgentBinaryPreservesMongoSelectedVersion(t *testing.T) {
	originalValidateFunc := validateOptionalDriverAgentExecutableFunc
	validateOptionalDriverAgentExecutableFunc = func(driverType string, executablePath string) error {
		return nil
	}
	t.Cleanup(func() {
		validateOptionalDriverAgentExecutableFunc = originalValidateFunc
	})
	disableGlobalProxyForTest(t)
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		t.Setenv(name, "")
	}

	tmpDir := t.TempDir()
	rawAssetName := mongoVersionedReleaseAssetName(1)
	zipAssetName := optionalDriverReleaseZipAssetName(rawAssetName)
	zipPath := filepath.Join(tmpDir, zipAssetName)
	zipFile, err := os.Create(zipPath)
	if err != nil {
		t.Fatalf("create MongoDB ZIP: %v", err)
	}
	zw := zip.NewWriter(zipFile)
	entryPath := filepath.ToSlash(filepath.Join(optionalDriverBundlePlatformDir(runtime.GOOS), rawAssetName))
	entry, err := zw.Create(entryPath)
	if err != nil {
		t.Fatalf("create MongoDB v1 entry: %v", err)
	}
	if _, err := entry.Write([]byte("mongodb-v1-agent")); err != nil {
		t.Fatalf("write MongoDB v1 entry: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close MongoDB ZIP: %v", err)
	}
	if err := zipFile.Close(); err != nil {
		t.Fatalf("close MongoDB ZIP file: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, zipPath)
	}))
	defer server.Close()
	target := filepath.Join(tmpDir, "install", optionalDriverExecutableBaseNameForType("mongodb"))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatalf("create MongoDB install dir: %v", err)
	}
	if _, err := downloadOptionalDriverAgentBinary(
		nil,
		driverDefinition{Type: "mongodb", Name: "MongoDB"},
		server.URL+"/"+zipAssetName,
		target,
		"1.17.9",
	); err != nil {
		t.Fatalf("download MongoDB v1 ZIP: %v", err)
	}
	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read installed MongoDB v1 agent: %v", err)
	}
	if string(installed) != "mongodb-v1-agent" {
		t.Fatalf("unexpected installed MongoDB v1 agent: %q", string(installed))
	}
}

func TestOptionalDriverDownloadZipURLAcceptsQueryString(t *testing.T) {
	if !isOptionalDriverDownloadZipURL("https://example.com/duckdb-driver.zip?token=abc") {
		t.Fatal("expected signed zip URL to be treated as zip download")
	}
	if isOptionalDriverDownloadZipURL("https://example.com/duckdb-driver-agent.exe?token=abc") {
		t.Fatal("expected exe URL with query to remain non-zip download")
	}
}

func TestDownloadDriverPackageRejectsUnsupportedMongoVersion(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	result := app.DownloadDriverPackage("mongodb", "1.16.1", "builtin://activate/mongodb?channel=history&version=1.16.1", t.TempDir())
	if result.Success {
		t.Fatal("expected unsupported MongoDB 1.16.1 install to be rejected")
	}
	if !strings.Contains(result.Message, "only 1.17.x and 2.x are supported") {
		t.Fatalf("expected English support-range error, got %q", result.Message)
	}
	if strings.Contains(result.Message, "仅支持 1.17.x 和 2.x") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", result.Message)
	}
}

func TestDownloadDriverPackageUsesCurrentLanguageForBuiltinWrapper(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	result := app.DownloadDriverPackage("mysql", "", "", t.TempDir())
	if result.Success {
		t.Fatal("expected built-in driver download to be rejected")
	}
	if !strings.Contains(result.Message, "Built-in drivers do not need extension package downloads") {
		t.Fatalf("expected English built-in wrapper, got %q", result.Message)
	}
	if strings.Contains(result.Message, "内置驱动无需下载扩展包") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", result.Message)
	}
}

func TestBuildDriverVersionDisplayLabelUsesLocalizedText(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	label := buildDriverVersionDisplayLabel(driverVersionOptionItem{
		Source:      "latest",
		Recommended: true,
	}, app.appText)
	if got, want := label, "Unlabeled version (latest) (recommended)"; got != want {
		t.Fatalf("expected localized English display label %q, got %q", want, got)
	}
	if strings.Contains(label, "未标注版本") || strings.Contains(label, "（最新）") || strings.Contains(label, "（推荐）") {
		t.Fatalf("expected localized display label instead of fixed Chinese, got %q", label)
	}

	rawVersionLabel := buildDriverVersionDisplayLabel(driverVersionOptionItem{
		Version: "v1.2.3",
		Source:  "latest",
	}, app.appText)
	if got, want := rawVersionLabel, "v1.2.3 (latest)"; got != want {
		t.Fatalf("expected raw version with localized suffix %q, got %q", want, got)
	}
}

func TestResolveDriverPackageSizeTextUsesLocalizedStatusText(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	builtInText := resolveDriverPackageSizeText(driverDefinition{BuiltIn: true}, installedDriverPackage{}, false, nil, app.appText)
	if got, want := builtInText, "Built-in"; got != want {
		t.Fatalf("expected localized built-in package size text %q, got %q", want, got)
	}
	if strings.Contains(builtInText, "内置") {
		t.Fatalf("expected localized built-in package size text instead of fixed Chinese, got %q", builtInText)
	}

	pendingText := resolveDriverPackageSizeText(driverDefinition{Type: "jdbc-only-test"}, installedDriverPackage{}, false, map[string]int64{}, app.appText)
	if got, want := pendingText, "Pending release"; got != want {
		t.Fatalf("expected localized pending-release package size text %q, got %q", want, got)
	}
	if strings.Contains(pendingText, "待发布") {
		t.Fatalf("expected localized pending-release package size text instead of fixed Chinese, got %q", pendingText)
	}

	sizeText := resolveDriverPackageSizeText(driverDefinition{Type: "mariadb"}, installedDriverPackage{}, false, map[string]int64{
		"mariadb": 12 * 1024 * 1024,
	}, app.appText)
	if got, want := sizeText, "12.00 MB"; got != want {
		t.Fatalf("expected raw size text %q to stay unchanged, got %q", want, got)
	}
}

func TestDriverVersionDisplayLabelsAndPackageSizeStatusesUseI18nKeys(t *testing.T) {
	source := methodsDriverSource(t)

	if !strings.Contains(source, "resolveDriverVersionOptions(definition, repositoryURL, a.appText)") {
		t.Fatal("expected GetDriverVersionList to pass app localizer into resolveDriverVersionOptions")
	}
	if !strings.Contains(source, "buildDriverVersionDisplayLabel(option, text)") {
		t.Fatal("expected resolveDriverVersionOptions to pass localizer into buildDriverVersionDisplayLabel")
	}
	if !strings.Contains(source, "resolveDriverPackageSizeText(definition, pkg, packageMetaExists, packageSizeBytesMap, a.appText)") {
		t.Fatal("expected GetDriverStatusList to pass app localizer into resolveDriverPackageSizeText")
	}

	buildStart := strings.Index(source, "func buildDriverVersionDisplayLabel")
	if buildStart < 0 {
		t.Fatal("methods_driver.go missing buildDriverVersionDisplayLabel")
	}
	buildRest := source[buildStart:]
	buildEnd := strings.Index(buildRest, "\nfunc resolveRecentDriverVersionOptions")
	if buildEnd < 0 {
		t.Fatal("buildDriverVersionDisplayLabel function boundary not found")
	}
	buildSource := buildRest[:buildEnd]

	for _, rawText := range []string{`"未标注版本"`, `"（最新）"`, `"（推荐）"`} {
		if strings.Contains(buildSource, rawText) {
			t.Fatalf("buildDriverVersionDisplayLabel still contains raw display text %s", rawText)
		}
	}
	for _, key := range []string{
		"driver_manager.version.unlabeled",
		"driver_manager.version.latest_suffix",
		"driver_manager.version.recommended_suffix",
	} {
		if !strings.Contains(buildSource, key) {
			t.Fatalf("buildDriverVersionDisplayLabel does not reference i18n key %q", key)
		}
	}

	sizeStart := strings.Index(source, "func resolveDriverPackageSizeText")
	if sizeStart < 0 {
		t.Fatal("methods_driver.go missing resolveDriverPackageSizeText")
	}
	sizeRest := source[sizeStart:]
	sizeEnd := strings.Index(sizeRest, "\nfunc readInstalledPackageSizeBytes")
	if sizeEnd < 0 {
		t.Fatal("resolveDriverPackageSizeText function boundary not found")
	}
	sizeSource := sizeRest[:sizeEnd]

	for _, rawText := range []string{`"内置"`, `"待发布"`} {
		if strings.Contains(sizeSource, rawText) {
			t.Fatalf("resolveDriverPackageSizeText still contains raw status text %s", rawText)
		}
	}
	for _, key := range []string{
		"driver_manager.package_size.built_in",
		"driver_manager.package_size.pending_release",
	} {
		if !strings.Contains(sizeSource, key) {
			t.Fatalf("resolveDriverPackageSizeText does not reference i18n key %q", key)
		}
	}
}

func TestLocalizedDriverNeedsUpdateTextsUseCurrentLanguage(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	reason, message := app.localizedDriverNeedsUpdateTexts("rev-old", "rev-new", 3)
	if !strings.Contains(reason, "Reinstall required to apply driver updates.") {
		t.Fatalf("expected English update reason, got %q", reason)
	}
	if !strings.Contains(reason, "installed revision rev-old.") || !strings.Contains(reason, "expected revision rev-new.") {
		t.Fatalf("expected English revision detail, got %q", reason)
	}
	if !strings.Contains(message, "Affects 3 saved connections") {
		t.Fatalf("expected affected-connections detail, got %q", message)
	}
	if strings.Contains(reason, "需要重装") || strings.Contains(message, "已保存连接") {
		t.Fatalf("expected localized update texts instead of fixed Chinese, got reason=%q message=%q", reason, message)
	}
}

func TestLocalizeDriverSelectionErrorUsesCurrentLanguageForSlimBuild(t *testing.T) {
	app := NewApp()
	app.SetLanguage("en-US")

	definition := driverDefinition{Type: "clickhouse", Name: "ClickHouse"}
	err := app.localizeDriverSelectionError(definition, &driverBuildUnavailableError{Name: "ClickHouse"})
	if err == nil {
		t.Fatal("expected localized slim-build error")
	}
	if !strings.Contains(err.Error(), "ClickHouse is not included in the current slim build") {
		t.Fatalf("expected English slim-build wrapper, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "当前发行包为精简构建") {
		t.Fatalf("expected localized wrapper instead of fixed Chinese, got %q", err.Error())
	}
}

func TestResolveRecentDriverVersionMetasIncludesHistoricalTDengineVersionsFromCache(t *testing.T) {
	seedGoModuleVersionCache(t, "github.com/taosdata/driver-go/v3", []string{
		"3.8.0",
		"3.7.8",
		"3.7.7",
		"3.7.6",
		"3.7.5",
		"3.7.4",
		"3.7.3",
		"3.7.2",
		"3.7.1",
		"3.7.0",
		"3.6.0",
		"3.5.8",
		"3.5.7",
		"3.5.6",
		"3.5.5",
		"3.5.4",
		"3.5.3",
		"3.5.2",
		"3.5.1",
		"3.5.0",
		"3.3.1",
		"3.1.0",
		"3.0.4",
		"3.0.3",
		"3.0.2",
		"3.0.1",
		"3.0.0",
	})

	metas := resolveRecentDriverVersionMetas("tdengine", driverRecentVersionLimit)
	versions := make([]string, 0, len(metas))
	for _, meta := range metas {
		versions = append(versions, meta.Version)
	}

	if !containsVersion(versions, "3.5.8") {
		t.Fatalf("expected tdengine historical version 3.5.8 to remain selectable, got %v", versions)
	}
	if !containsVersion(versions, "3.3.1") {
		t.Fatalf("expected tdengine historical version 3.3.1 to remain selectable, got %v", versions)
	}
}

func TestResolveRecentDriverVersionMetasFallsBackToHistoricalTDengineMatrix(t *testing.T) {
	driverModuleVersionMu.Lock()
	original := driverModuleVersionMap
	driverModuleVersionMap = map[string]goModuleVersionListCacheEntry{}
	driverModuleVersionMu.Unlock()
	t.Cleanup(func() {
		driverModuleVersionMu.Lock()
		driverModuleVersionMap = original
		driverModuleVersionMu.Unlock()
	})

	metas := resolveRecentDriverVersionMetas("tdengine", driverRecentVersionLimit)
	versions := make([]string, 0, len(metas))
	for _, meta := range metas {
		versions = append(versions, meta.Version)
	}

	if !containsVersion(versions, "3.5.8") {
		t.Fatalf("expected tdengine fallback list to include 3.5.8, got %v", versions)
	}
	if !containsVersion(versions, "3.3.1") {
		t.Fatalf("expected tdengine fallback list to include 3.3.1, got %v", versions)
	}
}

func TestShouldForceSourceBuildForResolvedDownload(t *testing.T) {
	if shouldForceSourceBuildForResolvedDownload("mongodb", "1.17.4", "builtin://activate/mongodb?channel=history&version=1.17.4") {
		t.Fatal("expected mongodb v1 builtin install to try published assets before source build")
	}

	explicitURL := driverReleaseDownloadURL("v1.17.4", mongoVersionedReleaseAssetName(1))
	if shouldForceSourceBuildForResolvedDownload("mongodb", "1.17.4", explicitURL) {
		t.Fatal("expected mongodb v1 published asset install to skip forced source build")
	}

	if shouldForceSourceBuildForResolvedDownload("mongodb", "2.5.0", "builtin://activate/mongodb?channel=latest&version=2.5.0") {
		t.Fatal("expected mongodb v2 install not to force source build")
	}
}

func TestShouldPreferSourceBuildBeforeDownloadDoesNotPreferKingbase(t *testing.T) {
	if shouldPreferSourceBuildBeforeDownload("kingbase", "0.0.0-20201021123113-29bd62a876c3") {
		t.Fatal("expected kingbase release install not to prefer source build before download")
	}
}

func TestShouldPreferSourceBuildBeforeDownloadForDevelopmentBuild(t *testing.T) {
	if shouldPreferSourceBuildBeforeDownloadForBuildType("dev", "mariadb", "1.9.3") {
		t.Fatal("expected development release build to prefer published MariaDB driver-agent before source fallback")
	}
	if shouldPreferSourceBuildBeforeDownloadForBuildType("development", "clickhouse", "2.43.1") && !shouldUseDuckDBWindowsDynamicLibrary("clickhouse") {
		t.Fatal("expected development build alias not to prefer source build for ClickHouse")
	}
	if shouldPreferSourceBuildBeforeDownloadForBuildType("production", "mariadb", "1.9.3") {
		t.Fatal("expected production build not to prefer source build for MariaDB")
	}
	if shouldPreferSourceBuildBeforeDownloadForBuildType("dev", "mysql", "") {
		t.Fatal("expected built-in drivers not to prefer optional driver-agent source build")
	}
}

func TestShouldRequireSourceBuildBeforeDownloadForDevelopmentBuild(t *testing.T) {
	if shouldRequireSourceBuildBeforeDownloadForBuildType("dev", "duckdb", "2.5.6") {
		t.Fatal("expected development build to allow DuckDB release bundle fallback after local build failure")
	}
	if shouldUseDuckDBWindowsDynamicLibrary("duckdb") {
		if !shouldPreferSourceBuildBeforeDownloadForBuildType("dev", "duckdb", "2.5.6") {
			t.Fatal("expected DuckDB Windows dynamic-library install to prefer local source build before bundle fallback")
		}
	} else if shouldPreferSourceBuildBeforeDownloadForBuildType("dev", "duckdb", "2.5.6") {
		t.Fatal("expected development build not to prefer DuckDB source build on non-Windows dynamic-library platforms")
	}
	if shouldRequireSourceBuildBeforeDownloadForBuildType("development", "mariadb", "1.9.3") {
		t.Fatal("expected development build alias to allow published MariaDB driver-agent fallback")
	}
	if shouldRequireSourceBuildBeforeDownloadForBuildType("production", "duckdb", "2.5.6") {
		t.Fatal("expected production build to allow DuckDB release bundle fallback")
	}
	if shouldRequireSourceBuildBeforeDownloadForBuildType("dev", "mysql", "") {
		t.Fatal("expected built-in drivers not to require optional driver-agent source build")
	}
}

func TestOptionalDriverInstallTimeoutsStayBounded(t *testing.T) {
	if optionalDriverBundleDownloadTimeout > 15*time.Minute {
		t.Fatalf("driver bundle download timeout should stay bounded, got %s", optionalDriverBundleDownloadTimeout)
	}
	if optionalDriverSourceBuildTimeout > 8*time.Minute {
		t.Fatalf("driver source build timeout should stay bounded, got %s", optionalDriverSourceBuildTimeout)
	}
}

func TestResolveDuckDBWindowsCGOToolchainBinFromCandidates(t *testing.T) {
	binDir := t.TempDir()
	writeSelfExecutable(t, filepath.Join(binDir, "gcc.exe"))
	writeSelfExecutable(t, filepath.Join(binDir, "g++.exe"))

	got, err := resolveDuckDBWindowsCGOToolchainBinFromCandidates([]string{
		filepath.Join(t.TempDir(), "missing"),
		binDir,
	})
	if err != nil {
		t.Fatalf("expected toolchain bin to resolve: %v", err)
	}
	if got != filepath.Clean(binDir) {
		t.Fatalf("expected %q, got %q", filepath.Clean(binDir), got)
	}
}

func TestPrependPathEnvUsesCurrentEnvPath(t *testing.T) {
	basePath := "base-path"
	firstPath := "first-path"
	secondPath := "second-path"
	env := []string{"PATH=" + basePath}
	env = prependPathEnv(env, firstPath)
	env = prependPathEnv(env, secondPath)

	got := envValue(env, "PATH")
	want := strings.Join([]string{secondPath, firstPath, basePath}, string(os.PathListSeparator))
	if got != want {
		t.Fatalf("expected PATH %q, got %q", want, got)
	}
}

func TestResolveOptionalDriverAgentDownloadURLsIncludesPublishedKingbaseAsset(t *testing.T) {
	definition, ok := resolveDriverDefinition("kingbase")
	if !ok {
		t.Fatal("expected kingbase driver definition")
	}

	version := normalizeVersion(definition.PinnedVersion)
	assetName := optionalDriverReleaseZipAssetNameForVersion("kingbase", version)
	publishedAssets := map[string]int64{
		assetName: 18 << 20,
	}
	seedReleaseAssetCacheEntry(t, "tag:v"+version, publishedAssets, publishedAssets)
	seedReleaseAssetCacheEntry(t, "latest", publishedAssets, publishedAssets)

	urls := resolveOptionalDriverAgentDownloadURLs(definition, "builtin://activate/kingbase", version)
	if len(urls) == 0 {
		t.Fatal("expected kingbase pinned install to include published download candidates")
	}

	if !strings.Contains(urls[0], assetName) {
		t.Fatalf("expected first kingbase download URL to contain %q, got %q", assetName, urls[0])
	}
}

func TestInstallOptionalDriverAgentFromLocalPathSupportsMongoV1DirectoryImport(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	packageRoot := t.TempDir()
	platformDir := filepath.Join(packageRoot, optionalDriverBundlePlatformDir(runtime.GOOS))
	if err := os.MkdirAll(platformDir, 0o755); err != nil {
		t.Fatalf("mkdir package dir failed: %v", err)
	}

	assetName := mongoVersionedReleaseAssetName(1)
	writeSelfExecutable(t, filepath.Join(platformDir, assetName))

	installRoot := filepath.Join(t.TempDir(), "drivers")
	meta, err := installOptionalDriverAgentFromLocalPath(definition, packageRoot, installRoot, "1.17.4")
	if err != nil {
		t.Fatalf("expected mongodb v1 directory import to succeed, got %v", err)
	}
	if meta.Version != "1.17.4" {
		t.Fatalf("expected imported version to stay 1.17.4, got %q", meta.Version)
	}
	if filepath.Base(meta.FilePath) != assetName {
		t.Fatalf("expected source file %q, got %q", assetName, meta.FilePath)
	}
	if !strings.Contains(meta.DownloadURL, assetName) {
		t.Fatalf("expected download source to reference %q, got %q", assetName, meta.DownloadURL)
	}
	if _, err := os.Stat(meta.ExecutablePath); err != nil {
		t.Fatalf("expected imported executable to exist, got %v", err)
	}
}

func TestInstallOptionalDriverAgentFromLocalPathSupportsMongoV1ZipImport(t *testing.T) {
	definition, ok := resolveDriverDefinition("mongodb")
	if !ok {
		t.Fatal("expected mongodb driver definition")
	}

	assetName := mongoVersionedReleaseAssetName(1)
	zipPath := filepath.Join(t.TempDir(), "mongodb-v1.zip")
	writeZipWithSelfExecutable(t, zipPath, filepath.ToSlash(filepath.Join(optionalDriverBundlePlatformDir(runtime.GOOS), assetName)))

	installRoot := filepath.Join(t.TempDir(), "drivers")
	meta, err := installOptionalDriverAgentFromLocalPath(definition, zipPath, installRoot, "1.17.4")
	if err != nil {
		t.Fatalf("expected mongodb v1 zip import to succeed, got %v", err)
	}
	if meta.Version != "1.17.4" {
		t.Fatalf("expected imported version to stay 1.17.4, got %q", meta.Version)
	}
	if !strings.Contains(meta.DownloadURL, assetName) {
		t.Fatalf("expected zip download source to reference %q, got %q", assetName, meta.DownloadURL)
	}
	if _, err := os.Stat(meta.ExecutablePath); err != nil {
		t.Fatalf("expected imported executable to exist, got %v", err)
	}
}

func TestDownloadOptionalDriverAgentFromBundleSharesConcurrentDownload(t *testing.T) {
	resetOptionalDriverBundleDownloadCacheForTest(t)
	proxySnapshot := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy)
	})

	bundlePath := filepath.Join(t.TempDir(), "GoNavi-DriverAgents.zip")
	writeZipWithSelfExecutableEntries(t, bundlePath, []string{
		optionalDriverBundleEntryPath("clickhouse"),
		optionalDriverBundleEntryPath("mongodb"),
	})

	var requestCount int32
	releaseDownload := make(chan struct{})
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			close(releaseDownload)
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		<-releaseDownload
		http.ServeFile(w, r, bundlePath)
	}))
	defer server.Close()
	defer release()

	errCh := make(chan error, 2)
	clickhouseTarget := filepath.Join(t.TempDir(), optionalDriverExecutableBaseName("clickhouse"))
	mongodbTarget := filepath.Join(t.TempDir(), optionalDriverExecutableBaseName("mongodb"))
	go func() {
		_, _, err := downloadOptionalDriverAgentFromBundle(
			nil,
			driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
			server.URL,
			clickhouseTarget,
		)
		errCh <- err
	}()

	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&requestCount) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if atomic.LoadInt32(&requestCount) != 1 {
		t.Fatalf("expected first bundle request to start, got %d", atomic.LoadInt32(&requestCount))
	}

	go func() {
		_, _, err := downloadOptionalDriverAgentFromBundle(
			nil,
			driverDefinition{Type: "mongodb", Name: "MongoDB"},
			server.URL,
			mongodbTarget,
		)
		errCh <- err
	}()

	time.Sleep(100 * time.Millisecond)
	if got := atomic.LoadInt32(&requestCount); got != 1 {
		t.Fatalf("expected concurrent bundle install to wait for first download, got %d requests", got)
	}
	release()

	for i := 0; i < 2; i++ {
		if err := <-errCh; err != nil {
			t.Fatalf("bundle install failed: %v", err)
		}
	}
	if got := atomic.LoadInt32(&requestCount); got != 1 {
		t.Fatalf("expected one shared bundle download, got %d requests", got)
	}
}

func TestDownloadOptionalDriverAgentFromBundleLocalizesInvalidBundleDetail(t *testing.T) {
	resetOptionalDriverBundleDownloadCacheForTest(t)
	proxySnapshot := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy)
	})

	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not-a-zip"))
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), optionalDriverExecutableBaseName("clickhouse"))
	_, _, err := downloadOptionalDriverAgentFromBundle(
		app,
		driverDefinition{Type: "clickhouse", Name: "ClickHouse"},
		server.URL,
		target,
	)
	if err == nil {
		t.Fatal("expected invalid bundle to fail")
	}

	message := localizedDriverBackendErrorMessage(app, err)
	if !strings.Contains(message, "Failed to download driver bundle:") {
		t.Fatalf("expected English bundle wrapper, got %q", message)
	}
	if !strings.Contains(message, "open driver bundle failed") {
		t.Fatalf("expected English internal bundle-open detail, got %q", message)
	}
	if strings.Contains(message, "打开驱动总包失败") {
		t.Fatalf("expected no Chinese internal bundle-open detail in en-US mode, got %q", message)
	}
}

func TestDownloadDriverPackageRejectsStaleRevisionAndPreservesInstalledDriver(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	originalValidate := validateOptionalDriverAgentExecutableFunc
	originalLookPath := goBinaryLookPath
	originalStat := goBinaryStat
	originalCommandOutput := goBinaryCommandOutput
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
		validateOptionalDriverAgentExecutableFunc = originalValidate
		goBinaryLookPath = originalLookPath
		goBinaryStat = originalStat
		goBinaryCommandOutput = originalCommandOutput
	})

	tmpDir := t.TempDir()
	driverRoot := filepath.Join(tmpDir, "drivers")
	executablePath, err := db.ResolveOptionalDriverAgentExecutablePath(driverRoot, "sqlserver")
	if err != nil {
		t.Fatalf("resolve installed driver path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(executablePath), 0o755); err != nil {
		t.Fatalf("create installed driver directory: %v", err)
	}
	previousBinary := []byte("previous-sqlserver-driver")
	if err := os.WriteFile(executablePath, previousBinary, 0o755); err != nil {
		t.Fatalf("write previous driver: %v", err)
	}
	previousMeta := installedDriverPackage{
		DriverType:     "sqlserver",
		Version:        "1.9.6",
		AgentRevision:  db.OptionalDriverAgentRevision("sqlserver"),
		FilePath:       executablePath,
		FileName:       filepath.Base(executablePath),
		ExecutablePath: executablePath,
		DownloadURL:    "https://example.test/previous-driver",
		SHA256:         "previous-sha256",
		DownloadedAt:   "2026-07-15T12:00:00+08:00",
	}
	if err := writeInstalledDriverPackage(driverRoot, "sqlserver", previousMeta); err != nil {
		t.Fatalf("write previous driver metadata: %v", err)
	}
	metaPath := installedDriverMetaPath(driverRoot, "sqlserver")
	previousMetaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read previous driver metadata: %v", err)
	}

	staleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("stale-sqlserver-driver"))
	}))
	defer staleServer.Close()
	proxySnapshot := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy)
	})

	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: "src-stale-agent",
		}, nil
	}
	validateOptionalDriverAgentExecutableFunc = func(driverType string, executablePath string) error {
		return nil
	}
	goBinaryLookPath = func(file string) (string, error) {
		return "", os.ErrNotExist
	}
	goBinaryStat = func(name string) (os.FileInfo, error) {
		return nil, os.ErrNotExist
	}
	goBinaryCommandOutput = func(cmd *exec.Cmd) ([]byte, error) {
		return nil, os.ErrNotExist
	}

	app := NewApp()
	result := app.DownloadDriverPackage("sqlserver", "1.9.7", staleServer.URL, driverRoot)
	if result.Success {
		t.Fatal("expected stale driver reinstall to fail")
	}

	installedBinary, err := os.ReadFile(executablePath)
	if err != nil {
		t.Fatalf("read installed driver after failed reinstall: %v", err)
	}
	if string(installedBinary) != string(previousBinary) {
		t.Fatalf("failed reinstall replaced the previous driver: got %q", string(installedBinary))
	}
	installedMetaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read driver metadata after failed reinstall: %v", err)
	}
	if string(installedMetaBytes) != string(previousMetaBytes) {
		t.Fatalf("failed reinstall changed installed metadata:\n%s", string(installedMetaBytes))
	}
	assertNoDriverInstallStagingDirs(t, filepath.Dir(executablePath))
}

func TestInstallLocalDriverPackageRejectsStaleRevisionAndPreservesInstalledDriver(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	originalValidate := validateOptionalDriverAgentExecutableFunc
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
		validateOptionalDriverAgentExecutableFunc = originalValidate
	})

	tmpDir := t.TempDir()
	driverRoot := filepath.Join(tmpDir, "drivers")
	executablePath, err := db.ResolveOptionalDriverAgentExecutablePath(driverRoot, "sqlserver")
	if err != nil {
		t.Fatalf("resolve installed driver path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(executablePath), 0o755); err != nil {
		t.Fatalf("create installed driver directory: %v", err)
	}
	previousBinary := []byte("previous-local-sqlserver-driver")
	if err := os.WriteFile(executablePath, previousBinary, 0o755); err != nil {
		t.Fatalf("write previous driver: %v", err)
	}
	previousMeta := installedDriverPackage{
		DriverType:     "sqlserver",
		Version:        "1.9.6",
		AgentRevision:  db.OptionalDriverAgentRevision("sqlserver"),
		FilePath:       executablePath,
		FileName:       filepath.Base(executablePath),
		ExecutablePath: executablePath,
		DownloadURL:    "local://previous-driver",
		SHA256:         "previous-sha256",
		DownloadedAt:   "2026-07-15T12:00:00+08:00",
	}
	if err := writeInstalledDriverPackage(driverRoot, "sqlserver", previousMeta); err != nil {
		t.Fatalf("write previous driver metadata: %v", err)
	}
	metaPath := installedDriverMetaPath(driverRoot, "sqlserver")
	previousMetaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read previous driver metadata: %v", err)
	}
	stalePackage := filepath.Join(tmpDir, "stale-sqlserver-driver")
	if runtime.GOOS == "windows" {
		stalePackage += ".exe"
	}
	if err := os.WriteFile(stalePackage, []byte("stale-local-sqlserver-driver"), 0o755); err != nil {
		t.Fatalf("write stale local driver package: %v", err)
	}
	validateOptionalDriverAgentExecutableFunc = func(driverType string, executablePath string) error {
		return nil
	}
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: "src-stale-local-agent",
		}, nil
	}

	app := NewApp()
	result := app.InstallLocalDriverPackage("sqlserver", stalePackage, driverRoot, "1.9.6")
	if result.Success {
		t.Fatal("expected stale local driver import to fail")
	}
	installedBinary, err := os.ReadFile(executablePath)
	if err != nil {
		t.Fatalf("read installed driver after failed local import: %v", err)
	}
	if string(installedBinary) != string(previousBinary) {
		t.Fatalf("failed local import replaced the previous driver: got %q", string(installedBinary))
	}
	installedMetaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read metadata after failed local import: %v", err)
	}
	if string(installedMetaBytes) != string(previousMetaBytes) {
		t.Fatalf("failed local import changed installed metadata:\n%s", string(installedMetaBytes))
	}
	assertNoDriverInstallStagingDirs(t, filepath.Dir(executablePath))
}

func TestDownloadDriverPackageFallsBackAfterStaleRevision(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	originalValidate := validateOptionalDriverAgentExecutableFunc
	originalLookPath := goBinaryLookPath
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
		validateOptionalDriverAgentExecutableFunc = originalValidate
		goBinaryLookPath = originalLookPath
	})

	tmpDir := t.TempDir()
	staleServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("stale-kingbase-driver"))
	}))
	defer staleServer.Close()
	proxySnapshot := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy)
	})

	projectRoot := filepath.Join(tmpDir, "project")
	if err := os.MkdirAll(filepath.Join(projectRoot, "cmd", "optional-driver-agent"), 0o755); err != nil {
		t.Fatalf("create project root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projectRoot, "go.mod"), []byte("module GoNavi-Wails\n"), 0o644); err != nil {
		t.Fatalf("write go.mod: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projectRoot, "cmd", "optional-driver-agent", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("write optional driver agent source: %v", err)
	}
	currentAgent := filepath.Join(tmpDir, "current-kingbase-driver")
	if runtime.GOOS == "windows" {
		currentAgent += ".exe"
	}
	if err := os.WriteFile(currentAgent, []byte("current-kingbase-driver"), 0o755); err != nil {
		t.Fatalf("write current driver fixture: %v", err)
	}
	fakeGo := filepath.Join(tmpDir, "fake-go")
	if runtime.GOOS == "windows" {
		fakeGo += ".bat"
		if err := os.WriteFile(fakeGo, []byte("@echo off\r\nsetlocal\r\nset \"out=\"\r\n:loop\r\nif \"%~1\"==\"\" goto done\r\nif \"%~1\"==\"-o\" goto capture\r\nshift\r\ngoto loop\r\n:capture\r\nset \"out=%~2\"\r\nshift\r\nshift\r\ngoto loop\r\n:done\r\nif \"%out%\"==\"\" exit /b 1\r\ncopy /Y \"%GONAVI_TEST_BUILT_AGENT%\" \"%out%\" >nul\r\n"), 0o755); err != nil {
			t.Fatalf("write fake go command: %v", err)
		}
	} else if err := os.WriteFile(fakeGo, []byte("#!/usr/bin/env sh\nout=\"\"\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"-o\" ]; then out=\"$2\"; shift 2; continue; fi\n  shift\ndone\ncp \"$GONAVI_TEST_BUILT_AGENT\" \"$out\"\n"), 0o755); err != nil {
		t.Fatalf("write fake go command: %v", err)
	}
	t.Setenv("GONAVI_TEST_BUILT_AGENT", currentAgent)
	goBinaryLookPath = func(file string) (string, error) {
		return fakeGo, nil
	}
	validateOptionalDriverAgentExecutableFunc = func(driverType string, executablePath string) error {
		return nil
	}
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		content, err := os.ReadFile(executablePath)
		if err != nil {
			return db.OptionalDriverAgentMetadata{}, err
		}
		revision := "src-stale-agent"
		if string(content) == "current-kingbase-driver" {
			revision = db.OptionalDriverAgentRevision(driverType)
		}
		return db.OptionalDriverAgentMetadata{DriverType: driverType, AgentRevision: revision}, nil
	}

	workingDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("get working directory: %v", err)
	}
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("change to project root: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(workingDir); err != nil {
			t.Fatalf("restore working directory: %v", err)
		}
	})

	driverRoot := filepath.Join(tmpDir, "drivers")
	app := NewApp()
	result := app.DownloadDriverPackage("kingbase", "0.0.0-test", staleServer.URL, driverRoot)
	if !result.Success {
		t.Fatalf("expected current source fallback to install successfully, got %q", result.Message)
	}
	executablePath, err := db.ResolveOptionalDriverAgentExecutablePath(driverRoot, "kingbase")
	if err != nil {
		t.Fatalf("resolve installed driver path: %v", err)
	}
	installedBinary, err := os.ReadFile(executablePath)
	if err != nil {
		t.Fatalf("read installed fallback driver: %v", err)
	}
	if string(installedBinary) != "current-kingbase-driver" {
		t.Fatalf("unexpected installed fallback driver: %q", string(installedBinary))
	}
	pkg, ok := readInstalledDriverPackage(driverRoot, "kingbase")
	if !ok {
		t.Fatal("expected installed metadata after fallback")
	}
	if pkg.AgentRevision != db.OptionalDriverAgentRevision("kingbase") {
		t.Fatalf("unexpected installed revision: %q", pkg.AgentRevision)
	}
	if pkg.DownloadURL != "local://go-build/kingbase-driver-agent" {
		t.Fatalf("unexpected fallback source: %q", pkg.DownloadURL)
	}
	assertNoDriverInstallStagingDirs(t, filepath.Dir(executablePath))
}

func TestDownloadDriverPackageRollsBackWhenRuntimeActivationFails(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	originalValidate := validateOptionalDriverAgentExecutableFunc
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
		validateOptionalDriverAgentExecutableFunc = originalValidate
	})

	tmpDir := t.TempDir()
	driverRoot := filepath.Join(tmpDir, "drivers")
	installPath, err := db.ResolveOptionalDriverAgentExecutablePathForVersion(driverRoot, "mongodb", "2.99.0")
	if err != nil {
		t.Fatalf("resolve versioned driver path: %v", err)
	}
	runtimePath, err := db.ResolveOptionalDriverAgentExecutablePath(driverRoot, "mongodb")
	if err != nil {
		t.Fatalf("resolve runtime driver path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(installPath), 0o755); err != nil {
		t.Fatalf("create driver directory: %v", err)
	}
	previousBinary := []byte("previous-mongodb-driver")
	if err := os.WriteFile(installPath, previousBinary, 0o755); err != nil {
		t.Fatalf("write previous versioned driver: %v", err)
	}
	if err := os.MkdirAll(runtimePath, 0o755); err != nil {
		t.Fatalf("create occupied runtime path: %v", err)
	}
	if err := os.WriteFile(filepath.Join(runtimePath, "keep"), []byte("occupied"), 0o644); err != nil {
		t.Fatalf("occupy runtime path: %v", err)
	}
	previousMeta := installedDriverPackage{
		DriverType:     "mongodb",
		Version:        "2.98.0",
		AgentRevision:  db.OptionalDriverAgentRevision("mongodb"),
		FilePath:       installPath,
		FileName:       filepath.Base(installPath),
		ExecutablePath: installPath,
		DownloadURL:    "https://example.test/previous-mongodb-driver",
		SHA256:         "previous-sha256",
		DownloadedAt:   "2026-07-15T12:00:00+08:00",
	}
	if err := writeInstalledDriverPackage(driverRoot, "mongodb", previousMeta); err != nil {
		t.Fatalf("write previous driver metadata: %v", err)
	}
	metaPath := installedDriverMetaPath(driverRoot, "mongodb")
	previousMetaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read previous driver metadata: %v", err)
	}

	currentServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("current-mongodb-driver"))
	}))
	defer currentServer.Close()
	proxySnapshot := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy)
	})
	validateOptionalDriverAgentExecutableFunc = func(driverType string, executablePath string) error {
		return nil
	}
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: db.OptionalDriverAgentRevision(driverType),
		}, nil
	}

	app := NewApp()
	result := app.DownloadDriverPackage("mongodb", "2.99.0", currentServer.URL, driverRoot)
	if result.Success {
		t.Fatal("expected runtime activation failure")
	}
	installedBinary, err := os.ReadFile(installPath)
	if err != nil {
		t.Fatalf("read versioned driver after rollback: %v", err)
	}
	if string(installedBinary) != string(previousBinary) {
		t.Fatalf("failed activation did not restore previous driver: got %q", string(installedBinary))
	}
	installedMetaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read metadata after failed activation: %v", err)
	}
	if string(installedMetaBytes) != string(previousMetaBytes) {
		t.Fatalf("failed activation changed installed metadata:\n%s", string(installedMetaBytes))
	}
	occupiedMarker, err := os.ReadFile(filepath.Join(runtimePath, "keep"))
	if err != nil {
		t.Fatalf("read occupied runtime marker after rollback: %v", err)
	}
	if string(occupiedMarker) != "occupied" {
		t.Fatalf("runtime marker changed after rollback: %q", string(occupiedMarker))
	}
	assertNoDriverInstallStagingDirs(t, filepath.Dir(installPath))
}

func seedReleaseAssetSizeCache(t *testing.T, cacheKey string, sizeByKey map[string]int64) {
	t.Helper()

	seedReleaseAssetCacheEntry(t, cacheKey, sizeByKey, sizeByKey)
}

func seedReleaseAssetCacheEntry(t *testing.T, cacheKey string, sizeByKey map[string]int64, publishedAssets map[string]int64) {
	t.Helper()

	driverReleaseSizeMu.Lock()
	original := cloneReleaseAssetSizeCache(driverReleaseSizeMap)
	driverReleaseSizeMap[cacheKey] = driverReleaseAssetSizeCacheEntry{
		LoadedAt:        time.Now(),
		SizeByKey:       cloneInt64Map(sizeByKey),
		PublishedAssets: cloneBoolMapFromSizes(publishedAssets),
	}
	driverReleaseSizeMu.Unlock()

	t.Cleanup(func() {
		driverReleaseSizeMu.Lock()
		driverReleaseSizeMap = original
		driverReleaseSizeMu.Unlock()
	})
}

func cloneReleaseAssetSizeCache(src map[string]driverReleaseAssetSizeCacheEntry) map[string]driverReleaseAssetSizeCacheEntry {
	cloned := make(map[string]driverReleaseAssetSizeCacheEntry, len(src))
	for key, value := range src {
		cloned[key] = driverReleaseAssetSizeCacheEntry{
			LoadedAt:           value.LoadedAt,
			SizeByKey:          cloneInt64Map(value.SizeByKey),
			PublishedAssets:    cloneBoolMap(value.PublishedAssets),
			MirrorDownloadURLs: cloneDriverStringMap(value.MirrorDownloadURLs),
			Err:                value.Err,
		}
	}
	return cloned
}

func cloneDriverStringMap(src map[string]string) map[string]string {
	if len(src) == 0 {
		return map[string]string{}
	}
	cloned := make(map[string]string, len(src))
	for key, value := range src {
		cloned[key] = value
	}
	return cloned
}

func cloneBoolMap(src map[string]bool) map[string]bool {
	if len(src) == 0 {
		return map[string]bool{}
	}
	cloned := make(map[string]bool, len(src))
	for key, value := range src {
		cloned[key] = value
	}
	return cloned
}

func cloneBoolMapFromSizes(src map[string]int64) map[string]bool {
	if len(src) == 0 {
		return map[string]bool{}
	}
	cloned := make(map[string]bool, len(src))
	for key := range src {
		cloned[key] = true
	}
	return cloned
}

func cloneInt64Map(src map[string]int64) map[string]int64 {
	if len(src) == 0 {
		return map[string]int64{}
	}
	cloned := make(map[string]int64, len(src))
	for key, value := range src {
		cloned[key] = value
	}
	return cloned
}

func seedGoModuleVersionCache(t *testing.T, modulePath string, versions []string) {
	t.Helper()

	driverModuleVersionMu.Lock()
	original := make(map[string]goModuleVersionListCacheEntry, len(driverModuleVersionMap))
	for key, value := range driverModuleVersionMap {
		original[key] = goModuleVersionListCacheEntry{
			LoadedAt: value.LoadedAt,
			Versions: append([]goModuleVersionMeta(nil), value.Versions...),
			Err:      value.Err,
		}
	}
	driverModuleVersionMap[modulePath] = goModuleVersionListCacheEntry{
		LoadedAt: time.Now(),
		Versions: mapVersionsToMetas(versions),
	}
	driverModuleVersionMu.Unlock()

	t.Cleanup(func() {
		driverModuleVersionMu.Lock()
		driverModuleVersionMap = original
		driverModuleVersionMu.Unlock()
	})
}

func mapVersionsToMetas(versions []string) []goModuleVersionMeta {
	result := make([]goModuleVersionMeta, 0, len(versions))
	for _, version := range versions {
		result = append(result, goModuleVersionMeta{Version: version})
	}
	return result
}

func containsVersion(versions []string, target string) bool {
	for _, version := range versions {
		if version == target {
			return true
		}
	}
	return false
}

func chdirTemp(t *testing.T) {
	t.Helper()

	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd failed: %v", err)
	}
	tempDir := t.TempDir()
	if err := os.Chdir(tempDir); err != nil {
		t.Fatalf("chdir temp failed: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(wd); err != nil {
			t.Fatalf("restore cwd failed: %v", err)
		}
	})
}

func assertNoDriverInstallStagingDirs(t *testing.T, driverDir string) {
	t.Helper()

	entries, err := os.ReadDir(driverDir)
	if err != nil {
		t.Fatalf("read driver directory: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".gonavi-driver-install-") {
			t.Fatalf("driver install staging directory was not cleaned up: %s", entry.Name())
		}
	}
}

func mongoVersionedReleaseAssetName(major int) string {
	name := fmt.Sprintf("mongodb-driver-agent-v%d-%s-%s", major, runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func writeSelfExecutable(t *testing.T, targetPath string) {
	t.Helper()

	selfPath, err := os.Executable()
	if err != nil {
		t.Fatalf("executable path failed: %v", err)
	}
	content, err := os.ReadFile(selfPath)
	if err != nil {
		t.Fatalf("read self executable failed: %v", err)
	}
	if err := os.WriteFile(targetPath, content, 0o755); err != nil {
		t.Fatalf("write executable failed: %v", err)
	}
}

func writeZipWithSelfExecutable(t *testing.T, zipPath string, entryName string) {
	t.Helper()
	writeZipWithSelfExecutableEntries(t, zipPath, []string{entryName})
}

func writeZipWithSelfExecutableEntries(t *testing.T, zipPath string, entryNames []string) {
	t.Helper()

	selfPath, err := os.Executable()
	if err != nil {
		t.Fatalf("executable path failed: %v", err)
	}
	content, err := os.ReadFile(selfPath)
	if err != nil {
		t.Fatalf("read self executable failed: %v", err)
	}

	file, err := os.Create(zipPath)
	if err != nil {
		t.Fatalf("create zip failed: %v", err)
	}
	defer file.Close()

	writer := zip.NewWriter(file)
	for _, entryName := range entryNames {
		entry, err := writer.Create(entryName)
		if err != nil {
			t.Fatalf("create zip entry failed: %v", err)
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatalf("write zip entry failed: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close zip writer failed: %v", err)
	}
}

func resetOptionalDriverBundleDownloadCacheForTest(t *testing.T) {
	t.Helper()
	reset := func() {
		optionalDriverBundleDownloadMu.Lock()
		paths := make([]string, 0, len(optionalDriverBundleDownloads))
		for _, state := range optionalDriverBundleDownloads {
			if state != nil && strings.TrimSpace(state.path) != "" {
				paths = append(paths, state.path)
			}
		}
		optionalDriverBundleDownloads = make(map[string]*optionalDriverBundleDownloadState)
		optionalDriverBundleDownloadMu.Unlock()
		for _, path := range paths {
			_ = os.Remove(path)
		}
	}
	reset()
	t.Cleanup(reset)
}

func TestOptionalDriverBundleCacheHelpersDoNotContainLegacyChineseWrappers(t *testing.T) {
	source := methodsDriverSource(t)

	functionNames := []string{
		"downloadOptionalDriverBundleToCache",
		"acquireOptionalDriverBundlePath",
	}
	functionSource := ""
	for _, name := range functionNames {
		start := strings.Index(source, "func "+name)
		if start < 0 {
			t.Fatalf("methods_driver.go missing %s", name)
		}
		rest := source[start+len("func "+name):]
		end := strings.Index(rest, "\nfunc ")
		if end < 0 {
			t.Fatalf("%s function boundary not found", name)
		}
		functionSource += rest[:end]
	}

	for _, rawWrapper := range []string{
		`fmt.Errorf("打开驱动总包失败：%w"`,
		`fmt.Errorf("关闭驱动总包失败：%w"`,
		`fmt.Errorf("驱动总包缓存文件不可用")`,
	} {
		if strings.Contains(functionSource, rawWrapper) {
			t.Fatalf("optional driver bundle cache helper still contains legacy raw wrapper %s", rawWrapper)
		}
	}
}
