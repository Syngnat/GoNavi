package app

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/cloudbackup"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dailysecret"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/secretstore"
	"github.com/google/uuid"
)

const (
	cloudBackupConfigFileName                     = "cloud_backup.json"
	cloudBackupSecretKind                         = "cloud-backup"
	cloudBackupLegacySecretID                     = "default"
	cloudBackupWebDAVSecretID                     = "webdav"
	cloudBackupS3SecretID                         = "s3"
	cloudBackupEncryptionID                       = "encryption"
	cloudBackupConfigSchemaVersion                = 3
	cloudBackupLegacyConfigSchema                 = 1
	cloudBackupSplitConfigSchema                  = 2
	cloudBackupPayloadSchemaVersion               = 1
	cloudBackupDefaultWebDAVFilePath              = "gonavi/backup.gonavi"
	cloudBackupDefaultS3ObjectKey                 = "gonavi/backup.gonavi"
	cloudBackupMaxFileBytes                       = 32 * 1024 * 1024
	defaultCloudBackupRestoreConfirmationTokenTTL = 10 * time.Minute
)

// NewCloudBackupChangeHandler returns a callback for services that persist
// files included in the cloud backup payload.
func NewCloudBackupChangeHandler(a *App) func() {
	if a == nil {
		return nil
	}
	return a.markCloudBackupDirty
}

type cloudBackupSecrets struct {
	WebDAVUsername     string `json:"webdavUsername,omitempty"`
	WebDAVPassword     string `json:"webdavPassword,omitempty"`
	S3AccessKey        string `json:"s3AccessKey,omitempty"`
	S3SecretKey        string `json:"s3SecretKey,omitempty"`
	EncryptionPassword string `json:"encryptionPassword,omitempty"`
}

type cloudBackupWebDAVSecrets struct {
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

type cloudBackupS3Secrets struct {
	AccessKey string `json:"accessKey,omitempty"`
	SecretKey string `json:"secretKey,omitempty"`
}

type cloudBackupEncryptionSecret struct {
	Password string `json:"password,omitempty"`
}

type cloudBackupSecretSnapshot struct {
	ref     string
	payload []byte
	exists  bool
}

type cloudBackupPersisted struct {
	SchemaVersion int               `json:"schemaVersion"`
	Config        CloudBackupConfig `json:"config"`
}

type cloudBackupFile struct {
	Path string `json:"path"`
	Data []byte `json:"data"`
}

type cloudBackupPayload struct {
	SchemaVersion int                      `json:"schemaVersion"`
	CreatedAt     string                   `json:"createdAt"`
	Connections   connectionPackagePayload `json:"connections"`
	Files         []cloudBackupFile        `json:"files,omitempty"`
}

type cloudBackupRestoreTarget struct {
	target string
	data   []byte
	mode   os.FileMode
}

type cloudBackupFileSnapshot struct {
	target string
	data   []byte
	mode   os.FileMode
	exists bool
}

type cloudBackupConnectionFilesSnapshot struct {
	connectionsData    []byte
	connectionsExists  bool
	dailySecretsData   []byte
	dailySecretsExists bool
}

type cloudBackupRestoreConfirmationToken struct {
	payloadHash string
	expiresAt   time.Time
}

var cloudBackupCategoryOrder = []string{
	CloudBackupCategoryConnections,
	CloudBackupCategorySavedQueries,
	CloudBackupCategoryAISettings,
	CloudBackupCategoryProxySettings,
	CloudBackupCategoryDailySecrets,
	CloudBackupCategoryUpdateSettings,
}

func defaultCloudBackupCategories() []string {
	return append([]string(nil), cloudBackupCategoryOrder...)
}

func normalizeCloudBackupCategories(categories []string) []string {
	selected := make(map[string]struct{}, len(categories))
	for _, category := range categories {
		selected[strings.TrimSpace(category)] = struct{}{}
	}
	normalized := make([]string, 0, len(selected))
	for _, category := range cloudBackupCategoryOrder {
		if _, ok := selected[category]; ok {
			normalized = append(normalized, category)
		}
	}
	return normalized
}

func normalizeCloudBackupConfig(config CloudBackupConfig) CloudBackupConfig {
	config.Provider = strings.ToLower(strings.TrimSpace(config.Provider))
	if config.Provider != CloudBackupProviderS3 && config.Provider != CloudBackupProviderWebDAV {
		config.Provider = CloudBackupProviderWebDAV
	}
	config.WebDAVEndpoint = strings.TrimRight(strings.TrimSpace(config.WebDAVEndpoint), "/")
	config.WebDAVFilePath = strings.Trim(strings.TrimSpace(config.WebDAVFilePath), "/")
	config.S3Endpoint = strings.TrimRight(strings.TrimSpace(config.S3Endpoint), "/")
	config.S3Bucket = strings.TrimSpace(config.S3Bucket)
	config.S3Region = strings.TrimSpace(config.S3Region)
	config.S3ObjectKey = strings.Trim(strings.TrimSpace(config.S3ObjectKey), "/")
	config.BackupCategories = normalizeCloudBackupCategories(config.BackupCategories)
	if config.WebDAVFilePath == "" {
		config.WebDAVFilePath = cloudBackupDefaultWebDAVFilePath
	}
	if config.S3ObjectKey == "" {
		config.S3ObjectKey = cloudBackupDefaultS3ObjectKey
	}
	switch config.Schedule {
	case CloudBackupScheduleImmediate, CloudBackupSchedule10Minutes, CloudBackupSchedule30Minutes, CloudBackupSchedule1Hour, CloudBackupScheduleOnExit:
	default:
		config.Schedule = CloudBackupScheduleManual
	}
	return config
}

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

func (a *App) cloudBackupView(config CloudBackupConfig) CloudBackupConfig {
	config = normalizeCloudBackupConfig(config)
	return config
}

func (a *App) CloudBackupGetConfig() (CloudBackupConfig, error) {
	config, err := a.loadCloudBackupConfig()
	if err != nil {
		return CloudBackupConfig{}, err
	}
	secrets, err := a.loadCloudBackupSecrets()
	if err != nil {
		return CloudBackupConfig{}, err
	}
	config.HasWebDAVCredential = cloudBackupHasWebDAVCredential(secrets)
	config.HasS3Credential = cloudBackupHasS3Credential(secrets)
	config.HasEncryptionKey = strings.TrimSpace(secrets.EncryptionPassword) != ""
	return a.cloudBackupView(config), nil
}

func cloudBackupHasWebDAVCredential(secrets cloudBackupSecrets) bool {
	return strings.TrimSpace(secrets.WebDAVUsername) != "" && strings.TrimSpace(secrets.WebDAVPassword) != ""
}

func cloudBackupHasS3Credential(secrets cloudBackupSecrets) bool {
	return strings.TrimSpace(secrets.S3AccessKey) != "" && strings.TrimSpace(secrets.S3SecretKey) != ""
}

func cloudBackupHasProviderCredential(provider string, secrets cloudBackupSecrets) bool {
	if provider == CloudBackupProviderS3 {
		return cloudBackupHasS3Credential(secrets)
	}
	return cloudBackupHasWebDAVCredential(secrets)
}

func clearCloudBackupWebDAVState(config *CloudBackupConfig) {
	config.WebDAVLastSyncAt = ""
	config.WebDAVLastSyncSuccess = false
	config.WebDAVLastSyncError = ""
	config.WebDAVRemoteAvailable = false
	config.WebDAVRemoteUpdatedAt = ""
}

func clearCloudBackupS3State(config *CloudBackupConfig) {
	config.S3LastSyncAt = ""
	config.S3LastSyncSuccess = false
	config.S3LastSyncError = ""
	config.S3RemoteAvailable = false
	config.S3RemoteUpdatedAt = ""
}

func applyCloudBackupConfigInput(previous CloudBackupConfig, input CloudBackupConfigInput) CloudBackupConfig {
	previous = normalizeCloudBackupConfig(previous)
	config := previous
	config.Enabled = input.Enabled
	config.Provider = input.Provider
	config.WebDAVEndpoint = input.WebDAVEndpoint
	config.WebDAVFilePath = input.WebDAVFilePath
	config.S3Endpoint = input.S3Endpoint
	config.S3Bucket = input.S3Bucket
	config.S3Region = input.S3Region
	config.S3ObjectKey = input.S3ObjectKey
	config.Schedule = input.Schedule
	if input.BackupCategories != nil {
		config.BackupCategories = append([]string(nil), input.BackupCategories...)
	}
	config = normalizeCloudBackupConfig(config)
	if previous.WebDAVEndpoint != config.WebDAVEndpoint || previous.WebDAVFilePath != config.WebDAVFilePath {
		clearCloudBackupWebDAVState(&config)
	}
	if previous.S3Endpoint != config.S3Endpoint || previous.S3Bucket != config.S3Bucket || previous.S3Region != config.S3Region || previous.S3ObjectKey != config.S3ObjectKey {
		clearCloudBackupS3State(&config)
	}
	return config
}

func (a *App) SaveCloudBackupConfig(input CloudBackupConfigInput) (CloudBackupConfig, error) {
	previousConfig, err := a.loadCloudBackupConfig()
	if err != nil {
		return CloudBackupConfig{}, err
	}
	config := applyCloudBackupConfigInput(previousConfig, input)
	secrets, err := a.loadCloudBackupSecrets()
	if err != nil {
		return CloudBackupConfig{}, err
	}
	previousSecrets := secrets
	if input.ClearRemoteSecret || input.ClearWebDAVCredential {
		secrets.WebDAVUsername, secrets.WebDAVPassword = "", ""
	}
	if input.ClearRemoteSecret || input.ClearS3Credential {
		secrets.S3AccessKey, secrets.S3SecretKey = "", ""
	}
	if input.ClearEncryptionKey {
		secrets.EncryptionPassword = ""
	}
	if strings.TrimSpace(input.WebDAVUsername) != "" {
		secrets.WebDAVUsername = strings.TrimSpace(input.WebDAVUsername)
	}
	if strings.TrimSpace(input.WebDAVPassword) != "" {
		secrets.WebDAVPassword = input.WebDAVPassword
	}
	if strings.TrimSpace(input.S3AccessKey) != "" {
		secrets.S3AccessKey = strings.TrimSpace(input.S3AccessKey)
	}
	if strings.TrimSpace(input.S3SecretKey) != "" {
		secrets.S3SecretKey = input.S3SecretKey
	}
	if strings.TrimSpace(input.EncryptionPassword) != "" {
		secrets.EncryptionPassword = input.EncryptionPassword
	}
	if len(config.BackupCategories) == 0 {
		return CloudBackupConfig{}, errors.New("select at least one cloud backup category")
	}
	if config.Enabled {
		if err := a.secretStore.HealthCheck(); err != nil {
			return CloudBackupConfig{}, fmt.Errorf("OS keyring unavailable: %w", err)
		}
		if !cloudBackupHasProviderCredential(config.Provider, secrets) {
			return CloudBackupConfig{}, errors.New("cloud backup remote credentials are required")
		}
		if strings.TrimSpace(secrets.EncryptionPassword) == "" {
			return CloudBackupConfig{}, errors.New("cloud backup encryption password is required")
		}
	}
	if err := a.saveCloudBackupSecrets(secrets); err != nil {
		return CloudBackupConfig{}, err
	}
	if _, err := a.updateCloudBackupState(func(current *CloudBackupConfig) error {
		*current = applyCloudBackupConfigInput(*current, input)
		return nil
	}); err != nil {
		if rollbackErr := a.saveCloudBackupSecrets(previousSecrets); rollbackErr != nil {
			return CloudBackupConfig{}, fmt.Errorf("save cloud backup configuration failed: %w (secret rollback failed: %v)", err, rollbackErr)
		}
		return CloudBackupConfig{}, err
	}
	a.restartCloudBackupScheduler()
	current, err := a.CloudBackupGetConfig()
	if err != nil {
		return CloudBackupConfig{}, err
	}
	// Saving settings must not wait for a remote request. Immediate schedules
	// are handled by the existing asynchronous dirty-state sync path.
	a.markCloudBackupDirty()
	return current, nil
}

func (a *App) buildCloudBackupPayload(config CloudBackupConfig) ([]byte, error) {
	selected := make(map[string]struct{}, len(config.BackupCategories))
	for _, category := range normalizeCloudBackupCategories(config.BackupCategories) {
		selected[category] = struct{}{}
	}
	if len(selected) == 0 {
		return nil, errors.New("select at least one cloud backup category")
	}
	connections := connectionPackagePayload{}
	if _, ok := selected[CloudBackupCategoryConnections]; ok {
		var err error
		connections, err = a.buildConnectionPackagePayload(nil, nil)
		if err != nil {
			return nil, err
		}
	}
	files, err := a.collectCloudBackupFiles(selected)
	if err != nil {
		return nil, err
	}
	payload := cloudBackupPayload{SchemaVersion: cloudBackupPayloadSchemaVersion, CreatedAt: time.Now().UTC().Format(time.RFC3339), Connections: connections, Files: files}
	return json.Marshal(payload)
}

func (a *App) collectCloudBackupFiles(selected map[string]struct{}) ([]cloudBackupFile, error) {
	root := strings.TrimSpace(a.configDir)
	if root == "" {
		root = resolveAppConfigDir()
	}
	paths := []string{"ai_config.json", "global_proxy.json", "daily_secrets.json", "saved_queries.json", "update_channel.json"}
	files := make([]cloudBackupFile, 0, len(paths))
	var total int64
	for _, name := range paths {
		category, categoryErr := cloudBackupRestoreCategoryForFile(name)
		if categoryErr != nil {
			return nil, categoryErr
		}
		if _, ok := selected[category]; !ok {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		total += int64(len(data))
		if total > cloudBackupMaxFileBytes {
			return nil, errors.New("cloud backup files exceed size limit")
		}
		files = append(files, cloudBackupFile{Path: name, Data: data})
	}
	if _, ok := selected[CloudBackupCategorySavedQueries]; !ok {
		return files, nil
	}
	savedQueryDir, err := appdata.ResolveSavedQueryDirectory(root)
	if err != nil {
		return nil, err
	}
	if err := filepath.WalkDir(savedQueryDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry == nil || entry.IsDir() {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		total += int64(len(data))
		if total > cloudBackupMaxFileBytes {
			return errors.New("cloud backup files exceed size limit")
		}
		relative, relErr := filepath.Rel(savedQueryDir, path)
		if relErr != nil {
			return relErr
		}
		files = append(files, cloudBackupFile{Path: filepath.ToSlash(filepath.Join("saved_queries", relative)), Data: data})
		return nil
	}); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return files, nil
}

func (a *App) cloudBackupRemote(config CloudBackupConfig, secrets cloudBackupSecrets) (cloudbackup.Remote, error) {
	remoteConfig := cloudbackup.RemoteConfig{Provider: config.Provider}
	credentials := cloudbackup.Credentials{}
	if config.Provider == CloudBackupProviderS3 {
		remoteConfig.Endpoint = config.S3Endpoint
		remoteConfig.Bucket = config.S3Bucket
		remoteConfig.Region = config.S3Region
		remoteConfig.ObjectKey = config.S3ObjectKey
		credentials.AccessKey = secrets.S3AccessKey
		credentials.SecretKey = secrets.S3SecretKey
	} else {
		remoteConfig.Endpoint = config.WebDAVEndpoint
		remoteConfig.ObjectKey = config.WebDAVFilePath
		credentials.Username = secrets.WebDAVUsername
		credentials.Password = secrets.WebDAVPassword
	}
	return cloudbackup.NewRemote(remoteConfig, credentials, newHTTPClientWithGlobalProxy(45*time.Second))
}

func (a *App) CloudBackupSyncNow() (CloudBackupStatus, error) {
	return a.cloudBackupSync(context.Background())
}

func (a *App) cloudBackupSync(parent context.Context) (CloudBackupStatus, error) {
	a.cloudBackupSyncMu.Lock()
	defer a.cloudBackupSyncMu.Unlock()
	_, dirtyRevision := a.cloudBackupDirtyState()
	config, err := a.loadCloudBackupConfig()
	if err != nil {
		return CloudBackupStatus{}, err
	}
	secrets, err := a.loadCloudBackupProviderSecrets(config.Provider)
	if err != nil {
		return CloudBackupStatus{}, err
	}
	dirty, _ := a.cloudBackupDirtyState()
	status := a.cloudBackupStatusFromConfig(config, dirty)
	if !config.Enabled {
		return status, errors.New("cloud backup is disabled")
	}
	remote, err := a.cloudBackupRemote(config, secrets)
	if err != nil {
		return a.recordCloudBackupFailure(config, err)
	}
	payload, err := a.buildCloudBackupPayload(config)
	if err != nil {
		return a.recordCloudBackupFailure(config, err)
	}
	envelope, err := cloudbackup.Encrypt(payload, secrets.EncryptionPassword)
	if err != nil {
		return a.recordCloudBackupFailure(config, err)
	}
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	metadata, err := remote.Put(ctx, envelope)
	if err != nil {
		return a.recordCloudBackupFailure(config, err)
	}
	stateUpdated := false
	updatedConfig, stateErr := a.updateCloudBackupState(func(current *CloudBackupConfig) error {
		if !cloudBackupDestinationMatches(*current, config) {
			return nil
		}
		current.setCloudBackupSyncSuccess(config.Provider, metadata)
		stateUpdated = true
		return nil
	})
	if stateErr != nil {
		return CloudBackupStatus{}, stateErr
	}
	if stateUpdated {
		a.clearCloudBackupDirty(dirtyRevision)
	}
	dirty, _ = a.cloudBackupDirtyState()
	return a.cloudBackupStatusFromConfig(updatedConfig, dirty), nil
}

func (a *App) recordCloudBackupFailure(config CloudBackupConfig, syncErr error) (CloudBackupStatus, error) {
	if updatedConfig, err := a.updateCloudBackupState(func(current *CloudBackupConfig) error {
		if cloudBackupDestinationMatches(*current, config) {
			current.setCloudBackupSyncFailure(config.Provider, syncErr)
		}
		return nil
	}); err == nil {
		config = updatedConfig
	}
	dirty, _ := a.cloudBackupDirtyState()
	return a.cloudBackupStatusFromConfig(config, dirty), syncErr
}

func (a *App) CloudBackupGetStatus() (CloudBackupStatus, error) {
	config, err := a.CloudBackupGetConfig()
	if err != nil {
		return CloudBackupStatus{}, err
	}
	dirty, _ := a.cloudBackupDirtyState()
	return a.cloudBackupStatusFromConfig(config, dirty), nil
}

func (a *App) cloudBackupStatusFromConfig(config CloudBackupConfig, dirty bool) CloudBackupStatus {
	endpoint := config.WebDAVEndpoint
	lastSyncAt, lastSyncSuccess, lastSyncError := config.WebDAVLastSyncAt, config.WebDAVLastSyncSuccess, config.WebDAVLastSyncError
	remoteAvailable, remoteUpdatedAt := config.WebDAVRemoteAvailable, config.WebDAVRemoteUpdatedAt
	if config.Provider == CloudBackupProviderS3 {
		endpoint = config.S3Endpoint
		lastSyncAt, lastSyncSuccess, lastSyncError = config.S3LastSyncAt, config.S3LastSyncSuccess, config.S3LastSyncError
		remoteAvailable, remoteUpdatedAt = config.S3RemoteAvailable, config.S3RemoteUpdatedAt
	}
	return CloudBackupStatus{Configured: strings.TrimSpace(endpoint) != "", Enabled: config.Enabled, Provider: config.Provider, LastSyncAt: lastSyncAt, LastSyncSuccess: lastSyncSuccess, LastSyncError: lastSyncError, RemoteAvailable: remoteAvailable, RemoteUpdatedAt: remoteUpdatedAt, Dirty: dirty}
}

func cloudBackupDestinationMatches(current, operation CloudBackupConfig) bool {
	if operation.Provider == CloudBackupProviderS3 {
		return current.S3Endpoint == operation.S3Endpoint && current.S3Bucket == operation.S3Bucket && current.S3Region == operation.S3Region && current.S3ObjectKey == operation.S3ObjectKey
	}
	return current.WebDAVEndpoint == operation.WebDAVEndpoint && current.WebDAVFilePath == operation.WebDAVFilePath
}

func (config *CloudBackupConfig) setCloudBackupSyncSuccess(provider string, metadata cloudbackup.ObjectMetadata) {
	now := time.Now().UTC().Format(time.RFC3339)
	if provider == CloudBackupProviderS3 {
		config.S3LastSyncAt, config.S3LastSyncSuccess, config.S3LastSyncError = now, true, ""
		config.S3RemoteAvailable, config.S3RemoteUpdatedAt = true, metadata.LastModified
		return
	}
	config.WebDAVLastSyncAt, config.WebDAVLastSyncSuccess, config.WebDAVLastSyncError = now, true, ""
	config.WebDAVRemoteAvailable, config.WebDAVRemoteUpdatedAt = true, metadata.LastModified
}

func (config *CloudBackupConfig) setCloudBackupSyncFailure(provider string, syncErr error) {
	now := time.Now().UTC().Format(time.RFC3339)
	if provider == CloudBackupProviderS3 {
		config.S3LastSyncAt, config.S3LastSyncSuccess, config.S3LastSyncError = now, false, syncErr.Error()
		return
	}
	config.WebDAVLastSyncAt, config.WebDAVLastSyncSuccess, config.WebDAVLastSyncError = now, false, syncErr.Error()
}

func (config *CloudBackupConfig) setCloudBackupRemoteAvailability(provider string, available bool, updatedAt string) {
	if provider == CloudBackupProviderS3 {
		config.S3RemoteAvailable, config.S3RemoteUpdatedAt = available, updatedAt
		return
	}
	config.WebDAVRemoteAvailable, config.WebDAVRemoteUpdatedAt = available, updatedAt
}

func (a *App) recordCloudBackupRemoteAvailability(operation CloudBackupConfig, available bool, updatedAt string) {
	_, _ = a.updateCloudBackupState(func(current *CloudBackupConfig) error {
		if cloudBackupDestinationMatches(*current, operation) {
			current.setCloudBackupRemoteAvailability(operation.Provider, available, updatedAt)
		}
		return nil
	})
}

func (a *App) CloudBackupListRestorePoints() ([]CloudBackupRestorePoint, error) {
	config, err := a.loadCloudBackupConfig()
	if err != nil {
		return nil, err
	}
	secrets, err := a.loadCloudBackupProviderSecrets(config.Provider)
	if err != nil {
		return nil, err
	}
	remote, err := a.cloudBackupRemote(config, secrets)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	metadata, err := remote.Head(ctx)
	if err != nil {
		a.recordCloudBackupRemoteAvailability(config, false, "")
		return nil, err
	}
	a.recordCloudBackupRemoteAvailability(config, true, metadata.LastModified)
	objectKey := config.WebDAVFilePath
	if config.Provider == CloudBackupProviderS3 {
		objectKey = config.S3ObjectKey
	}
	return []CloudBackupRestorePoint{{ObjectKey: objectKey, LastModified: metadata.LastModified, Size: metadata.Size, ETag: metadata.ETag}}, nil
}

func (a *App) readCloudBackupPayload() (cloudBackupPayload, error) {
	config, err := a.loadCloudBackupConfig()
	if err != nil {
		return cloudBackupPayload{}, err
	}
	secrets, err := a.loadCloudBackupProviderSecrets(config.Provider)
	if err != nil {
		return cloudBackupPayload{}, err
	}
	remote, err := a.cloudBackupRemote(config, secrets)
	if err != nil {
		return cloudBackupPayload{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	envelope, metadata, err := remote.Get(ctx)
	if err != nil {
		a.recordCloudBackupRemoteAvailability(config, false, "")
		return cloudBackupPayload{}, err
	}
	a.recordCloudBackupRemoteAvailability(config, true, metadata.LastModified)
	plain, err := cloudbackup.Decrypt(envelope, secrets.EncryptionPassword)
	if err != nil {
		return cloudBackupPayload{}, err
	}
	var payload cloudBackupPayload
	if err := json.Unmarshal(plain, &payload); err != nil || payload.SchemaVersion != cloudBackupPayloadSchemaVersion {
		return cloudBackupPayload{}, errors.New("unsupported cloud backup payload")
	}
	return payload, nil
}

func (a *App) CloudBackupPreviewRestore() (CloudBackupRestorePreview, error) {
	payload, err := a.readCloudBackupPayload()
	if err != nil {
		return CloudBackupRestorePreview{}, err
	}
	preview, err := buildCloudBackupRestorePreview(payload, nil)
	if err != nil {
		return CloudBackupRestorePreview{}, err
	}
	preview.ConfirmationToken, err = a.issueCloudBackupRestoreConfirmationToken(payload)
	if err != nil {
		return CloudBackupRestorePreview{}, err
	}
	return preview, nil
}

func (a *App) CloudBackupRestore(request CloudBackupRestoreRequest) (CloudBackupRestorePreview, error) {
	payload, err := a.readCloudBackupPayload()
	if err != nil {
		return CloudBackupRestorePreview{}, err
	}
	restoreConnections, files, selectedCategories, err := selectCloudBackupRestorePayload(payload, request.Categories)
	if err != nil {
		return CloudBackupRestorePreview{}, err
	}
	resultPreview, err := buildCloudBackupRestorePreview(payload, selectedCategories)
	if err != nil {
		return CloudBackupRestorePreview{}, err
	}

	settingsFiles := make([]cloudBackupFile, 0, len(files))
	savedQueryFiles := make([]cloudBackupFile, 0, len(files))
	for _, file := range files {
		category, categoryErr := cloudBackupRestoreCategoryForFile(file.Path)
		if categoryErr != nil {
			return CloudBackupRestorePreview{}, categoryErr
		}
		if category == CloudBackupCategorySavedQueries {
			savedQueryFiles = append(savedQueryFiles, file)
			continue
		}
		settingsFiles = append(settingsFiles, file)
	}

	var savedQueryPayload connection.SavedQueryImportPayload
	if len(savedQueryFiles) > 0 {
		savedQueryPayload, err = buildCloudBackupSavedQueryImportPayload(savedQueryFiles)
		if err != nil {
			return CloudBackupRestorePreview{}, err
		}
		for _, item := range payload.Connections.Connections {
			savedQueryPayload.LegacyConnections = append(savedQueryPayload.LegacyConnections, newSavedConnectionInputFromPackageItem(item))
		}
	}

	var connectionSnapshot cloudBackupConnectionFilesSnapshot
	if restoreConnections {
		connectionSnapshot, err = a.captureCloudBackupConnectionFilesSnapshot()
		if err != nil {
			return CloudBackupRestorePreview{}, err
		}
		settingsFiles, err = a.preserveLocalOnlyConnectionSecrets(settingsFiles, payload.Connections)
		if err != nil {
			return CloudBackupRestorePreview{}, err
		}
	}
	if err := a.consumeCloudBackupRestoreConfirmationToken(request.ConfirmationToken, payload); err != nil {
		return CloudBackupRestorePreview{}, err
	}

	rollbackSettings := func() error { return nil }
	if len(settingsFiles) > 0 {
		rollbackSettings, err = a.restoreCloudBackupFiles(settingsFiles)
		if err != nil {
			return CloudBackupRestorePreview{}, err
		}
	}
	rollbackMutations := func() error {
		var rollbackErr error
		if restoreConnections {
			rollbackErr = errors.Join(rollbackErr, connectionSnapshot.restore(a))
		}
		return errors.Join(rollbackErr, rollbackSettings())
	}
	if restoreConnections {
		if _, err := a.importConnectionPackagePayload(payload.Connections); err != nil {
			if rollbackErr := rollbackMutations(); rollbackErr != nil {
				return CloudBackupRestorePreview{}, fmt.Errorf("restore connections failed: %w (rollback failed: %v)", err, rollbackErr)
			}
			return CloudBackupRestorePreview{}, err
		}
	}
	if len(savedQueryFiles) > 0 {
		currentConnections, listErr := a.savedConnectionRepository().List()
		if listErr != nil {
			if rollbackErr := rollbackMutations(); rollbackErr != nil {
				return CloudBackupRestorePreview{}, fmt.Errorf("restore saved queries failed: %w (rollback failed: %v)", listErr, rollbackErr)
			}
			return CloudBackupRestorePreview{}, listErr
		}
		if _, err := a.savedQueryRepository().Import(savedQueryPayload, currentConnections); err != nil {
			if rollbackErr := rollbackMutations(); rollbackErr != nil {
				return CloudBackupRestorePreview{}, fmt.Errorf("restore saved queries failed: %w (rollback failed: %v)", err, rollbackErr)
			}
			return CloudBackupRestorePreview{}, err
		}
	}

	a.markCloudBackupDirty()
	return resultPreview, nil
}

func buildCloudBackupRestorePreview(payload cloudBackupPayload, selectedCategories map[string]struct{}) (CloudBackupRestorePreview, error) {
	fileGroups := make(map[string][]cloudBackupFile)
	for _, file := range payload.Files {
		category, err := cloudBackupRestoreCategoryForFile(file.Path)
		if err != nil {
			return CloudBackupRestorePreview{}, err
		}
		fileGroups[category] = append(fileGroups[category], file)
	}

	preview := CloudBackupRestorePreview{CreatedAt: payload.CreatedAt}
	for _, categoryID := range cloudBackupCategoryOrder {
		if selectedCategories != nil {
			if _, selected := selectedCategories[categoryID]; !selected {
				continue
			}
		}
		category := CloudBackupCategory{ID: categoryID}
		if categoryID == CloudBackupCategoryConnections {
			category.ItemCount = len(payload.Connections.Connections)
			if category.ItemCount == 0 {
				continue
			}
			preview.ConnectionCount = category.ItemCount
			category.Connections = make([]CloudBackupConnectionSummary, 0, category.ItemCount)
			for _, item := range payload.Connections.Connections {
				id := strings.TrimSpace(item.ID)
				if id == "" {
					id = strings.TrimSpace(item.Config.ID)
				}
				category.Connections = append(category.Connections, CloudBackupConnectionSummary{
					ID:   id,
					Name: strings.TrimSpace(item.Name),
					Host: strings.TrimSpace(item.Config.Host),
				})
			}
		} else {
			files := fileGroups[categoryID]
			if len(files) == 0 {
				continue
			}
			category.ItemCount = len(files)
			category.Files = make([]string, 0, len(files))
			for _, file := range files {
				category.Files = append(category.Files, file.Path)
				preview.Files = append(preview.Files, file.Path)
			}
			sort.Strings(category.Files)
			category.RestartRequired = cloudBackupRestoreRequiresRestart(files)
			preview.FileCount += len(files)
			preview.RestartRequired = preview.RestartRequired || category.RestartRequired
		}
		preview.Categories = append(preview.Categories, category)
	}
	sort.Strings(preview.Files)
	return preview, nil
}

func selectCloudBackupRestorePayload(payload cloudBackupPayload, requested []string) (bool, []cloudBackupFile, map[string]struct{}, error) {
	if len(requested) == 0 {
		return false, nil, nil, errors.New("select at least one cloud backup category to restore")
	}
	availablePreview, err := buildCloudBackupRestorePreview(payload, nil)
	if err != nil {
		return false, nil, nil, err
	}
	available := make(map[string]struct{}, len(availablePreview.Categories))
	for _, category := range availablePreview.Categories {
		available[category.ID] = struct{}{}
	}

	selected := make(map[string]struct{}, len(requested))
	for _, rawCategory := range requested {
		category := strings.TrimSpace(rawCategory)
		if _, ok := available[category]; !ok {
			return false, nil, nil, fmt.Errorf("cloud backup category is unavailable: %s", rawCategory)
		}
		selected[category] = struct{}{}
	}

	files := make([]cloudBackupFile, 0, len(payload.Files))
	for _, file := range payload.Files {
		category, err := cloudBackupRestoreCategoryForFile(file.Path)
		if err != nil {
			return false, nil, nil, err
		}
		if _, ok := selected[category]; ok {
			files = append(files, file)
		}
	}
	_, restoreConnections := selected[CloudBackupCategoryConnections]
	return restoreConnections, files, selected, nil
}

func buildCloudBackupSavedQueryImportPayload(files []cloudBackupFile) (connection.SavedQueryImportPayload, error) {
	var metadata []byte
	sqlFiles := make(map[string][]byte)
	for _, file := range files {
		clean := filepath.Clean(filepath.FromSlash(file.Path))
		if clean == savedQueriesFileName {
			if metadata != nil {
				return connection.SavedQueryImportPayload{}, fmt.Errorf("duplicate backup file: %s", file.Path)
			}
			metadata = append([]byte(nil), file.Data...)
			continue
		}
		if filepath.Dir(clean) != "saved_queries" || !strings.EqualFold(filepath.Ext(clean), ".sql") {
			continue
		}
		fileName, err := normalizeSavedQueryDiskFileName(filepath.Base(clean))
		if err != nil {
			return connection.SavedQueryImportPayload{}, err
		}
		key := savedQuerySQLFileNameKey(fileName)
		if _, exists := sqlFiles[key]; exists {
			return connection.SavedQueryImportPayload{}, fmt.Errorf("duplicate saved query sql file: %s", file.Path)
		}
		sqlFiles[key] = append([]byte(nil), file.Data...)
	}
	if metadata == nil {
		return connection.SavedQueryImportPayload{}, errors.New("saved query backup metadata is missing")
	}

	var diskFile savedQueriesDiskFile
	if err := json.Unmarshal(metadata, &diskFile); err != nil {
		return connection.SavedQueryImportPayload{}, fmt.Errorf("decode saved query backup metadata: %w", err)
	}
	if diskFile.Version < 0 || diskFile.Version > savedQueriesFormatVersion {
		return connection.SavedQueryImportPayload{}, fmt.Errorf("unsupported saved query backup version: %d", diskFile.Version)
	}
	queries := make([]connection.SavedQuery, 0, len(diskFile.Queries))
	seenIDs := make(map[string]struct{}, len(diskFile.Queries))
	for index, record := range diskFile.Queries {
		queryID := strings.TrimSpace(record.ID)
		if queryID == "" {
			return connection.SavedQueryImportPayload{}, errors.New("saved query backup contains an empty query id")
		}
		if _, exists := seenIDs[queryID]; exists {
			return connection.SavedQueryImportPayload{}, fmt.Errorf("saved query backup contains a duplicate query id: %s", queryID)
		}
		seenIDs[queryID] = struct{}{}

		sqlText := record.LegacySQL
		if strings.TrimSpace(record.FileName) != "" {
			fileName, err := normalizeSavedQueryDiskFileName(record.FileName)
			if err != nil {
				return connection.SavedQueryImportPayload{}, err
			}
			content, exists := sqlFiles[savedQuerySQLFileNameKey(fileName)]
			if !exists {
				return connection.SavedQueryImportPayload{}, fmt.Errorf("saved query sql file is missing: %s", fileName)
			}
			sqlText = string(content)
		}
		query, ok := sanitizeSavedQuery(savedQueryFromDiskRecord(record, sqlText), index, false)
		if !ok {
			return connection.SavedQueryImportPayload{}, fmt.Errorf("saved query backup contains an invalid query: %s", queryID)
		}
		queries = append(queries, query)
	}
	if err := validateSavedQueryGroupsQueryIDs(diskFile.Groups, queries); err != nil {
		return connection.SavedQueryImportPayload{}, err
	}
	return connection.SavedQueryImportPayload{
		Queries: queries,
		Groups:  append([]connection.SavedQueryGroup(nil), diskFile.Groups...),
	}, nil
}

func (a *App) captureCloudBackupConnectionFilesSnapshot() (cloudBackupConnectionFilesSnapshot, error) {
	repo := a.savedConnectionRepository()
	snapshot := cloudBackupConnectionFilesSnapshot{}
	var err error
	snapshot.connectionsData, snapshot.connectionsExists, err = readOptionalFile(repo.connectionsPath())
	if err != nil {
		return cloudBackupConnectionFilesSnapshot{}, err
	}
	snapshot.dailySecretsData, snapshot.dailySecretsExists, err = readOptionalFile(repo.dailySecrets().Path())
	if err != nil {
		return cloudBackupConnectionFilesSnapshot{}, err
	}
	return snapshot, nil
}

func (snapshot cloudBackupConnectionFilesSnapshot) restore(a *App) error {
	repo := a.savedConnectionRepository()
	return errors.Join(
		restoreCloudBackupOptionalFile(repo.connectionsPath(), snapshot.connectionsExists, snapshot.connectionsData, 0o644),
		restoreCloudBackupOptionalFile(repo.dailySecrets().Path(), snapshot.dailySecretsExists, snapshot.dailySecretsData, 0o600),
	)
}

func (a *App) preserveLocalOnlyConnectionSecrets(files []cloudBackupFile, connections connectionPackagePayload) ([]cloudBackupFile, error) {
	remoteConnectionIDs := make(map[string]struct{}, len(connections.Connections))
	for _, item := range connections.Connections {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			id = strings.TrimSpace(item.Config.ID)
		}
		if id != "" {
			remoteConnectionIDs[id] = struct{}{}
		}
	}

	localSecrets, err := a.savedConnectionRepository().dailySecrets().Load()
	if err != nil {
		return nil, err
	}
	result := append([]cloudBackupFile(nil), files...)
	for index := range result {
		clean := filepath.Clean(filepath.FromSlash(result[index].Path))
		if clean != "daily_secrets.json" {
			continue
		}
		var remoteSecrets dailysecret.File
		if err := json.Unmarshal(result[index].Data, &remoteSecrets); err != nil {
			return nil, fmt.Errorf("decode daily secrets backup: %w", err)
		}
		if remoteSecrets.Connections == nil {
			remoteSecrets.Connections = make(map[string]dailysecret.ConnectionBundle)
		}
		for id, bundle := range localSecrets.Connections {
			if _, restored := remoteConnectionIDs[id]; restored {
				continue
			}
			if _, suppliedByBackup := remoteSecrets.Connections[id]; !suppliedByBackup {
				remoteSecrets.Connections[id] = bundle
			}
		}
		data, err := json.MarshalIndent(remoteSecrets, "", "  ")
		if err != nil {
			return nil, err
		}
		result[index].Data = data
	}
	return result, nil
}

func restoreCloudBackupOptionalFile(path string, exists bool, data []byte, mode os.FileMode) error {
	if !exists {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return writeCloudBackupFile(path, data, mode)
}

func cloudBackupRestoreCategoryForFile(path string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(path))
	switch {
	case clean == "saved_queries.json", filepath.Dir(clean) == "saved_queries", strings.HasPrefix(clean, "saved_queries"+string(os.PathSeparator)):
		return CloudBackupCategorySavedQueries, nil
	case clean == "ai_config.json":
		return CloudBackupCategoryAISettings, nil
	case clean == "global_proxy.json":
		return CloudBackupCategoryProxySettings, nil
	case clean == "daily_secrets.json":
		return CloudBackupCategoryDailySecrets, nil
	case clean == "update_channel.json":
		return CloudBackupCategoryUpdateSettings, nil
	default:
		return "", fmt.Errorf("unsupported backup file: %s", path)
	}
}

func cloudBackupPayloadHash(payload cloudBackupPayload) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return string(digest[:]), nil
}

func (a *App) issueCloudBackupRestoreConfirmationToken(payload cloudBackupPayload) (string, error) {
	payloadHash, err := cloudBackupPayloadHash(payload)
	if err != nil {
		return "", fmt.Errorf("build cloud backup restore confirmation: %w", err)
	}
	token := uuid.NewString()
	now := time.Now()
	ttl := a.cloudBackupRestoreTokenTTL
	if ttl <= 0 {
		ttl = defaultCloudBackupRestoreConfirmationTokenTTL
	}

	a.cloudBackupRestoreTokenMu.Lock()
	defer a.cloudBackupRestoreTokenMu.Unlock()
	if a.cloudBackupRestoreTokens == nil {
		a.cloudBackupRestoreTokens = make(map[string]cloudBackupRestoreConfirmationToken)
	}
	a.pruneExpiredCloudBackupRestoreConfirmationTokensLocked(now)
	a.cloudBackupRestoreTokens[token] = cloudBackupRestoreConfirmationToken{
		payloadHash: payloadHash,
		expiresAt:   now.Add(ttl),
	}
	return token, nil
}

func (a *App) consumeCloudBackupRestoreConfirmationToken(rawToken string, payload cloudBackupPayload) error {
	token := strings.TrimSpace(rawToken)
	if token == "" {
		return errors.New("cloud backup restore requires a preview confirmation token")
	}
	payloadHash, err := cloudBackupPayloadHash(payload)
	if err != nil {
		return fmt.Errorf("validate cloud backup restore confirmation: %w", err)
	}
	now := time.Now()

	a.cloudBackupRestoreTokenMu.Lock()
	if a.cloudBackupRestoreTokens == nil {
		a.cloudBackupRestoreTokens = make(map[string]cloudBackupRestoreConfirmationToken)
	}
	entry, ok := a.cloudBackupRestoreTokens[token]
	if ok {
		delete(a.cloudBackupRestoreTokens, token)
	}
	a.pruneExpiredCloudBackupRestoreConfirmationTokensLocked(now)
	a.cloudBackupRestoreTokenMu.Unlock()

	if !ok || !entry.expiresAt.After(now) || subtle.ConstantTimeCompare([]byte(entry.payloadHash), []byte(payloadHash)) != 1 {
		return errors.New("cloud backup restore confirmation is invalid or expired; preview the backup again")
	}
	return nil
}

func (a *App) pruneExpiredCloudBackupRestoreConfirmationTokensLocked(now time.Time) {
	for token, entry := range a.cloudBackupRestoreTokens {
		if !entry.expiresAt.After(now) {
			delete(a.cloudBackupRestoreTokens, token)
		}
	}
}

func cloudBackupRestoreRequiresRestart(files []cloudBackupFile) bool {
	for _, file := range files {
		clean := filepath.Clean(filepath.FromSlash(file.Path))
		if clean == "ai_config.json" || clean == "global_proxy.json" || clean == "daily_secrets.json" || clean == "update_channel.json" {
			return true
		}
	}
	return false
}

func (a *App) restoreCloudBackupFiles(files []cloudBackupFile) (func() error, error) {
	root := strings.TrimSpace(a.configDir)
	if root == "" {
		root = resolveAppConfigDir()
	}
	savedQueryDir, err := appdata.ResolveSavedQueryDirectory(root)
	if err != nil {
		return nil, err
	}
	targets := make([]cloudBackupRestoreTarget, 0, len(files))
	seenTargets := make(map[string]struct{}, len(files))
	for _, file := range files {
		clean := filepath.Clean(filepath.FromSlash(file.Path))
		var target string
		baseDir := root
		mode := os.FileMode(0o644)
		switch {
		case clean == "ai_config.json" || clean == "global_proxy.json" || clean == "saved_queries.json" || clean == "update_channel.json":
			target = filepath.Join(root, clean)
		case clean == "daily_secrets.json":
			target = filepath.Join(root, clean)
			mode = 0o600
		case filepath.Dir(clean) == "saved_queries" || strings.HasPrefix(clean, "saved_queries"+string(os.PathSeparator)):
			relative := strings.TrimPrefix(clean, "saved_queries"+string(os.PathSeparator))
			if relative == "" || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
				return nil, fmt.Errorf("unsupported backup file: %s", file.Path)
			}
			target = filepath.Join(savedQueryDir, relative)
			baseDir = savedQueryDir
		default:
			return nil, fmt.Errorf("unsupported backup file: %s", file.Path)
		}
		rel, relErr := filepath.Rel(baseDir, target)
		if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
			return nil, fmt.Errorf("unsupported backup file: %s", file.Path)
		}
		if _, ok := seenTargets[target]; ok {
			return nil, fmt.Errorf("duplicate backup file: %s", file.Path)
		}
		seenTargets[target] = struct{}{}
		targets = append(targets, cloudBackupRestoreTarget{target: target, data: append([]byte(nil), file.Data...), mode: mode})
	}

	snapshots := make([]cloudBackupFileSnapshot, 0, len(targets))
	for _, target := range targets {
		info, statErr := os.Stat(target.target)
		if statErr == nil {
			if info.IsDir() {
				return nil, fmt.Errorf("backup target is a directory: %s", target.target)
			}
			data, readErr := os.ReadFile(target.target)
			if readErr != nil {
				return nil, readErr
			}
			snapshots = append(snapshots, cloudBackupFileSnapshot{target: target.target, data: data, mode: info.Mode().Perm(), exists: true})
			continue
		}
		if !os.IsNotExist(statErr) {
			return nil, statErr
		}
		snapshots = append(snapshots, cloudBackupFileSnapshot{target: target.target})
	}

	rollback := func() error {
		var rollbackErr error
		for _, snapshot := range snapshots {
			if !snapshot.exists {
				if err := os.Remove(snapshot.target); err != nil && !os.IsNotExist(err) && rollbackErr == nil {
					rollbackErr = err
				}
				continue
			}
			if err := writeCloudBackupFile(snapshot.target, snapshot.data, snapshot.mode); err != nil && rollbackErr == nil {
				rollbackErr = err
			}
		}
		return rollbackErr
	}

	for _, target := range targets {
		if err := writeCloudBackupFile(target.target, target.data, target.mode); err != nil {
			_ = rollback()
			return nil, err
		}
	}
	return rollback, nil
}

func writeCloudBackupFile(target string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(target, data, mode); err != nil {
		return err
	}
	return os.Chmod(target, mode)
}

func (a *App) initializeCloudBackup(ctx context.Context) {
	if _, err := a.CloudBackupGetConfig(); err != nil {
		logger.Warnf("加载云端备份配置失败：%v", err)
	}
	a.restartCloudBackupScheduler()
	config, err := a.loadCloudBackupConfig()
	if err == nil && config.Enabled {
		go func() {
			if _, checkErr := a.CloudBackupListRestorePoints(); checkErr != nil {
				logger.Warnf("启动时检查云端备份失败：%v", checkErr)
			}
		}()
	}
}

func (a *App) restartCloudBackupScheduler() {
	a.cloudBackupSchedulerMu.Lock()
	if a.cloudBackupSchedulerCancel != nil {
		a.cloudBackupSchedulerCancel()
	}
	a.cloudBackupSchedulerCancel = nil
	a.cloudBackupSchedulerMu.Unlock()
	config, err := a.loadCloudBackupConfig()
	if err != nil || !config.Enabled {
		return
	}
	interval := cloudBackupScheduleInterval(config.Schedule)
	if interval <= 0 {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.cloudBackupSchedulerMu.Lock()
	a.cloudBackupSchedulerCancel = cancel
	a.cloudBackupSchedulerMu.Unlock()
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := a.cloudBackupSync(ctx); err != nil {
					logger.Warnf("自动同步云端备份失败：%v", err)
				}
			}
		}
	}()
}

func cloudBackupScheduleInterval(schedule string) time.Duration {
	switch schedule {
	case CloudBackupSchedule10Minutes:
		return 10 * time.Minute
	case CloudBackupSchedule30Minutes:
		return 30 * time.Minute
	case CloudBackupSchedule1Hour:
		return time.Hour
	default:
		return 0
	}
}

func (a *App) markCloudBackupDirty() {
	config, err := a.loadCloudBackupConfig()
	if err != nil || !config.Enabled {
		return
	}
	a.cloudBackupDirtyMu.Lock()
	a.cloudBackupDirty = true
	a.cloudBackupDirtyRevision++
	a.cloudBackupDirtyMu.Unlock()
	if config.Schedule != CloudBackupScheduleImmediate {
		return
	}
	go func() {
		if _, err := a.cloudBackupSync(context.Background()); err != nil {
			logger.Warnf("修改后同步云端备份失败：%v", err)
		}
	}()
}

func (a *App) cloudBackupDirtyState() (bool, uint64) {
	a.cloudBackupDirtyMu.Lock()
	defer a.cloudBackupDirtyMu.Unlock()
	return a.cloudBackupDirty, a.cloudBackupDirtyRevision
}

func (a *App) clearCloudBackupDirty(revision uint64) {
	a.cloudBackupDirtyMu.Lock()
	if a.cloudBackupDirtyRevision == revision {
		a.cloudBackupDirty = false
	}
	a.cloudBackupDirtyMu.Unlock()
}

func (a *App) shutdownCloudBackup() {
	a.cloudBackupSchedulerMu.Lock()
	if a.cloudBackupSchedulerCancel != nil {
		a.cloudBackupSchedulerCancel()
		a.cloudBackupSchedulerCancel = nil
	}
	a.cloudBackupSchedulerMu.Unlock()
	config, err := a.loadCloudBackupConfig()
	if err != nil || !config.Enabled || config.Schedule != CloudBackupScheduleOnExit {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := a.cloudBackupSync(ctx); err != nil {
		logger.Warnf("退出前同步云端备份失败：%v", err)
	}
}
