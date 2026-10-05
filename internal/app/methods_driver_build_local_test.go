package app

import (
	"archive/zip"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

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
	entryName, err := installOptionalDriverAgentFromLocalArchive(zipPath, driverDefinition{Type: "duckdb", Name: "DuckDB"}, target, "")
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
	meta, err := installOptionalDriverAgentFromLocalPath(nil, definition, packageRoot, installRoot, "1.17.4")
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
	meta, err := installOptionalDriverAgentFromLocalPath(nil, definition, zipPath, installRoot, "1.17.4")
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
