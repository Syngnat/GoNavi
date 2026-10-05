package app

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/dailysecret"

	"github.com/google/uuid"
)

func (a *App) captureCloudBackupConnectionFilesSnapshot() (cloudBackupConnectionFilesSnapshot, error) {
	repo := a.savedConnectionRepository()
	var snapshot cloudBackupConnectionFilesSnapshot
	err := repo.withWriteLock(func() error {
		var captureErr error
		snapshot, captureErr = captureCloudBackupConnectionFilesSnapshotUnlocked(repo)
		return captureErr
	})
	return snapshot, err
}

func captureCloudBackupConnectionFilesSnapshotUnlocked(repo *savedConnectionRepository) (cloudBackupConnectionFilesSnapshot, error) {
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
	snapshot.connectionSidebarLayout, err = captureConnectionSidebarLayoutSnapshotUnlocked(
		newConnectionSidebarLayoutRepository(repo.configDir),
	)
	if err != nil {
		return cloudBackupConnectionFilesSnapshot{}, err
	}
	return snapshot, nil
}

func (snapshot cloudBackupConnectionFilesSnapshot) restore(a *App) error {
	repo := a.savedConnectionRepository()
	return repo.withWriteLock(func() error {
		return snapshot.restoreUnlocked(repo)
	})
}

func (snapshot cloudBackupConnectionFilesSnapshot) restoreUnlocked(repo *savedConnectionRepository) error {
	return errors.Join(
		restoreCloudBackupOptionalFile(repo.connectionsPath(), snapshot.connectionsExists, snapshot.connectionsData, 0o644),
		restoreCloudBackupOptionalFile(repo.dailySecrets().Path(), snapshot.dailySecretsExists, snapshot.dailySecretsData, 0o600),
		snapshot.connectionSidebarLayout.restoreUnlocked(newConnectionSidebarLayoutRepository(repo.configDir)),
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
	if !cloudBackupFilesTouchSavedConnectionState(files) {
		return a.restoreCloudBackupFilesUnlocked(files)
	}

	repo := a.savedConnectionRepository()
	var rollbackUnlocked func() error
	err := repo.withWriteLock(func() error {
		var restoreErr error
		rollbackUnlocked, restoreErr = a.restoreCloudBackupFilesUnlocked(files)
		return restoreErr
	})
	if err != nil {
		return nil, err
	}
	return func() error {
		return repo.withWriteLock(rollbackUnlocked)
	}, nil
}

func cloudBackupFilesTouchSavedConnectionState(files []cloudBackupFile) bool {
	for _, file := range files {
		if filepath.Clean(filepath.FromSlash(file.Path)) == "daily_secrets.json" {
			return true
		}
	}
	return false
}

func (a *App) restoreCloudBackupFilesUnlocked(files []cloudBackupFile) (func() error, error) {
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
