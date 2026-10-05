package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/cloudbackup"
	"GoNavi-Wails/internal/connection"
)

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

	if err := a.consumeCloudBackupRestoreConfirmationToken(request.ConfirmationToken, payload); err != nil {
		return CloudBackupRestorePreview{}, err
	}

	repo := a.savedConnectionRepository()
	layoutRepo := a.connectionSidebarLayoutRepository()
	restoreMutations := func() error {
		filesToRestore := append([]cloudBackupFile(nil), settingsFiles...)
		var connectionSnapshot cloudBackupConnectionFilesSnapshot
		if restoreConnections {
			var snapshotErr error
			connectionSnapshot, snapshotErr = captureCloudBackupConnectionFilesSnapshotUnlocked(repo)
			if snapshotErr != nil {
				return snapshotErr
			}
			filesToRestore, snapshotErr = a.preserveLocalOnlyConnectionSecrets(filesToRestore, payload.Connections)
			if snapshotErr != nil {
				return snapshotErr
			}
		}

		rollbackSettings := func() error { return nil }
		if len(filesToRestore) > 0 {
			var restoreErr error
			rollbackSettings, restoreErr = a.restoreCloudBackupFilesUnlocked(filesToRestore)
			if restoreErr != nil {
				return restoreErr
			}
		}
		rollbackMutations := func() error {
			var rollbackErr error
			if restoreConnections {
				rollbackErr = errors.Join(rollbackErr, connectionSnapshot.restoreUnlocked(repo))
			}
			return errors.Join(rollbackErr, rollbackSettings())
		}

		if restoreConnections {
			if _, importErr := a.importConnectionPackagePayloadUnlocked(repo, payload.Connections); importErr != nil {
				if rollbackErr := rollbackMutations(); rollbackErr != nil {
					return fmt.Errorf("restore connections failed: %w (rollback failed: %v)", importErr, rollbackErr)
				}
				return importErr
			}
			if payload.ConnectionSidebarLayout != nil {
				_, replaceErr := layoutRepo.replaceUnlocked(connection.ConnectionSidebarLayoutInput{
					ConnectionTags:         payload.ConnectionSidebarLayout.ConnectionTags,
					SidebarRootOrder:       payload.ConnectionSidebarLayout.SidebarRootOrder,
					RootSortMode:           payload.ConnectionSidebarLayout.RootSortMode,
					RootConnectionSortMode: payload.ConnectionSidebarLayout.RootConnectionSortMode,
				})
				if replaceErr != nil {
					if rollbackErr := rollbackMutations(); rollbackErr != nil {
						return fmt.Errorf("restore connection sidebar layout failed: %w (rollback failed: %v)", replaceErr, rollbackErr)
					}
					return fmt.Errorf("restore connection sidebar layout: %w", replaceErr)
				}
			}
		}
		if len(savedQueryFiles) > 0 {
			currentConnections, listErr := repo.List()
			if listErr != nil {
				if rollbackErr := rollbackMutations(); rollbackErr != nil {
					return fmt.Errorf("restore saved queries failed: %w (rollback failed: %v)", listErr, rollbackErr)
				}
				return listErr
			}
			if _, importErr := a.savedQueryRepository().Import(savedQueryPayload, currentConnections); importErr != nil {
				if rollbackErr := rollbackMutations(); rollbackErr != nil {
					return fmt.Errorf("restore saved queries failed: %w (rollback failed: %v)", importErr, rollbackErr)
				}
				return importErr
			}
		}
		return nil
	}

	if restoreConnections || cloudBackupFilesTouchSavedConnectionState(settingsFiles) {
		err = repo.withWriteLock(restoreMutations)
	} else {
		err = restoreMutations()
	}
	if err != nil {
		return CloudBackupRestorePreview{}, err
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
			if category.ItemCount == 0 && payload.ConnectionSidebarLayout == nil {
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
