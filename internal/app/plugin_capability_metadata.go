package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// pluginCapabilityConnectionTest tests a saved connection through the host
// driver. The page supplies only the saved id; the resolved config never leaves
// the process.
func pluginCapabilityConnectionTest(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageConnectionArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.TestConnection(config)
	return map[string]any{
		"success": result.Success,
		"message": result.Message,
	}, ""
}

func pluginCapabilityMetadataViews(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageTablesArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetViewsContext(ctx, config, strings.TrimSpace(arguments.Database))
	if !result.Success {
		return nil, "internal"
	}
	names, ok := pluginPageMetadataNames(result.Data, "View", pluginPageMaxMetadataTables)
	if !ok {
		return nil, "internal"
	}
	return names, ""
}

func pluginCapabilityMetadataObjects(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageTablesArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetObjectsContext(ctx, config, strings.TrimSpace(arguments.Database))
	if !result.Success {
		return nil, "internal"
	}
	objects, ok := result.Data.([]connection.DatabaseObject)
	if !ok {
		if result.Data == nil {
			return []connection.DatabaseObject{}, ""
		}
		return nil, "internal"
	}
	return pluginCapabilityLimitSlice(objects, pluginPageMaxMetadataTables), ""
}

func pluginCapabilityMetadataAllColumns(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageTablesArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetAllColumnsContext(ctx, config, strings.TrimSpace(arguments.Database))
	if !result.Success {
		return nil, "internal"
	}
	columns, ok := result.Data.([]connection.ColumnDefinitionWithTable)
	if !ok {
		if result.Data == nil {
			return []connection.ColumnDefinitionWithTable{}, ""
		}
		return nil, "internal"
	}
	return pluginCapabilityLimitSlice(columns, pluginPageMaxMetadataColumns), ""
}

func pluginCapabilityMetadataIndexes(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageColumnsArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	table := strings.TrimSpace(arguments.Table)
	if table == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetIndexesContext(ctx, config, strings.TrimSpace(arguments.Database), table)
	if !result.Success {
		return nil, "internal"
	}
	indexes, ok := result.Data.([]connection.IndexDefinition)
	if !ok {
		if result.Data == nil {
			return []connection.IndexDefinition{}, ""
		}
		return nil, "internal"
	}
	return pluginCapabilityLimitSlice(indexes, pluginPageMaxMetadataColumns), ""
}

func pluginCapabilityMetadataForeignKeys(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageColumnsArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	table := strings.TrimSpace(arguments.Table)
	if table == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetForeignKeysContext(ctx, config, strings.TrimSpace(arguments.Database), table)
	if !result.Success {
		return nil, "internal"
	}
	foreignKeys, ok := result.Data.([]connection.ForeignKeyDefinition)
	if !ok {
		if result.Data == nil {
			return []connection.ForeignKeyDefinition{}, ""
		}
		return nil, "internal"
	}
	return pluginCapabilityLimitSlice(foreignKeys, pluginPageMaxMetadataColumns), ""
}

func pluginCapabilityMetadataTriggers(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageColumnsArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	table := strings.TrimSpace(arguments.Table)
	if table == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetTriggersContext(ctx, config, strings.TrimSpace(arguments.Database), table)
	if !result.Success {
		return nil, "internal"
	}
	triggers, ok := result.Data.([]connection.TriggerDefinition)
	if !ok {
		if result.Data == nil {
			return []connection.TriggerDefinition{}, ""
		}
		return nil, "internal"
	}
	return pluginCapabilityLimitSlice(triggers, pluginPageMaxMetadataColumns), ""
}

func pluginCapabilityMetadataCreateStatement(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageColumnsArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	table := strings.TrimSpace(arguments.Table)
	if table == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBShowCreateTableContext(ctx, config, strings.TrimSpace(arguments.Database), table)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

type pluginCapabilityTableInfoArguments struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	Schema       string `json:"schema,omitempty"`
	Table        string `json:"table"`
}

func pluginCapabilityMetadataTableInfo(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilityTableInfoArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	table := strings.TrimSpace(arguments.Table)
	if table == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetTableInfo(config, strings.TrimSpace(arguments.Database), strings.TrimSpace(arguments.Schema), table)
	if !result.Success {
		return nil, "internal"
	}
	return map[string]any{
		"supported": result.Data != nil,
		"message":   result.Message,
		"data":      result.Data,
	}, ""
}

func pluginCapabilityMetadataServerVersion(ctx context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageConnectionArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetServerVersionContext(ctx, config)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityMetadataTableExists(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageColumnsArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	table := strings.TrimSpace(arguments.Table)
	if table == "" {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBTableExists(config, strings.TrimSpace(arguments.Database), table)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilityMetadataDatabaseForeignKeys(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageTablesArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetDatabaseForeignKeys(config, strings.TrimSpace(arguments.Database))
	if !result.Success {
		return nil, "internal"
	}
	if result.Data == nil {
		return map[string][]connection.ForeignKeyDefinition{}, ""
	}
	return result.Data, ""
}

func pluginCapabilityMetadataCharsets(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageConnectionArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.ListDatabaseCharsets(config)
	if !result.Success {
		return nil, "internal"
	}
	charsets, ok := result.Data.([]connection.DatabaseCharset)
	if !ok {
		if result.Data == nil {
			return []connection.DatabaseCharset{}, ""
		}
		return nil, "internal"
	}
	return pluginCapabilityLimitSlice(charsets, pluginPageMaxMetadataColumns), ""
}

func pluginCapabilityMetadataCollations(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginPageConnectionArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.ListDatabaseCollations(config)
	if !result.Success {
		return nil, "internal"
	}
	collations, ok := result.Data.([]connection.DatabaseCollation)
	if !ok {
		if result.Data == nil {
			return []connection.DatabaseCollation{}, ""
		}
		return nil, "internal"
	}
	return pluginCapabilityLimitSlice(collations, pluginPageMaxMetadataColumns), ""
}

func pluginCapabilityLimitSlice[T any](items []T, limit int) []T {
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return ensureNonNilSlice(items)
}
