package app

import (
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
	if got, want := atomic.LoadInt32(&requestCount), int32(parallelDownloadWorkers+1); got != want {
		t.Fatalf("expected one shared bundle task (probe plus %d ranges), got %d requests", parallelDownloadWorkers, got)
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
