package appdata

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	bootstrapFileName              = "storage_root.json"
	bootstrapLockFileName          = bootstrapFileName + ".lock"
	sharedStorageLockFileName      = ".gonavi-storage-write.lock"
	configuredLogFileName          = "gonavi.log"
	savedQueryDirectoryName        = "saved_queries"
	savedQueryDirectoryProbePrefix = ".gonavi-saved-query-"
)
const dataRootEnvName = "GONAVI_DATA_ROOT"

var (
	ErrSetActiveRootCreateDataDirectory      = errors.New("create data directory failed")
	ErrSetActiveRootCreateBootstrapDirectory = errors.New("create bootstrap directory failed")
	bootstrapConfigMu                        sync.Mutex
)

// AcquireFileLock obtains an exclusive, cross-process lock for a caller-owned
// file path. It is shared by the data-root, connection, and daily-secret
// stores so their read-modify-write operations cannot overwrite each other.
func AcquireFileLock(path string) (*bootstrapFileLock, error) {
	return acquireBootstrapFileLock(path)
}

// AtomicReplaceFile replaces target with source using the platform-specific
// durable rename implementation used by the bootstrap configuration.
func AtomicReplaceFile(source string, target string) error {
	return atomicReplaceBootstrapFile(source, target)
}

// SharedStorageLockPath returns the lock shared by the saved connection and
// daily-secret stores. Those files are updated as one logical operation by the
// GUI and CLI, so per-file locks alone cannot prevent a cross-process
// read-modify-write race.
func SharedStorageLockPath(root string) string {
	trimmed := strings.TrimSpace(root)
	if trimmed == "" {
		return filepath.Join(trimmed, sharedStorageLockFileName)
	}
	if absolute, err := filepath.Abs(trimmed); err == nil {
		trimmed = absolute
	}
	// Resolve aliases when the root already exists so callers using a symlink
	// and callers using its real path coordinate on the same lock file. Keep the
	// absolute fallback for a not-yet-created root.
	if resolved, err := filepath.EvalSymlinks(trimmed); err == nil {
		trimmed = resolved
	}
	return filepath.Join(filepath.Clean(trimmed), sharedStorageLockFileName)
}

type setActiveRootError struct {
	kind   error
	detail error
}

func (e *setActiveRootError) Error() string {
	if e == nil || e.kind == nil {
		return ""
	}
	if e.detail == nil {
		return e.kind.Error()
	}
	return e.kind.Error() + ": " + e.detail.Error()
}

func (e *setActiveRootError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.kind
}

func newSetActiveRootError(kind error, detail error) error {
	if kind == nil {
		return detail
	}
	if detail == nil {
		return kind
	}
	return &setActiveRootError{kind: kind, detail: detail}
}

func SetActiveRootErrorDetail(err error) error {
	var target *setActiveRootError
	if errors.As(err, &target) {
		return target.detail
	}
	return nil
}

type bootstrapConfig struct {
	DataRoot            string `json:"dataRoot,omitempty"`
	LogDirectory        string `json:"logDirectory,omitempty"`
	SavedQueryDirectory string `json:"savedQueryDirectory,omitempty"`
}

func readBootstrapConfig() (bootstrapConfig, error) {
	data, err := os.ReadFile(BootstrapPath())
	if err != nil {
		if os.IsNotExist(err) {
			return bootstrapConfig{}, nil
		}
		return bootstrapConfig{}, err
	}
	var cfg bootstrapConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return bootstrapConfig{}, err
	}
	return cfg, nil
}

func writeBootstrapConfig(cfg bootstrapConfig) error {
	cfg.DataRoot = strings.TrimSpace(cfg.DataRoot)
	cfg.LogDirectory = strings.TrimSpace(cfg.LogDirectory)
	cfg.SavedQueryDirectory = strings.TrimSpace(cfg.SavedQueryDirectory)
	if cfg.DataRoot == "" && cfg.LogDirectory == "" && cfg.SavedQueryDirectory == "" {
		if err := os.Remove(BootstrapPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(DefaultRoot(), 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeBootstrapConfigAtomic(payload)
}

func writeBootstrapConfigAtomic(payload []byte) error {
	temporary, err := os.CreateTemp(DefaultRoot(), ".storage_root-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o644); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := atomicReplaceBootstrapFile(temporaryPath, BootstrapPath()); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func updateBootstrapConfig(update func(*bootstrapConfig)) (err error) {
	bootstrapConfigMu.Lock()
	defer bootstrapConfigMu.Unlock()
	if err := os.MkdirAll(DefaultRoot(), 0o755); err != nil {
		return err
	}
	fileLock, err := acquireBootstrapFileLock(BootstrapLockPath())
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, fileLock.Close())
	}()
	cfg, err := readBootstrapConfig()
	if err != nil {
		return err
	}
	update(&cfg)
	return writeBootstrapConfig(cfg)
}

func configuredRootOverride() string {
	return strings.TrimSpace(os.Getenv(dataRootEnvName))
}

func DefaultRoot() string {
	homeDir, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(homeDir) == "" {
		return "."
	}
	return filepath.Join(homeDir, ".gonavi")
}

func BootstrapPath() string {
	return filepath.Join(DefaultRoot(), bootstrapFileName)
}

func BootstrapLockPath() string {
	return filepath.Join(DefaultRoot(), bootstrapLockFileName)
}

func normalizeRoot(root string) (string, error) {
	trimmed := strings.TrimSpace(root)
	if trimmed == "" {
		trimmed = DefaultRoot()
	}
	abs, err := filepath.Abs(trimmed)
	if err != nil {
		return "", err
	}
	return abs, nil
}

func ResolveRoot(root string) (string, error) {
	return normalizeRoot(root)
}

func ResolveActiveRoot() (string, error) {
	if override := configuredRootOverride(); override != "" {
		return normalizeRoot(override)
	}
	defaultRoot, err := normalizeRoot(DefaultRoot())
	if err != nil {
		return "", err
	}
	bootstrapConfigMu.Lock()
	cfg, err := readBootstrapConfig()
	bootstrapConfigMu.Unlock()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(cfg.DataRoot) == "" {
		return defaultRoot, nil
	}
	return normalizeRoot(cfg.DataRoot)
}

func MustResolveActiveRoot() string {
	root, err := ResolveActiveRoot()
	if err != nil {
		return DefaultRoot()
	}
	return root
}

func DriverRoot(activeRoot string) string {
	root := strings.TrimSpace(activeRoot)
	if root == "" {
		root = MustResolveActiveRoot()
	}
	return filepath.Join(root, "drivers")
}

func DefaultSavedQueryDirectory(activeRoot string) string {
	root := strings.TrimSpace(activeRoot)
	if root == "" {
		root = MustResolveActiveRoot()
	}
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	return filepath.Join(filepath.Clean(root), savedQueryDirectoryName)
}

func SetActiveRoot(root string) (string, error) {
	targetRoot, err := normalizeRoot(root)
	if err != nil {
		return "", err
	}
	defaultRoot, err := normalizeRoot(DefaultRoot())
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		return "", newSetActiveRootError(ErrSetActiveRootCreateDataDirectory, err)
	}
	if targetRoot != defaultRoot {
		if err := os.MkdirAll(defaultRoot, 0o755); err != nil {
			return "", newSetActiveRootError(ErrSetActiveRootCreateBootstrapDirectory, err)
		}
	}

	if err := updateBootstrapConfig(func(cfg *bootstrapConfig) {
		if targetRoot == defaultRoot {
			cfg.DataRoot = ""
		} else {
			cfg.DataRoot = targetRoot
		}
	}); err != nil {
		return "", err
	}
	return targetRoot, nil
}

func ResolveConfiguredLogDirectory() (string, error) {
	bootstrapConfigMu.Lock()
	cfg, err := readBootstrapConfig()
	bootstrapConfigMu.Unlock()
	if err != nil {
		return "", err
	}
	directory := strings.TrimSpace(cfg.LogDirectory)
	if directory == "" {
		return "", nil
	}
	abs, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

func SetConfiguredLogDirectory(directory string) (string, error) {
	target := strings.TrimSpace(directory)
	if target != "" {
		abs, err := filepath.Abs(target)
		if err != nil {
			return "", err
		}
		target = filepath.Clean(abs)
		if err := os.MkdirAll(target, 0o755); err != nil {
			return "", err
		}
		probe, err := os.OpenFile(filepath.Join(target, configuredLogFileName), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			return "", err
		}
		if err := probe.Close(); err != nil {
			return "", err
		}
	}

	if err := updateBootstrapConfig(func(cfg *bootstrapConfig) {
		cfg.LogDirectory = target
	}); err != nil {
		return "", err
	}
	return target, nil
}

func ResolveConfiguredSavedQueryDirectory() (string, error) {
	bootstrapConfigMu.Lock()
	cfg, err := readBootstrapConfig()
	bootstrapConfigMu.Unlock()
	if err != nil {
		return "", err
	}
	directory := strings.TrimSpace(cfg.SavedQueryDirectory)
	if directory == "" {
		return "", nil
	}
	abs, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

func ResolveSavedQueryDirectory(activeRoot string) (string, error) {
	directory, err := ResolveConfiguredSavedQueryDirectory()
	if err != nil {
		return "", err
	}
	if directory != "" {
		return directory, nil
	}
	return DefaultSavedQueryDirectory(activeRoot), nil
}

func SetConfiguredSavedQueryDirectory(directory string) (string, error) {
	target := strings.TrimSpace(directory)
	if target != "" {
		abs, resolveErr := filepath.Abs(target)
		if resolveErr != nil {
			return "", resolveErr
		}
		target = filepath.Clean(abs)
		if mkdirErr := os.MkdirAll(target, 0o755); mkdirErr != nil {
			return "", mkdirErr
		}

		probe, createErr := os.CreateTemp(target, savedQueryDirectoryProbePrefix)
		if createErr != nil {
			return "", createErr
		}
		probePath := probe.Name()
		if closeErr := probe.Close(); closeErr != nil {
			_ = os.Remove(probePath)
			return "", closeErr
		}
		if removeErr := os.Remove(probePath); removeErr != nil {
			return "", removeErr
		}
	}

	if err := updateBootstrapConfig(func(cfg *bootstrapConfig) {
		cfg.SavedQueryDirectory = target
	}); err != nil {
		return "", err
	}
	return target, nil
}
