package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
)

func emptySavedQueriesFile() savedQueriesFile {
	return savedQueriesFile{
		Queries:   []connection.SavedQuery{},
		Groups:    []connection.SavedQueryGroup{},
		FileNames: map[string]string{},
	}
}

func savedQueryFromDiskRecord(record savedQueryDiskRecord, sqlText string) connection.SavedQuery {
	return connection.SavedQuery{
		ID:                    record.ID,
		Name:                  record.Name,
		SQL:                   sqlText,
		ConnectionID:          record.ConnectionID,
		DBName:                record.DBName,
		CreatedAt:             record.CreatedAt,
		ConnectionFingerprint: record.ConnectionFingerprint,
		FingerprintVersion:    record.FingerprintVersion,
		BindingStatus:         record.BindingStatus,
		OriginalConnectionID:  record.OriginalConnectionID,
		Parameters:            record.Parameters,
	}
}

func savedQueryToDiskRecord(query connection.SavedQuery, fileName string) savedQueryDiskRecord {
	return savedQueryDiskRecord{
		ID:                    query.ID,
		Name:                  query.Name,
		FileName:              fileName,
		ConnectionID:          query.ConnectionID,
		DBName:                query.DBName,
		CreatedAt:             query.CreatedAt,
		ConnectionFingerprint: query.ConnectionFingerprint,
		FingerprintVersion:    query.FingerprintVersion,
		BindingStatus:         query.BindingStatus,
		OriginalConnectionID:  query.OriginalConnectionID,
		Parameters:            query.Parameters,
	}
}

func normalizeSavedQueryDiskFileName(fileName string) (string, error) {
	name := strings.TrimSpace(fileName)
	if name == "" || filepath.Base(name) != name || strings.ContainsAny(name, `/\`) {
		return "", fmt.Errorf("saved query has an invalid sql file name: %q", fileName)
	}
	if !strings.EqualFold(filepath.Ext(name), ".sql") {
		return "", fmt.Errorf("saved query sql file must use the .sql extension: %q", fileName)
	}
	return name, nil
}

func trimSavedQueryFileBase(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	end := 0
	for index := range value {
		if index > maxBytes {
			break
		}
		end = index
	}
	if end == 0 {
		_, size := utf8.DecodeRuneInString(value)
		if size <= maxBytes {
			end = size
		}
	}
	return strings.TrimSpace(value[:end])
}

func buildSavedQuerySQLFileBase(name string) string {
	base := strings.TrimSpace(name)
	if strings.EqualFold(filepath.Ext(base), ".sql") {
		base = strings.TrimSpace(base[:len(base)-len(filepath.Ext(base))])
	}
	base = strings.Map(func(value rune) rune {
		if value < 0x20 || strings.ContainsRune(`<>:"/\|?*`, value) {
			return '_'
		}
		return value
	}, base)
	base = strings.Trim(base, " .")
	base = trimSavedQueryFileBase(base, 120)
	if base == "" {
		base = "query"
	}
	return base
}

func savedQuerySQLFileNameKey(fileName string) string {
	return strings.ToLower(strings.TrimSpace(fileName))
}

func allocateSavedQuerySQLFileName(name string, unavailable map[string]struct{}) string {
	base := buildSavedQuerySQLFileBase(name)
	for suffix := 1; ; suffix++ {
		candidate := base + ".sql"
		if suffix > 1 {
			candidate = fmt.Sprintf("%s (%d).sql", base, suffix)
		}
		key := savedQuerySQLFileNameKey(candidate)
		if _, exists := unavailable[key]; exists {
			continue
		}
		unavailable[key] = struct{}{}
		return candidate
	}
}

func listSavedQueryDirectoryFileNames(directory string) (map[string]struct{}, error) {
	fileNames := make(map[string]struct{})
	entries, err := os.ReadDir(directory)
	if err != nil {
		if os.IsNotExist(err) {
			return fileNames, nil
		}
		return nil, err
	}
	for _, entry := range entries {
		fileNames[savedQuerySQLFileNameKey(entry.Name())] = struct{}{}
	}
	return fileNames, nil
}

func (r *savedQueryRepository) hydrateDiskFile(diskFile savedQueriesDiskFile) (savedQueriesFile, error) {
	directory, err := r.sqlDirectory()
	if err != nil {
		return savedQueriesFile{}, err
	}
	file := emptySavedQueriesFile()
	file.Groups = diskFile.Groups
	migrated := diskFile.Version < savedQueriesFormatVersion
	unavailable, err := listSavedQueryDirectoryFileNames(directory)
	if err != nil {
		return savedQueriesFile{}, err
	}
	mutations := make([]savedQuerySQLMutation, 0)
	oldPaths := make([]string, 0, len(diskFile.Queries))
	seenQueryIDs := make(map[string]struct{}, len(diskFile.Queries))
	rollback := func(cause error) (savedQueriesFile, error) {
		return savedQueriesFile{}, errors.Join(cause, rollbackSavedQuerySQLMutations(mutations))
	}

	for index, record := range diskFile.Queries {
		recordID := strings.TrimSpace(record.ID)
		if recordID == "" {
			migrated = true
			continue
		}
		if _, exists := seenQueryIDs[recordID]; exists {
			migrated = true
			continue
		}
		seenQueryIDs[recordID] = struct{}{}
		if record.LegacySQL != "" {
			migrated = true
		}
		oldFileName := strings.TrimSpace(record.FileName)
		content := []byte(record.LegacySQL)
		if oldFileName != "" {
			oldFileName, err = normalizeSavedQueryDiskFileName(oldFileName)
			if err != nil {
				return rollback(err)
			}
			oldPath := filepath.Join(directory, oldFileName)
			content, err = os.ReadFile(oldPath)
			if err != nil {
				if os.IsNotExist(err) {
					// The referenced SQL file is gone (manually deleted,
					// moved by the user, or lost during an interrupted
					// migration). The disk record is an orphan: its content
					// cannot be recovered. Skip it instead of failing the
					// whole saved-queries load — a hard failure here blocks
					// app startup and, critically, the quit/update flow
					// ("check unsaved SQL" runs the same load).
					migrated = true
					continue
				}
				return rollback(fmt.Errorf("read saved query sql file %s: %w", oldFileName, err))
			}
			oldPaths = append(oldPaths, oldPath)
		}
		query, ok := sanitizeSavedQuery(savedQueryFromDiskRecord(record, string(content)), index, false)
		if !ok {
			if oldFileName == "" {
				migrated = true
				continue
			}
			return rollback(fmt.Errorf("saved query is invalid: %s", strings.TrimSpace(record.ID)))
		}

		fileName := oldFileName
		if diskFile.Version < savedQueriesFormatVersion || fileName == "" {
			oldKey := savedQuerySQLFileNameKey(oldFileName)
			if oldKey != "" {
				delete(unavailable, oldKey)
			}
			fileName = allocateSavedQuerySQLFileName(query.Name, unavailable)
			if oldKey != "" && savedQuerySQLFileNameKey(fileName) != oldKey {
				unavailable[oldKey] = struct{}{}
			}
			migrated = true
		} else {
			fileName, err = normalizeSavedQueryDiskFileName(fileName)
			if err != nil {
				return rollback(err)
			}
		}

		targetPath := filepath.Join(directory, fileName)
		if oldFileName == "" || !savedQueryPathsReferToSameFile(filepath.Join(directory, oldFileName), targetPath) {
			previous, readErr := os.ReadFile(targetPath)
			if readErr != nil && !os.IsNotExist(readErr) {
				return rollback(readErr)
			}
			if readErr == nil && string(previous) != string(content) {
				return rollback(fmt.Errorf("saved query migration target already exists: %s", targetPath))
			}
			if os.IsNotExist(readErr) {
				mutation := savedQuerySQLMutation{path: targetPath}
				if err := writeSavedQuerySQLFileAtomic(targetPath, content); err != nil {
					return rollback(err)
				}
				mutations = append(mutations, mutation)
			}
		}
		record.FileName = fileName
		record.LegacySQL = ""
		diskFile.Queries[index] = record
		file.Queries = append(file.Queries, query)
		file.FileNames[query.ID] = fileName
	}

	file = normalizeSavedQueriesFile(file)
	if migrated {
		diskFile = buildSavedQueriesDiskFile(file)
		if err := r.saveDiskFile(diskFile); err != nil {
			return rollback(err)
		}
		referencedPaths := make([]string, 0, len(file.FileNames))
		for _, fileName := range file.FileNames {
			referencedPaths = append(referencedPaths, filepath.Join(directory, fileName))
		}
		for _, oldPath := range oldPaths {
			referenced := false
			for _, targetPath := range referencedPaths {
				if savedQueryPathsReferToSameFile(oldPath, targetPath) {
					referenced = true
					break
				}
			}
			if !referenced {
				_ = os.Remove(oldPath)
			}
		}
	}
	return file, nil
}

func buildSavedQueriesDiskFile(file savedQueriesFile) savedQueriesDiskFile {
	file = normalizeSavedQueriesFile(file)
	records := make([]savedQueryDiskRecord, 0, len(file.Queries))
	for _, query := range file.Queries {
		records = append(records, savedQueryToDiskRecord(query, file.FileNames[query.ID]))
	}
	return savedQueriesDiskFile{
		Version: savedQueriesFormatVersion,
		Queries: records,
		Groups:  file.Groups,
	}
}

func (r *savedQueryRepository) saveDiskFile(file savedQueriesDiskFile) error {
	if err := os.MkdirAll(r.configDir, 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	return writeSavedQueriesMetadataAtomic(r.queriesPath(), payload)
}

func (r *savedQueryRepository) saveMetadataFile(file savedQueriesFile) error {
	return r.saveDiskFile(buildSavedQueriesDiskFile(file))
}
