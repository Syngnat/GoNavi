package app

import (
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"

	"github.com/google/uuid"
)

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
		Parameters:            normalizeSavedQueryParameters(input.Parameters),
	}, true
}

func defaultSavedQueryName(index int) string {
	return fmt.Sprintf("Query %d", index+1)
}
