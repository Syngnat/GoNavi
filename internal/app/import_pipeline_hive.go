package app

import (
	"context"
	"fmt"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func effectiveHiveImportOptions(config connection.ConnectionConfig, options ImportFileOptions) ImportFileOptions {
	options.LosslessHive = options.LosslessHive || resolveDDLDBType(config) == "hive"
	return options
}

func (w *importDatabaseRowWriter) normalizeRowsForImport(rows []map[string]interface{}) []map[string]interface{} {
	// Hive STRING distinguishes blank text from NULL. Only the parser's explicit
	// null options may change that value; generic nullable-column coercion may not.
	if normalizeInsertSQLDialect(w.dbType) == "hive" {
		return cloneImportRows(rows)
	}
	return normalizeImportRowsForTargetColumns(rows, w.columnTypes)
}

func (w *importDatabaseRowWriter) preserveHiveWriteOutcome(ctx context.Context, err error) error {
	if err != nil && normalizeInsertSQLDialect(w.dbType) == "hive" && (db.IsAmbiguousWriteResponse(err) || ctx.Err() != nil) {
		return db.MarkWriteOutcomeUnknown(err)
	}
	return err
}

func buildHiveImportInsert(table string, columns []string, row map[string]interface{}, lookup importColumnTypeLookup) (string, error) {
	if len(lookup.columnOrder) == 0 {
		return "", fmt.Errorf("hive import requires complete target column metadata")
	}
	defs := make([]connection.ColumnDefinition, 0, len(lookup.columnOrder))
	for _, name := range lookup.columnOrder {
		defs = append(defs, connection.ColumnDefinition{Name: name, Type: lookup.Resolve(name)})
	}
	layout, err := newHiveInsertLayout(defs, lookup.partitionColumns)
	if err != nil {
		return "", err
	}
	selected := make(map[string]interface{}, len(columns))
	for _, name := range columns {
		if lookup.Resolve(name) == "" {
			return "", fmt.Errorf("unknown Hive import column %q", name)
		}
		selected[normalizeColumnName(name)] = row[name]
	}
	return layout.insert(table, selected)
}
