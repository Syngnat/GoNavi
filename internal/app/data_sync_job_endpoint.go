package app

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/syncjob"
)

const (
	// Legacy OS-keychain identity. Keep the kind string so tests can assert
	// save/run/preflight never reintroduce a Keychain ACL prompt.
	dataSyncFingerprintSecretKind  = "data-sync-fingerprint"
	dataSyncFingerprintKeyFileName = "data_sync_fingerprint.key"
	dataSyncFingerprintKeySize     = 32
)

type resolvedDataSyncJobEndpoint struct {
	View        connection.SavedConnectionView
	Config      connection.ConnectionConfig
	Database    string
	Schema      string
	Fingerprint string
}

func (a *App) resolveDataSyncJobEndpoint(connectionID, database, schema string) (resolvedDataSyncJobEndpoint, error) {
	resolved, err := a.resolveDataSyncSavedEndpoint(connectionID, database, schema)
	if err != nil {
		return resolved, err
	}
	return a.withDataSyncJobEndpointFingerprint(resolved)
}

// resolveDataSyncSavedEndpoint loads a saved connection for metadata/query use
// without loading the data-sync fingerprint key. Listing databases or objects
// only needs the saved connection bundle.
func (a *App) resolveDataSyncSavedEndpoint(connectionID, database, schema string) (resolvedDataSyncJobEndpoint, error) {
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return resolvedDataSyncJobEndpoint{}, errors.New("saved connection id is required")
	}
	repository := newSavedConnectionRepository(a.configDir, a.secretStore)
	view, err := repository.Find(connectionID)
	if err != nil {
		return resolvedDataSyncJobEndpoint{}, err
	}
	selectedDatabase := strings.TrimSpace(database)
	config, selectedDatabase, err := a.resolveDataSyncEndpointConfig(connection.ConnectionConfig{ID: connectionID}, selectedDatabase)
	if err != nil {
		return resolvedDataSyncJobEndpoint{}, err
	}
	return resolvedDataSyncJobEndpoint{
		View:     view,
		Config:   config,
		Database: selectedDatabase,
		Schema:   strings.TrimSpace(schema),
	}, nil
}

func (a *App) withDataSyncJobEndpointFingerprint(resolved resolvedDataSyncJobEndpoint) (resolvedDataSyncJobEndpoint, error) {
	fingerprintKey, err := a.dataSyncJobFingerprintKeyBytes()
	if err != nil {
		return resolvedDataSyncJobEndpoint{}, err
	}
	resolved.Fingerprint, err = dataSyncJobEndpointFingerprint(resolved, fingerprintKey)
	if err != nil {
		return resolvedDataSyncJobEndpoint{}, err
	}
	return resolved, nil
}

func dataSyncJobEndpointFingerprint(endpoint resolvedDataSyncJobEndpoint, key []byte) (string, error) {
	if len(key) < dataSyncFingerprintKeySize {
		return "", errors.New("data sync endpoint fingerprint key is unavailable")
	}
	// A per-install secret HMAC covers the complete canonical resolved endpoint,
	// including opaque DSN/URI and credentials. This detects physical endpoint
	// and secret drift without turning a persisted/public digest into an offline
	// password verifier.
	payload := struct {
		ID              string                      `json:"id"`
		EnvironmentType string                      `json:"environmentType"`
		SecretRef       string                      `json:"secretRef,omitempty"`
		Config          connection.ConnectionConfig `json:"config"`
		Database        string                      `json:"database"`
		Schema          string                      `json:"schema"`
	}{
		ID:              endpoint.View.ID,
		EnvironmentType: normalizeConnectionEnvironmentType(endpoint.View.EnvironmentType),
		SecretRef:       endpoint.View.SecretRef,
		Config:          endpoint.Config.WithoutRuntimeDatabaseOverride(),
		Database:        strings.TrimSpace(endpoint.Database),
		Schema:          strings.TrimSpace(endpoint.Schema),
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode data sync endpoint fingerprint: %w", err)
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(encoded)
	return "hmac-sha256:" + hex.EncodeToString(mac.Sum(nil)), nil
}

func (a *App) dataSyncJobFingerprintKeyBytes() ([]byte, error) {
	if a == nil {
		return nil, errors.New("data sync endpoint fingerprint store is unavailable")
	}
	configDir := strings.TrimSpace(a.configDir)
	if configDir == "" {
		return nil, errors.New("data sync endpoint fingerprint store is unavailable")
	}
	a.dataSyncFingerprintMu.Lock()
	defer a.dataSyncFingerprintMu.Unlock()
	if len(a.dataSyncFingerprintKey) >= dataSyncFingerprintKeySize {
		return append([]byte(nil), a.dataSyncFingerprintKey...), nil
	}
	// Persist under configDir, never the OS keychain. A Keychain Get/Put on
	// macOS surfaces an ACL prompt after Wails rebuilds, which must not
	// interrupt save, preflight, or run.
	key, err := loadOrCreateDataSyncFingerprintKeyFile(filepath.Join(configDir, dataSyncFingerprintKeyFileName))
	if err != nil {
		return nil, err
	}
	a.dataSyncFingerprintKey = append([]byte(nil), key...)
	return append([]byte(nil), key...), nil
}

func loadOrCreateDataSyncFingerprintKeyFile(path string) ([]byte, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("data sync endpoint fingerprint store is unavailable")
	}
	info, err := os.Lstat(path)
	if err == nil {
		return readDataSyncFingerprintKeyFile(path, info)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect data sync endpoint fingerprint key: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data sync endpoint fingerprint directory: %w", err)
	}
	key := make([]byte, dataSyncFingerprintKeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate data sync endpoint fingerprint key: %w", err)
	}
	if err := writeDataSyncFingerprintKeyFileExclusive(path, key); err != nil {
		if errors.Is(err, os.ErrExist) {
			info, statErr := os.Lstat(path)
			if statErr != nil {
				return nil, fmt.Errorf("load data sync endpoint fingerprint key: %w", statErr)
			}
			return readDataSyncFingerprintKeyFile(path, info)
		}
		return nil, err
	}
	return key, nil
}

func writeDataSyncFingerprintKeyFileExclusive(path string, key []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	cleanup := true
	defer func() {
		_ = file.Close()
		if cleanup {
			_ = os.Remove(path)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return fmt.Errorf("persist data sync endpoint fingerprint key: %w", err)
	}
	if _, err := file.Write(key); err != nil {
		return fmt.Errorf("persist data sync endpoint fingerprint key: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("persist data sync endpoint fingerprint key: %w", err)
	}
	cleanup = false
	return nil
}

func readDataSyncFingerprintKeyFile(path string, info os.FileInfo) ([]byte, error) {
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("data sync endpoint fingerprint key file is a symlink")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("data sync endpoint fingerprint key file is not regular")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("load data sync endpoint fingerprint key: %w", err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("load data sync endpoint fingerprint key: %w", err)
	}
	if !os.SameFile(info, opened) {
		return nil, errors.New("data sync endpoint fingerprint key file changed while opening")
	}
	if err := os.Chmod(path, 0o600); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("restrict data sync endpoint fingerprint key: %w", err)
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, fmt.Errorf("load data sync endpoint fingerprint key: %w", err)
	}
	if len(data) != dataSyncFingerprintKeySize {
		return nil, fmt.Errorf("data sync endpoint fingerprint key has length %d", len(data))
	}
	return append([]byte(nil), data...), nil
}

func dataSyncJobNeedsProductionApproval(endpoint resolvedDataSyncJobEndpoint) bool {
	if normalizeConnectionEnvironmentType(endpoint.View.EnvironmentType) != "production" {
		return false
	}
	// Protection flags block their corresponding action; an unrelated flag is
	// not evidence that a permitted production write was approved. Every
	// writable production endpoint therefore requires explicit approval, while
	// ensureDataSyncTargetProtection independently rejects prohibited actions.
	return !endpoint.Config.ReadOnly
}

func dataSyncJobRequiresExecutionApproval(definition syncjob.JobDefinition, endpoint resolvedDataSyncJobEndpoint) bool {
	return definition.Kind != syncjob.JobKindCompare && dataSyncJobNeedsProductionApproval(endpoint)
}
