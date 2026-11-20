package scriptlib

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"GoNavi-Wails/internal/scriptlimits"
)

func normalizeScriptInput(input SaveScriptInput) (SaveScriptInput, error) {
	if err := validateDisplayName(input.Name); err != nil {
		return input, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	input.ID = strings.TrimSpace(input.ID)
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	input.FolderID = strings.TrimSpace(input.FolderID)
	if utf8.RuneCountInString(input.Description) > MaxDescRunes {
		return input, fmt.Errorf("%w: description is too long", ErrInvalid)
	}
	if !utf8.ValidString(input.Code) {
		return input, fmt.Errorf("%w: script source must be valid UTF-8", ErrInvalid)
	}
	if len(input.Code) > MaxScriptBytes {
		return input, fmt.Errorf("%w: script exceeds %d bytes", ErrInvalid, MaxScriptBytes)
	}
	if strings.TrimSpace(input.Code) == "" {
		return input, fmt.Errorf("%w: script source is required", ErrInvalid)
	}
	visibility, err := normalizeVisibility(input.Visibility)
	if err != nil {
		return input, err
	}
	input.Visibility = visibility
	input.Connections, err = normalizeConnections(input.Connections)
	if err != nil {
		return input, err
	}
	input.Inputs, err = normalizeInputs(input.Inputs)
	if err != nil {
		return input, err
	}
	input.BatchSize = normalizeBounded(input.BatchSize, 1, 5000, 500)
	input.INListLimit = normalizeBounded(input.INListLimit, 1, 1000, 1000)
	input.RunLimits = normalizeRunLimits(input.RunLimits)
	if input.Visibility == VisibilityShared {
		input.Connections = sanitizeConnections(input.Connections)
		input.Inputs = sanitizeInputs(input.Inputs)
	}
	return input, nil
}

func normalizeFolderInput(input SaveFolderInput) (SaveFolderInput, error) {
	if err := validateDisplayName(input.Name); err != nil {
		return input, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	input.ID = strings.TrimSpace(input.ID)
	input.Name = strings.TrimSpace(input.Name)
	input.ParentID = strings.TrimSpace(input.ParentID)
	visibility, err := normalizeVisibility(input.Visibility)
	if err != nil {
		return input, err
	}
	input.Visibility = visibility
	return input, nil
}

func normalizeVisibility(value Visibility) (Visibility, error) {
	normalized := strings.ToLower(strings.TrimSpace(string(value)))
	switch normalized {
	case "", string(VisibilityPrivate):
		return VisibilityPrivate, nil
	case string(VisibilityShared):
		return VisibilityShared, nil
	default:
		return "", fmt.Errorf("%w: unsupported visibility %q", ErrInvalid, value)
	}
}

func validateDisplayName(value string) error {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) {
		return fmt.Errorf("name must be valid UTF-8")
	}
	if value == "" || utf8.RuneCountInString(value) > MaxNameRunes {
		return fmt.Errorf("name is required and must not exceed %d characters", MaxNameRunes)
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return fmt.Errorf("name contains control characters")
		}
	}
	return nil
}

func normalizeConnections(items []ConnectionBinding) ([]ConnectionBinding, error) {
	if len(items) > MaxBindings {
		return nil, fmt.Errorf("%w: too many connection bindings", ErrInvalid)
	}
	result := make([]ConnectionBinding, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		item.Alias = normalizeAlias(item.Alias)
		item.ConnectionID = strings.TrimSpace(item.ConnectionID)
		item.Database = strings.TrimSpace(item.Database)
		if item.Alias == "" {
			return nil, fmt.Errorf("%w: invalid connection alias %q", ErrInvalid, item.Alias)
		}
		if len([]rune(item.Alias)) > MaxAliasRunes {
			return nil, fmt.Errorf("%w: connection alias is too long", ErrInvalid)
		}
		if len(item.ConnectionID) > 1024 || len(item.Database) > 1024 {
			return nil, fmt.Errorf("%w: connection binding is too long", ErrInvalid)
		}
		if _, exists := seen[item.Alias]; exists {
			return nil, fmt.Errorf("%w: duplicate connection alias %q", ErrInvalid, item.Alias)
		}
		seen[item.Alias] = struct{}{}
		result = append(result, item)
	}
	return result, nil
}

func normalizeInputs(items []InputBinding) ([]InputBinding, error) {
	if len(items) > MaxBindings {
		return nil, fmt.Errorf("%w: too many input bindings", ErrInvalid)
	}
	result := make([]InputBinding, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		item.Alias = normalizeAlias(item.Alias)
		item.Path = strings.TrimSpace(item.Path)
		item.Reference = strings.TrimSpace(item.Reference)
		item.Name = strings.TrimSpace(item.Name)
		item.SheetName = strings.TrimSpace(item.SheetName)
		item.Encoding = strings.TrimSpace(item.Encoding)
		item.Delimiter = strings.TrimSpace(item.Delimiter)
		if item.Alias == "" {
			return nil, fmt.Errorf("%w: invalid input alias %q", ErrInvalid, item.Alias)
		}
		if len([]rune(item.Alias)) > MaxAliasRunes {
			return nil, fmt.Errorf("%w: input alias is too long", ErrInvalid)
		}
		if len(item.Path) > 8192 || len(item.Reference) > 1024 {
			return nil, fmt.Errorf("%w: input binding is too long", ErrInvalid)
		}
		if _, exists := seen[item.Alias]; exists {
			return nil, fmt.Errorf("%w: duplicate input alias %q", ErrInvalid, item.Alias)
		}
		seen[item.Alias] = struct{}{}
		if item.HeaderRow == 0 {
			item.HeaderRow = 1
		}
		if item.HeaderRow < 1 || item.HeaderRow > 1_000_000 {
			return nil, fmt.Errorf("%w: invalid input header row", ErrInvalid)
		}
		result = append(result, item)
	}
	return result, nil
}

func normalizeAlias(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	for index, char := range value {
		valid := char == '_' || char == '-' || char == '.' ||
			(char >= 'a' && char <= 'z') ||
			(char >= 'A' && char <= 'Z') ||
			(index > 0 && char >= '0' && char <= '9')
		if !valid {
			return ""
		}
	}
	return value
}

func normalizeBounded(value, minimum, maximum, fallback int) int {
	if value == 0 {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func normalizeStoredScript(items []Script) {
	for index := range items {
		item := &items[index]
		item.Owner = normalizeOwner(item.Owner)
		item.Visibility = normalizeStoredVisibility(item.Visibility)
		item.Connections, _ = normalizeConnections(item.Connections)
		item.Inputs, _ = normalizeInputs(item.Inputs)
		item.BatchSize = normalizeBounded(item.BatchSize, 1, 5000, 500)
		item.INListLimit = normalizeBounded(item.INListLimit, 1, 1000, 1000)
		item.RunLimits = normalizeRunLimits(item.RunLimits)
		item.CanEdit = false
		item.CanShare = false
		if item.Visibility == VisibilityShared {
			item.Connections = sanitizeConnections(item.Connections)
			item.Inputs = sanitizeInputs(item.Inputs)
		}
	}
}

func normalizeRunLimits(limits RunLimits) RunLimits {
	limits.TimeoutMs = clampNonZeroInt64(
		limits.TimeoutMs,
		scriptlimits.MinTimeoutMs,
		scriptlimits.MaxDesktopTimeoutMs,
	)
	limits.MaxDBCalls = clampNonZeroInt(
		limits.MaxDBCalls,
		1,
		scriptlimits.MaxDBCalls,
	)
	limits.MaxOutputRows = clampNonZeroInt(
		limits.MaxOutputRows,
		1,
		scriptlimits.MaxOutputRows,
	)
	limits.MemoryLimitBytes = clampNonZeroInt64(
		limits.MemoryLimitBytes,
		scriptlimits.MinMemoryLimitBytes,
		scriptlimits.MaxDesktopMemoryLimitBytes,
	)
	return limits
}

func clampNonZeroInt(value, minimum, maximum int) int {
	if value == 0 {
		return 0
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func clampNonZeroInt64(value, minimum, maximum int64) int64 {
	if value == 0 {
		return 0
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func normalizeStoredFolder(items []Folder) {
	for index := range items {
		items[index].Owner = normalizeOwner(items[index].Owner)
		items[index].Visibility = normalizeStoredVisibility(items[index].Visibility)
		items[index].CanEdit = false
		items[index].CanShare = false
	}
}

func validateStoredDocument(doc *diskDocument) error {
	if len(doc.Scripts) > MaxItems {
		return fmt.Errorf("script library contains too many scripts")
	}
	if len(doc.Folders) > MaxItems {
		return fmt.Errorf("script library contains too many folders")
	}
	scriptIDs := make(map[string]struct{}, len(doc.Scripts))
	for _, script := range doc.Scripts {
		scriptID := strings.TrimSpace(script.ID)
		if scriptID == "" {
			return fmt.Errorf("script library contains a script without an id")
		}
		if _, duplicate := scriptIDs[scriptID]; duplicate {
			return fmt.Errorf("script library contains duplicate script id %q", scriptID)
		}
		scriptIDs[scriptID] = struct{}{}
		if err := validateDisplayName(script.Name); err != nil {
			return fmt.Errorf("invalid stored script %s name: %w", scriptID, err)
		}
		if !utf8.ValidString(script.Code) || strings.TrimSpace(script.Code) == "" {
			return fmt.Errorf("invalid stored script %s source", scriptID)
		}
		if len(script.Code) > MaxScriptBytes {
			return fmt.Errorf("stored script %s exceeds %d bytes", scriptID, MaxScriptBytes)
		}
	}
	folderIDs := make(map[string]struct{}, len(doc.Folders))
	for _, folder := range doc.Folders {
		folderID := strings.TrimSpace(folder.ID)
		if folderID == "" {
			return fmt.Errorf("script library contains a folder without an id")
		}
		if _, duplicate := folderIDs[folderID]; duplicate {
			return fmt.Errorf("script library contains duplicate folder id %q", folderID)
		}
		folderIDs[folderID] = struct{}{}
		if err := validateDisplayName(folder.Name); err != nil {
			return fmt.Errorf("invalid stored folder %s name: %w", folderID, err)
		}
	}
	return nil
}

func cloneConnections(items []ConnectionBinding) []ConnectionBinding {
	return append([]ConnectionBinding(nil), items...)
}

func cloneInputs(items []InputBinding) []InputBinding {
	return append([]InputBinding(nil), items...)
}

func findScript(items []Script, id string) int {
	id = strings.TrimSpace(id)
	if id == "" {
		return -1
	}
	for index := range items {
		if items[index].ID == id {
			return index
		}
	}
	return -1
}

func findFolder(items []Folder, id string) int {
	id = strings.TrimSpace(id)
	if id == "" {
		return -1
	}
	for index := range items {
		if items[index].ID == id {
			return index
		}
	}
	return -1
}
