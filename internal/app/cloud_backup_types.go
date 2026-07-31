package app

import (
	"encoding/json"
	"strings"
)

const (
	CloudBackupProviderWebDAV = "webdav"
	CloudBackupProviderS3     = "s3"

	CloudBackupCategoryConnections    = "connections"
	CloudBackupCategorySavedQueries   = "saved_queries"
	CloudBackupCategoryAISettings     = "ai_settings"
	CloudBackupCategoryProxySettings  = "proxy_settings"
	CloudBackupCategoryDailySecrets   = "daily_secrets"
	CloudBackupCategoryUpdateSettings = "update_settings"

	CloudBackupScheduleManual    = "manual"
	CloudBackupScheduleImmediate = "immediate"
	CloudBackupSchedule10Minutes = "10m"
	CloudBackupSchedule30Minutes = "30m"
	CloudBackupSchedule1Hour     = "1h"
	CloudBackupScheduleOnExit    = "on_exit"
)

type CloudBackupConfig struct {
	Enabled               bool     `json:"enabled"`
	Provider              string   `json:"provider"`
	WebDAVEndpoint        string   `json:"webdavEndpoint,omitempty"`
	WebDAVFilePath        string   `json:"webdavFilePath,omitempty"`
	S3Endpoint            string   `json:"s3Endpoint,omitempty"`
	S3Bucket              string   `json:"s3Bucket,omitempty"`
	S3Region              string   `json:"s3Region,omitempty"`
	S3ObjectKey           string   `json:"s3ObjectKey,omitempty"`
	Schedule              string   `json:"schedule"`
	BackupCategories      []string `json:"backupCategories"`
	HasWebDAVCredential   bool     `json:"hasWebdavCredential,omitempty"`
	HasS3Credential       bool     `json:"hasS3Credential,omitempty"`
	HasEncryptionKey      bool     `json:"hasEncryptionKey,omitempty"`
	WebDAVLastSyncAt      string   `json:"webdavLastSyncAt,omitempty"`
	WebDAVLastSyncSuccess bool     `json:"webdavLastSyncSuccess"`
	WebDAVLastSyncError   string   `json:"webdavLastSyncError,omitempty"`
	WebDAVRemoteAvailable bool     `json:"webdavRemoteAvailable"`
	WebDAVRemoteUpdatedAt string   `json:"webdavRemoteUpdatedAt,omitempty"`
	S3LastSyncAt          string   `json:"s3LastSyncAt,omitempty"`
	S3LastSyncSuccess     bool     `json:"s3LastSyncSuccess"`
	S3LastSyncError       string   `json:"s3LastSyncError,omitempty"`
	S3RemoteAvailable     bool     `json:"s3RemoteAvailable"`
	S3RemoteUpdatedAt     string   `json:"s3RemoteUpdatedAt,omitempty"`
}

// UnmarshalJSON keeps configurations written before provider-specific fields
// were introduced readable, while all subsequent writes use the split schema.
func (config *CloudBackupConfig) UnmarshalJSON(data []byte) error {
	type cloudBackupConfigJSON struct {
		Enabled               bool     `json:"enabled"`
		Provider              string   `json:"provider"`
		WebDAVEndpoint        string   `json:"webdavEndpoint"`
		WebDAVFilePath        string   `json:"webdavFilePath"`
		S3Endpoint            string   `json:"s3Endpoint"`
		S3Bucket              string   `json:"s3Bucket"`
		S3Region              string   `json:"s3Region"`
		S3ObjectKey           string   `json:"s3ObjectKey"`
		LegacyEndpoint        string   `json:"endpoint"`
		LegacyBucket          string   `json:"bucket"`
		LegacyRegion          string   `json:"region"`
		LegacyObjectKey       string   `json:"objectKey"`
		Schedule              string   `json:"schedule"`
		BackupCategories      []string `json:"backupCategories"`
		HasWebDAVCredential   bool     `json:"hasWebdavCredential"`
		HasS3Credential       bool     `json:"hasS3Credential"`
		HasEncryptionKey      bool     `json:"hasEncryptionKey"`
		LastSyncAt            string   `json:"lastSyncAt"`
		LastSyncSuccess       bool     `json:"lastSyncSuccess"`
		LastSyncError         string   `json:"lastSyncError"`
		RemoteAvailable       bool     `json:"remoteAvailable"`
		RemoteUpdatedAt       string   `json:"remoteUpdatedAt"`
		WebDAVLastSyncAt      string   `json:"webdavLastSyncAt"`
		WebDAVLastSyncSuccess bool     `json:"webdavLastSyncSuccess"`
		WebDAVLastSyncError   string   `json:"webdavLastSyncError"`
		WebDAVRemoteAvailable bool     `json:"webdavRemoteAvailable"`
		WebDAVRemoteUpdatedAt string   `json:"webdavRemoteUpdatedAt"`
		S3LastSyncAt          string   `json:"s3LastSyncAt"`
		S3LastSyncSuccess     bool     `json:"s3LastSyncSuccess"`
		S3LastSyncError       string   `json:"s3LastSyncError"`
		S3RemoteAvailable     bool     `json:"s3RemoteAvailable"`
		S3RemoteUpdatedAt     string   `json:"s3RemoteUpdatedAt"`
	}
	var raw cloudBackupConfigJSON
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*config = CloudBackupConfig{
		Enabled: raw.Enabled, Provider: raw.Provider,
		WebDAVEndpoint: raw.WebDAVEndpoint, WebDAVFilePath: raw.WebDAVFilePath,
		S3Endpoint: raw.S3Endpoint, S3Bucket: raw.S3Bucket, S3Region: raw.S3Region, S3ObjectKey: raw.S3ObjectKey,
		Schedule: raw.Schedule, BackupCategories: append([]string(nil), raw.BackupCategories...),
		HasWebDAVCredential: raw.HasWebDAVCredential, HasS3Credential: raw.HasS3Credential, HasEncryptionKey: raw.HasEncryptionKey,
		WebDAVLastSyncAt: raw.WebDAVLastSyncAt, WebDAVLastSyncSuccess: raw.WebDAVLastSyncSuccess,
		WebDAVLastSyncError: raw.WebDAVLastSyncError, WebDAVRemoteAvailable: raw.WebDAVRemoteAvailable, WebDAVRemoteUpdatedAt: raw.WebDAVRemoteUpdatedAt,
		S3LastSyncAt: raw.S3LastSyncAt, S3LastSyncSuccess: raw.S3LastSyncSuccess,
		S3LastSyncError: raw.S3LastSyncError, S3RemoteAvailable: raw.S3RemoteAvailable, S3RemoteUpdatedAt: raw.S3RemoteUpdatedAt,
	}
	legacyStatusPresent := raw.LastSyncAt != "" || raw.LastSyncSuccess || raw.LastSyncError != "" || raw.RemoteAvailable || raw.RemoteUpdatedAt != ""
	if strings.EqualFold(strings.TrimSpace(config.Provider), CloudBackupProviderS3) {
		if config.S3Endpoint == "" {
			config.S3Endpoint = raw.LegacyEndpoint
		}
		if config.S3Bucket == "" {
			config.S3Bucket = raw.LegacyBucket
		}
		if config.S3Region == "" {
			config.S3Region = raw.LegacyRegion
		}
		if config.S3ObjectKey == "" {
			config.S3ObjectKey = raw.LegacyObjectKey
		}
		if legacyStatusPresent && config.S3LastSyncAt == "" && config.S3LastSyncError == "" {
			config.S3LastSyncAt, config.S3LastSyncSuccess, config.S3LastSyncError = raw.LastSyncAt, raw.LastSyncSuccess, raw.LastSyncError
			config.S3RemoteAvailable, config.S3RemoteUpdatedAt = raw.RemoteAvailable, raw.RemoteUpdatedAt
		}
	} else {
		if config.WebDAVEndpoint == "" {
			config.WebDAVEndpoint = raw.LegacyEndpoint
		}
		if config.WebDAVFilePath == "" {
			config.WebDAVFilePath = raw.LegacyObjectKey
		}
		if legacyStatusPresent && config.WebDAVLastSyncAt == "" && config.WebDAVLastSyncError == "" {
			config.WebDAVLastSyncAt, config.WebDAVLastSyncSuccess, config.WebDAVLastSyncError = raw.LastSyncAt, raw.LastSyncSuccess, raw.LastSyncError
			config.WebDAVRemoteAvailable, config.WebDAVRemoteUpdatedAt = raw.RemoteAvailable, raw.RemoteUpdatedAt
		}
	}
	return nil
}

type CloudBackupConfigInput struct {
	Enabled               bool     `json:"enabled"`
	Provider              string   `json:"provider"`
	WebDAVEndpoint        string   `json:"webdavEndpoint,omitempty"`
	WebDAVFilePath        string   `json:"webdavFilePath,omitempty"`
	S3Endpoint            string   `json:"s3Endpoint,omitempty"`
	S3Bucket              string   `json:"s3Bucket,omitempty"`
	S3Region              string   `json:"s3Region,omitempty"`
	S3ObjectKey           string   `json:"s3ObjectKey,omitempty"`
	Schedule              string   `json:"schedule"`
	BackupCategories      []string `json:"backupCategories"`
	WebDAVUsername        string   `json:"webdavUsername,omitempty"`
	WebDAVPassword        string   `json:"webdavPassword,omitempty"`
	S3AccessKey           string   `json:"s3AccessKey,omitempty"`
	S3SecretKey           string   `json:"s3SecretKey,omitempty"`
	EncryptionPassword    string   `json:"encryptionPassword,omitempty"`
	ClearWebDAVCredential bool     `json:"clearWebdavCredential"`
	ClearS3Credential     bool     `json:"clearS3Credential"`
	// ClearRemoteSecret is retained for callers using the pre-split input and
	// intentionally clears both provider credentials when set.
	ClearRemoteSecret  bool `json:"clearRemoteSecret"`
	ClearEncryptionKey bool `json:"clearEncryptionKey"`
}

type CloudBackupStatus struct {
	Configured      bool   `json:"configured"`
	Enabled         bool   `json:"enabled"`
	Provider        string `json:"provider"`
	LastSyncAt      string `json:"lastSyncAt,omitempty"`
	LastSyncSuccess bool   `json:"lastSyncSuccess"`
	LastSyncError   string `json:"lastSyncError,omitempty"`
	RemoteAvailable bool   `json:"remoteAvailable"`
	RemoteUpdatedAt string `json:"remoteUpdatedAt,omitempty"`
	Dirty           bool   `json:"dirty"`
}

type CloudBackupRestorePoint struct {
	ObjectKey    string `json:"objectKey"`
	LastModified string `json:"lastModified,omitempty"`
	Size         int64  `json:"size,omitempty"`
	ETag         string `json:"etag,omitempty"`
}

type CloudBackupRestorePreview struct {
	CreatedAt         string                `json:"createdAt"`
	ConnectionCount   int                   `json:"connectionCount"`
	FileCount         int                   `json:"fileCount"`
	Files             []string              `json:"files"`
	RestartRequired   bool                  `json:"restartRequired"`
	Categories        []CloudBackupCategory `json:"categories"`
	ConfirmationToken string                `json:"confirmationToken,omitempty"`
}

type CloudBackupCategory struct {
	ID              string                         `json:"id"`
	ItemCount       int                            `json:"itemCount"`
	Files           []string                       `json:"files,omitempty"`
	Connections     []CloudBackupConnectionSummary `json:"connections,omitempty"`
	RestartRequired bool                           `json:"restartRequired"`
}

type CloudBackupConnectionSummary struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Host string `json:"host,omitempty"`
}

type CloudBackupRestoreRequest struct {
	ConfirmationToken string   `json:"confirmationToken"`
	Categories        []string `json:"categories"`
}
