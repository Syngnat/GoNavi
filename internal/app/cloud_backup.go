package app

import (
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
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
	SchemaVersion           int                                 `json:"schemaVersion"`
	CreatedAt               string                              `json:"createdAt"`
	Connections             connectionPackagePayload            `json:"connections"`
	ConnectionSidebarLayout *connection.ConnectionSidebarLayout `json:"connectionSidebarLayout,omitempty"`
	Files                   []cloudBackupFile                   `json:"files,omitempty"`
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
	connectionsData         []byte
	connectionsExists       bool
	dailySecretsData        []byte
	dailySecretsExists      bool
	connectionSidebarLayout connectionSidebarLayoutSnapshot
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
