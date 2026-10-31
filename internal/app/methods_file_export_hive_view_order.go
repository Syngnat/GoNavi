package app

import (
	"context"
	"fmt"
	"sort"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func prepareHiveExportObjectOrder(ctx context.Context, instance db.Database, config connection.ConnectionConfig, database string, objects []string, views map[string]string) ([]string, error) {
	if resolveDDLDBType(config) != "hive" || len(views) < 2 {
		return objects, nil
	}
	definitions := make(map[string]string)
	for _, name := range objects {
		key := normalizeExportObjectKey(config, database, name)
		if _, isView := views[key]; !isView {
			continue
		}
		schema, table := normalizeMetadataSchemaAndTable(config, database, name)
		ddl, err := readHiveCreateStatement(ctx, instance, config, quoteTableIdentByType("hive", schema, table))
		if err != nil {
			return nil, err
		}
		definitions[key] = ddl
	}
	return orderHiveBackupViews(config, database, objects, views, definitions)
}

func orderHiveBackupViews(config connection.ConnectionConfig, database string, objects []string, views, definitions map[string]string) ([]string, error) {
	result := make([]string, 0, len(objects))
	selected := make(map[string]string)
	for _, name := range objects {
		key := normalizeExportObjectKey(config, database, name)
		if _, isView := views[key]; !isView {
			result = append(result, name)
		} else {
			selected[key] = name
		}
	}
	dependencies := make(map[string][]string, len(selected))
	for key := range selected {
		refs, err := hiveViewReferences(definitions[key], database)
		if err != nil {
			return nil, err
		}
		for _, ref := range refs {
			if _, exists := selected[ref]; exists {
				dependencies[key] = append(dependencies[key], ref)
			}
		}
		sort.Strings(dependencies[key])
	}
	state := make(map[string]byte, len(selected))
	var visit func(string) error
	visit = func(key string) error {
		if state[key] == 2 {
			return nil
		}
		if state[key] == 1 {
			return fmt.Errorf("Hive view dependency cycle prevents a safe restore order")
		}
		state[key] = 1
		for _, dependency := range dependencies[key] {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		state[key] = 2
		result = append(result, selected[key])
		return nil
	}
	keys := make([]string, 0, len(selected))
	for key := range selected {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := visit(key); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func hiveViewReferences(ddl, database string) ([]string, error) {
	tokens, err := hiveBackupTokens(ddl)
	if err != nil {
		return nil, err
	}
	var references []string
	for _, relation := range hiveBackupRelations(ddl, tokens) {
		if relation.ddlTarget {
			continue
		}
		schema := relation.database
		if schema == "" {
			schema = database
		}
		references = append(references, normalizeExportObjectKeyByParts(schema, relation.name))
	}
	return references, nil
}
