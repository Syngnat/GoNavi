package app

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/cloudbackup"
	"GoNavi-Wails/internal/connection"
)

func (a *App) buildCloudBackupPayload(config CloudBackupConfig) ([]byte, error) {
	selected := make(map[string]struct{}, len(config.BackupCategories))
	for _, category := range normalizeCloudBackupCategories(config.BackupCategories) {
		selected[category] = struct{}{}
	}
	if len(selected) == 0 {
		return nil, errors.New("select at least one cloud backup category")
	}
	var connections connectionPackagePayload
	var connectionSidebarLayout *connection.ConnectionSidebarLayout
	var files []cloudBackupFile
	buildSnapshot := func(repo *savedConnectionRepository) error {
		if _, ok := selected[CloudBackupCategoryConnections]; ok {
			var err error
			connections, err = a.buildConnectionPackagePayloadUnlocked(repo, nil, nil)
			if err != nil {
				return err
			}
			layout, err := a.connectionSidebarLayoutRepository().loadUnlocked()
			if err != nil {
				return err
			}
			if layout.Initialized {
				connectionSidebarLayout = &layout
			}
		}
		var err error
		files, err = a.collectCloudBackupFiles(selected)
		return err
	}

	var err error
	if cloudBackupSelectionTouchesSavedConnectionState(selected) {
		repo := a.savedConnectionRepository()
		err = repo.withWriteLock(func() error {
			return buildSnapshot(repo)
		})
	} else {
		err = buildSnapshot(nil)
	}
	if err != nil {
		return nil, err
	}
	payload := cloudBackupPayload{
		SchemaVersion:           cloudBackupPayloadSchemaVersion,
		CreatedAt:               time.Now().UTC().Format(time.RFC3339),
		Connections:             connections,
		ConnectionSidebarLayout: connectionSidebarLayout,
		Files:                   files,
	}
	return json.Marshal(payload)
}

func cloudBackupSelectionTouchesSavedConnectionState(selected map[string]struct{}) bool {
	if _, ok := selected[CloudBackupCategoryConnections]; ok {
		return true
	}
	_, ok := selected[CloudBackupCategoryDailySecrets]
	return ok
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
