package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

// SetColumnDefinitions validates the source wire representation, independently of target write types.
func (c *sqlInsertExportConsumer) SetColumnDefinitions(columns []connection.ColumnDefinition) error {
	if normalizeInsertSQLDialect(c.dbType) != "hive" {
		return nil
	}
	return validateHiveExportColumnTypes(columns)
}

func validateHiveExportColumnTypes(columns []connection.ColumnDefinition) error {
	for _, column := range columns {
		if err := hivesql.ValidateReadableType(column.Type); err != nil {
			return fmt.Errorf("Hive source column %q: %w; explicitly project HEX/BASE64 scalar values in source SQL if result metadata is incomplete", column.Name, err)
		}
	}
	return nil
}

func withHiveExportColumns(options ExportFileOptions, defs []connection.ColumnDefinition) ExportFileOptions {
	if normalizeInsertSQLDialect(options.InsertSQLDialect) != "hive" {
		return options
	}
	options.InsertSQLColumnOrder = make([]string, 0, len(defs))
	options.InsertSQLPartitionColumns = nil
	for _, def := range defs {
		options.InsertSQLColumnOrder = append(options.InsertSQLColumnOrder, def.Name)
		if strings.EqualFold(strings.TrimSpace(def.Extra), "partition") {
			options.InsertSQLPartitionColumns = append(options.InsertSQLPartitionColumns, def.Name)
		}
	}
	return options
}

func (c *sqlInsertExportConsumer) setHiveColumns(columns []string) error {
	if c.hiveLayout == nil {
		return fmt.Errorf("hive SQL export requires complete target column metadata")
	}
	available := make(map[string]bool, len(c.hiveLayout.dataColumns)+len(c.hiveLayout.partitions))
	for _, def := range c.hiveLayout.dataColumns {
		available[normalizeColumnName(def.Name)] = true
	}
	for _, def := range c.hiveLayout.partitions {
		available[normalizeColumnName(def.Name)] = true
	}
	resolved := make(map[string]string, len(columns))
	seen := make(map[string]bool, len(columns))
	for _, name := range columns {
		target := c.hiveTargetColumn(name)
		if !available[target] || seen[target] {
			return fmt.Errorf("query result column %q does not uniquely match the Hive INSERT target", name)
		}
		seen[target] = true
		resolved[name] = target
	}
	for _, def := range c.hiveLayout.partitions {
		if !seen[normalizeColumnName(def.Name)] {
			return fmt.Errorf("Hive partition column %q is missing from query result", def.Name)
		}
	}
	c.columns = append([]string(nil), columns...)
	c.hiveSourceTargets = resolved
	return nil
}

func (c *sqlInsertExportConsumer) hiveTargetColumn(source string) string {
	if target, ok := c.targetColumns[normalizeColumnName(source)]; ok {
		return normalizeColumnName(target)
	}
	key := normalizeColumnName(source)
	available := make(map[string]bool, len(c.hiveLayout.dataColumns)+len(c.hiveLayout.partitions))
	for _, defs := range [][]connection.ColumnDefinition{c.hiveLayout.dataColumns, c.hiveLayout.partitions} {
		for _, def := range defs {
			available[normalizeColumnName(def.Name)] = true
		}
	}
	if available[key] {
		return key
	}
	parts, err := hivesql.SplitTable(c.quotedTable)
	if err != nil || len(parts) == 0 {
		return key
	}
	prefixes := []string{normalizeColumnName(parts[len(parts)-1]) + "."}
	if len(parts) == 2 {
		prefixes = append(prefixes, normalizeColumnName(parts[0]+"."+parts[1])+".")
	}
	for _, prefix := range prefixes {
		if strings.HasPrefix(key, prefix) {
			name := strings.TrimPrefix(key, prefix)
			if available[name] {
				return name
			}
		}
	}
	return key
}

func (c *sqlInsertExportConsumer) consumeHiveRow(row map[string]interface{}) error {
	normalized := make(map[string]interface{}, len(c.columns))
	for _, name := range c.columns {
		normalized[c.hiveSourceTargets[name]] = row[name]
	}
	statement, err := c.hiveLayout.insert(c.quotedTable, normalized)
	if err != nil {
		return err
	}
	if _, err := c.w.WriteString(statement + ";\n"); err != nil {
		return err
	}
	c.rowCount++
	return nil
}
