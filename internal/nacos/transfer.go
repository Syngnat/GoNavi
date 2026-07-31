package nacos

import (
	"encoding/json"
	"os"
	"strings"
	"time"
)

const (
	TransferFileFormat  = "gonavi.nacos.configs"
	TransferFileVersion = 1
)

// NewTransferFile builds an export payload shell.
func NewTransferFile(namespaceID, namespaceName string) TransferFile {
	return TransferFile{
		Format:        TransferFileFormat,
		Version:       TransferFileVersion,
		ExportedAt:    time.Now().UTC().Format(time.RFC3339),
		NamespaceID:   normalizeNamespaceID(namespaceID),
		NamespaceName: strings.TrimSpace(namespaceName),
		SourceAppName: "GoNavi",
		Configs:       []TransferConfigEntry{},
	}
}

// ValidateTransferFile checks import payload structure.
func ValidateTransferFile(payload TransferFile) error {
	if strings.TrimSpace(payload.Format) != TransferFileFormat {
		return localizedNacosBackendError("nacos.backend.error.import_format_invalid", map[string]any{
			"format": payload.Format,
		})
	}
	if payload.Version <= 0 || payload.Version > TransferFileVersion {
		return localizedNacosBackendError("nacos.backend.error.import_version_invalid", map[string]any{
			"version": payload.Version,
		})
	}
	if len(payload.Configs) == 0 {
		return localizedNacosBackendError("nacos.backend.error.import_empty", nil)
	}
	for i, item := range payload.Configs {
		if strings.TrimSpace(item.DataID) == "" {
			return localizedNacosBackendError("nacos.backend.error.import_item_invalid", map[string]any{
				"index": i,
			})
		}
	}
	return nil
}

// ReadTransferFile loads a transfer JSON file from disk.
func ReadTransferFile(path string) (TransferFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return TransferFile{}, err
	}
	var payload TransferFile
	if err := json.Unmarshal(raw, &payload); err != nil {
		return TransferFile{}, err
	}
	if err := ValidateTransferFile(payload); err != nil {
		return TransferFile{}, err
	}
	// normalize groups
	for i := range payload.Configs {
		if strings.TrimSpace(payload.Configs[i].Group) == "" {
			payload.Configs[i].Group = "DEFAULT_GROUP"
		}
		payload.Configs[i].DataID = strings.TrimSpace(payload.Configs[i].DataID)
		payload.Configs[i].Group = strings.TrimSpace(payload.Configs[i].Group)
	}
	return payload, nil
}

// WriteTransferFile writes payload as pretty JSON.
func WriteTransferFile(path string, payload TransferFile) error {
	if strings.TrimSpace(payload.Format) == "" {
		payload.Format = TransferFileFormat
	}
	if payload.Version <= 0 {
		payload.Version = TransferFileVersion
	}
	if strings.TrimSpace(payload.ExportedAt) == "" {
		payload.ExportedAt = time.Now().UTC().Format(time.RFC3339)
	}
	content, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, content, 0o644)
}
