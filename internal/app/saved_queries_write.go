package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"GoNavi-Wails/internal/connection"
)

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
