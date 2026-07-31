package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (a *App) savedQueryRepository() *savedQueryRepository {
	return newSavedQueryRepository(a.configDir)
}

func (a *App) GetSavedQueries() ([]connection.SavedQuery, error) {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	queries, err := a.savedQueryRepository().load()
	if err != nil {
		return nil, err
	}
	currentConnections, err := a.savedConnectionRepository().List()
	if err != nil {
		return queries, nil
	}
	return resolveSavedQueryBindings(queries, currentConnections, nil), nil
}

func (a *App) GetSavedQueryGroups() ([]connection.SavedQueryGroup, error) {
	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	return a.savedQueryRepository().loadGroups()
}

func (a *App) SaveQuery(input connection.SavedQuery) (connection.SavedQuery, error) {
	if strings.TrimSpace(input.Name) == "" {
		input.Name = a.localizedSavedQueryDefaultName(0)
	}
	currentConnections, err := a.savedConnectionRepository().List()
	if err == nil {
		input = resolveSavedQueryBindings([]connection.SavedQuery{input}, currentConnections, nil)[0]
	}
	query, err := a.savedQueryRepository().Save(input)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return query, err
}

func (a *App) ImportSavedQueries(payload connection.SavedQueryImportPayload) ([]connection.SavedQuery, error) {
	if len(payload.Queries) > 0 {
		localizedQueries := append([]connection.SavedQuery(nil), payload.Queries...)
		for index := range localizedQueries {
			if strings.TrimSpace(localizedQueries[index].Name) == "" {
				localizedQueries[index].Name = a.localizedSavedQueryDefaultName(index)
			}
		}
		payload.Queries = localizedQueries
	}
	currentConnections, err := a.savedConnectionRepository().List()
	if err != nil {
		currentConnections = nil
	}
	queries, err := a.savedQueryRepository().Import(payload, currentConnections)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return queries, err
}

func (a *App) localizedSavedQueryDefaultName(index int) string {
	return a.appText("saved_query.default_name", map[string]any{"index": index + 1})
}

func (a *App) DeleteQuery(id string) error {
	err := a.savedQueryRepository().Delete(id)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return err
}

func (a *App) RenameSavedQuery(id string, name string) (connection.SavedQuery, error) {
	query, err := a.savedQueryRepository().Rename(id, name)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return query, err
}

// SaveSavedQueryGroup creates or fully replaces a saved SQL group. Callers
// must submit the current parent, query IDs, and child order; query IDs in the
// submitted group become owned by that direct group only.
func (a *App) SaveSavedQueryGroup(input connection.SavedQueryGroup) (connection.SavedQueryGroup, error) {
	group, err := a.savedQueryRepository().SaveGroup(input)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return group, err
}

// DeleteSavedQueryGroup removes a group and promotes its direct queries and
// child groups to the deleted group's parent when it has one.
func (a *App) DeleteSavedQueryGroup(id string) error {
	err := a.savedQueryRepository().DeleteGroup(id)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return err
}

// MoveSavedQueryToGroup moves a saved query to a direct group. An empty group
// id makes the query ungrouped.
func (a *App) MoveSavedQueryToGroup(queryID string, groupID string) error {
	err := a.savedQueryRepository().MoveQueryToGroup(queryID, groupID)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return err
}

// MoveSavedQueryGroup reparents a saved-query group. An empty parent id moves
// it to the root level.
func (a *App) MoveSavedQueryGroup(groupID string, parentGroupID string) error {
	err := a.savedQueryRepository().MoveGroup(groupID, parentGroupID)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return err
}

func (a *App) RebindSavedQuery(id string, connectionID string) (connection.SavedQuery, error) {
	target, err := a.savedConnectionRepository().Find(connectionID)
	if err != nil {
		return connection.SavedQuery{}, err
	}
	query, err := a.savedQueryRepository().Rebind(id, target)
	if err == nil {
		a.markCloudBackupDirty()
	}
	return query, err
}

func (a *App) GetUnboundSavedQueries() ([]connection.SavedQuery, error) {
	queries, err := a.GetSavedQueries()
	if err != nil {
		return nil, err
	}
	result := make([]connection.SavedQuery, 0)
	for _, query := range queries {
		if query.BindingStatus == savedQueryBindingOrphan {
			result = append(result, query)
		}
	}
	return result, nil
}
