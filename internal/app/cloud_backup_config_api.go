package app

import (
	"errors"
	"fmt"
	"strings"
)

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
