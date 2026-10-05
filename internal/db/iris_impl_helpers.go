//go:build gonavi_full_drivers || gonavi_iris_driver || gonavi_cache_driver

package db

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func buildIRISInfoSchemaWhereQuery(table string, ref irisTableRef) string {
	conditions := []string{fmt.Sprintf("TABLE_NAME = '%s'", irisSQLLiteral(ref.Table))}
	if ref.Schema != "" {
		conditions = append(conditions, fmt.Sprintf("TABLE_SCHEMA = '%s'", irisSQLLiteral(ref.Schema)))
	}
	orderBy := ""
	switch strings.ToUpper(strings.TrimSpace(table)) {
	case "INFORMATION_SCHEMA.COLUMNS":
		orderBy = " ORDER BY ORDINAL_POSITION"
	case "INFORMATION_SCHEMA.INDEXES":
		orderBy = " ORDER BY INDEX_NAME, ORDINAL_POSITION"
	}
	return fmt.Sprintf("SELECT * FROM %s WHERE %s%s", table, strings.Join(conditions, " AND "), orderBy)
}

func parseIRISTableRef(defaultSchema, raw string) (irisTableRef, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return irisTableRef{}, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	if schemaPart, tablePart, ok := splitIRISTablePath(text); ok {
		schema := cleanIRISIdentifier(schemaPart)
		table := cleanIRISIdentifier(tablePart)
		if table == "" {
			return irisTableRef{}, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
		}
		return irisTableRef{Schema: schema, Table: table}, nil
	}
	return irisTableRef{Schema: cleanIRISIdentifier(defaultSchema), Table: cleanIRISIdentifier(text)}, nil
}

func splitIRISTablePath(raw string) (schemaPart, tablePart string, ok bool) {
	inQuote := false
	for idx := 0; idx < len(raw); idx++ {
		switch raw[idx] {
		case '"':
			if inQuote && idx+1 < len(raw) && raw[idx+1] == '"' {
				idx++
				continue
			}
			inQuote = !inQuote
		case '.':
			if !inQuote {
				return raw[:idx], raw[idx+1:], true
			}
		}
	}
	return "", raw, false
}

func cleanIRISIdentifier(raw string) string {
	text := strings.TrimSpace(raw)
	text = strings.Trim(text, `"`)
	return strings.ReplaceAll(text, `""`, `"`)
}

func irisSQLLiteral(raw string) string {
	return strings.ReplaceAll(raw, "'", "''")
}

func irisQuoteIdent(name string) string {
	text := cleanIRISIdentifier(name)
	text = strings.ReplaceAll(text, `"`, `""`)
	return `"` + text + `"`
}

func irisQuoteTable(raw string) string {
	ref, err := parseIRISTableRef("", raw)
	if err != nil {
		return irisQuoteIdent(raw)
	}
	if ref.Schema != "" {
		return irisQuoteIdent(ref.Schema) + "." + irisQuoteIdent(ref.Table)
	}
	return irisQuoteIdent(ref.Table)
}

func isIRISSystemSchema(schema string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(schema))
	return normalized == "INFORMATION_SCHEMA" ||
		strings.HasPrefix(normalized, "%") ||
		strings.HasPrefix(normalized, "SYS")
}

func rowValue(row map[string]interface{}, keys ...string) (interface{}, bool) {
	for _, key := range keys {
		if value, ok := row[key]; ok {
			return value, true
		}
		for existing, value := range row {
			if strings.EqualFold(existing, key) {
				return value, true
			}
		}
	}
	return nil, false
}

func rowValueAny(row map[string]interface{}, keys ...string) interface{} {
	value, _ := rowValue(row, keys...)
	return value
}

func rowString(row map[string]interface{}, keys ...string) string {
	value, ok := rowValue(row, keys...)
	if !ok || value == nil {
		return ""
	}
	return fmt.Sprintf("%v", value)
}

func parseIRISInt(value interface{}) int {
	switch v := value.(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	case float64:
		return int(v)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(v))
		return n
	default:
		n, _ := strconv.Atoi(strings.TrimSpace(fmt.Sprintf("%v", value)))
		return n
	}
}

func parseIRISBool(value interface{}) (bool, bool) {
	switch v := value.(type) {
	case bool:
		return v, true
	case int:
		return v != 0, true
	case int64:
		return v != 0, true
	case float64:
		return v != 0, true
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "t", "yes", "y":
			return true, true
		case "0", "false", "f", "no", "n":
			return false, true
		}
	}
	return false, false
}

func irisBoolFromRow(row map[string]interface{}, keys ...string) (bool, bool) {
	value, ok := rowValue(row, keys...)
	if !ok {
		return false, false
	}
	return parseIRISBool(value)
}

func parseIRISNonUnique(row map[string]interface{}) int {
	if primary, ok := irisBoolFromRow(row, "PRIMARY_KEY", "primary_key", "PRIMARYKEY", "primarykey"); ok && primary {
		return 0
	}
	if value, ok := rowValue(row, "NON_UNIQUE", "non_unique", "NONUNIQUE", "nonunique"); ok {
		if enabled, ok := parseIRISBool(value); ok {
			if enabled {
				return 1
			}
			return 0
		}
		n := parseIRISInt(value)
		if n != 0 {
			return 1
		}
		return 0
	}
	if value, ok := rowValue(row, "IS_UNIQUE", "is_unique", "UNIQUE", "unique"); ok {
		if unique, ok := parseIRISBool(value); ok && unique {
			return 0
		}
	}
	if unique, ok := irisBoolFromRow(row, "UNIQUE_COLUMN", "unique_column", "UNIQUECOLUMN", "uniquecolumn"); ok && unique {
		return 0
	}
	return 1
}

func normalizeIRISIndexType(raw string) string {
	text := strings.ToUpper(strings.TrimSpace(raw))
	if text == "" {
		return "BTREE"
	}
	return text
}

func normalizeIRISNullable(raw string) string {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "NO", "N", "FALSE", "0":
		return "NO"
	default:
		return "YES"
	}
}

func buildIRISColumnType(row map[string]interface{}) string {
	dataType := strings.TrimSpace(rowString(row, "DATA_TYPE", "data_type", "DATATYPE", "datatype", "TYPE_NAME", "type_name", "TYPENAME", "typename"))
	if dataType == "" {
		dataType = "VARCHAR"
	}
	upper := strings.ToUpper(dataType)
	charLength := parseIRISInt(rowValueAny(row, "CHARACTER_MAXIMUM_LENGTH", "character_maximum_length", "CHARACTERMAXIMUMLENGTH", "charactermaximumlength", "CHARACTER_MAX_LENGTH", "character_max_length", "CHARACTERMAXLENGTH", "charactermaxlength"))
	precision := parseIRISInt(rowValueAny(row, "NUMERIC_PRECISION", "numeric_precision", "NUMERICPRECISION", "numericprecision"))
	scale := parseIRISInt(rowValueAny(row, "NUMERIC_SCALE", "numeric_scale", "NUMERICSCALE", "numericscale"))
	if charLength > 0 && (strings.Contains(upper, "CHAR") || strings.Contains(upper, "VARCHAR")) && !strings.Contains(dataType, "(") {
		return fmt.Sprintf("%s(%d)", dataType, charLength)
	}
	if precision > 0 && (strings.Contains(upper, "NUMERIC") || strings.Contains(upper, "DECIMAL") || strings.Contains(upper, "NUMBER")) && !strings.Contains(dataType, "(") {
		if scale > 0 {
			return fmt.Sprintf("%s(%d,%d)", dataType, precision, scale)
		}
		return fmt.Sprintf("%s(%d)", dataType, precision)
	}
	return dataType
}

func rowOrdinal(rows []map[string]interface{}, columnName string) int {
	for idx, row := range rows {
		if strings.EqualFold(rowString(row, "COLUMN_NAME", "column_name", "COLUMNNAME", "columnname"), columnName) {
			ordinal := parseIRISInt(rowValueAny(row, "ORDINAL_POSITION", "ordinal_position", "ORDINALPOSITION", "ordinalposition"))
			if ordinal > 0 {
				return ordinal
			}
			return idx + 1
		}
	}
	return len(rows) + 1
}

func irisColumnKeyMap(indexes []connection.IndexDefinition) map[string]string {
	result := map[string]string{}
	for _, idx := range indexes {
		column := strings.TrimSpace(idx.ColumnName)
		if column == "" {
			continue
		}
		if isIRISPrimaryIndex(idx) {
			result[column] = "PRI"
			continue
		}
		if idx.NonUnique == 0 && result[column] == "" {
			result[column] = "UNI"
		}
	}
	return result
}

func isIRISPrimaryIndexName(name string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(name))
	return normalized == "PRIMARY" || normalized == "PRIMARYKEY" || normalized == "IDKEY"
}

func isIRISPrimaryIndex(idx connection.IndexDefinition) bool {
	return isIRISPrimaryIndexName(idx.Name) || strings.EqualFold(strings.TrimSpace(idx.IndexType), "PRIMARY")
}

func buildIRISCreateTableDDL(ref irisTableRef, columns []connection.ColumnDefinition, indexes []connection.IndexDefinition) string {
	qualified := irisQuoteIdent(ref.Table)
	if strings.TrimSpace(ref.Schema) != "" {
		qualified = irisQuoteIdent(ref.Schema) + "." + qualified
	}

	lines := make([]string, 0, len(columns)+1)
	primaryColumns := irisPrimaryColumns(indexes)
	if len(primaryColumns) == 0 {
		primaryColumns = irisPrimaryColumnsFromColumns(columns)
	}
	for _, col := range columns {
		line := fmt.Sprintf("  %s %s", irisQuoteIdent(col.Name), strings.TrimSpace(col.Type))
		if col.Default != nil && strings.TrimSpace(*col.Default) != "" {
			line += " DEFAULT " + strings.TrimSpace(*col.Default)
		}
		if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
			line += " NOT NULL"
		}
		lines = append(lines, line)
	}
	if len(primaryColumns) > 0 {
		lines = append(lines, fmt.Sprintf("  PRIMARY KEY (%s)", irisQuoteIdentList(primaryColumns)))
	}

	var b strings.Builder
	b.WriteString(fmt.Sprintf("CREATE TABLE %s (\n%s\n);", qualified, strings.Join(lines, ",\n")))

	for _, stmt := range buildIRISCreateIndexStatements(ref, indexes) {
		b.WriteString("\n\n")
		b.WriteString(stmt)
	}
	return b.String()
}

func irisPrimaryColumns(indexes []connection.IndexDefinition) []string {
	for _, group := range groupIRISIndexes(indexes) {
		if group.Primary {
			return group.Columns
		}
	}
	return nil
}

func irisPrimaryColumnsFromColumns(columns []connection.ColumnDefinition) []string {
	primaryColumns := make([]string, 0)
	for _, column := range columns {
		if strings.EqualFold(strings.TrimSpace(column.Key), "PRI") && strings.TrimSpace(column.Name) != "" {
			primaryColumns = append(primaryColumns, column.Name)
		}
	}
	return primaryColumns
}

type irisIndexGroup struct {
	Name      string
	Columns   []string
	NonUnique int
	IndexType string
	Primary   bool
}

func groupIRISIndexes(indexes []connection.IndexDefinition) []irisIndexGroup {
	groupsByName := map[string]*irisIndexGroup{}
	order := make([]string, 0)
	for _, idx := range indexes {
		name := strings.TrimSpace(idx.Name)
		column := strings.TrimSpace(idx.ColumnName)
		if name == "" || column == "" {
			continue
		}
		group, ok := groupsByName[name]
		if !ok {
			group = &irisIndexGroup{Name: name, NonUnique: idx.NonUnique, IndexType: idx.IndexType}
			groupsByName[name] = group
			order = append(order, name)
		}
		group.Columns = append(group.Columns, column)
		if idx.NonUnique == 0 {
			group.NonUnique = 0
		}
		if isIRISPrimaryIndex(idx) {
			group.Primary = true
		}
	}
	sort.Strings(order)
	groups := make([]irisIndexGroup, 0, len(order))
	for _, name := range order {
		group := groupsByName[name]
		groups = append(groups, *group)
	}
	return groups
}

func buildIRISCreateIndexStatements(ref irisTableRef, indexes []connection.IndexDefinition) []string {
	qualified := irisQuoteIdent(ref.Table)
	if strings.TrimSpace(ref.Schema) != "" {
		qualified = irisQuoteIdent(ref.Schema) + "." + qualified
	}
	var statements []string
	for _, group := range groupIRISIndexes(indexes) {
		if len(group.Columns) == 0 || group.Primary {
			continue
		}
		unique := ""
		if group.NonUnique == 0 {
			unique = "UNIQUE "
		}
		statements = append(statements, fmt.Sprintf("CREATE %sINDEX %s ON %s (%s);", unique, irisQuoteIdent(group.Name), qualified, irisQuoteIdentList(group.Columns)))
	}
	return statements
}

func irisQuoteIdentList(columns []string) string {
	quoted := make([]string, 0, len(columns))
	for _, column := range columns {
		quoted = append(quoted, irisQuoteIdent(column))
	}
	return strings.Join(quoted, ", ")
}

func buildIRISDeleteSQL(tableName string, keys map[string]interface{}) (string, []interface{}, bool) {
	wheres, args := irisAssignments(keys, " = ?")
	if len(wheres) == 0 {
		return "", nil, false
	}
	return fmt.Sprintf("DELETE FROM %s WHERE %s", irisQuoteTable(tableName), strings.Join(wheres, " AND ")), args, true
}

func buildIRISUpdateSQL(tableName string, update connection.UpdateRow) (string, []interface{}, bool, error) {
	sets, args := irisAssignments(update.Values, " = ?")
	if len(sets) == 0 {
		return "", nil, false, nil
	}
	wheres, whereArgs := irisAssignments(update.Keys, " = ?")
	if len(wheres) == 0 {
		return "", nil, false, fmt.Errorf("更新操作需要主键条件")
	}
	args = append(args, whereArgs...)
	return fmt.Sprintf("UPDATE %s SET %s WHERE %s", irisQuoteTable(tableName), strings.Join(sets, ", "), strings.Join(wheres, " AND ")), args, true, nil
}

func buildIRISInsertSQL(tableName string, row map[string]interface{}) (string, []interface{}, bool) {
	if len(row) == 0 {
		return "", nil, false
	}
	keys := sortedMapKeys(row)
	cols := make([]string, 0, len(keys))
	placeholders := make([]string, 0, len(keys))
	args := make([]interface{}, 0, len(keys))
	for _, key := range keys {
		cols = append(cols, irisQuoteIdent(key))
		placeholders = append(placeholders, "?")
		args = append(args, row[key])
	}
	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", irisQuoteTable(tableName), strings.Join(cols, ", "), strings.Join(placeholders, ", ")), args, true
}

func irisAssignments(values map[string]interface{}, suffix string) ([]string, []interface{}) {
	keys := sortedMapKeys(values)
	parts := make([]string, 0, len(keys))
	args := make([]interface{}, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, irisQuoteIdent(key)+suffix)
		args = append(args, values[key])
	}
	return parts, args
}

func sortedMapKeys(values map[string]interface{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		if strings.TrimSpace(key) != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}
