package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/secretstore"
)

func (a *App) cloudBackupConfigPath() string {
	root := strings.TrimSpace(a.configDir)
	if root == "" {
		root = resolveAppConfigDir()
	}
	return filepath.Join(root, cloudBackupConfigFileName)
}

func cloudBackupSecretRef(id string) (string, error) {
	return secretstore.BuildRef(cloudBackupSecretKind, id)
}

func (a *App) loadCloudBackupConfig() (CloudBackupConfig, error) {
	data, err := os.ReadFile(a.cloudBackupConfigPath())
	if err != nil {
		if os.IsNotExist(err) {
			return normalizeCloudBackupConfig(CloudBackupConfig{BackupCategories: defaultCloudBackupCategories()}), nil
		}
		return CloudBackupConfig{}, err
	}
	var persisted cloudBackupPersisted
	if err := json.Unmarshal(data, &persisted); err != nil {
		return CloudBackupConfig{}, err
	}
	if persisted.SchemaVersion != cloudBackupLegacyConfigSchema && persisted.SchemaVersion != cloudBackupSplitConfigSchema && persisted.SchemaVersion != cloudBackupConfigSchemaVersion {
		return CloudBackupConfig{}, errors.New("unsupported cloud backup configuration")
	}
	if persisted.SchemaVersion < cloudBackupConfigSchemaVersion && len(persisted.Config.BackupCategories) == 0 {
		persisted.Config.BackupCategories = defaultCloudBackupCategories()
	}
	return normalizeCloudBackupConfig(persisted.Config), nil
}

func (a *App) loadCloudBackupSecrets() (cloudBackupSecrets, error) {
	a.cloudBackupSecretMu.Lock()
	defer a.cloudBackupSecretMu.Unlock()
	return a.loadCloudBackupSecretsUnlocked(true, true, true)
}

func (a *App) loadCloudBackupProviderSecrets(provider string) (cloudBackupSecrets, error) {
	a.cloudBackupSecretMu.Lock()
	defer a.cloudBackupSecretMu.Unlock()
	if provider == CloudBackupProviderS3 {
		return a.loadCloudBackupSecretsUnlocked(false, true, true)
	}
	return a.loadCloudBackupSecretsUnlocked(true, false, true)
}

func (a *App) loadCloudBackupSecretsUnlocked(includeWebDAV, includeS3, includeEncryption bool) (cloudBackupSecrets, error) {
	var secrets cloudBackupSecrets
	webDAVLoaded, s3Loaded, encryptionLoaded := !includeWebDAV, !includeS3, !includeEncryption
	if includeWebDAV {
		var value cloudBackupWebDAVSecrets
		loaded, err := a.readCloudBackupSecret(cloudBackupWebDAVSecretID, &value)
		if err != nil {
			return cloudBackupSecrets{}, err
		}
		webDAVLoaded = loaded
		if loaded {
			secrets.WebDAVUsername, secrets.WebDAVPassword = value.Username, value.Password
		}
	}
	if includeS3 {
		var value cloudBackupS3Secrets
		loaded, err := a.readCloudBackupSecret(cloudBackupS3SecretID, &value)
		if err != nil {
			return cloudBackupSecrets{}, err
		}
		s3Loaded = loaded
		if loaded {
			secrets.S3AccessKey, secrets.S3SecretKey = value.AccessKey, value.SecretKey
		}
	}
	if includeEncryption {
		var value cloudBackupEncryptionSecret
		loaded, err := a.readCloudBackupSecret(cloudBackupEncryptionID, &value)
		if err != nil {
			return cloudBackupSecrets{}, err
		}
		encryptionLoaded = loaded
		if loaded {
			secrets.EncryptionPassword = value.Password
		}
	}
	if webDAVLoaded && s3Loaded && encryptionLoaded {
		return secrets, nil
	}

	var legacy cloudBackupSecrets
	legacyLoaded, err := a.readCloudBackupSecret(cloudBackupLegacySecretID, &legacy)
	if err != nil {
		return cloudBackupSecrets{}, err
	}
	if !legacyLoaded {
		return secrets, nil
	}
	if includeWebDAV && !webDAVLoaded {
		secrets.WebDAVUsername, secrets.WebDAVPassword = legacy.WebDAVUsername, legacy.WebDAVPassword
	}
	if includeS3 && !s3Loaded {
		secrets.S3AccessKey, secrets.S3SecretKey = legacy.S3AccessKey, legacy.S3SecretKey
	}
	if includeEncryption && !encryptionLoaded {
		secrets.EncryptionPassword = legacy.EncryptionPassword
	}
	return secrets, nil
}

func (a *App) readCloudBackupSecret(id string, target any) (bool, error) {
	ref, err := cloudBackupSecretRef(id)
	if err != nil {
		return false, err
	}
	payload, err := a.secretStore.Get(ref)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if err := json.Unmarshal(payload, target); err != nil {
		return false, err
	}
	return true, nil
}

func (a *App) saveCloudBackupState(config CloudBackupConfig) error {
	a.cloudBackupStateMu.Lock()
	defer a.cloudBackupStateMu.Unlock()
	return a.saveCloudBackupStateUnlocked(config)
}

func (a *App) saveCloudBackupStateUnlocked(config CloudBackupConfig) error {
	if err := os.MkdirAll(filepath.Dir(a.cloudBackupConfigPath()), 0o755); err != nil {
		return err
	}
	config = normalizeCloudBackupConfig(config)
	// Credential markers are derived from the OS keyring and must never become
	// persisted state. They are populated only by CloudBackupGetConfig.
	config.HasWebDAVCredential = false
	config.HasS3Credential = false
	config.HasEncryptionKey = false
	payload, err := json.MarshalIndent(cloudBackupPersisted{SchemaVersion: cloudBackupConfigSchemaVersion, Config: config}, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(a.cloudBackupConfigPath()), ".cloud-backup-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if _, err := temporary.Write(payload); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, a.cloudBackupConfigPath())
}

func (a *App) updateCloudBackupState(update func(*CloudBackupConfig) error) (CloudBackupConfig, error) {
	a.cloudBackupStateMu.Lock()
	defer a.cloudBackupStateMu.Unlock()
	config, err := a.loadCloudBackupConfig()
	if err != nil {
		return CloudBackupConfig{}, err
	}
	if err := update(&config); err != nil {
		return CloudBackupConfig{}, err
	}
	if err := a.saveCloudBackupStateUnlocked(config); err != nil {
		return CloudBackupConfig{}, err
	}
	return config, nil
}

func (a *App) saveCloudBackupSecrets(secrets cloudBackupSecrets) error {
	a.cloudBackupSecretMu.Lock()
	defer a.cloudBackupSecretMu.Unlock()

	values := []struct {
		id    string
		value any
	}{
		{cloudBackupWebDAVSecretID, cloudBackupWebDAVSecrets{Username: secrets.WebDAVUsername, Password: secrets.WebDAVPassword}},
		{cloudBackupS3SecretID, cloudBackupS3Secrets{AccessKey: secrets.S3AccessKey, SecretKey: secrets.S3SecretKey}},
		{cloudBackupEncryptionID, cloudBackupEncryptionSecret{Password: secrets.EncryptionPassword}},
	}
	entries := make([]cloudBackupSecretSnapshot, 0, len(values)+1)
	for _, value := range values {
		ref, err := cloudBackupSecretRef(value.id)
		if err != nil {
			return err
		}
		payload, err := json.Marshal(value.value)
		if err != nil {
			return err
		}
		entries = append(entries, cloudBackupSecretSnapshot{ref: ref, payload: payload})
	}
	legacyRef, err := cloudBackupSecretRef(cloudBackupLegacySecretID)
	if err != nil {
		return err
	}

	snapshots := make([]cloudBackupSecretSnapshot, 0, len(entries)+1)
	for _, entry := range append(entries, cloudBackupSecretSnapshot{ref: legacyRef}) {
		payload, getErr := a.secretStore.Get(entry.ref)
		if getErr != nil && !os.IsNotExist(getErr) {
			return getErr
		}
		snapshots = append(snapshots, cloudBackupSecretSnapshot{ref: entry.ref, payload: payload, exists: getErr == nil})
	}
	rollback := func(saveErr error) error {
		if rollbackErr := a.restoreCloudBackupSecretSnapshots(snapshots); rollbackErr != nil {
			return fmt.Errorf("%w (secret rollback failed: %v)", saveErr, rollbackErr)
		}
		return saveErr
	}
	for _, entry := range entries {
		if err := a.secretStore.Put(entry.ref, entry.payload); err != nil {
			return rollback(err)
		}
	}
	if err := a.secretStore.Delete(legacyRef); err != nil && !os.IsNotExist(err) {
		return rollback(err)
	}
	return nil
}

func (a *App) restoreCloudBackupSecretSnapshots(snapshots []cloudBackupSecretSnapshot) error {
	var firstErr error
	for index := len(snapshots) - 1; index >= 0; index-- {
		snapshot := snapshots[index]
		var err error
		if snapshot.exists {
			err = a.secretStore.Put(snapshot.ref, snapshot.payload)
		} else {
			err = a.secretStore.Delete(snapshot.ref)
			if os.IsNotExist(err) {
				err = nil
			}
		}
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
