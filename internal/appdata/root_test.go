package appdata

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestResolveActiveRootDefaultsToLegacyGonaviDir(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	root, err := ResolveActiveRoot()
	if err != nil {
		t.Fatalf("ResolveActiveRoot returned error: %v", err)
	}
	expected := filepath.Join(homeDir, ".gonavi")
	if root != expected {
		t.Fatalf("expected default root %q, got %q", expected, root)
	}
}

func TestSetActiveRootWritesBootstrapAndResolveUsesIt(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	customRoot := filepath.Join(t.TempDir(), "gonavi-data")
	savedRoot, err := SetActiveRoot(customRoot)
	if err != nil {
		t.Fatalf("SetActiveRoot returned error: %v", err)
	}
	if savedRoot != customRoot {
		t.Fatalf("expected saved root %q, got %q", customRoot, savedRoot)
	}
	if _, err := os.Stat(BootstrapPath()); err != nil {
		t.Fatalf("expected bootstrap file to exist: %v", err)
	}
	resolvedRoot, err := ResolveActiveRoot()
	if err != nil {
		t.Fatalf("ResolveActiveRoot returned error: %v", err)
	}
	if resolvedRoot != customRoot {
		t.Fatalf("expected custom root %q, got %q", customRoot, resolvedRoot)
	}
}

func TestSetActiveRootResetToDefaultRemovesBootstrap(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	customRoot := filepath.Join(t.TempDir(), "gonavi-data")
	if _, err := SetActiveRoot(customRoot); err != nil {
		t.Fatalf("SetActiveRoot custom returned error: %v", err)
	}
	defaultRoot, err := SetActiveRoot("")
	if err != nil {
		t.Fatalf("SetActiveRoot default returned error: %v", err)
	}
	expectedDefault := filepath.Join(homeDir, ".gonavi")
	if defaultRoot != expectedDefault {
		t.Fatalf("expected default root %q, got %q", expectedDefault, defaultRoot)
	}
	if _, err := os.Stat(BootstrapPath()); !os.IsNotExist(err) {
		t.Fatalf("expected bootstrap file to be removed, got err=%v", err)
	}
}

func TestResolveActiveRootPrefersEnvOverride(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	customRoot := filepath.Join(t.TempDir(), "custom-root")
	if _, err := SetActiveRoot(customRoot); err != nil {
		t.Fatalf("SetActiveRoot returned error: %v", err)
	}

	overrideRoot := filepath.Join(t.TempDir(), "override-root")
	t.Setenv(dataRootEnvName, overrideRoot)

	resolvedRoot, err := ResolveActiveRoot()
	if err != nil {
		t.Fatalf("ResolveActiveRoot returned error: %v", err)
	}
	if resolvedRoot != overrideRoot {
		t.Fatalf("expected env override root %q, got %q", overrideRoot, resolvedRoot)
	}
}

func TestDataRootAndLogDirectoryPreserveEachOtherInBootstrap(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	customDataRoot := filepath.Join(t.TempDir(), "gonavi-data")
	customLogDirectory := filepath.Join(t.TempDir(), "gonavi-logs")
	if _, err := SetConfiguredLogDirectory(customLogDirectory); err != nil {
		t.Fatalf("SetConfiguredLogDirectory returned error: %v", err)
	}
	if _, err := SetActiveRoot(customDataRoot); err != nil {
		t.Fatalf("SetActiveRoot returned error: %v", err)
	}

	resolvedLogDirectory, err := ResolveConfiguredLogDirectory()
	if err != nil {
		t.Fatalf("ResolveConfiguredLogDirectory returned error: %v", err)
	}
	if resolvedLogDirectory != customLogDirectory {
		t.Fatalf("expected custom log directory %q, got %q", customLogDirectory, resolvedLogDirectory)
	}

	if _, err := SetActiveRoot(""); err != nil {
		t.Fatalf("reset SetActiveRoot returned error: %v", err)
	}
	if _, err := os.Stat(BootstrapPath()); err != nil {
		t.Fatalf("bootstrap should remain while log directory is customized: %v", err)
	}
	resolvedLogDirectory, err = ResolveConfiguredLogDirectory()
	if err != nil || resolvedLogDirectory != customLogDirectory {
		t.Fatalf("log directory after data-root reset = %q, %v", resolvedLogDirectory, err)
	}

	if _, err := SetActiveRoot(customDataRoot); err != nil {
		t.Fatalf("restore custom data root returned error: %v", err)
	}
	if _, err := SetConfiguredLogDirectory(""); err != nil {
		t.Fatalf("reset SetConfiguredLogDirectory returned error: %v", err)
	}
	resolvedRoot, err := ResolveActiveRoot()
	if err != nil || resolvedRoot != customDataRoot {
		t.Fatalf("data root after log reset = %q, %v", resolvedRoot, err)
	}
	if _, err := os.Stat(BootstrapPath()); err != nil {
		t.Fatalf("bootstrap should remain while data root is customized: %v", err)
	}

	if _, err := SetActiveRoot(""); err != nil {
		t.Fatalf("final SetActiveRoot reset returned error: %v", err)
	}
	if _, err := os.Stat(BootstrapPath()); !os.IsNotExist(err) {
		t.Fatalf("bootstrap should be removed when both settings use defaults, got err=%v", err)
	}
}

func TestDefaultSavedQueryDirectoryUsesActiveRoot(t *testing.T) {
	activeRoot := filepath.Join(t.TempDir(), "gonavi-data")
	want := filepath.Join(activeRoot, savedQueryDirectoryName)
	if got := DefaultSavedQueryDirectory(activeRoot); got != want {
		t.Fatalf("DefaultSavedQueryDirectory = %q, want %q", got, want)
	}
}

func TestSavedQueryDirectoryFollowsDataRootOnlyWhileUsingDefault(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	firstRoot := filepath.Join(t.TempDir(), "first-root")
	secondRoot := filepath.Join(t.TempDir(), "second-root")
	if _, err := SetActiveRoot(firstRoot); err != nil {
		t.Fatalf("SetActiveRoot first returned error: %v", err)
	}
	resolved, err := ResolveSavedQueryDirectory(firstRoot)
	if err != nil || resolved != filepath.Join(firstRoot, savedQueryDirectoryName) {
		t.Fatalf("first default saved query directory = %q, %v", resolved, err)
	}
	if _, err := SetActiveRoot(secondRoot); err != nil {
		t.Fatalf("SetActiveRoot second returned error: %v", err)
	}
	resolved, err = ResolveSavedQueryDirectory(secondRoot)
	if err != nil || resolved != filepath.Join(secondRoot, savedQueryDirectoryName) {
		t.Fatalf("second default saved query directory = %q, %v", resolved, err)
	}

	customDirectory := filepath.Join(t.TempDir(), "custom-saved-queries")
	if _, err := SetConfiguredSavedQueryDirectory(customDirectory); err != nil {
		t.Fatalf("SetConfiguredSavedQueryDirectory returned error: %v", err)
	}
	if _, err := SetActiveRoot(firstRoot); err != nil {
		t.Fatalf("restore SetActiveRoot first returned error: %v", err)
	}
	resolved, err = ResolveSavedQueryDirectory(firstRoot)
	if err != nil || resolved != customDirectory {
		t.Fatalf("custom saved query directory after data-root switch = %q, %v; want %q", resolved, err, customDirectory)
	}
}

func TestSavedQueryDirectoryAndOtherSettingsPreserveEachOtherInBootstrap(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	customDataRoot := filepath.Join(t.TempDir(), "gonavi-data")
	customLogDirectory := filepath.Join(t.TempDir(), "gonavi-logs")
	customSavedQueryDirectory := filepath.Join(t.TempDir(), "saved-queries")
	if _, err := SetActiveRoot(customDataRoot); err != nil {
		t.Fatalf("SetActiveRoot returned error: %v", err)
	}
	if _, err := SetConfiguredLogDirectory(customLogDirectory); err != nil {
		t.Fatalf("SetConfiguredLogDirectory returned error: %v", err)
	}
	if _, err := SetConfiguredSavedQueryDirectory(customSavedQueryDirectory); err != nil {
		t.Fatalf("SetConfiguredSavedQueryDirectory returned error: %v", err)
	}

	resolvedSavedQueryDirectory, err := ResolveSavedQueryDirectory(customDataRoot)
	if err != nil || resolvedSavedQueryDirectory != customSavedQueryDirectory {
		t.Fatalf("saved query directory = %q, %v; want %q", resolvedSavedQueryDirectory, err, customSavedQueryDirectory)
	}

	if _, err := SetActiveRoot(""); err != nil {
		t.Fatalf("reset SetActiveRoot returned error: %v", err)
	}
	if _, err := SetConfiguredLogDirectory(""); err != nil {
		t.Fatalf("reset SetConfiguredLogDirectory returned error: %v", err)
	}
	if _, err := os.Stat(BootstrapPath()); err != nil {
		t.Fatalf("bootstrap should remain while saved query directory is customized: %v", err)
	}
	resolvedSavedQueryDirectory, err = ResolveConfiguredSavedQueryDirectory()
	if err != nil || resolvedSavedQueryDirectory != customSavedQueryDirectory {
		t.Fatalf("configured saved query directory = %q, %v; want %q", resolvedSavedQueryDirectory, err, customSavedQueryDirectory)
	}

	if _, err := SetConfiguredSavedQueryDirectory(""); err != nil {
		t.Fatalf("reset SetConfiguredSavedQueryDirectory returned error: %v", err)
	}
	if _, err := os.Stat(BootstrapPath()); !os.IsNotExist(err) {
		t.Fatalf("bootstrap should be removed when all settings use defaults, got err=%v", err)
	}
	defaultSavedQueryDirectory := filepath.Join(homeDir, ".gonavi", savedQueryDirectoryName)
	resolvedSavedQueryDirectory, err = ResolveSavedQueryDirectory("")
	if err != nil || resolvedSavedQueryDirectory != defaultSavedQueryDirectory {
		t.Fatalf("default saved query directory = %q, %v; want %q", resolvedSavedQueryDirectory, err, defaultSavedQueryDirectory)
	}
}

func TestSetConfiguredSavedQueryDirectoryRejectsFilePathWithoutChangingConfig(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	blockingPath := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blockingPath, []byte("blocked"), 0o644); err != nil {
		t.Fatalf("write blocking file: %v", err)
	}
	if _, err := SetConfiguredSavedQueryDirectory(blockingPath); err == nil {
		t.Fatal("expected file path to be rejected as a saved query directory")
	}
	configured, err := ResolveConfiguredSavedQueryDirectory()
	if err != nil {
		t.Fatalf("ResolveConfiguredSavedQueryDirectory returned error: %v", err)
	}
	if configured != "" {
		t.Fatalf("failed update changed configured saved query directory to %q", configured)
	}
}

func TestAgentDataDirectoryDefaultsToActiveRootAndSupportsOverride(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	activeRoot := filepath.Join(t.TempDir(), "gonavi-data")
	if _, err := SetActiveRoot(activeRoot); err != nil {
		t.Fatalf("SetActiveRoot: %v", err)
	}
	resolved, err := ResolveAgentDataDirectory(activeRoot)
	if err != nil || resolved != activeRoot {
		t.Fatalf("default agent data directory = %q, %v; want %q", resolved, err, activeRoot)
	}

	custom := filepath.Join(t.TempDir(), "agent-data")
	if _, err := SetConfiguredAgentDataDirectory(custom); err != nil {
		t.Fatalf("SetConfiguredAgentDataDirectory: %v", err)
	}
	resolved, err = ResolveAgentDataDirectory(activeRoot)
	if err != nil || resolved != custom {
		t.Fatalf("custom agent data directory = %q, %v; want %q", resolved, err, custom)
	}

	if _, err := SetConfiguredAgentDataDirectory(""); err != nil {
		t.Fatalf("reset agent data directory: %v", err)
	}
	resolved, err = ResolveAgentDataDirectory(activeRoot)
	if err != nil || resolved != activeRoot {
		t.Fatalf("reset agent data directory = %q, %v; want %q", resolved, err, activeRoot)
	}
}

func TestAgentDataDirectoryPreservesOtherBootstrapSettings(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	dataRoot := filepath.Join(t.TempDir(), "data")
	logDir := filepath.Join(t.TempDir(), "logs")
	savedDir := filepath.Join(t.TempDir(), "queries")
	agentDir := filepath.Join(t.TempDir(), "agent")
	if _, err := SetActiveRoot(dataRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := SetConfiguredLogDirectory(logDir); err != nil {
		t.Fatal(err)
	}
	if _, err := SetConfiguredSavedQueryDirectory(savedDir); err != nil {
		t.Fatal(err)
	}
	if _, err := SetConfiguredAgentDataDirectory(agentDir); err != nil {
		t.Fatal(err)
	}
	if _, err := SetConfiguredAgentDataDirectory(""); err != nil {
		t.Fatal(err)
	}

	resolvedRoot, _ := ResolveActiveRoot()
	resolvedLog, _ := ResolveConfiguredLogDirectory()
	resolvedSaved, _ := ResolveConfiguredSavedQueryDirectory()
	if resolvedRoot != dataRoot || resolvedLog != logDir || resolvedSaved != savedDir {
		t.Fatalf("agent directory reset changed other settings: root=%q log=%q saved=%q", resolvedRoot, resolvedLog, resolvedSaved)
	}
}

func TestSetConfiguredLogDirectoryRejectsFilePathWithoutChangingConfig(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	blockingPath := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blockingPath, []byte("blocked"), 0o644); err != nil {
		t.Fatalf("write blocking file: %v", err)
	}
	if _, err := SetConfiguredLogDirectory(blockingPath); err == nil {
		t.Fatal("expected file path to be rejected as a log directory")
	}
	configured, err := ResolveConfiguredLogDirectory()
	if err != nil {
		t.Fatalf("ResolveConfiguredLogDirectory returned error: %v", err)
	}
	if configured != "" {
		t.Fatalf("failed update changed configured log directory to %q", configured)
	}
}

func TestSetConfiguredLogDirectoryRejectsDirectoryAtLogFilePathWithoutChangingConfig(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	targetDirectory := filepath.Join(t.TempDir(), "logs")
	if err := os.MkdirAll(filepath.Join(targetDirectory, configuredLogFileName), 0o755); err != nil {
		t.Fatalf("create blocking log-file directory: %v", err)
	}
	if _, err := SetConfiguredLogDirectory(targetDirectory); err == nil {
		t.Fatal("expected a directory at the log file path to be rejected")
	}
	configured, err := ResolveConfiguredLogDirectory()
	if err != nil {
		t.Fatalf("ResolveConfiguredLogDirectory returned error: %v", err)
	}
	if configured != "" {
		t.Fatalf("failed update changed configured log directory to %q", configured)
	}
}

func TestBootstrapFileLockSerializesAccess(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "storage_root.json.lock")
	first, err := acquireBootstrapFileLock(lockPath)
	if err != nil {
		t.Fatalf("acquire first bootstrap lock: %v", err)
	}
	defer first.Close()

	acquired := make(chan *bootstrapFileLock, 1)
	errs := make(chan error, 1)
	go func() {
		second, err := acquireBootstrapFileLock(lockPath)
		if err != nil {
			errs <- err
			return
		}
		acquired <- second
	}()

	select {
	case second := <-acquired:
		_ = second.Close()
		t.Fatal("second bootstrap lock acquired before the first was released")
	case err := <-errs:
		t.Fatalf("acquire second bootstrap lock: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := first.Close(); err != nil {
		t.Fatalf("release first bootstrap lock: %v", err)
	}

	select {
	case second := <-acquired:
		if err := second.Close(); err != nil {
			t.Fatalf("release second bootstrap lock: %v", err)
		}
	case err := <-errs:
		t.Fatalf("acquire second bootstrap lock after release: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("second bootstrap lock did not acquire after the first was released")
	}
}
