package app

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/syncjob"
)

const (
	dataSyncFingerprintSecretKind = "data-sync-fingerprint"
	dataSyncFingerprintSecretID   = "v1"
)

type resolvedDataSyncJobEndpoint struct {
	View        connection.SavedConnectionView
	Config      connection.ConnectionConfig
	Database    string
	Schema      string
	Fingerprint string
}

func (a *App) resolveDataSyncJobEndpoint(connectionID, database, schema string) (resolvedDataSyncJobEndpoint, error) {
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
	resolved := resolvedDataSyncJobEndpoint{
		View:     view,
		Config:   config,
		Database: selectedDatabase,
		Schema:   strings.TrimSpace(schema),
	}
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
	if len(key) < 32 {
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
	if a == nil || a.secretStore == nil {
		return nil, errors.New("data sync endpoint fingerprint secret store is unavailable")
	}
	a.dataSyncFingerprintMu.Lock()
	defer a.dataSyncFingerprintMu.Unlock()
	if len(a.dataSyncFingerprintKey) >= 32 {
		return append([]byte(nil), a.dataSyncFingerprintKey...), nil
	}
	ref, err := secretstore.BuildRef(dataSyncFingerprintSecretKind, dataSyncFingerprintSecretID)
	if err != nil {
		return nil, err
	}
	key, err := a.secretStore.Get(ref)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("load data sync endpoint fingerprint key: %w", err)
	}
	if errors.Is(err, os.ErrNotExist) || len(key) < 32 {
		key = make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, fmt.Errorf("generate data sync endpoint fingerprint key: %w", err)
		}
		if err := a.secretStore.Put(ref, key); err != nil {
			return nil, fmt.Errorf("persist data sync endpoint fingerprint key: %w", err)
		}
	}
	a.dataSyncFingerprintKey = append([]byte(nil), key...)
	return append([]byte(nil), key...), nil
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
