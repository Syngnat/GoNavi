package sync

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

type hiveTableLabelConsumer struct {
	next      db.QueryStreamConsumer
	table     string
	fields    []connection.ColumnDefinition
	prefixes  []string
	raw       []string
	canonical []string
}

// Only a proven single table may remove a qualified HS2 label. Names from
// arbitrary SQL are not suffix-guessed, since that would corrupt JOIN aliases.
func canonicalHiveTableLabels(table string, fields []connection.ColumnDefinition, prefixes, labels []string) ([]string, error) {
	parts, err := hivesql.SplitTable(table)
	if err != nil {
		return nil, err
	}
	allowed := append([]string(nil), prefixes...)
	allowed = append(allowed, strings.Join(parts, "."), parts[len(parts)-1])
	canonical := make([]string, len(labels))
	seen := make(map[string]struct{}, len(labels))
	for i, label := range labels {
		matches := make(map[string]string)
		for _, column := range fields {
			if strings.EqualFold(label, column.Name) {
				matches[strings.ToLower(column.Name)] = column.Name
			}
			for _, prefix := range allowed {
				if strings.EqualFold(label, prefix+"."+column.Name) {
					matches[strings.ToLower(column.Name)] = column.Name
				}
			}
		}
		if len(matches) != 1 {
			return nil, fmt.Errorf("Hive result label %q is unknown or ambiguous for table %s; use explicit unique aliases", label, table)
		}
		for key, name := range matches {
			if _, duplicate := seen[key]; duplicate {
				return nil, fmt.Errorf("Hive result labels resolve to duplicate column %q", name)
			}
			seen[key] = struct{}{}
			canonical[i] = name
		}
	}
	return canonical, nil
}

func (c *hiveTableLabelConsumer) SetColumns(columns []string) error {
	canonical, err := canonicalHiveTableLabels(c.table, c.fields, c.prefixes, columns)
	if err != nil {
		return err
	}
	c.raw, c.canonical = append([]string(nil), columns...), canonical
	return c.next.SetColumns(canonical)
}

func (c *hiveTableLabelConsumer) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	names := make([]string, len(columns))
	for i, column := range columns {
		names[i] = column.Name
	}
	canonical, err := canonicalHiveTableLabels(c.table, c.fields, c.prefixes, names)
	if err != nil {
		return err
	}
	definitions := append([]connection.ColumnDefinition(nil), columns...)
	for i := range definitions {
		definitions[i].Name = canonical[i]
	}
	if typed, ok := c.next.(interface {
		SetColumnDefinitions([]connection.ColumnDefinition) error
	}); ok {
		return typed.SetColumnDefinitions(definitions)
	}
	return nil
}

func (c *hiveTableLabelConsumer) ConsumeRow(row map[string]interface{}) error {
	if len(c.raw) == 0 {
		return fmt.Errorf("Hive result row arrived before label metadata")
	}
	canonical := make(map[string]interface{}, len(c.raw))
	for i, raw := range c.raw {
		value, exists := row[raw]
		if !exists {
			return fmt.Errorf("Hive result row is missing label %q", raw)
		}
		canonical[c.canonical[i]] = value
	}
	return c.next.ConsumeRow(canonical)
}

func streamHiveTableRows(ctx context.Context, database db.Database, query, table string, fields []connection.ColumnDefinition, batchSize int, consume func([]map[string]interface{}) error) ([]string, error) {
	wrap := func(next db.QueryStreamConsumer) db.QueryStreamConsumer {
		return &hiveTableLabelConsumer{next: next, table: table, fields: fields}
	}
	return streamHiveRowsWithConsumer(ctx, database, query, batchSize, consume, wrap)
}

func querySyncTableSnapshotContext(ctx context.Context, database db.Database, dbType, table string, fields []connection.ColumnDefinition, queries ...string) ([]map[string]interface{}, []string, error) {
	query := "SELECT * FROM " + quoteQualifiedIdentByType(dbType, table)
	if len(queries) > 0 {
		query = queries[0]
	}
	if normalizeMigrationDBType(dbType) != "hive" {
		return querySyncDatabaseContext(ctx, database, query)
	}
	var rows []map[string]interface{}
	columns, err := streamHiveTableRows(ctx, database, query, table, fields, defaultSyncReadPageSize, func(batch []map[string]interface{}) error { rows = append(rows, batch...); return nil })
	return rows, columns, err
}
