package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func driverInstallDir(downloadDir string, driverType string) string {
	root, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		root = defaultDriverDownloadDirectory()
	}
	return filepath.Join(root, normalizeDriverType(driverType))
}

func installedDriverMetaPath(downloadDir string, driverType string) string {
	return filepath.Join(driverInstallDir(downloadDir, driverType), "installed.json")
}

func readInstalledDriverPackage(downloadDir string, driverType string) (installedDriverPackage, bool) {
	metaPath := installedDriverMetaPath(downloadDir, driverType)
	content, err := os.ReadFile(metaPath)
	if err != nil {
		return installedDriverPackage{}, false
	}
	var meta installedDriverPackage
	if err := json.Unmarshal(content, &meta); err != nil {
		return installedDriverPackage{}, false
	}
	meta.DriverType = normalizeDriverType(meta.DriverType)
	if strings.TrimSpace(meta.DriverType) == "" {
		meta.DriverType = normalizeDriverType(driverType)
	}
	return meta, true
}

func optionalDriverAgentRevisionCurrent(driverType string, executablePath string) (string, bool, error) {
	expected := strings.TrimSpace(db.OptionalDriverAgentRevision(driverType))
	if expected == "" {
		return "", true, nil
	}
	metadata, err := optionalDriverAgentMetadataProbe(driverType, executablePath)
	if err != nil {
		return "", false, fmt.Errorf("%w: %v", errOptionalDriverAgentMetadataUnavailable, err)
	}
	actual := strings.TrimSpace(metadata.AgentRevision)
	return actual, actual == expected, nil
}

func verifyInstalledOptionalDriverAgentRevision(driverType string, executablePath string, selectedVersion ...string) (string, error) {
	version := ""
	if len(selectedVersion) > 0 {
		version = selectedVersion[0]
	}
	if !shouldVerifyOptionalDriverAgentRevision(driverType, version) {
		return "", nil
	}
	expected := strings.TrimSpace(db.OptionalDriverAgentRevision(driverType))
	actual, current, err := optionalDriverAgentRevisionCurrent(driverType, executablePath)
	if expected == "" {
		return actual, nil
	}
	displayName := resolveDriverDisplayName(driverDefinition{Type: driverType})
	if err != nil {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.agent_metadata_unavailable", map[string]any{"name": displayName}, err)
	}
	if !current {
		actualLabel := strings.TrimSpace(actual)
		if actualLabel == "" {
			return "", newLocalizedDriverBackendError("driver_manager.backend.error.agent_revision_mismatch_empty_actual", map[string]any{
				"name":     displayName,
				"expected": expected,
			}, nil)
		}
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.agent_revision_mismatch", map[string]any{
			"name":     displayName,
			"actual":   actualLabel,
			"expected": expected,
		}, nil)
	}
	return actual, nil
}

func shouldVerifyOptionalDriverAgentRevision(driverType string, selectedVersion string) bool {
	switch normalizeDriverType(driverType) {
	case "mongodb":
		return resolveMongoDriverMajorFromVersion(selectedVersion) != 1
	default:
		return true
	}
}

func (a *App) savedConnectionDriverUsageCounts() map[string]int {
	counts := map[string]int{}
	if a == nil || strings.TrimSpace(a.configDir) == "" {
		return counts
	}
	items, err := a.savedConnectionRepository().List()
	if err != nil {
		logger.Warnf("统计驱动连接使用数失败：%v", err)
		return counts
	}
	for _, item := range items {
		driverType := normalizeDriverType(item.Config.Type)
		if driverType == "custom" {
			driverType = normalizeDriverType(item.Config.Driver)
		}
		if driverType == "" || !db.IsOptionalGoDriver(driverType) {
			continue
		}
		counts[driverType]++
	}
	return counts
}

func writeInstalledDriverPackage(downloadDir string, driverType string, meta installedDriverPackage) error {
	driverDir := driverInstallDir(downloadDir, driverType)
	if err := os.MkdirAll(driverDir, 0o755); err != nil {
		return newLocalizedDriverBackendError("driver_manager.backend.error.create_directory_failed", nil, err)
	}
	meta.DriverType = normalizeDriverType(driverType)
	if meta.DownloadedAt == "" {
		meta.DownloadedAt = time.Now().Format(time.RFC3339)
	}
	payload, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return newLocalizedDriverBackendError("driver_manager.backend.error.metadata_payload_encode_failed", nil, err)
	}
	if err := os.WriteFile(installedDriverMetaPath(downloadDir, driverType), payload, 0o644); err != nil {
		return newLocalizedDriverBackendError("driver_manager.backend.error.metadata_file_write_failed", nil, err)
	}
	return nil
}

func hashFileSHA256(filePath string) (string, error) {
	pathText := strings.TrimSpace(filePath)
	if pathText == "" {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.file_path_empty", nil, nil)
	}
	file, err := os.Open(pathText)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}
