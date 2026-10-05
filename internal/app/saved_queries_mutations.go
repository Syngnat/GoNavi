package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"

	"github.com/google/uuid"
)

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
