package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"github.com/google/uuid"
)

const (
	savedQueriesFileName      = "saved_queries.json"
	savedQueriesFormatVersion = 3
)

const (
	savedQueryGroupTokenPrefix = "group:"
	savedQueryTokenPrefix      = "query:"
)

var savedQueriesMu sync.Mutex

var writeSavedQueriesMetadataAtomic = writeSavedQueriesFileAtomic

type savedQueriesFile struct {
	Queries   []connection.SavedQuery
	Groups    []connection.SavedQueryGroup
	FileNames map[string]string
}

// savedQueryDiskRecord deliberately excludes SQL from the current on-disk
// format. LegacySQL is read only so older saved_queries.json files can be
// migrated without losing content.
type savedQueryDiskRecord struct {
	ID                    string `json:"id"`
	Name                  string `json:"name"`
	FileName              string `json:"fileName,omitempty"`
	LegacySQL             string `json:"sql,omitempty"`
	ConnectionID          string `json:"connectionId"`
	DBName                string `json:"dbName"`
	CreatedAt             int64  `json:"createdAt"`
	ConnectionFingerprint string `json:"connectionFingerprint,omitempty"`
	FingerprintVersion    string `json:"fingerprintVersion,omitempty"`
	BindingStatus         string `json:"bindingStatus,omitempty"`
	OriginalConnectionID  string `json:"originalConnectionId,omitempty"`
}

type savedQueriesDiskFile struct {
	Version int                          `json:"version,omitempty"`
	Queries []savedQueryDiskRecord       `json:"queries"`
	Groups  []connection.SavedQueryGroup `json:"groups,omitempty"`
}

type savedQueryRepository struct {
	configDir string
}

func newSavedQueryRepository(configDir string) *savedQueryRepository {
	if strings.TrimSpace(configDir) == "" {
		configDir = resolveAppConfigDir()
	}
	return &savedQueryRepository{configDir: configDir}
}

func (r *savedQueryRepository) queriesPath() string {
	return filepath.Join(r.configDir, savedQueriesFileName)
}

func (r *savedQueryRepository) sqlDirectory() (string, error) {
	return appdata.ResolveSavedQueryDirectory(r.configDir)
}

func (r *savedQueryRepository) loadFile() (savedQueriesFile, error) {
	data, err := os.ReadFile(r.queriesPath())
	if err != nil {
		if os.IsNotExist(err) {
			return emptySavedQueriesFile(), nil
		}
		return savedQueriesFile{}, err
	}

	var diskFile savedQueriesDiskFile
	if err := json.Unmarshal(data, &diskFile); err != nil {
		return savedQueriesFile{}, err
	}
	return r.hydrateDiskFile(diskFile)
}

func (r *savedQueryRepository) load() ([]connection.SavedQuery, error) {
	file, err := r.loadFile()
	if err != nil {
		return nil, err
	}
	return file.Queries, nil
}

func (r *savedQueryRepository) loadGroups() ([]connection.SavedQueryGroup, error) {
	file, err := r.loadFile()
	if err != nil {
		return nil, err
	}
	return file.Groups, nil
}

func (r *savedQueryRepository) findSQLPath(id string) (string, bool, error) {
	targetID := strings.TrimSpace(id)
	if targetID == "" {
		return "", false, nil
	}
	payload, err := os.ReadFile(r.queriesPath())
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	var diskFile savedQueriesDiskFile
	if err := json.Unmarshal(payload, &diskFile); err != nil {
		return "", false, err
	}

	fileName := ""
	for _, record := range diskFile.Queries {
		if strings.TrimSpace(record.ID) != targetID {
			continue
		}
		fileName = strings.TrimSpace(record.FileName)
		if diskFile.Version < savedQueriesFormatVersion || fileName == "" || record.LegacySQL != "" {
			hydrated, err := r.hydrateDiskFile(diskFile)
			if err != nil {
				return "", false, err
			}
			fileName = hydrated.FileNames[targetID]
		}
		break
	}
	if fileName == "" {
		return "", false, nil
	}
	fileName, err = normalizeSavedQueryDiskFileName(fileName)
	if err != nil {
		return "", false, err
	}
	directory, err := r.sqlDirectory()
	if err != nil {
		return "", false, err
	}
	return filepath.Join(directory, fileName), true, nil
}

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

type savedQuerySQLMutation struct {
	path     string
	previous []byte
	existed  bool
}

func rollbackSavedQuerySQLMutations(mutations []savedQuerySQLMutation) error {
	var rollbackErr error
	for index := len(mutations) - 1; index >= 0; index-- {
		mutation := mutations[index]
		if mutation.existed {
			rollbackErr = errors.Join(rollbackErr, writeSavedQuerySQLFileAtomic(mutation.path, mutation.previous))
			continue
		}
		if err := os.Remove(mutation.path); err != nil && !os.IsNotExist(err) {
			rollbackErr = errors.Join(rollbackErr, err)
		}
	}
	return rollbackErr
}

func savedQueryPathsReferToSameFile(left string, right string) bool {
	if filepath.Clean(left) == filepath.Clean(right) {
		return true
	}
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	return leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo)
}

func (r *savedQueryRepository) replaceQueries(current savedQueriesFile, queries []connection.SavedQuery) error {
	directory, err := r.sqlDirectory()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}

	next := savedQueriesFile{
		Queries:   sanitizeSavedQueries(queries),
		Groups:    append([]connection.SavedQueryGroup(nil), current.Groups...),
		FileNames: make(map[string]string, len(queries)),
	}
	currentByID := make(map[string]connection.SavedQuery, len(current.Queries))
	for _, query := range current.Queries {
		currentByID[query.ID] = query
	}
	unavailable, err := listSavedQueryDirectoryFileNames(directory)
	if err != nil {
		return err
	}
	for _, query := range next.Queries {
		previous, existed := currentByID[query.ID]
		if existed && previous.Name == query.Name {
			fileName, normalizeErr := normalizeSavedQueryDiskFileName(current.FileNames[query.ID])
			if normalizeErr != nil {
				return normalizeErr
			}
			next.FileNames[query.ID] = fileName
			continue
		}

		oldFileName := ""
		if existed {
			oldFileName = current.FileNames[query.ID]
			delete(unavailable, savedQuerySQLFileNameKey(oldFileName))
		}
		fileName := allocateSavedQuerySQLFileName(query.Name, unavailable)
		next.FileNames[query.ID] = fileName
		if oldFileName != "" && savedQuerySQLFileNameKey(fileName) != savedQuerySQLFileNameKey(oldFileName) {
			unavailable[savedQuerySQLFileNameKey(oldFileName)] = struct{}{}
		}
	}

	mutations := make([]savedQuerySQLMutation, 0, len(next.Queries))
	rollback := func(cause error) error {
		return errors.Join(cause, rollbackSavedQuerySQLMutations(mutations))
	}
	for _, query := range next.Queries {
		previous, existed := currentByID[query.ID]
		fileName := next.FileNames[query.ID]
		fileName, err = normalizeSavedQueryDiskFileName(fileName)
		if err != nil {
			return rollback(err)
		}
		next.FileNames[query.ID] = fileName
		targetPath := filepath.Join(directory, fileName)
		previousPath := ""
		if existed {
			previousPath = filepath.Join(directory, current.FileNames[query.ID])
		}

		if existed && savedQueryPathsReferToSameFile(previousPath, targetPath) && previous.SQL == query.SQL {
			continue
		}
		priorContent, readErr := os.ReadFile(targetPath)
		if readErr != nil && !os.IsNotExist(readErr) {
			return rollback(readErr)
		}
		if !existed || !savedQueryPathsReferToSameFile(previousPath, targetPath) {
			if readErr == nil && string(priorContent) != query.SQL {
				return rollback(fmt.Errorf("saved query sql target already exists: %s", targetPath))
			}
		}
		if readErr == nil && string(priorContent) == query.SQL {
			continue
		}
		mutation := savedQuerySQLMutation{path: targetPath}
		if readErr == nil {
			mutation.existed = true
			mutation.previous = priorContent
		}
		if err := writeSavedQuerySQLFileAtomic(targetPath, []byte(query.SQL)); err != nil {
			return rollback(err)
		}
		mutations = append(mutations, mutation)
	}

	next = normalizeSavedQueriesFile(next)
	if err := r.saveMetadataFile(next); err != nil {
		return rollback(err)
	}

	referencedPaths := make(map[string]struct{}, len(next.FileNames))
	for _, fileName := range next.FileNames {
		referencedPaths[filepath.Clean(filepath.Join(directory, fileName))] = struct{}{}
	}
	for queryID, fileName := range current.FileNames {
		oldPath := filepath.Clean(filepath.Join(directory, fileName))
		if _, stillReferenced := referencedPaths[oldPath]; stillReferenced {
			continue
		}
		if nextName, exists := next.FileNames[queryID]; exists {
			newPath := filepath.Join(directory, nextName)
			if savedQueryPathsReferToSameFile(oldPath, newPath) {
				continue
			}
		}
		_ = os.Remove(oldPath)
	}
	return nil
}

// saveAll remains available to callers that only replace query content. It
// loads and carries forward saved-query groups instead of silently dropping
// the new metadata.
func (r *savedQueryRepository) saveAll(queries []connection.SavedQuery) error {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	file, err := r.loadFile()
	if err != nil {
		return err
	}
	return r.replaceQueries(file, queries)
}

func writeSavedQuerySQLFileAtomic(targetPath string, payload []byte) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if info, err := os.Stat(targetPath); err == nil {
		if info.IsDir() {
			return fmt.Errorf("saved query sql path is a directory: %s", targetPath)
		}
		mode = info.Mode().Perm()
	} else if !os.IsNotExist(err) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(targetPath), ".saved_query_*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := replaceSavedQueryTempFile(tempPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func replaceSavedQueryTempFile(tempPath string, targetPath string) error {
	renameErr := os.Rename(tempPath, targetPath)
	if renameErr == nil {
		return nil
	}
	if _, err := os.Stat(targetPath); err != nil {
		return renameErr
	}
	backup, err := os.CreateTemp(filepath.Dir(targetPath), ".saved_query_backup_*.tmp")
	if err != nil {
		return errors.Join(renameErr, err)
	}
	backupPath := backup.Name()
	if err := backup.Close(); err != nil {
		_ = os.Remove(backupPath)
		return errors.Join(renameErr, err)
	}
	if err := os.Remove(backupPath); err != nil {
		return errors.Join(renameErr, err)
	}
	if err := os.Rename(targetPath, backupPath); err != nil {
		return errors.Join(renameErr, err)
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		return errors.Join(err, os.Rename(backupPath, targetPath))
	}
	_ = os.Remove(backupPath)
	return nil
}

func writeSavedQueriesFileAtomic(targetPath string, payload []byte) error {
	dir := filepath.Dir(targetPath)
	temp, err := os.CreateTemp(dir, ".saved_queries_*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()

	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tempPath, 0o644); err != nil {
		return err
	}
	if err := replaceSavedQueryTempFile(tempPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func (r *savedQueryRepository) Save(input connection.SavedQuery) (connection.SavedQuery, error) {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	query, ok := sanitizeSavedQuery(input, 0, true)
	if !ok {
		return connection.SavedQuery{}, fmt.Errorf("saved query requires sql, connectionId and dbName")
	}

	file, err := r.loadFile()
	if err != nil {
		return connection.SavedQuery{}, err
	}
	queries := append([]connection.SavedQuery(nil), file.Queries...)

	replaced := false
	for index, item := range queries {
		if item.ID == query.ID {
			queries[index] = query
			replaced = true
			break
		}
	}
	if !replaced {
		queries = append(queries, query)
	}
	if err := r.replaceQueries(file, queries); err != nil {
		return connection.SavedQuery{}, err
	}
	return query, nil
}

func (r *savedQueryRepository) Import(payload connection.SavedQueryImportPayload, currentConnections []connection.SavedConnectionView) ([]connection.SavedQuery, error) {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	file, err := r.loadFile()
	if err != nil {
		return nil, err
	}
	// 必须复制而不能直接引用 file.Queries：下面对 existing 的下标原地写会共享同一底层数组，
	// 使 replaceQueries 拿到的「磁盘旧快照」也被改成新值，于是它比较 previous.SQL == query.SQL
	// 时成立而跳过写盘——同 ID 同名条目的 SQL 更新会被静默丢弃（元数据已更新、.sql 文件仍是旧内容）。
	// Save(716) 与 Rename(858) 都是这样复制的。
	existing := append([]connection.SavedQuery(nil), file.Queries...)

	byID := make(map[string]int, len(existing)+len(payload.Queries))
	for index, item := range existing {
		byID[item.ID] = index
	}

	imported := resolveSavedQueryBindings(payload.Queries, currentConnections, payload.LegacyConnections)
	for index, item := range imported {
		query, ok := sanitizeSavedQuery(item, index, true)
		if !ok {
			continue
		}
		if existingIndex, found := byID[query.ID]; found {
			existing[existingIndex] = query
			continue
		}
		byID[query.ID] = len(existing)
		existing = append(existing, query)
	}

	if payload.Groups != nil {
		if err := validateSavedQueryGroupsQueryIDs(payload.Groups, existing); err != nil {
			return nil, err
		}
		file.Groups = mergeSavedQueryGroups(file.Groups, payload.Groups)
	}
	if err := r.replaceQueries(file, existing); err != nil {
		return nil, err
	}
	return sanitizeSavedQueries(existing), nil
}

func (r *savedQueryRepository) Rebind(id string, target connection.SavedConnectionView) (connection.SavedQuery, error) {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	targetID := strings.TrimSpace(id)
	if targetID == "" || strings.TrimSpace(target.ID) == "" {
		return connection.SavedQuery{}, fmt.Errorf("saved query and target connection are required")
	}

	file, err := r.loadFile()
	if err != nil {
		return connection.SavedQuery{}, err
	}
	queries := file.Queries

	for index, item := range queries {
		if item.ID != targetID {
			continue
		}
		if strings.TrimSpace(item.OriginalConnectionID) == "" && strings.TrimSpace(item.ConnectionID) != strings.TrimSpace(target.ID) {
			item.OriginalConnectionID = item.ConnectionID
		}
		item.ConnectionID = target.ID
		item = applySavedQueryActiveBinding(item, target)
		query, ok := sanitizeSavedQuery(item, index, false)
		if !ok {
			return connection.SavedQuery{}, fmt.Errorf("saved query is invalid: %s", targetID)
		}
		queries[index] = query
		file.Queries = queries
		if err := r.saveMetadataFile(file); err != nil {
			return connection.SavedQuery{}, err
		}
		return query, nil
	}

	return connection.SavedQuery{}, fmt.Errorf("saved query not found: %s", targetID)
}

func (r *savedQueryRepository) Delete(id string) error {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	targetID := strings.TrimSpace(id)
	if targetID == "" {
		return nil
	}

	file, err := r.loadFile()
	if err != nil {
		return err
	}
	queries := file.Queries
	filtered := queries[:0]
	for _, item := range queries {
		if item.ID != targetID {
			filtered = append(filtered, item)
		}
	}
	return r.replaceQueries(file, filtered)
}

func (r *savedQueryRepository) Rename(id string, name string) (connection.SavedQuery, error) {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	targetID := strings.TrimSpace(id)
	nextName := strings.TrimSpace(name)
	if targetID == "" || nextName == "" {
		return connection.SavedQuery{}, fmt.Errorf("saved query and name are required")
	}
	file, err := r.loadFile()
	if err != nil {
		return connection.SavedQuery{}, err
	}
	for index, query := range file.Queries {
		if query.ID != targetID {
			continue
		}
		if query.Name == nextName {
			return query, nil
		}
		queries := append([]connection.SavedQuery(nil), file.Queries...)
		query.Name = nextName
		queries[index] = query
		if err := r.replaceQueries(file, queries); err != nil {
			return connection.SavedQuery{}, err
		}
		return query, nil
	}

	return connection.SavedQuery{}, fmt.Errorf("saved query not found: %s", targetID)
}

// migrateSQLDirectory copies all managed SQL files to target atomically as a
// batch. Source files remain in place until the directory setting is switched,
// so a later configuration write failure cannot disconnect saved queries from
// their content.
func (r *savedQueryRepository) migrateSQLDirectory(target string) error {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()
	return r.migrateSQLDirectoryLocked(target)
}

func (r *savedQueryRepository) migrateSQLDirectoryLocked(target string) error {
	targetDirectory := strings.TrimSpace(target)
	if targetDirectory == "" {
		targetDirectory = appdata.DefaultSavedQueryDirectory(r.configDir)
	}
	absTarget, err := filepath.Abs(targetDirectory)
	if err != nil {
		return err
	}
	targetDirectory = filepath.Clean(absTarget)
	if err := os.MkdirAll(targetDirectory, 0o755); err != nil {
		return err
	}
	currentDirectory, err := r.sqlDirectory()
	if err != nil {
		return err
	}
	if savedQueryPathsReferToSameFile(currentDirectory, targetDirectory) {
		return nil
	}
	file, err := r.loadFile()
	if err != nil {
		return err
	}

	mutations := make([]savedQuerySQLMutation, 0, len(file.Queries))
	rollback := func(cause error) error {
		return errors.Join(cause, rollbackSavedQuerySQLMutations(mutations))
	}
	for _, query := range file.Queries {
		fileName := file.FileNames[query.ID]
		sourcePath := filepath.Join(currentDirectory, fileName)
		content, err := os.ReadFile(sourcePath)
		if err != nil {
			return rollback(err)
		}
		targetPath := filepath.Join(targetDirectory, fileName)
		previous, readErr := os.ReadFile(targetPath)
		if readErr == nil && string(previous) == string(content) {
			continue
		}
		if readErr != nil && !os.IsNotExist(readErr) {
			return rollback(readErr)
		}
		mutation := savedQuerySQLMutation{path: targetPath}
		if readErr == nil {
			mutation.existed = true
			mutation.previous = previous
		}
		if err := writeSavedQuerySQLFileAtomic(targetPath, content); err != nil {
			return rollback(err)
		}
		mutations = append(mutations, mutation)
	}
	return nil
}

func (r *savedQueryRepository) SaveGroup(input connection.SavedQueryGroup) (connection.SavedQueryGroup, error) {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	file, err := r.loadFile()
	if err != nil {
		return connection.SavedQueryGroup{}, err
	}

	groupID := strings.TrimSpace(input.ID)
	if groupID == "" {
		groupID = "saved-query-group-" + uuid.NewString()
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return connection.SavedQueryGroup{}, fmt.Errorf("saved query group requires a name")
	}

	group := connection.SavedQueryGroup{
		ID:            groupID,
		Name:          name,
		ParentGroupID: strings.TrimSpace(input.ParentGroupID),
		QueryIDs:      sanitizeSavedQueryIDs(input.QueryIDs),
		ChildOrder:    sanitizeSavedQueryGroupChildOrder(input.ChildOrder),
	}
	if err := validateSavedQueryGroupQueryIDs(input.QueryIDs, file.Queries); err != nil {
		return connection.SavedQueryGroup{}, err
	}
	groupIndex := findSavedQueryGroupIndex(file.Groups, groupID)

	nextGroups := append([]connection.SavedQueryGroup(nil), file.Groups...)
	if groupIndex >= 0 {
		nextGroups[groupIndex] = group
	} else {
		nextGroups = append(nextGroups, group)
	}
	if err := validateSavedQueryGroupParent(nextGroups, groupID, group.ParentGroupID); err != nil {
		return connection.SavedQueryGroup{}, err
	}

	nextGroups = removeSavedQueryIDsFromOtherGroups(nextGroups, groupID, group.QueryIDs)
	file.Groups = normalizeSavedQueryGroups(nextGroups, file.Queries)
	if err := r.saveMetadataFile(file); err != nil {
		return connection.SavedQueryGroup{}, err
	}

	persistedIndex := findSavedQueryGroupIndex(file.Groups, groupID)
	if persistedIndex < 0 {
		return connection.SavedQueryGroup{}, fmt.Errorf("saved query group could not be persisted: %s", groupID)
	}
	return file.Groups[persistedIndex], nil
}

func (r *savedQueryRepository) DeleteGroup(id string) error {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	groupID := strings.TrimSpace(id)
	if groupID == "" {
		return nil
	}

	file, err := r.loadFile()
	if err != nil {
		return err
	}
	groupIndex := findSavedQueryGroupIndex(file.Groups, groupID)
	if groupIndex < 0 {
		return nil
	}

	removed := file.Groups[groupIndex]
	promotedOrder := resolveSavedQueryGroupChildOrder(groupID, file.Groups)
	removedToken := buildSavedQueryGroupToken(groupID)
	nextGroups := make([]connection.SavedQueryGroup, 0, len(file.Groups)-1)
	for _, candidate := range file.Groups {
		if candidate.ID == groupID {
			continue
		}
		next := candidate
		if next.ParentGroupID == groupID {
			next.ParentGroupID = removed.ParentGroupID
		}
		if next.ID == removed.ParentGroupID {
			next.QueryIDs = append(next.QueryIDs, removed.QueryIDs...)
			next.ChildOrder = replaceSavedQueryGroupChildOrderToken(
				next.ChildOrder,
				removedToken,
				promotedOrder,
			)
		}
		nextGroups = append(nextGroups, next)
	}

	file.Groups = normalizeSavedQueryGroups(nextGroups, file.Queries)
	return r.saveMetadataFile(file)
}

func (r *savedQueryRepository) MoveQueryToGroup(queryID string, groupID string) error {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	targetQueryID := strings.TrimSpace(queryID)
	if targetQueryID == "" {
		return fmt.Errorf("saved query is required")
	}

	file, err := r.loadFile()
	if err != nil {
		return err
	}
	if !savedQueryExists(file.Queries, targetQueryID) {
		return fmt.Errorf("saved query not found: %s", targetQueryID)
	}

	targetGroupID := strings.TrimSpace(groupID)
	targetGroupIndex := -1
	if targetGroupID != "" {
		targetGroupIndex = findSavedQueryGroupIndex(file.Groups, targetGroupID)
		if targetGroupIndex < 0 {
			return fmt.Errorf("saved query group not found: %s", targetGroupID)
		}
	}

	queryToken := buildSavedQueryToken(targetQueryID)
	nextGroups := append([]connection.SavedQueryGroup(nil), file.Groups...)
	for index := range nextGroups {
		nextGroups[index].QueryIDs = removeSavedQueryID(nextGroups[index].QueryIDs, targetQueryID)
		nextGroups[index].ChildOrder = removeSavedQueryGroupChildOrderToken(
			nextGroups[index].ChildOrder,
			queryToken,
		)
	}
	if targetGroupIndex >= 0 {
		nextGroups[targetGroupIndex].QueryIDs = append(nextGroups[targetGroupIndex].QueryIDs, targetQueryID)
		nextGroups[targetGroupIndex].ChildOrder = append(nextGroups[targetGroupIndex].ChildOrder, queryToken)
	}

	file.Groups = normalizeSavedQueryGroups(nextGroups, file.Queries)
	return r.saveMetadataFile(file)
}

func (r *savedQueryRepository) MoveGroup(groupID string, parentGroupID string) error {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	targetGroupID := strings.TrimSpace(groupID)
	if targetGroupID == "" {
		return fmt.Errorf("saved query group is required")
	}

	file, err := r.loadFile()
	if err != nil {
		return err
	}
	groupIndex := findSavedQueryGroupIndex(file.Groups, targetGroupID)
	if groupIndex < 0 {
		return fmt.Errorf("saved query group not found: %s", targetGroupID)
	}
	nextParentGroupID := strings.TrimSpace(parentGroupID)
	if err := validateSavedQueryGroupParent(file.Groups, targetGroupID, nextParentGroupID); err != nil {
		return err
	}

	groupToken := buildSavedQueryGroupToken(targetGroupID)
	nextGroups := append([]connection.SavedQueryGroup(nil), file.Groups...)
	for index := range nextGroups {
		nextGroups[index].ChildOrder = removeSavedQueryGroupChildOrderToken(
			nextGroups[index].ChildOrder,
			groupToken,
		)
	}
	nextGroups[groupIndex].ParentGroupID = nextParentGroupID
	if nextParentGroupID != "" {
		parentIndex := findSavedQueryGroupIndex(nextGroups, nextParentGroupID)
		nextGroups[parentIndex].ChildOrder = append(nextGroups[parentIndex].ChildOrder, groupToken)
	}

	file.Groups = normalizeSavedQueryGroups(nextGroups, file.Queries)
	return r.saveMetadataFile(file)
}

func normalizeSavedQueriesFile(file savedQueriesFile) savedQueriesFile {
	queries := sanitizeSavedQueries(file.Queries)
	fileNames := make(map[string]string, len(queries))
	for _, query := range queries {
		if fileName := strings.TrimSpace(file.FileNames[query.ID]); fileName != "" {
			fileNames[query.ID] = fileName
		}
	}
	return savedQueriesFile{
		Queries:   queries,
		Groups:    normalizeSavedQueryGroups(file.Groups, queries),
		FileNames: fileNames,
	}
}

func normalizeSavedQueryGroups(
	input []connection.SavedQueryGroup,
	queries []connection.SavedQuery,
) []connection.SavedQueryGroup {
	validQueryIDs := make(map[string]struct{}, len(queries))
	for _, query := range queries {
		validQueryIDs[query.ID] = struct{}{}
	}

	groups := make([]connection.SavedQueryGroup, 0, len(input))
	seenGroupIDs := make(map[string]struct{}, len(input))
	for index, item := range input {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if _, exists := seenGroupIDs[id]; exists {
			continue
		}
		seenGroupIDs[id] = struct{}{}
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = defaultSavedQueryGroupName(index)
		}
		groups = append(groups, connection.SavedQueryGroup{
			ID:            id,
			Name:          name,
			ParentGroupID: strings.TrimSpace(item.ParentGroupID),
			QueryIDs:      sanitizeSavedQueryIDs(item.QueryIDs),
			ChildOrder:    sanitizeSavedQueryGroupChildOrder(item.ChildOrder),
		})
	}
	if len(groups) == 0 {
		return []connection.SavedQueryGroup{}
	}

	groupIndexByID := make(map[string]int, len(groups))
	for index, group := range groups {
		groupIndexByID[group.ID] = index
	}
	for index := range groups {
		parentID := groups[index].ParentGroupID
		if parentID == "" || parentID == groups[index].ID {
			groups[index].ParentGroupID = ""
			continue
		}
		if _, exists := groupIndexByID[parentID]; !exists {
			groups[index].ParentGroupID = ""
		}
	}

	// Corrupt persisted parent cycles must not make the sidebar recurse forever.
	for _, group := range groups {
		path := make([]string, 0, len(groups))
		pathIndex := make(map[string]int, len(groups))
		currentID := group.ID
		for currentID != "" {
			currentIndex, exists := groupIndexByID[currentID]
			if !exists || groups[currentIndex].ParentGroupID == "" {
				break
			}
			if cycleStart, found := pathIndex[currentID]; found {
				for _, cycleID := range path[cycleStart:] {
					groups[groupIndexByID[cycleID]].ParentGroupID = ""
				}
				break
			}
			pathIndex[currentID] = len(path)
			path = append(path, currentID)
			currentID = groups[currentIndex].ParentGroupID
		}
	}

	assignedQueryIDs := make(map[string]struct{}, len(validQueryIDs))
	for index := range groups {
		filtered := make([]string, 0, len(groups[index].QueryIDs))
		for _, queryID := range groups[index].QueryIDs {
			if _, exists := validQueryIDs[queryID]; !exists {
				continue
			}
			if _, alreadyAssigned := assignedQueryIDs[queryID]; alreadyAssigned {
				continue
			}
			assignedQueryIDs[queryID] = struct{}{}
			filtered = append(filtered, queryID)
		}
		groups[index].QueryIDs = filtered
	}

	for index := range groups {
		childOrder := resolveSavedQueryGroupChildOrder(groups[index].ID, groups)
		groups[index].ChildOrder = childOrder
		queryIDs := make([]string, 0, len(groups[index].QueryIDs))
		for _, token := range childOrder {
			if queryID, ok := parseSavedQueryToken(token); ok {
				queryIDs = append(queryIDs, queryID)
			}
		}
		groups[index].QueryIDs = queryIDs
	}

	return groups
}

func mergeSavedQueryGroups(
	existing []connection.SavedQueryGroup,
	imported []connection.SavedQueryGroup,
) []connection.SavedQueryGroup {
	groups := append([]connection.SavedQueryGroup(nil), existing...)
	for _, item := range imported {
		groupID := strings.TrimSpace(item.ID)
		if groupID == "" {
			continue
		}
		item.ID = groupID
		index := findSavedQueryGroupIndex(groups, groupID)
		if index >= 0 {
			current := groups[index]
			if item.QueryIDs == nil {
				item.QueryIDs = append([]string(nil), current.QueryIDs...)
			}
			if item.ChildOrder == nil {
				item.ChildOrder = append([]string(nil), current.ChildOrder...)
			}
			groups[index] = item
		} else {
			groups = append(groups, item)
		}
		groups = removeSavedQueryIDsFromOtherGroups(groups, groupID, item.QueryIDs)
	}
	return groups
}

func resolveSavedQueryGroupChildOrder(
	groupID string,
	groups []connection.SavedQueryGroup,
) []string {
	groupIndex := findSavedQueryGroupIndex(groups, groupID)
	if groupIndex < 0 {
		return []string{}
	}
	group := groups[groupIndex]
	defaultOrder := make([]string, 0, len(group.QueryIDs)+len(groups))
	for _, queryID := range sanitizeSavedQueryIDs(group.QueryIDs) {
		defaultOrder = append(defaultOrder, buildSavedQueryToken(queryID))
	}
	for _, candidate := range groups {
		if candidate.ParentGroupID == groupID {
			defaultOrder = append(defaultOrder, buildSavedQueryGroupToken(candidate.ID))
		}
	}

	validTokens := make(map[string]struct{}, len(defaultOrder))
	for _, token := range defaultOrder {
		validTokens[token] = struct{}{}
	}
	result := make([]string, 0, len(defaultOrder))
	seen := make(map[string]struct{}, len(defaultOrder))
	for _, token := range sanitizeSavedQueryGroupChildOrder(group.ChildOrder) {
		if _, valid := validTokens[token]; !valid {
			continue
		}
		if _, exists := seen[token]; exists {
			continue
		}
		seen[token] = struct{}{}
		result = append(result, token)
	}
	for _, token := range defaultOrder {
		if _, exists := seen[token]; exists {
			continue
		}
		seen[token] = struct{}{}
		result = append(result, token)
	}
	return result
}

func validateSavedQueryGroupParent(
	groups []connection.SavedQueryGroup,
	groupID string,
	parentGroupID string,
) error {
	parentID := strings.TrimSpace(parentGroupID)
	if parentID == "" {
		return nil
	}
	if parentID == groupID {
		return fmt.Errorf("saved query group cannot be its own parent")
	}
	groupIndexByID := make(map[string]int, len(groups))
	for index, group := range groups {
		groupIndexByID[group.ID] = index
	}
	if _, exists := groupIndexByID[parentID]; !exists {
		return fmt.Errorf("saved query group parent not found: %s", parentID)
	}

	visited := make(map[string]struct{}, len(groups))
	currentID := parentID
	for currentID != "" {
		if currentID == groupID {
			return fmt.Errorf("saved query group cannot be moved below its descendant")
		}
		if _, exists := visited[currentID]; exists {
			return fmt.Errorf("saved query group hierarchy contains a cycle")
		}
		visited[currentID] = struct{}{}
		currentIndex, exists := groupIndexByID[currentID]
		if !exists {
			break
		}
		currentID = strings.TrimSpace(groups[currentIndex].ParentGroupID)
	}
	return nil
}

func validateSavedQueryGroupsQueryIDs(
	groups []connection.SavedQueryGroup,
	queries []connection.SavedQuery,
) error {
	for _, group := range groups {
		if err := validateSavedQueryGroupQueryIDs(group.QueryIDs, queries); err != nil {
			groupID := strings.TrimSpace(group.ID)
			if groupID == "" {
				groupID = strings.TrimSpace(group.Name)
			}
			if groupID == "" {
				groupID = "unknown"
			}
			return fmt.Errorf("saved query group %s: %w", groupID, err)
		}
	}
	return nil
}

func validateSavedQueryGroupQueryIDs(
	queryIDs []string,
	queries []connection.SavedQuery,
) error {
	validQueryIDs := make(map[string]struct{}, len(queries))
	for _, query := range queries {
		validQueryIDs[query.ID] = struct{}{}
	}
	for _, rawID := range queryIDs {
		queryID := strings.TrimSpace(rawID)
		if queryID == "" {
			return fmt.Errorf("saved query group contains an empty query id")
		}
		if _, exists := validQueryIDs[queryID]; !exists {
			return fmt.Errorf("saved query not found: %s", queryID)
		}
	}
	return nil
}

func removeSavedQueryIDsFromOtherGroups(
	groups []connection.SavedQueryGroup,
	targetGroupID string,
	queryIDs []string,
) []connection.SavedQueryGroup {
	if len(queryIDs) == 0 {
		return groups
	}
	requested := make(map[string]struct{}, len(queryIDs))
	for _, queryID := range queryIDs {
		if queryID = strings.TrimSpace(queryID); queryID != "" {
			requested[queryID] = struct{}{}
		}
	}
	if len(requested) == 0 {
		return groups
	}
	for index := range groups {
		if groups[index].ID == targetGroupID {
			continue
		}
		filtered := make([]string, 0, len(groups[index].QueryIDs))
		for _, queryID := range groups[index].QueryIDs {
			if _, remove := requested[queryID]; !remove {
				filtered = append(filtered, queryID)
			}
		}
		groups[index].QueryIDs = filtered
	}
	return groups
}

func findSavedQueryGroupIndex(groups []connection.SavedQueryGroup, groupID string) int {
	targetID := strings.TrimSpace(groupID)
	for index, group := range groups {
		if group.ID == targetID {
			return index
		}
	}
	return -1
}

func savedQueryExists(queries []connection.SavedQuery, queryID string) bool {
	for _, query := range queries {
		if query.ID == queryID {
			return true
		}
	}
	return false
}

func sanitizeSavedQueryIDs(value []string) []string {
	result := make([]string, 0, len(value))
	seen := make(map[string]struct{}, len(value))
	for _, item := range value {
		id := strings.TrimSpace(item)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func removeSavedQueryID(ids []string, queryID string) []string {
	result := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != queryID {
			result = append(result, id)
		}
	}
	return result
}

func buildSavedQueryGroupToken(groupID string) string {
	return savedQueryGroupTokenPrefix + groupID
}

func buildSavedQueryToken(queryID string) string {
	return savedQueryTokenPrefix + queryID
}

func parseSavedQueryToken(token string) (string, bool) {
	if !strings.HasPrefix(token, savedQueryTokenPrefix) {
		return "", false
	}
	queryID := strings.TrimSpace(strings.TrimPrefix(token, savedQueryTokenPrefix))
	return queryID, queryID != ""
}

func isSavedQueryGroupChildOrderToken(token string) bool {
	if queryID, ok := parseSavedQueryToken(token); ok && queryID != "" {
		return true
	}
	groupID := strings.TrimSpace(strings.TrimPrefix(token, savedQueryGroupTokenPrefix))
	return strings.HasPrefix(token, savedQueryGroupTokenPrefix) && groupID != ""
}

func sanitizeSavedQueryGroupChildOrder(value []string) []string {
	result := make([]string, 0, len(value))
	seen := make(map[string]struct{}, len(value))
	for _, item := range value {
		token := strings.TrimSpace(item)
		if !isSavedQueryGroupChildOrderToken(token) {
			continue
		}
		if _, exists := seen[token]; exists {
			continue
		}
		seen[token] = struct{}{}
		result = append(result, token)
	}
	return result
}

func removeSavedQueryGroupChildOrderToken(order []string, token string) []string {
	result := make([]string, 0, len(order))
	for _, item := range sanitizeSavedQueryGroupChildOrder(order) {
		if item != token {
			result = append(result, item)
		}
	}
	return result
}

func replaceSavedQueryGroupChildOrderToken(
	order []string,
	token string,
	replacements []string,
) []string {
	replacementTokens := sanitizeSavedQueryGroupChildOrder(replacements)
	replacementSet := make(map[string]struct{}, len(replacementTokens))
	for _, item := range replacementTokens {
		replacementSet[item] = struct{}{}
	}
	result := make([]string, 0, len(order)+len(replacementTokens))
	inserted := false
	for _, item := range sanitizeSavedQueryGroupChildOrder(order) {
		if item == token {
			if !inserted {
				result = append(result, replacementTokens...)
				inserted = true
			}
			continue
		}
		if _, isReplacement := replacementSet[item]; isReplacement {
			continue
		}
		result = append(result, item)
	}
	if !inserted {
		result = append(result, replacementTokens...)
	}
	return result
}

func defaultSavedQueryGroupName(index int) string {
	return fmt.Sprintf("Group %d", index+1)
}

func sanitizeSavedQueries(items []connection.SavedQuery) []connection.SavedQuery {
	result := make([]connection.SavedQuery, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for index, item := range items {
		query, ok := sanitizeSavedQuery(item, index, false)
		if !ok {
			continue
		}
		if _, exists := seen[query.ID]; exists {
			continue
		}
		seen[query.ID] = struct{}{}
		result = append(result, query)
	}
	return result
}

func sanitizeSavedQuery(input connection.SavedQuery, index int, allowGeneratedID bool) (connection.SavedQuery, bool) {
	id := strings.TrimSpace(input.ID)
	if id == "" && allowGeneratedID {
		id = "saved-" + uuid.NewString()
	}
	if id == "" {
		return connection.SavedQuery{}, false
	}

	sqlText := input.SQL
	connectionID := strings.TrimSpace(input.ConnectionID)
	dbName := strings.TrimSpace(input.DBName)
	if strings.TrimSpace(sqlText) == "" || connectionID == "" || dbName == "" {
		return connection.SavedQuery{}, false
	}

	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = defaultSavedQueryName(index)
	}
	createdAt := input.CreatedAt
	if createdAt <= 0 {
		createdAt = time.Now().UnixMilli()
	}

	return connection.SavedQuery{
		ID:                    id,
		Name:                  name,
		SQL:                   sqlText,
		ConnectionID:          connectionID,
		DBName:                dbName,
		CreatedAt:             createdAt,
		ConnectionFingerprint: strings.TrimSpace(input.ConnectionFingerprint),
		FingerprintVersion:    strings.TrimSpace(input.FingerprintVersion),
		BindingStatus:         strings.TrimSpace(input.BindingStatus),
		OriginalConnectionID:  strings.TrimSpace(input.OriginalConnectionID),
	}, true
}

func defaultSavedQueryName(index int) string {
	return fmt.Sprintf("Query %d", index+1)
}
