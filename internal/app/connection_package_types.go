package app

import (
	"encoding/json"
	"errors"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const (
	connectionPackageSchemaVersion   = 1
	connectionPackageSchemaVersionV2 = 2
	connectionPackageKind            = "gonavi_connection_package"
	connectionPackageCipher          = "AES-256-GCM"
	connectionPackageKDFName         = "Argon2id"
	connectionPackageKDFNameV2       = "a2id"
	connectionPackageExtension       = ".gonavi-conn"

	connectionPackageProtectionAppManaged        = 1
	connectionPackageProtectionPasswordProtected = 2

	connectionPackageKDFDefaultMemoryKiB   = 65536
	connectionPackageKDFDefaultTimeCost    = 3
	connectionPackageKDFDefaultParallelism = 4

	connectionPackageKDFMaxMemoryKiB   = 262144
	connectionPackageKDFMaxTimeCost    = 10
	connectionPackageKDFMaxParallelism = 16

	connectionPackageMaxCiphertextBytes    = 16 * 1024 * 1024
	connectionPackageMaxPayloadBase64Bytes = ((connectionPackageMaxCiphertextBytes + 2) / 3) * 4
	connectionImportMaxFileBytes           = connectionPackageMaxPayloadBase64Bytes + (1 * 1024 * 1024)
)

var (
	errConnectionPackagePasswordRequired = errors.New("connection package password cannot be empty")
	errConnectionPackageDecryptFailed    = errors.New("file password is incorrect or the file is corrupted")
	errConnectionPackageUnsupported      = errors.New("unsupported connection package format")
	errConnectionImportFileTooLarge      = errors.New("connection import file is too large")
	errConnectionPackagePayloadTooLarge  = errors.New("connection package payload is too large")
	errConnectionPackageNotImplemented   = errors.New("connection package not implemented")
)

type connectionPackageTextFunc func(key string, params map[string]any) string

type localizedConnectionPackageError struct {
	message string
	cause   error
}

func (e localizedConnectionPackageError) Error() string {
	return e.message
}

func (e localizedConnectionPackageError) Unwrap() error {
	return e.cause
}

func localizedConnectionPackageText(text connectionPackageTextFunc, key string, params map[string]any) string {
	if text != nil {
		return text(key, params)
	}
	return defaultAppText(key, params)
}

func localizedConnectionPackageMessageKey(err error) (string, bool) {
	switch {
	case errors.Is(err, errConnectionPackagePasswordRequired):
		return "file.backend.error.connection_package_password_required", true
	case errors.Is(err, errConnectionPackageDecryptFailed):
		return "file.backend.error.connection_package_decrypt_failed", true
	case errors.Is(err, errConnectionPackageUnsupported):
		return "file.backend.error.connection_package_unsupported", true
	case errors.Is(err, errConnectionImportFileTooLarge):
		return "file.backend.error.connection_import_file_too_large", true
	case errors.Is(err, errConnectionPackagePayloadTooLarge):
		return "file.backend.error.connection_package_payload_too_large", true
	default:
		return "", false
	}
}

func localizedConnectionPackageMessage(text connectionPackageTextFunc, err error) string {
	if err == nil {
		return ""
	}
	key, ok := localizedConnectionPackageMessageKey(err)
	if !ok {
		return err.Error()
	}
	return localizedConnectionPackageText(text, key, nil)
}

func localizedConnectionPackageExportMessage(text connectionPackageTextFunc, err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, errConnectionImportFileTooLarge) {
		return localizedConnectionPackageText(text, "file.backend.error.connection_export_file_too_large", nil)
	}
	return localizedConnectionPackageMessage(text, err)
}

func localizeConnectionPackageError(text connectionPackageTextFunc, err error) error {
	if err == nil {
		return nil
	}
	if _, ok := localizedConnectionPackageMessageKey(err); !ok {
		return err
	}
	return localizedConnectionPackageError{
		message: localizedConnectionPackageMessage(text, err),
		cause:   err,
	}
}

type connectionPackageFile struct {
	SchemaVersion int                      `json:"schemaVersion"`
	Kind          string                   `json:"kind"`
	Cipher        string                   `json:"cipher"`
	KDF           connectionPackageKDFSpec `json:"kdf"`
	Nonce         string                   `json:"nonce"`
	Payload       string                   `json:"payload"`
}

type connectionPackageKDFSpec struct {
	Name        string `json:"name"`
	MemoryKiB   uint32 `json:"memoryKiB"`
	TimeCost    uint32 `json:"timeCost"`
	Parallelism uint8  `json:"parallelism"`
	Salt        string `json:"salt"`
}

type connectionPackageFileV2 struct {
	V              int                          `json:"v"`
	Kind           string                       `json:"kind"`
	P              int                          `json:"p"`
	ExportedAt     string                       `json:"exportedAt,omitempty"`
	Connections    []connectionPackageItem      `json:"connections"`
	RedisDbAliases map[string]map[string]string `json:"redisDbAliases,omitempty"`
}

type connectionPackageFileV2Protected struct {
	V    int                        `json:"v"`
	Kind string                     `json:"kind"`
	P    int                        `json:"p"`
	KDF  connectionPackageKDFSpecV2 `json:"kdf"`
	NC   string                     `json:"nc"`
	D    string                     `json:"d"`
}

type connectionPackageKDFSpecV2 struct {
	N string `json:"n"`
	M uint32 `json:"m"`
	T uint32 `json:"t"`
	L uint8  `json:"l"`
	S string `json:"s"`
}

type connectionPackagePayload struct {
	ExportedAt  string                  `json:"exportedAt,omitempty"`
	Connections []connectionPackageItem `json:"connections"`
	// RedisDbAliases：连接 ID → (db 序号字符串 → 别名)。前端展示偏好，随连接包一并迁移。
	RedisDbAliases map[string]map[string]string `json:"redisDbAliases,omitempty"`
}

type connectionPackageItem struct {
	ID                         string                                     `json:"id"`
	Name                       string                                     `json:"name"`
	EnvironmentType            string                                     `json:"environmentType,omitempty"`
	IncludeDatabases           []string                                   `json:"includeDatabases,omitempty"`
	IncludeDatabasePatterns    []string                                   `json:"includeDatabasePatterns,omitempty"`
	ExcludeDatabasePatterns    []string                                   `json:"excludeDatabasePatterns,omitempty"`
	IncludeRedisDatabases      []int                                      `json:"includeRedisDatabases,omitempty"`
	SchemaVisibilityByDatabase map[string]connection.SchemaVisibilityRule `json:"schemaVisibilityByDatabase,omitempty"`
	// RedisDbAliases：该连接下 db 序号 → 别名（如 "0"→"cache"），与前端 redisDbAliases 对齐。
	RedisDbAliases map[string]string           `json:"redisDbAliases,omitempty"`
	IconType       string                      `json:"iconType,omitempty"`
	IconColor      string                      `json:"iconColor,omitempty"`
	Config         connection.ConnectionConfig `json:"config"`
	Secrets        connectionSecretBundle      `json:"secrets,omitempty"`
}

func (i connectionPackageItem) MarshalJSON() ([]byte, error) {
	type connectionPackageItemJSON struct {
		ID                         string                                     `json:"id"`
		Name                       string                                     `json:"name"`
		EnvironmentType            string                                     `json:"environmentType,omitempty"`
		IncludeDatabases           []string                                   `json:"includeDatabases,omitempty"`
		IncludeDatabasePatterns    []string                                   `json:"includeDatabasePatterns,omitempty"`
		ExcludeDatabasePatterns    []string                                   `json:"excludeDatabasePatterns,omitempty"`
		IncludeRedisDatabases      []int                                      `json:"includeRedisDatabases,omitempty"`
		SchemaVisibilityByDatabase map[string]connection.SchemaVisibilityRule `json:"schemaVisibilityByDatabase,omitempty"`
		RedisDbAliases             map[string]string                          `json:"redisDbAliases,omitempty"`
		IconType                   string                                     `json:"iconType,omitempty"`
		IconColor                  string                                     `json:"iconColor,omitempty"`
		Config                     connection.ConnectionConfig                `json:"config"`
		Secrets                    *connectionSecretBundle                    `json:"secrets,omitempty"`
	}

	item := connectionPackageItemJSON{
		ID:                         i.ID,
		Name:                       i.Name,
		EnvironmentType:            i.EnvironmentType,
		IncludeDatabases:           i.IncludeDatabases,
		IncludeDatabasePatterns:    i.IncludeDatabasePatterns,
		ExcludeDatabasePatterns:    i.ExcludeDatabasePatterns,
		IncludeRedisDatabases:      i.IncludeRedisDatabases,
		SchemaVisibilityByDatabase: cloneSchemaVisibilityByDatabase(i.SchemaVisibilityByDatabase),
		RedisDbAliases:             cloneStringMap(i.RedisDbAliases),
		IconType:                   i.IconType,
		IconColor:                  i.IconColor,
		Config:                     i.Config,
	}
	if i.Secrets.hasAny() {
		secrets := i.Secrets
		item.Secrets = &secrets
	}
	return json.Marshal(item)
}

type ConnectionExportOptions struct {
	IncludeSecrets bool   `json:"includeSecrets"`
	FilePassword   string `json:"filePassword,omitempty"`
	// ConnectionIDs 可选：仅导出指定连接；为空时导出全部连接。
	ConnectionIDs []string `json:"connectionIds,omitempty"`
	// RedisDbAliases 由前端传入（appearance.redisDbAliases），导出时写入连接包。
	RedisDbAliases map[string]map[string]string `json:"redisDbAliases,omitempty"`
}

// ConnectionPackageImportResult 连接包导入结果；兼容仅返回 connections 数组的旧前端解析逻辑时，
// 新字段 redisDbAliases 可一并恢复 Redis DB 别名。
type ConnectionPackageImportResult struct {
	Connections    []connection.SavedConnectionView `json:"connections"`
	RedisDbAliases map[string]map[string]string     `json:"redisDbAliases,omitempty"`
}

func defaultConnectionPackageKDFSpec() connectionPackageKDFSpec {
	return connectionPackageKDFSpec{
		Name:        connectionPackageKDFName,
		MemoryKiB:   connectionPackageKDFDefaultMemoryKiB,
		TimeCost:    connectionPackageKDFDefaultTimeCost,
		Parallelism: connectionPackageKDFDefaultParallelism,
	}
}

func defaultConnectionPackageKDFSpecV2() connectionPackageKDFSpecV2 {
	return connectionPackageKDFSpecV2{
		N: connectionPackageKDFNameV2,
		M: connectionPackageKDFDefaultMemoryKiB,
		T: connectionPackageKDFDefaultTimeCost,
		L: connectionPackageKDFDefaultParallelism,
	}
}

func normalizeConnectionPackagePassword(password string) string {
	return strings.TrimSpace(password)
}
