package app

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func listExportViewLookup(ctx context.Context, instance db.Database, config connection.ConnectionConfig, database string) (map[string]string, error) {
	if resolveDDLDBType(config) == "hive" {
		return listHiveExportViews(ctx, instance, config, database)
	}
	return listViewNameLookup(instance, config, database), nil
}

func listHiveExportViews(ctx context.Context, instance db.Database, config connection.ConnectionConfig, database string) (map[string]string, error) {
	provider, ok := instance.(db.HiveViewProvider)
	if !ok {
		return nil, fmt.Errorf("Hive export requires protocol-native view metadata")
	}
	names, err := provider.HiveViews(ctx, database)
	if err != nil {
		return nil, fmt.Errorf("list Hive export views: %w", err)
	}
	lookup := make(map[string]string, len(names))
	for _, name := range names {
		if strings.TrimSpace(name) == "" {
			continue
		}
		key := normalizeExportObjectKey(config, database, name)
		lookup[key] = name
	}
	return lookup, nil
}
