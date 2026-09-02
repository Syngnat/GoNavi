package app

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
)

// DeleteConnectionGroup atomically removes a group subtree, its direct
// connections and their stored credentials. The layout revision is checked
// while the same shared storage lock is held, so a stale window cannot delete
// a connection that another window moved elsewhere.
func (a *App) DeleteConnectionGroup(input connection.DeleteConnectionGroupInput) error {
	tagID := strings.TrimSpace(input.TagID)
	if tagID == "" {
		return errors.New("connection group id is required")
	}
	if input.ExpectedRevision == 0 {
		return errors.New("connection sidebar layout revision is required")
	}

	connectionsRepo := a.savedConnectionRepository()
	layoutRepo := a.connectionSidebarLayoutRepository()
	err := withConnectionGroupDeleteLocks(a.configDir, connectionsRepo, layoutRepo, func() error {
		layout, err := layoutRepo.loadUnlocked()
		if err != nil {
			return err
		}
		if !layout.Initialized || layout.Revision != input.ExpectedRevision {
			return errors.New("connection sidebar layout revision conflict")
		}

		removedTagIDs := collectConnectionSidebarTagTree(tagID, layout.ConnectionTags)
		if len(removedTagIDs) == 0 {
			return fmt.Errorf("connection group not found: %s", tagID)
		}
		removedTagSet := make(map[string]struct{}, len(removedTagIDs))
		for _, id := range removedTagIDs {
			removedTagSet[id] = struct{}{}
		}
		removedConnectionSet := make(map[string]struct{})
		for _, tag := range layout.ConnectionTags {
			if _, removed := removedTagSet[tag.ID]; !removed {
				continue
			}
			for _, id := range tag.ConnectionIDs {
				if id = strings.TrimSpace(id); id != "" {
					removedConnectionSet[id] = struct{}{}
				}
			}
		}

		connections, err := connectionsRepo.load()
		if err != nil {
			return err
		}
		filtered := make([]connection.SavedConnectionView, 0, len(connections))
		for _, item := range connections {
			if _, remove := removedConnectionSet[item.ID]; remove {
				if err := connectionsRepo.deleteSecretBundle(item.ID); err != nil {
					return err
				}
				continue
			}
			filtered = append(filtered, item)
		}
		if err := connectionsRepo.saveAll(filtered); err != nil {
			return err
		}

		remainingTags := make([]connection.ConnectionTag, 0, len(layout.ConnectionTags)-len(removedTagIDs))
		for _, tag := range layout.ConnectionTags {
			if _, removed := removedTagSet[tag.ID]; removed {
				continue
			}
			tag.ConnectionIDs = filterConnectionSidebarIDs(tag.ConnectionIDs, removedConnectionSet)
			tag.ChildOrder = filterConnectionSidebarTokens(tag.ChildOrder, removedTagSet, removedConnectionSet)
			remainingTags = append(remainingTags, tag)
		}
		remainingRootOrder := filterConnectionSidebarTokens(layout.SidebarRootOrder, removedTagSet, removedConnectionSet)
		normalized, err := layoutRepo.normalizeUnlocked(connection.ConnectionSidebarLayoutInput{
			ConnectionTags:         remainingTags,
			SidebarRootOrder:       remainingRootOrder,
			RootSortMode:           "manual",
			RootConnectionSortMode: layout.RootConnectionSortMode,
		})
		if err != nil {
			return err
		}
		if layout.Revision == ^uint64(0) {
			return errors.New("connection sidebar layout revision overflow")
		}
		return layoutRepo.saveUnlocked(connection.ConnectionSidebarLayout{
			Initialized:            true,
			Revision:               layout.Revision + 1,
			ConnectionTags:         normalized.ConnectionTags,
			SidebarRootOrder:       normalized.SidebarRootOrder,
			RootSortMode:           "manual",
			RootConnectionSortMode: normalized.RootConnectionSortMode,
		})
	})
	if err == nil {
		a.markCloudBackupDirty()
	}
	return err
}

func collectConnectionSidebarTagTree(rootID string, tags []connection.ConnectionTag) []string {
	children := make(map[string][]string, len(tags))
	for _, tag := range tags {
		children[strings.TrimSpace(tag.ParentTagID)] = append(children[strings.TrimSpace(tag.ParentTagID)], tag.ID)
	}
	seen := make(map[string]struct{}, len(tags))
	result := make([]string, 0, len(tags))
	pending := []string{rootID}
	for len(pending) > 0 {
		id := strings.TrimSpace(pending[len(pending)-1])
		pending = pending[:len(pending)-1]
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		found := false
		for _, tag := range tags {
			if tag.ID == id {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
		pending = append(pending, children[id]...)
	}
	return result
}

func filterConnectionSidebarIDs(ids []string, removed map[string]struct{}) []string {
	result := make([]string, 0, len(ids))
	for _, id := range ids {
		if _, exists := removed[strings.TrimSpace(id)]; !exists {
			result = append(result, id)
		}
	}
	return result
}

func filterConnectionSidebarTokens(tokens []string, removedTags, removedConnections map[string]struct{}) []string {
	result := make([]string, 0, len(tokens))
	for _, token := range tokens {
		kind, id, ok := parseConnectionSidebarToken(token)
		if !ok {
			continue
		}
		if kind == "tag" {
			if _, exists := removedTags[id]; exists {
				continue
			}
		} else if _, exists := removedConnections[id]; exists {
			continue
		}
		result = append(result, token)
	}
	return result
}

func withConnectionGroupDeleteLocks(
	configDir string,
	connectionsRepo *savedConnectionRepository,
	layoutRepo *connectionSidebarLayoutRepository,
	operation func() error,
) (resultErr error) {
	savedConnectionsMu.Lock()
	defer savedConnectionsMu.Unlock()
	connectionSidebarLayoutMu.Lock()
	defer connectionSidebarLayoutMu.Unlock()
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(configDir))
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, sharedLock.Close()) }()
	connectionLock, err := appdata.AcquireFileLock(connectionsRepo.connectionsPath() + ".lock")
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, connectionLock.Close()) }()
	layoutLock, err := appdata.AcquireFileLock(layoutRepo.layoutPath() + ".lock")
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, layoutLock.Close()) }()

	savedSnapshot, err := connectionsRepo.captureFilesSnapshotUnlocked()
	if err != nil {
		return err
	}
	layoutSnapshot, err := captureConnectionSidebarLayoutSnapshotUnlocked(layoutRepo)
	if err != nil {
		return err
	}
	if operation == nil {
		return nil
	}
	if err := operation(); err != nil {
		var restoreErr error
		restoreErr = errors.Join(restoreErr, savedSnapshot.restoreUnlocked(connectionsRepo))
		restoreErr = errors.Join(restoreErr, layoutSnapshot.restoreUnlocked(layoutRepo))
		if restoreErr != nil {
			return errors.Join(err, fmt.Errorf("restore connection group delete files: %w", restoreErr))
		}
		return err
	}
	return nil
}
