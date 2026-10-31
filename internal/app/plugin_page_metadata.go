package app

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// Metadata results are capped by the bridge contract so a large catalog cannot
// exhaust the WebView or the 256 KiB result budget in one call.
const (
	pluginPageMaxMetadataDatabases = 2000
	pluginPageMaxMetadataTables    = 5000
	pluginPageMaxMetadataColumns   = 5000
)

type pluginPageConnectionArguments struct {
	ConnectionID string `json:"connectionId"`
}

type pluginPageTablesArguments struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
}

type pluginPageColumnsArguments struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	Table        string `json:"table"`
}

type pluginPageTableSummary struct {
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
}

type pluginPageColumnSummary struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable *bool  `json:"nullable,omitempty"`
}

func pluginPageMetadataDatabases(ctx context.Context, a *App, request pluginPageRequest) (any, string) {
	var arguments pluginPageConnectionArguments
	if !decodePluginPageArguments(request.arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetDatabasesContext(ctx, config)
	if !result.Success {
		return nil, "internal"
	}
	names, ok := pluginPageMetadataNames(result.Data, "Database", pluginPageMaxMetadataDatabases)
	if !ok {
		return nil, "internal"
	}
	return names, ""
}

func pluginPageMetadataTables(ctx context.Context, a *App, request pluginPageRequest) (any, string) {
	var arguments pluginPageTablesArguments
	if !decodePluginPageArguments(request.arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	config, code := a.pluginPageConnectionConfig(arguments.ConnectionID)
	if code != "" {
		return nil, code
	}
	result := a.DBGetTablesContext(ctx, config, strings.TrimSpace(arguments.Database))
	if !result.Success {
		return nil, "internal"
	}
	tables, ok := pluginPageMetadataTablesFromData(result.Data)
	if !ok {
		return nil, "internal"
	}
	return tables, ""
}

func pluginPageMetadataColumns(ctx context.Context, a *App, request pluginPageRequest) (any, string) {
	var arguments pluginPageColumnsArguments
	if !decodePluginPageArguments(request.arguments, &arguments) {
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
	result := a.DBGetColumnsContext(ctx, config, strings.TrimSpace(arguments.Database), table)
	if !result.Success {
		return nil, "internal"
	}
	columns, ok := pluginPageMetadataColumnsFromData(result.Data)
	if !ok {
		return nil, "internal"
	}
	return columns, ""
}

// pluginPageMetadataNames accepts the historical map rows and the plain string
// rows some drivers return, preserving order and dropping blank names.
func pluginPageMetadataNames(data any, key string, limit int) ([]string, bool) {
	names := make([]string, 0, 32)
	switch rows := data.(type) {
	case []map[string]string:
		for _, row := range rows {
			if name := strings.TrimSpace(row[key]); name != "" {
				names = append(names, name)
			}
			if len(names) >= limit {
				break
			}
		}
	case []map[string]any:
		for _, row := range rows {
			if name := strings.TrimSpace(metadataString(row[key])); name != "" {
				names = append(names, name)
			}
			if len(names) >= limit {
				break
			}
		}
	case []string:
		for _, name := range rows {
			if name = strings.TrimSpace(name); name != "" {
				names = append(names, name)
			}
			if len(names) >= limit {
				break
			}
		}
	case nil:
		return names, true
	default:
		return nil, false
	}
	return names, true
}

func pluginPageMetadataTablesFromData(data any) ([]pluginPageTableSummary, bool) {
	tables := make([]pluginPageTableSummary, 0, 32)
	switch rows := data.(type) {
	case []map[string]string:
		for _, row := range rows {
			if name := strings.TrimSpace(row["Table"]); name != "" {
				tables = append(tables, pluginPageTableSummary{Name: name, Type: strings.TrimSpace(row["Type"])})
			}
			if len(tables) >= pluginPageMaxMetadataTables {
				break
			}
		}
	case []map[string]any:
		for _, row := range rows {
			if name := strings.TrimSpace(metadataString(row["Table"])); name != "" {
				tables = append(tables, pluginPageTableSummary{Name: name, Type: strings.TrimSpace(metadataString(row["Type"]))})
			}
			if len(tables) >= pluginPageMaxMetadataTables {
				break
			}
		}
	case []string:
		for _, name := range rows {
			if name = strings.TrimSpace(name); name != "" {
				tables = append(tables, pluginPageTableSummary{Name: name})
			}
			if len(tables) >= pluginPageMaxMetadataTables {
				break
			}
		}
	case nil:
		return tables, true
	default:
		return nil, false
	}
	return tables, true
}

func pluginPageMetadataColumnsFromData(data any) ([]pluginPageColumnSummary, bool) {
	columns := make([]pluginPageColumnSummary, 0, 16)
	switch items := data.(type) {
	case []connection.ColumnDefinition:
		for _, item := range items {
			columns = append(columns, pluginPageColumnSummary{Name: item.Name, Type: item.Type, Nullable: pluginPageNullableFlag(item.Nullable)})
			if len(columns) >= pluginPageMaxMetadataColumns {
				break
			}
		}
	case []map[string]any:
		for _, item := range items {
			columns = append(columns, pluginPageColumnSummary{
				Name:     metadataString(item["name"]),
				Type:     metadataString(item["type"]),
				Nullable: pluginPageNullableFlag(metadataString(item["nullable"])),
			})
			if len(columns) >= pluginPageMaxMetadataColumns {
				break
			}
		}
	case nil:
		return columns, true
	default:
		return nil, false
	}
	return columns, true
}

func pluginPageNullableFlag(value string) *bool {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "YES", "TRUE", "1":
		flag := true
		return &flag
	case "NO", "FALSE", "0":
		flag := false
		return &flag
	default:
		return nil
	}
}

func metadataString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return fmt.Sprint(typed)
	}
}
