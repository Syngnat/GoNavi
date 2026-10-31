package sync

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

// Result labels and driver type enrichment share one source-provenance proof.
// This only renames known direct output labels; it never fills missing types
// from a target schema, and it preserves literal dots in explicit aliases.
func hiveSimpleQueryLabelContext(query string) (string, []connection.ColumnDefinition, []string, bool) {
	projection, proven := hivesql.DirectSourceProjection(query)
	if !proven || projection.Table == "" {
		// A CTE or constant projection carries explicit types but no label source;
		// renaming qualified labels would need a table identity we do not have.
		return "", nil, nil, false
	}
	table := hivesql.QuoteIdentifier(projection.Table)
	if projection.Database != "" {
		table = hivesql.QuoteIdentifier(projection.Database) + "." + table
	}
	prefixes := []string{projection.Table}
	if projection.Alias != "" {
		prefixes = append(prefixes, projection.Alias)
	}
	if projection.Wildcard {
		return table, nil, prefixes, true
	}
	fields := make([]connection.ColumnDefinition, 0, len(projection.Columns))
	for _, column := range projection.Columns {
		name := column.Name
		if column.Alias != "" {
			name = column.Alias
		}
		fields = append(fields, connection.ColumnDefinition{Name: name})
	}
	return table, fields, prefixes, len(fields) > 0
}

func streamHiveSourceQueryRows(ctx context.Context, config SyncConfig, database db.Database, batchSize int, consume func([]map[string]interface{}) error, validate ...func([]connection.ColumnDefinition) error) ([]string, error) {
	query := strings.TrimSpace(config.SourceQuery)
	table, fields, prefixes, proven := hiveSimpleQueryLabelContext(query)
	var wrap func(db.QueryStreamConsumer) db.QueryStreamConsumer
	if proven {
		if len(fields) == 0 {
			parts, err := hivesql.SplitTable(table)
			if err != nil {
				return nil, err
			}
			schema, name := selectedSyncSourceDatabase(config), parts[len(parts)-1]
			if len(parts) == 2 {
				schema = parts[0]
			}
			if provider, ok := database.(db.ColumnDefinitionContexter); ok {
				fields, err = provider.GetColumnsContext(ctx, schema, name)
			} else {
				fields, err = database.GetColumns(schema, name)
			}
			if err != nil {
				return nil, err
			}
		}
		if len(fields) > 0 {
			wrap = func(next db.QueryStreamConsumer) db.QueryStreamConsumer {
				return &hiveTableLabelConsumer{next: next, table: table, fields: fields, prefixes: prefixes}
			}
		}
	}
	return streamHiveRowsWithConsumer(ctx, database, query, batchSize, consume, wrap, validate...)
}
