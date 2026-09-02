package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
)

const (
	connectionSidebarLayoutFileName       = "connection_sidebar_layout.json"
	connectionSidebarLayoutFormatVersion  = 2
	connectionSidebarLayoutMaxFileBytes   = 4 * 1024 * 1024
	connectionSidebarLayoutMaxTags        = 1024
	connectionSidebarLayoutMaxReferences  = 65536
	connectionSidebarLayoutMaxStringBytes = 256
	connectionSidebarLayoutMaxTreeDepth   = 64
	connectionSidebarTagTokenPrefix       = "tag:"
	connectionSidebarHostTokenPrefix      = "connection:"
)

var connectionSidebarLayoutMu sync.Mutex

type connectionSidebarLayoutDiskFile struct {
	Version                int                        `json:"version"`
	Revision               uint64                     `json:"revision"`
	ConnectionTags         []connection.ConnectionTag `json:"connectionTags"`
	SidebarRootOrder       []string                   `json:"sidebarRootOrder"`
	RootSortMode           string                     `json:"rootSortMode,omitempty"`
	RootConnectionSortMode string                     `json:"rootConnectionSortMode,omitempty"`
}

type connectionSidebarLayoutRepository struct {
	configDir string
}

type connectionSidebarLayoutSnapshot struct {
	exists bool
	data   []byte
}

func newConnectionSidebarLayoutRepository(configDir string) *connectionSidebarLayoutRepository {
	if strings.TrimSpace(configDir) == "" {
		configDir = resolveAppConfigDir()
	}
	return &connectionSidebarLayoutRepository{configDir: configDir}
}

func (r *connectionSidebarLayoutRepository) layoutPath() string {
	return filepath.Join(r.configDir, connectionSidebarLayoutFileName)
}

// captureConnectionSidebarLayoutSnapshotUnlocked captures the exact layout
// file state while the caller already holds the shared storage write lock.
func captureConnectionSidebarLayoutSnapshotUnlocked(
	repository *connectionSidebarLayoutRepository,
) (connectionSidebarLayoutSnapshot, error) {
	data, exists, err := readOptionalFile(repository.layoutPath())
	if err != nil {
		return connectionSidebarLayoutSnapshot{}, err
	}
	return connectionSidebarLayoutSnapshot{exists: exists, data: data}, nil
}

// restoreUnlocked rolls back without decoding or revising the snapshot. This
// preserves even an older byte representation exactly during a failed restore.
func (snapshot connectionSidebarLayoutSnapshot) restoreUnlocked(
	repository *connectionSidebarLayoutRepository,
) error {
	if !snapshot.exists {
		if err := os.Remove(repository.layoutPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return writeConnectionSidebarLayoutFileAtomic(repository.layoutPath(), snapshot.data)
}

func emptyConnectionSidebarLayout() connection.ConnectionSidebarLayout {
	return connection.ConnectionSidebarLayout{
		ConnectionTags:         []connection.ConnectionTag{},
		SidebarRootOrder:       []string{},
		RootSortMode:           "manual",
		RootConnectionSortMode: "createdAt",
	}
}

func (r *connectionSidebarLayoutRepository) withLock(operation func() error) (resultErr error) {
	connectionSidebarLayoutMu.Lock()
	defer connectionSidebarLayoutMu.Unlock()
	if err := os.MkdirAll(r.configDir, 0o755); err != nil {
		return err
	}
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(r.configDir))
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, sharedLock.Close())
	}()
	fileLock, err := appdata.AcquireFileLock(r.layoutPath() + ".lock")
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, fileLock.Close())
	}()
	if operation == nil {
		return nil
	}
	return operation()
}

func (r *connectionSidebarLayoutRepository) loadUnlocked() (connection.ConnectionSidebarLayout, error) {
	if info, err := os.Stat(r.layoutPath()); err == nil {
		if info.IsDir() {
			return connection.ConnectionSidebarLayout{}, fmt.Errorf("connection sidebar layout path is a directory: %s", r.layoutPath())
		}
		if info.Size() > connectionSidebarLayoutMaxFileBytes {
			return connection.ConnectionSidebarLayout{}, fmt.Errorf(
				"connection sidebar layout exceeds %d-byte limit",
				connectionSidebarLayoutMaxFileBytes,
			)
		}
	} else if !os.IsNotExist(err) {
		return connection.ConnectionSidebarLayout{}, err
	}
	payload, err := os.ReadFile(r.layoutPath())
	if err != nil {
		if os.IsNotExist(err) {
			return emptyConnectionSidebarLayout(), nil
		}
		return connection.ConnectionSidebarLayout{}, err
	}
	var diskFile connectionSidebarLayoutDiskFile
	if err := json.Unmarshal(payload, &diskFile); err != nil {
		return connection.ConnectionSidebarLayout{}, err
	}
	if diskFile.Version != 1 && diskFile.Version != connectionSidebarLayoutFormatVersion {
		return connection.ConnectionSidebarLayout{}, fmt.Errorf(
			"unsupported connection sidebar layout version: %d",
			diskFile.Version,
		)
	}
	if diskFile.Revision == 0 {
		return connection.ConnectionSidebarLayout{}, errors.New("connection sidebar layout revision must be positive")
	}
	if diskFile.ConnectionTags == nil {
		diskFile.ConnectionTags = []connection.ConnectionTag{}
	}
	legacyTagCreatedAt := int64(0)
	if info, statErr := os.Stat(r.layoutPath()); statErr == nil {
		legacyTagCreatedAt = info.ModTime().UnixMilli()
	}
	legacyTagCreatedAtChanged := false
	for index := range diskFile.ConnectionTags {
		if diskFile.ConnectionTags[index].CreatedAt <= 0 && legacyTagCreatedAt > 0 {
			diskFile.ConnectionTags[index].CreatedAt = legacyTagCreatedAt - int64(index)
			legacyTagCreatedAtChanged = true
		}
		if diskFile.ConnectionTags[index].ConnectionIDs == nil {
			diskFile.ConnectionTags[index].ConnectionIDs = []string{}
		}
		if diskFile.ConnectionTags[index].ChildOrder == nil {
			diskFile.ConnectionTags[index].ChildOrder = []string{}
		}
		diskFile.ConnectionTags[index].ConnectionSortMode = normalizeConnectionSidebarConnectionSortMode(
			diskFile.ConnectionTags[index].ConnectionSortMode,
			diskFile.ConnectionTags[index].SortMode,
		)
		diskFile.ConnectionTags[index].SortMode = "manual"
	}
	if diskFile.SidebarRootOrder == nil {
		diskFile.SidebarRootOrder = []string{}
	}
	layout := connection.ConnectionSidebarLayout{
		Initialized:      true,
		Revision:         diskFile.Revision,
		ConnectionTags:   diskFile.ConnectionTags,
		SidebarRootOrder: diskFile.SidebarRootOrder,
		RootSortMode:     "manual",
		RootConnectionSortMode: normalizeConnectionSidebarConnectionSortMode(
			diskFile.RootConnectionSortMode,
			diskFile.RootSortMode,
		),
	}
	// A layout at the maximum revision cannot participate in a safe write CAS.
	// Keep the migrated timestamps in the returned snapshot, but do not rewrite
	// its bytes before callers can report the overflow to the user.
	if legacyTagCreatedAtChanged && diskFile.Revision != ^uint64(0) {
		if err := r.saveUnlocked(layout); err != nil {
			return connection.ConnectionSidebarLayout{}, err
		}
	}
	return layout, nil
}

func normalizeConnectionSidebarConnectionSortMode(value string, legacyValue string) string {
	if value == "name" || value == "createdAt" {
		return value
	}
	if legacyValue == "name" || legacyValue == "createdAt" {
		return legacyValue
	}
	return "createdAt"
}

func (r *connectionSidebarLayoutRepository) saveUnlocked(layout connection.ConnectionSidebarLayout) error {
	diskFile := connectionSidebarLayoutDiskFile{
		Version:          connectionSidebarLayoutFormatVersion,
		Revision:         layout.Revision,
		ConnectionTags:   layout.ConnectionTags,
		SidebarRootOrder: layout.SidebarRootOrder,
		RootSortMode:     "manual",
		RootConnectionSortMode: normalizeConnectionSidebarConnectionSortMode(
			layout.RootConnectionSortMode,
			layout.RootSortMode,
		),
	}
	payload, err := json.MarshalIndent(diskFile, "", "  ")
	if err != nil {
		return err
	}
	if len(payload) > connectionSidebarLayoutMaxFileBytes {
		return fmt.Errorf(
			"connection sidebar layout exceeds %d-byte limit",
			connectionSidebarLayoutMaxFileBytes,
		)
	}
	return writeConnectionSidebarLayoutFileAtomicFunc(r.layoutPath(), payload)
}

// replaceUnlocked replaces the authoritative layout while the caller already
// holds the saved-connection shared storage write lock. Cloud restore uses this
// form after importing connections so normalization sees the restored host set
// without attempting to acquire the shared lock a second time.
func (r *connectionSidebarLayoutRepository) replaceUnlocked(
	input connection.ConnectionSidebarLayoutInput,
) (connection.ConnectionSidebarLayout, error) {
	current, err := r.loadUnlocked()
	if err != nil {
		return connection.ConnectionSidebarLayout{}, err
	}
	normalized, err := r.normalizeUnlocked(input)
	if err != nil {
		return connection.ConnectionSidebarLayout{}, err
	}
	nextRevision := uint64(1)
	if current.Initialized {
		if current.Revision == ^uint64(0) {
			return connection.ConnectionSidebarLayout{}, errors.New("connection sidebar layout revision overflow")
		}
		nextRevision = current.Revision + 1
	}
	replacement := connection.ConnectionSidebarLayout{
		Initialized:            true,
		Revision:               nextRevision,
		ConnectionTags:         normalized.ConnectionTags,
		SidebarRootOrder:       normalized.SidebarRootOrder,
		RootSortMode:           normalized.RootSortMode,
		RootConnectionSortMode: normalized.RootConnectionSortMode,
	}
	if err := r.saveUnlocked(replacement); err != nil {
		return connection.ConnectionSidebarLayout{}, err
	}
	return replacement, nil
}

func buildConnectionSidebarTagToken(id string) string {
	return connectionSidebarTagTokenPrefix + strings.TrimSpace(id)
}

func buildConnectionSidebarHostToken(id string) string {
	return connectionSidebarHostTokenPrefix + strings.TrimSpace(id)
}

func parseConnectionSidebarToken(token string) (kind string, id string, ok bool) {
	token = strings.TrimSpace(token)
	switch {
	case strings.HasPrefix(token, connectionSidebarTagTokenPrefix):
		id = strings.TrimSpace(strings.TrimPrefix(token, connectionSidebarTagTokenPrefix))
		return "tag", id, id != ""
	case strings.HasPrefix(token, connectionSidebarHostTokenPrefix):
		id = strings.TrimSpace(strings.TrimPrefix(token, connectionSidebarHostTokenPrefix))
		return "connection", id, id != ""
	default:
		return "", "", false
	}
}

func validateConnectionSidebarLayoutString(label string, value string, maxBytes int) error {
	if len(strings.TrimSpace(value)) > maxBytes {
		return fmt.Errorf("%s exceeds %d-byte limit", label, maxBytes)
	}
	return nil
}

func validateConnectionSidebarLayoutLimits(input connection.ConnectionSidebarLayoutInput) error {
	if len(input.ConnectionTags) > connectionSidebarLayoutMaxTags {
		return fmt.Errorf("connection sidebar layout exceeds %d-group limit", connectionSidebarLayoutMaxTags)
	}
	referenceCount := len(input.SidebarRootOrder)
	for index, tag := range input.ConnectionTags {
		if err := validateConnectionSidebarLayoutString("connection sidebar group id", tag.ID, connectionSidebarLayoutMaxStringBytes); err != nil {
			return fmt.Errorf("group %d: %w", index, err)
		}
		if err := validateConnectionSidebarLayoutString("connection sidebar group name", tag.Name, connectionSidebarLayoutMaxStringBytes); err != nil {
			return fmt.Errorf("group %d: %w", index, err)
		}
		if err := validateConnectionSidebarLayoutString("connection sidebar parent group id", tag.ParentTagID, connectionSidebarLayoutMaxStringBytes); err != nil {
			return fmt.Errorf("group %d: %w", index, err)
		}
		referenceCount += len(tag.ConnectionIDs) + len(tag.ChildOrder)
		for _, id := range tag.ConnectionIDs {
			if err := validateConnectionSidebarLayoutString("connection sidebar host id", id, connectionSidebarLayoutMaxStringBytes); err != nil {
				return fmt.Errorf("group %d: %w", index, err)
			}
		}
		for _, token := range tag.ChildOrder {
			if err := validateConnectionSidebarLayoutString(
				"connection sidebar child-order token",
				token,
				connectionSidebarLayoutMaxStringBytes+len(connectionSidebarHostTokenPrefix),
			); err != nil {
				return fmt.Errorf("group %d: %w", index, err)
			}
		}
	}
	for _, token := range input.SidebarRootOrder {
		if err := validateConnectionSidebarLayoutString(
			"connection sidebar root-order token",
			token,
			connectionSidebarLayoutMaxStringBytes+len(connectionSidebarHostTokenPrefix),
		); err != nil {
			return err
		}
	}
	if referenceCount > connectionSidebarLayoutMaxReferences {
		return fmt.Errorf("connection sidebar layout exceeds %d-reference limit", connectionSidebarLayoutMaxReferences)
	}
	return nil
}

func sanitizeConnectionSidebarOrderTokens(tokens []string) []string {
	result := make([]string, 0, len(tokens))
	seen := make(map[string]struct{}, len(tokens))
	for _, raw := range tokens {
		kind, id, ok := parseConnectionSidebarToken(raw)
		if !ok {
			continue
		}
		token := buildConnectionSidebarHostToken(id)
		if kind == "tag" {
			token = buildConnectionSidebarTagToken(id)
		}
		if _, exists := seen[token]; exists {
			continue
		}
		seen[token] = struct{}{}
		result = append(result, token)
	}
	return result
}

func appendMissingConnectionSidebarTokens(order []string, defaults []string) []string {
	result := make([]string, 0, len(defaults))
	valid := make(map[string]struct{}, len(defaults))
	for _, token := range defaults {
		valid[token] = struct{}{}
	}
	seen := make(map[string]struct{}, len(defaults))
	for _, token := range sanitizeConnectionSidebarOrderTokens(order) {
		if _, ok := valid[token]; !ok {
			continue
		}
		if _, exists := seen[token]; exists {
			continue
		}
		seen[token] = struct{}{}
		result = append(result, token)
	}
	for _, token := range defaults {
		if _, exists := seen[token]; exists {
			continue
		}
		seen[token] = struct{}{}
		result = append(result, token)
	}
	return result
}

func (r *connectionSidebarLayoutRepository) savedConnectionIDsUnlocked() ([]string, map[string]struct{}, error) {
	items, err := newSavedConnectionRepository(r.configDir, nil).List()
	if err != nil {
		return nil, nil, err
	}
	ordered := make([]string, 0, len(items))
	valid := make(map[string]struct{}, len(items))
	for _, item := range items {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if _, exists := valid[id]; exists {
			continue
		}
		valid[id] = struct{}{}
		ordered = append(ordered, id)
	}
	return ordered, valid, nil
}

func (r *connectionSidebarLayoutRepository) normalizeUnlocked(
	input connection.ConnectionSidebarLayoutInput,
) (connection.ConnectionSidebarLayoutInput, error) {
	if err := validateConnectionSidebarLayoutLimits(input); err != nil {
		return connection.ConnectionSidebarLayoutInput{}, err
	}
	orderedConnectionIDs, validConnectionIDs, err := r.savedConnectionIDsUnlocked()
	if err != nil {
		return connection.ConnectionSidebarLayoutInput{}, err
	}

	tags := make([]connection.ConnectionTag, 0, len(input.ConnectionTags))
	tagIndex := make(map[string]int, len(input.ConnectionTags))
	for rawIndex, raw := range input.ConnectionTags {
		id := strings.TrimSpace(raw.ID)
		if id == "" {
			continue
		}
		if _, duplicate := tagIndex[id]; duplicate {
			continue
		}
		name := strings.TrimSpace(raw.Name)
		if name == "" {
			name = id
		}
		connectionIDs := make([]string, 0, len(raw.ConnectionIDs))
		seenConnectionIDs := make(map[string]struct{}, len(raw.ConnectionIDs))
		for _, rawID := range raw.ConnectionIDs {
			connectionID := strings.TrimSpace(rawID)
			if _, valid := validConnectionIDs[connectionID]; !valid {
				continue
			}
			if _, duplicate := seenConnectionIDs[connectionID]; duplicate {
				continue
			}
			seenConnectionIDs[connectionID] = struct{}{}
			connectionIDs = append(connectionIDs, connectionID)
		}
		tagIndex[id] = len(tags)
		createdAt := raw.CreatedAt
		if createdAt <= 0 {
			createdAt = time.Now().UnixMilli() - int64(len(input.ConnectionTags)-rawIndex)
		}
		tags = append(tags, connection.ConnectionTag{
			ID:                 id,
			Name:               name,
			CreatedAt:          createdAt,
			ParentTagID:        strings.TrimSpace(raw.ParentTagID),
			ConnectionIDs:      connectionIDs,
			ChildOrder:         sanitizeConnectionSidebarOrderTokens(raw.ChildOrder),
			SortMode:           "manual",
			ConnectionSortMode: normalizeConnectionSidebarConnectionSortMode(raw.ConnectionSortMode, raw.SortMode),
		})
	}

	for index := range tags {
		parentID := tags[index].ParentTagID
		if parentID == "" || parentID == tags[index].ID {
			tags[index].ParentTagID = ""
			continue
		}
		if _, exists := tagIndex[parentID]; !exists {
			tags[index].ParentTagID = ""
		}
	}
	for _, tag := range tags {
		path := make([]string, 0, connectionSidebarLayoutMaxTreeDepth)
		pathIndex := make(map[string]int)
		currentID := tag.ID
		for currentID != "" {
			if cycleStart, cycle := pathIndex[currentID]; cycle {
				for _, cycleID := range path[cycleStart:] {
					tags[tagIndex[cycleID]].ParentTagID = ""
				}
				break
			}
			if len(path) >= connectionSidebarLayoutMaxTreeDepth {
				return connection.ConnectionSidebarLayoutInput{}, fmt.Errorf(
					"connection sidebar group hierarchy exceeds %d-level limit",
					connectionSidebarLayoutMaxTreeDepth,
				)
			}
			pathIndex[currentID] = len(path)
			path = append(path, currentID)
			currentID = tags[tagIndex[currentID]].ParentTagID
		}
	}

	ownedConnectionIDs := make(map[string]struct{})
	for index := range tags {
		unique := make([]string, 0, len(tags[index].ConnectionIDs))
		for _, connectionID := range tags[index].ConnectionIDs {
			if _, owned := ownedConnectionIDs[connectionID]; owned {
				continue
			}
			ownedConnectionIDs[connectionID] = struct{}{}
			unique = append(unique, connectionID)
		}
		tags[index].ConnectionIDs = unique
	}

	childrenByParent := make(map[string][]string, len(tags))
	for _, tag := range tags {
		if tag.ParentTagID != "" {
			childrenByParent[tag.ParentTagID] = append(childrenByParent[tag.ParentTagID], tag.ID)
		}
	}
	for index := range tags {
		defaults := make([]string, 0, len(tags[index].ConnectionIDs)+len(childrenByParent[tags[index].ID]))
		for _, connectionID := range tags[index].ConnectionIDs {
			defaults = append(defaults, buildConnectionSidebarHostToken(connectionID))
		}
		for _, childID := range childrenByParent[tags[index].ID] {
			defaults = append(defaults, buildConnectionSidebarTagToken(childID))
		}
		childOrder := appendMissingConnectionSidebarTokens(tags[index].ChildOrder, defaults)
		orderedDirectConnections := make([]string, 0, len(tags[index].ConnectionIDs))
		for _, token := range childOrder {
			kind, id, _ := parseConnectionSidebarToken(token)
			if kind == "connection" {
				orderedDirectConnections = append(orderedDirectConnections, id)
			}
		}
		tags[index].ConnectionIDs = orderedDirectConnections
		tags[index].ChildOrder = childOrder
	}

	rootDefaults := make([]string, 0, len(tags)+len(orderedConnectionIDs))
	for _, tag := range tags {
		if tag.ParentTagID == "" {
			rootDefaults = append(rootDefaults, buildConnectionSidebarTagToken(tag.ID))
		}
	}
	for _, connectionID := range orderedConnectionIDs {
		if _, grouped := ownedConnectionIDs[connectionID]; grouped {
			continue
		}
		rootDefaults = append(rootDefaults, buildConnectionSidebarHostToken(connectionID))
	}
	return connection.ConnectionSidebarLayoutInput{
		ConnectionTags:         tags,
		SidebarRootOrder:       appendMissingConnectionSidebarTokens(input.SidebarRootOrder, rootDefaults),
		RootSortMode:           "manual",
		RootConnectionSortMode: normalizeConnectionSidebarConnectionSortMode(input.RootConnectionSortMode, input.RootSortMode),
	}, nil
}

var writeConnectionSidebarLayoutFileAtomicFunc = writeConnectionSidebarLayoutFileAtomic

func writeConnectionSidebarLayoutFileAtomic(targetPath string, payload []byte) error {
	directory := filepath.Dir(targetPath)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".connection_sidebar_layout_*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o644); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := appdata.AtomicReplaceFile(temporaryPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func (r *connectionSidebarLayoutRepository) Bootstrap(
	candidate connection.ConnectionSidebarLayoutInput,
) (connection.ConnectionSidebarLayout, bool, error) {
	result := emptyConnectionSidebarLayout()
	mutated := false
	err := r.withLock(func() error {
		current, err := r.loadUnlocked()
		if err != nil {
			return err
		}
		if current.Initialized {
			normalized, err := r.normalizeUnlocked(connection.ConnectionSidebarLayoutInput{
				ConnectionTags:         current.ConnectionTags,
				SidebarRootOrder:       current.SidebarRootOrder,
				RootSortMode:           current.RootSortMode,
				RootConnectionSortMode: current.RootConnectionSortMode,
			})
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(current.ConnectionTags, normalized.ConnectionTags) ||
				!reflect.DeepEqual(current.SidebarRootOrder, normalized.SidebarRootOrder) ||
				current.RootSortMode != normalized.RootSortMode ||
				current.RootConnectionSortMode != normalized.RootConnectionSortMode {
				if current.Revision == ^uint64(0) {
					return errors.New("connection sidebar layout revision overflow")
				}
				current.Revision++
				current.ConnectionTags = normalized.ConnectionTags
				current.SidebarRootOrder = normalized.SidebarRootOrder
				current.RootSortMode = normalized.RootSortMode
				current.RootConnectionSortMode = normalized.RootConnectionSortMode
				if err := r.saveUnlocked(current); err != nil {
					return err
				}
				mutated = true
			}
			result = current
			return nil
		}
		if len(candidate.ConnectionTags) == 0 {
			return nil
		}
		normalized, err := r.normalizeUnlocked(candidate)
		if err != nil {
			return err
		}
		if len(normalized.ConnectionTags) == 0 {
			return nil
		}
		result = connection.ConnectionSidebarLayout{
			Initialized:            true,
			Revision:               1,
			ConnectionTags:         normalized.ConnectionTags,
			SidebarRootOrder:       normalized.SidebarRootOrder,
			RootSortMode:           normalized.RootSortMode,
			RootConnectionSortMode: normalized.RootConnectionSortMode,
		}
		if err := r.saveUnlocked(result); err != nil {
			return err
		}
		mutated = true
		return nil
	})
	return result, mutated, err
}

// Load returns the latest authoritative layout for an already-running client.
// Normalization is applied only to the returned view: keeping the persisted
// revision and bytes unchanged lets a later Save use the same revision CAS and
// makes this operation safe for polling.
func (r *connectionSidebarLayoutRepository) Load() (connection.ConnectionSidebarLayout, error) {
	result := emptyConnectionSidebarLayout()
	err := r.withLock(func() error {
		current, err := r.loadUnlocked()
		if err != nil {
			return err
		}
		if !current.Initialized {
			result = current
			return nil
		}
		normalized, err := r.normalizeUnlocked(connection.ConnectionSidebarLayoutInput{
			ConnectionTags:         current.ConnectionTags,
			SidebarRootOrder:       current.SidebarRootOrder,
			RootSortMode:           current.RootSortMode,
			RootConnectionSortMode: current.RootConnectionSortMode,
		})
		if err != nil {
			return err
		}
		current.ConnectionTags = normalized.ConnectionTags
		current.SidebarRootOrder = normalized.SidebarRootOrder
		current.RootSortMode = normalized.RootSortMode
		current.RootConnectionSortMode = normalized.RootConnectionSortMode
		result = current
		return nil
	})
	return result, err
}

func (r *connectionSidebarLayoutRepository) Save(
	input connection.SaveConnectionSidebarLayoutInput,
) (connection.SaveConnectionSidebarLayoutResult, error) {
	result := connection.SaveConnectionSidebarLayoutResult{Layout: emptyConnectionSidebarLayout()}
	err := r.withLock(func() error {
		current, err := r.loadUnlocked()
		if err != nil {
			return err
		}
		if (!current.Initialized && input.ExpectedRevision != 0) ||
			(current.Initialized && input.ExpectedRevision != current.Revision) {
			if current.Initialized {
				normalized, normalizeErr := r.normalizeUnlocked(connection.ConnectionSidebarLayoutInput{
					ConnectionTags:         current.ConnectionTags,
					SidebarRootOrder:       current.SidebarRootOrder,
					RootSortMode:           current.RootSortMode,
					RootConnectionSortMode: current.RootConnectionSortMode,
				})
				if normalizeErr != nil {
					return normalizeErr
				}
				current.ConnectionTags = normalized.ConnectionTags
				current.SidebarRootOrder = normalized.SidebarRootOrder
				current.RootSortMode = normalized.RootSortMode
				current.RootConnectionSortMode = normalized.RootConnectionSortMode
			}
			result.Conflict = true
			result.Layout = current
			return nil
		}
		normalized, err := r.normalizeUnlocked(input.Layout)
		if err != nil {
			return err
		}
		nextRevision := uint64(1)
		if current.Initialized {
			if current.Revision == ^uint64(0) {
				return errors.New("connection sidebar layout revision overflow")
			}
			nextRevision = current.Revision + 1
		}
		result.Layout = connection.ConnectionSidebarLayout{
			Initialized:            true,
			Revision:               nextRevision,
			ConnectionTags:         normalized.ConnectionTags,
			SidebarRootOrder:       normalized.SidebarRootOrder,
			RootSortMode:           normalized.RootSortMode,
			RootConnectionSortMode: normalized.RootConnectionSortMode,
		}
		return r.saveUnlocked(result.Layout)
	})
	return result, err
}
