package app

import (
	"bufio"
	"context"
	"fmt"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

func writeHiveSQLDatabaseContext(w *bufio.Writer, database string, includeContext, createDatabase bool) error {
	if _, err := w.WriteString("-- Dialect: hive\n\n"); err != nil {
		return err
	}
	if !includeContext || strings.TrimSpace(database) == "" {
		return nil
	}
	quoted := hivesql.QuoteIdentifier(database)
	if createDatabase {
		if _, err := w.WriteString("CREATE DATABASE IF NOT EXISTS " + quoted + ";\n\n"); err != nil {
			return err
		}
	}
	_, err := w.WriteString("USE " + quoted + ";\n\n")
	return err
}

func readHiveCreateStatement(ctx context.Context, instance db.Database, config connection.ConnectionConfig, table string) (string, error) {
	rows, columns, err := queryDataForExportWithContext(ctx, instance, config, "SHOW CREATE TABLE "+hivesql.QuoteTable(table))
	if err != nil {
		return "", fmt.Errorf("read Hive SHOW CREATE TABLE: %w", err)
	}
	if len(columns) != 1 {
		return "", fmt.Errorf("Hive SHOW CREATE TABLE must return one DDL column")
	}
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		value := row[columns[0]]
		if value == nil {
			continue
		}
		if bytes, ok := value.([]byte); ok {
			lines = append(lines, string(bytes))
		} else {
			lines = append(lines, fmt.Sprint(value))
		}
	}
	ddl := strings.TrimSpace(strings.Join(lines, "\n"))
	if keyword, _ := nextSQLKeyword(ddl, 0); keyword != "create" {
		return "", fmt.Errorf("Hive SHOW CREATE TABLE did not return a CREATE statement")
	}
	return ddl, nil
}

func loadHiveExportColumns(ctx context.Context, instance db.Database, database, table string) ([]connection.ColumnDefinition, error) {
	if getter, ok := instance.(db.ColumnDefinitionContexter); ok {
		return getter.GetColumnsContext(ctx, database, table)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	defs, err := instance.GetColumns(database, table)
	if err == nil {
		err = ctx.Err()
	}
	return defs, err
}

func dumpHiveTableSQL(ctx context.Context, w *bufio.Writer, instance db.Database, config connection.ConnectionConfig, database, table string, includeSchema, includeData, includeContext bool) error {
	schema, name := normalizeMetadataSchemaAndTable(config, database, table)
	qualified := quoteTableIdentByType("hive", schema, name)
	ddl, err := readHiveCreateStatement(ctx, instance, config, qualified)
	if err != nil {
		return err
	}
	if _, err := w.WriteString("\n-- Hive object: " + strings.ReplaceAll(qualified, "\n", " ") + "\n\n"); err != nil {
		return err
	}
	if includeSchema {
		backupDDL, err := prepareHiveBackupDDL(ddl, schema, includeContext)
		if err != nil {
			return err
		}
		if _, err := w.WriteString(ensureSQLTerminator(backupDDL) + "\n\n"); err != nil {
			return err
		}
	}
	if isCreateViewStatement(ddl) {
		return nil
	}
	defs, err := loadHiveExportColumns(ctx, instance, schema, name)
	if err != nil {
		return fmt.Errorf("read Hive export columns: %w", err)
	}
	if includeData {
		if err := validateHiveExportColumnTypes(defs); err != nil {
			return err
		}
	}
	layout, err := newHiveInsertLayout(defs, nil)
	if err != nil {
		return err
	}
	outputTable := qualified
	if includeContext {
		outputTable = hivesql.QuoteIdentifier(name)
	}
	if includeSchema && len(layout.partitions) > 0 {
		consumer := &hivePartitionExportConsumer{w: w, table: outputTable, partitions: layout.partitions, family: hiveExportFamily(config)}
		if err := streamQueryDataForExportWithContext(ctx, instance, config, "SHOW PARTITIONS "+qualified, consumer); err != nil {
			return fmt.Errorf("export Hive partition definitions: %w", err)
		}
	}
	if !includeData {
		return nil
	}
	consumer := &sqlInsertExportConsumer{w: w, dbType: "hive", quotedTable: outputTable, hiveLayout: layout}
	if err := streamQueryDataForExportWithContext(ctx, instance, config, "SELECT * FROM "+qualified, consumer); err != nil {
		return err
	}
	if consumer.rowCount == 0 {
		_, err = w.WriteString("-- (0 rows)\n")
	}
	return err
}

type hivePartitionExportConsumer struct {
	w              *bufio.Writer
	table          string
	partitions     []connection.ColumnDefinition
	column         string
	family         string
	nativeColumns  []string
	locationColumn string
	hasStatistics  bool
}

func (c *hivePartitionExportConsumer) SetColumns(columns []string) error {
	if c.family == "impala" {
		return c.setNativePartitionColumns(columns)
	}
	if len(columns) != 1 {
		return fmt.Errorf("Hive SHOW PARTITIONS must return one column")
	}
	c.column = columns[0]
	return nil
}

func (c *hivePartitionExportConsumer) ConsumeRow(row map[string]interface{}) error {
	if c.family == "impala" {
		clause, skip, err := c.nativePartitionClause(row)
		if err != nil || skip {
			return err
		}
		_, err = c.w.WriteString("ALTER TABLE " + c.table + " ADD IF NOT EXISTS " + clause + ";\n")
		return err
	}
	value := row[c.column]
	var path string
	if raw, ok := value.([]byte); ok {
		path = string(raw)
	} else if value != nil {
		path = fmt.Sprint(value)
	}
	clause, err := hivePartitionClauseFromPath(path, c.partitions)
	if err != nil {
		return err
	}
	_, err = c.w.WriteString("ALTER TABLE " + c.table + " ADD IF NOT EXISTS " + clause + ";\n")
	return err
}

func hivePartitionClauseFromPath(path string, defs []connection.ColumnDefinition) (string, error) {
	parts := strings.Split(path, "/")
	if len(parts) != len(defs) {
		return "", fmt.Errorf("invalid Hive partition path: expected %d keys", len(defs))
	}
	assignments := make([]string, 0, len(parts))
	for i, part := range parts {
		key, value, found := strings.Cut(part, "=")
		decodedKey, keyErr := url.PathUnescape(key)
		decodedValue, valueErr := url.PathUnescape(value)
		if !found || keyErr != nil || valueErr != nil || strings.Contains(decodedValue, "${") || !strings.EqualFold(decodedKey, defs[i].Name) {
			return "", fmt.Errorf("invalid Hive partition path at key %q", defs[i].Name)
		}
		assignments = append(assignments, hivesql.QuoteIdentifier(defs[i].Name)+"="+hivesql.QuoteString(decodedValue))
	}
	return "PARTITION (" + strings.Join(assignments, ", ") + ")", nil
}
