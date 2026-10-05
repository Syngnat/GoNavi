//go:build gonavi_full_drivers || gonavi_sqlserver_driver

package db

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

const sqlServerMetadataQueryTimeout = 60 * time.Second

func sqlServerMetadataQueryContext(database any) (context.Context, context.CancelFunc) {
	ctx := metadataContextFor(database)
	if _, hasDeadline := ctx.Deadline(); hasDeadline {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, sqlServerMetadataQueryTimeout)
}

func (s *SqlServerDB) queryEngineEdition() (int, error) {
	data, _, err := s.Query(sqlServerEngineEditionQuery())
	if err != nil {
		return 0, err
	}
	if len(data) == 0 {
		return 0, fmt.Errorf("empty ENGINEEDITION result")
	}
	raw, ok := data[0]["edition"]
	if !ok {
		return 0, fmt.Errorf("missing ENGINEEDITION column")
	}
	edition, ok := sqlServerIntFromValue(raw)
	if !ok {
		return 0, fmt.Errorf("invalid ENGINEEDITION value %v", raw)
	}
	return edition, nil
}

func (s *SqlServerDB) currentDatabaseNames() ([]string, error) {
	data, _, err := s.Query(sqlServerCurrentDatabaseQuery())
	if err != nil {
		return nil, err
	}
	names := collectSQLServerNameColumn(data)
	if len(names) == 0 {
		return nil, fmt.Errorf("empty current database name")
	}
	return names, nil
}

func (s *SqlServerDB) GetDatabases() ([]string, error) {
	if edition, err := s.queryEngineEdition(); err == nil && sqlServerUsesCurrentDatabaseCatalogOnly(edition) {
		current, currentErr := s.currentDatabaseNames()
		if currentErr != nil {
			return nil, currentErr
		}
		if len(current) == 1 && strings.EqualFold(current[0], "master") {
			data, _, listErr := s.Query(sqlServerAccessibleDatabasesQuery())
			if listErr == nil {
				if names := collectSQLServerNameColumn(data); len(names) > 0 {
					return names, nil
				}
			}
		}
		return current, nil
	}

	data, _, err := s.Query(sqlServerAccessibleDatabasesQuery())
	if err == nil {
		if names := collectSQLServerNameColumn(data); len(names) > 0 {
			return names, nil
		}
	}
	names, fallbackErr := s.currentDatabaseNames()
	if fallbackErr != nil {
		if err != nil {
			return nil, err
		}
		return nil, fallbackErr
	}
	return names, nil
}

func (s *SqlServerDB) GetTables(dbName string) ([]string, error) {
	// The DSN already selects dbName. Azure SQL Database rejects or hangs on
	// three-part catalog names such as [dbName].sys.tables.
	data, _, err := s.Query(sqlServerListTablesQuery())
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		schema, okSchema := row["schema_name"]
		name, okName := row["table_name"]
		if okSchema && okName {
			tables = append(tables, formatSQLServerTableMetadataName(fmt.Sprintf("%v", schema), fmt.Sprintf("%v", name)))
			continue
		}
		if okName {
			tables = append(tables, fmt.Sprintf("%v", name))
		}
	}
	return tables, nil
}

// formatSQLServerTableMetadataName keeps metadata round-trippable when a
// schema or table contains a dot (or a bracket). Plain names retain the
// historical schema.table representation used by the sidebar.
func formatSQLServerTableMetadataName(schema, table string) string {
	if schema == "" {
		return table
	}
	if strings.ContainsAny(schema, ".[]") || strings.ContainsAny(table, ".[]") ||
		strings.TrimSpace(schema) != schema || strings.TrimSpace(table) != table {
		return fmt.Sprintf("[%s].[%s]", quoteBracket(schema), quoteBracket(table))
	}
	return schema + "." + table
}

func (s *SqlServerDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", localizedDatabaseRuntimeError("db.backend.error.sqlserver_create_statement_unsupported", nil)
}

// splitSQLServerTableName accepts both schema.table and delimited SQL Server
// identifiers. In particular, dots inside [Sales.Data] are part of the table
// name and must not be treated as a schema separator.
func splitSQLServerTableName(raw string) (schema string, table string) {
	schema = "dbo"
	table = strings.TrimSpace(raw)
	parsedSchema, parsedTable := SplitSQLQualifiedName(table)
	if parsedTable == "" {
		return schema, table
	}
	if parsedSchema != "" {
		schema = parsedSchema
	}
	return schema, parsedTable
}

func (s *SqlServerDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	schema, table := splitSQLServerTableName(tableName)

	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }

	query := fmt.Sprintf(`
SELECT
    c.name AS column_name,
    t.name + CASE
        WHEN t.name IN ('varchar', 'nvarchar', 'char', 'nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'MAX' ELSE CAST(CASE WHEN t.name IN ('nvarchar', 'nchar') THEN c.max_length / 2 ELSE c.max_length END AS VARCHAR) END + ')'
        WHEN t.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS VARCHAR) + ',' + CAST(c.scale AS VARCHAR) + ')'
        ELSE ''
    END AS data_type,
    CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS is_nullable,
    dc.definition AS column_default,
    CONVERT(nvarchar(4000), ep.value) AS comment,
    CASE WHEN pk.column_id IS NOT NULL THEN 'PRI' ELSE '' END AS column_key,
    CASE WHEN c.is_identity = 1 THEN 'auto_increment' ELSE '' END AS extra
FROM sys.columns c
JOIN sys.types t ON c.user_type_id = t.user_type_id
JOIN sys.tables tb ON c.object_id = tb.object_id
JOIN sys.schemas s ON tb.schema_id = s.schema_id
LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
LEFT JOIN (
    SELECT ic.object_id, ic.column_id
    FROM sys.index_columns ic
    JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    WHERE i.is_primary_key = 1
) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
WHERE s.name = '%s' AND tb.name = '%s'
ORDER BY c.column_id`,
		esc(schema), esc(table))

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var columns []connection.ColumnDefinition
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     fmt.Sprintf("%v", row["column_name"]),
			Type:     fmt.Sprintf("%v", row["data_type"]),
			Nullable: fmt.Sprintf("%v", row["is_nullable"]),
			Key:      fmt.Sprintf("%v", row["column_key"]),
			Extra:    fmt.Sprintf("%v", row["extra"]),
			Comment:  "",
		}

		if v, ok := row["comment"]; ok && v != nil {
			col.Comment = fmt.Sprintf("%v", v)
		}

		if v, ok := row["column_default"]; ok && v != nil {
			def := fmt.Sprintf("%v", v)
			col.Default = &def
		}

		columns = append(columns, col)
	}
	return columns, nil
}

func (s *SqlServerDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := `
SELECT s.name AS schema_name, t.name AS table_name, c.name AS column_name, tp.name AS data_type, CONVERT(nvarchar(4000), ep.value) AS comment
FROM sys.columns c
JOIN sys.tables t ON c.object_id = t.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.types tp ON c.user_type_id = tp.user_type_id
LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
WHERE t.type = 'U'
ORDER BY s.name, t.name, c.column_id`

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		schema := fmt.Sprintf("%v", row["schema_name"])
		table := fmt.Sprintf("%v", row["table_name"])
		tableName := formatSQLServerTableMetadataName(schema, table)

		col := connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      fmt.Sprintf("%v", row["column_name"]),
			Type:      fmt.Sprintf("%v", row["data_type"]),
		}
		if v, ok := row["comment"]; ok && v != nil {
			col.Comment = fmt.Sprintf("%v", v)
		}
		cols = append(cols, col)
	}
	return cols, nil
}

func (s *SqlServerDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	schema, table := splitSQLServerTableName(tableName)

	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }

	query := fmt.Sprintf(`
SELECT
    i.name AS index_name,
    c.name AS column_name,
    i.is_unique,
    ic.key_ordinal AS seq_in_index,
    i.type_desc AS index_type
FROM sys.indexes i
JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
JOIN sys.tables t ON i.object_id = t.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = '%s' AND t.name = '%s' AND i.name IS NOT NULL
  AND i.is_primary_key = 0
  AND ic.is_included_column = 0
ORDER BY i.name, ic.key_ordinal`,
		esc(schema), esc(table))

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var indexes []connection.IndexDefinition
	for _, row := range data {
		isUnique := false
		if v, ok := row["is_unique"]; ok && v != nil {
			switch val := v.(type) {
			case bool:
				isUnique = val
			case int64:
				isUnique = val == 1
			}
		}

		nonUnique := 1
		if isUnique {
			nonUnique = 0
		}

		seq := 0
		if v, ok := row["seq_in_index"]; ok && v != nil {
			switch val := v.(type) {
			case int:
				seq = val
			case int64:
				seq = int(val)
			}
		}

		indexType := "NONCLUSTERED"
		if v, ok := row["index_type"]; ok && v != nil {
			indexType = strings.ToUpper(fmt.Sprintf("%v", v))
		}

		idx := connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["index_name"]),
			ColumnName: fmt.Sprintf("%v", row["column_name"]),
			NonUnique:  nonUnique,
			SeqInIndex: seq,
			IndexType:  indexType,
		}
		indexes = append(indexes, idx)
	}
	return indexes, nil
}

func (s *SqlServerDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	schema, table := splitSQLServerTableName(tableName)

	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }

	query := fmt.Sprintf(`
SELECT
    fk.name AS constraint_name,
    c.name AS column_name,
    rs.name AS foreign_schema,
    rt.name AS foreign_table,
    rc.name AS foreign_column
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
JOIN sys.tables t ON fk.parent_object_id = t.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
JOIN sys.schemas rs ON rt.schema_id = rs.schema_id
JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
WHERE s.name = '%s' AND t.name = '%s'
ORDER BY fk.name`,
		esc(schema), esc(table))

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var fks []connection.ForeignKeyDefinition
	for _, row := range data {
		refSchema := fmt.Sprintf("%v", row["foreign_schema"])
		refTable := fmt.Sprintf("%v", row["foreign_table"])
		refTableName := formatSQLServerTableMetadataName(refSchema, refTable)

		fk := connection.ForeignKeyDefinition{
			Name:           fmt.Sprintf("%v", row["constraint_name"]),
			ColumnName:     fmt.Sprintf("%v", row["column_name"]),
			RefTableName:   refTableName,
			RefColumnName:  fmt.Sprintf("%v", row["foreign_column"]),
			ConstraintName: fmt.Sprintf("%v", row["constraint_name"]),
		}
		fks = append(fks, fk)
	}
	return fks, nil
}

func (s *SqlServerDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	schema, table := splitSQLServerTableName(tableName)

	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}

	esc := func(s string) string { return strings.ReplaceAll(s, "'", "''") }

	query := fmt.Sprintf(`
SELECT
    tr.name AS trigger_name,
    CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
    STUFF((
        SELECT ', ' + te.type_desc
        FROM sys.trigger_events te
        WHERE te.object_id = tr.object_id
        FOR XML PATH('')
    ), 1, 2, '') AS event,
    OBJECT_DEFINITION(tr.object_id) AS statement
FROM sys.triggers tr
JOIN sys.tables t ON tr.parent_id = t.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = '%s' AND t.name = '%s'
ORDER BY tr.name`,
		esc(schema), esc(table))

	data, _, err := s.Query(query)
	if err != nil {
		return nil, err
	}

	var triggers []connection.TriggerDefinition
	for _, row := range data {
		trig := connection.TriggerDefinition{
			Name:      fmt.Sprintf("%v", row["trigger_name"]),
			Timing:    fmt.Sprintf("%v", row["timing"]),
			Event:     fmt.Sprintf("%v", row["event"]),
			Statement: "",
		}
		if v, ok := row["statement"]; ok && v != nil {
			trig.Statement = fmt.Sprintf("%v", v)
		}
		triggers = append(triggers, trig)
	}
	return triggers, nil
}
