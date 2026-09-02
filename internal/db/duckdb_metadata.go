package db

import (
	"fmt"
	"reflect"
	"strings"

	"GoNavi-Wails/internal/connection"
)

type duckDBObjectPath struct {
	Catalog             string
	Schema              string
	Object              string
	ExplicitlyQualified bool
}

func buildDuckDBConstraintMetadataQuery(path duckDBObjectPath, exact bool) string {
	base := `
SELECT
  database_name,
  schema_name,
  table_name,
  constraint_name,
  constraint_type,
  constraint_column_names
FROM duckdb_constraints()
WHERE table_name = '%s'
  AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')`
	args := []any{escapeDuckDBLiteral(path.Object)}
	if exact && path.Schema != "" {
		base += "\n  AND schema_name = '%s'"
		args = append(args, escapeDuckDBLiteral(path.Schema))
	}
	if exact && path.Catalog != "" {
		base += "\n  AND database_name = '%s'"
		args = append(args, escapeDuckDBLiteral(path.Catalog))
	}
	base += "\nORDER BY database_name, schema_name, table_name, constraint_type, constraint_name"
	return fmt.Sprintf(base, args...)
}

func buildDuckDBIndexMetadataQuery(path duckDBObjectPath, exact bool) string {
	base := `
SELECT
  database_name,
  schema_name,
  table_name,
  index_name,
  is_unique,
  expressions
FROM duckdb_indexes()
WHERE table_name = '%s'`
	args := []any{escapeDuckDBLiteral(path.Object)}
	if exact && path.Schema != "" {
		base += "\n  AND schema_name = '%s'"
		args = append(args, escapeDuckDBLiteral(path.Schema))
	}
	if exact && path.Catalog != "" {
		base += "\n  AND database_name = '%s'"
		args = append(args, escapeDuckDBLiteral(path.Catalog))
	}
	base += "\nORDER BY database_name, schema_name, table_name, index_name"
	return fmt.Sprintf(base, args...)
}

func buildDuckDBCreateStatementQueryCandidates(path duckDBObjectPath) []string {
	escapedTable := escapeDuckDBLiteral(path.Object)
	escapedSchema := escapeDuckDBLiteral(path.Schema)
	escapedCatalog := escapeDuckDBLiteral(path.Catalog)

	queryCandidates := make([]string, 0, 3)
	if path.Catalog != "" {
		queryCandidates = append(queryCandidates,
			fmt.Sprintf("SHOW CREATE TABLE %s.%s", quoteDuckDBIdentifier(path.Catalog), quoteDuckDBQualifiedTable(path.Schema, path.Object)),
			fmt.Sprintf("SELECT sql FROM duckdb_tables() WHERE table_name = '%s' AND schema_name = '%s' AND database_name = '%s' LIMIT 1", escapedTable, escapedSchema, escapedCatalog),
		)
	} else {
		queryCandidates = append(queryCandidates,
			fmt.Sprintf("SELECT sql FROM duckdb_tables() WHERE table_name = '%s' AND schema_name = '%s' LIMIT 1", escapedTable, escapedSchema),
		)
	}

	if !path.ExplicitlyQualified {
		queryCandidates = append(queryCandidates,
			fmt.Sprintf("SELECT sql FROM duckdb_tables() WHERE table_name = '%s' LIMIT 1", escapedTable),
		)
	}

	if path.Catalog == "" {
		queryCandidates = append(queryCandidates,
			fmt.Sprintf("SHOW CREATE TABLE %s", quoteDuckDBQualifiedTable(path.Schema, path.Object)),
		)
	}

	return queryCandidates
}

func buildDuckDBColumnDefinitions(rows []map[string]interface{}, constraintRows []map[string]interface{}) []connection.ColumnDefinition {
	primaryKeyColumns := make(map[string]struct{})
	uniqueColumns := make(map[string]struct{})

	for _, row := range constraintRows {
		columnNames := duckDBRowIdentifierList(row, "constraint_column_names")
		switch strings.ToUpper(strings.TrimSpace(duckDBRowString(row, "constraint_type"))) {
		case "PRIMARY KEY":
			for _, columnName := range columnNames {
				primaryKeyColumns[strings.ToLower(columnName)] = struct{}{}
			}
		case "UNIQUE":
			for _, columnName := range columnNames {
				uniqueColumns[strings.ToLower(columnName)] = struct{}{}
			}
		}
	}

	columns := make([]connection.ColumnDefinition, 0, len(rows))
	for _, row := range rows {
		columnName := strings.TrimSpace(duckDBRowString(row, "column_name"))
		column := connection.ColumnDefinition{
			Name:     columnName,
			Type:     duckDBRowString(row, "data_type"),
			Nullable: strings.ToUpper(strings.TrimSpace(duckDBRowString(row, "is_nullable"))),
			Key:      "",
			Extra:    "",
			Comment:  "",
		}
		if column.Nullable == "" {
			column.Nullable = "YES"
		}
		if _, ok := primaryKeyColumns[strings.ToLower(columnName)]; ok {
			column.Key = "PRI"
		} else if _, ok := uniqueColumns[strings.ToLower(columnName)]; ok {
			column.Key = "UNI"
		}
		if defaultVal := strings.TrimSpace(duckDBRowString(row, "column_default")); defaultVal != "" && defaultVal != "<nil>" {
			def := defaultVal
			column.Default = &def
		}
		columns = append(columns, column)
	}

	return columns
}

func buildDuckDBIndexDefinitions(constraintRows []map[string]interface{}, indexRows []map[string]interface{}) []connection.IndexDefinition {
	indexes := make([]connection.IndexDefinition, 0, len(constraintRows)+len(indexRows))

	for _, row := range constraintRows {
		name := strings.TrimSpace(duckDBRowString(row, "constraint_name"))
		constraintType := strings.ToUpper(strings.TrimSpace(duckDBRowString(row, "constraint_type")))
		columnNames := duckDBRowIdentifierList(row, "constraint_column_names")
		if name == "" || len(columnNames) == 0 {
			continue
		}
		for idx, columnName := range columnNames {
			indexes = append(indexes, connection.IndexDefinition{
				Name:       name,
				ColumnName: columnName,
				NonUnique:  0,
				SeqInIndex: idx + 1,
				IndexType:  constraintType,
			})
		}
	}

	for _, row := range indexRows {
		name := strings.TrimSpace(duckDBRowString(row, "index_name"))
		columnNames := duckDBRowExpressionList(row, "expressions")
		if name == "" || len(columnNames) == 0 {
			continue
		}
		nonUnique := 1
		if duckDBRowBool(row, "is_unique") {
			nonUnique = 0
		}
		for idx, columnName := range columnNames {
			indexes = append(indexes, connection.IndexDefinition{
				Name:       name,
				ColumnName: columnName,
				NonUnique:  nonUnique,
				SeqInIndex: idx + 1,
				IndexType:  "INDEX",
			})
		}
	}

	return indexes
}

func normalizeDuckDBObjectPath(dbName string, tableName string) duckDBObjectPath {
	path := parseDuckDBObjectPath(dbName, tableName)
	if strings.TrimSpace(tableName) == "" {
		return path
	}

	path.ExplicitlyQualified = len(splitDuckDBQualifiedName(dbName)) > 0 || len(splitDuckDBQualifiedName(tableName)) > 1
	return path
}

func parseDuckDBObjectPath(dbName string, tableName string) duckDBObjectPath {
	rawDB := strings.TrimSpace(dbName)
	rawTable := strings.TrimSpace(tableName)
	if rawTable == "" {
		if rawDB == "" {
			return duckDBObjectPath{Schema: "main"}
		}
		dbParts := splitDuckDBQualifiedName(rawDB)
		switch len(dbParts) {
		case 0:
			return duckDBObjectPath{Schema: "main"}
		case 1:
			return duckDBObjectPath{Catalog: normalizeDuckDBIdentifier(dbParts[0])}
		default:
			return duckDBObjectPath{
				Catalog: normalizeDuckDBIdentifier(dbParts[0]),
				Schema:  normalizeDuckDBIdentifier(dbParts[len(dbParts)-1]),
			}
		}
	}

	parts := splitDuckDBQualifiedName(rawTable)
	switch len(parts) {
	case 0:
		return duckDBObjectPath{Schema: "main"}
	case 1:
		schema := "main"
		if rawDB != "" {
			dbParts := splitDuckDBQualifiedName(rawDB)
			if len(dbParts) >= 2 {
				return duckDBObjectPath{
					Catalog: normalizeDuckDBIdentifier(dbParts[0]),
					Schema:  normalizeDuckDBIdentifier(dbParts[len(dbParts)-1]),
					Object:  normalizeDuckDBIdentifier(parts[0]),
				}
			}
			schema = normalizeDuckDBIdentifier(rawDB)
		}
		return duckDBObjectPath{
			Schema: schema,
			Object: normalizeDuckDBIdentifier(parts[0]),
		}
	case 2:
		if rawDB != "" {
			dbParts := splitDuckDBQualifiedName(rawDB)
			if len(dbParts) == 1 && (strings.EqualFold(dbParts[0], "main") || strings.EqualFold(dbParts[0], "memory")) {
				return duckDBObjectPath{
					Schema: normalizeDuckDBIdentifier(parts[0]),
					Object: normalizeDuckDBIdentifier(parts[1]),
				}
			}
			if len(dbParts) == 1 {
				return duckDBObjectPath{
					Catalog: normalizeDuckDBIdentifier(dbParts[0]),
					Schema:  normalizeDuckDBIdentifier(parts[0]),
					Object:  normalizeDuckDBIdentifier(parts[1]),
				}
			}
			if len(dbParts) >= 2 {
				return duckDBObjectPath{
					Catalog: normalizeDuckDBIdentifier(dbParts[0]),
					Schema:  normalizeDuckDBIdentifier(parts[0]),
					Object:  normalizeDuckDBIdentifier(parts[1]),
				}
			}
		}
		return duckDBObjectPath{
			Schema: normalizeDuckDBIdentifier(parts[0]),
			Object: normalizeDuckDBIdentifier(parts[1]),
		}
	default:
		return duckDBObjectPath{
			Catalog: normalizeDuckDBIdentifier(parts[len(parts)-3]),
			Schema:  normalizeDuckDBIdentifier(parts[len(parts)-2]),
			Object:  normalizeDuckDBIdentifier(parts[len(parts)-1]),
		}
	}
}

func normalizeDuckDBSchemaAndTable(dbName string, tableName string) (string, string) {
	path := normalizeDuckDBObjectPath(dbName, tableName)
	schema := path.Schema
	if schema == "" {
		schema = "main"
	}
	return schema, path.Object
}

func normalizeDuckDBIdentifier(raw string) string {
	text := strings.TrimSpace(normalizeSQLIdentifierEscapes(raw))
	if len(text) >= 2 {
		first := text[0]
		last := text[len(text)-1]
		if (first == '"' && last == '"') || (first == '`' && last == '`') {
			text = strings.TrimSpace(text[1 : len(text)-1])
		}
	}
	return text
}

func quoteDuckDBIdentifier(raw string) string {
	text := normalizeDuckDBIdentifier(raw)
	return `"` + strings.ReplaceAll(text, `"`, `""`) + `"`
}

func quoteDuckDBQualifiedTable(schema string, table string) string {
	s := strings.TrimSpace(schema)
	t := strings.TrimSpace(table)
	if s == "" {
		return quoteDuckDBIdentifier(t)
	}
	return quoteDuckDBIdentifier(s) + "." + quoteDuckDBIdentifier(t)
}

func duckDBRowString(row map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		for rowKey, value := range row {
			if !strings.EqualFold(rowKey, key) || value == nil {
				continue
			}
			return fmt.Sprintf("%v", value)
		}
	}
	return ""
}

func duckDBRowValue(row map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		for rowKey, value := range row {
			if !strings.EqualFold(rowKey, key) {
				continue
			}
			return value
		}
	}
	return nil
}

func duckDBRowBool(row map[string]interface{}, keys ...string) bool {
	value := strings.TrimSpace(strings.ToLower(duckDBRowString(row, keys...)))
	return value == "true" || value == "1" || value == "yes"
}

func duckDBRowInt(row map[string]interface{}, keys ...string) int {
	raw := strings.TrimSpace(duckDBRowString(row, keys...))
	if raw == "" {
		return 0
	}
	var value int
	_, _ = fmt.Sscanf(raw, "%d", &value)
	return value
}

func duckDBRowIdentifierList(row map[string]interface{}, keys ...string) []string {
	return parseDuckDBListValue(duckDBRowValue(row, keys...), true)
}

func duckDBRowExpressionList(row map[string]interface{}, keys ...string) []string {
	return parseDuckDBListValue(duckDBRowValue(row, keys...), false)
}

func parseDuckDBIdentifierList(raw string) []string {
	return parseDuckDBList(raw, true)
}

func parseDuckDBExpressionList(raw string) []string {
	values := parseDuckDBList(raw, false)
	return normalizeDuckDBExpressionList(values)
}

func parseDuckDBListValue(raw interface{}, normalize bool) []string {
	if raw == nil {
		return nil
	}

	switch typed := raw.(type) {
	case []string:
		values := append([]string(nil), typed...)
		if normalize {
			return normalizeDuckDBIdentifierEntries(values)
		}
		return normalizeDuckDBExpressionList(values)
	case []interface{}:
		values := make([]string, 0, len(typed))
		for _, item := range typed {
			values = append(values, strings.TrimSpace(fmt.Sprintf("%v", item)))
		}
		if normalize {
			return normalizeDuckDBIdentifierEntries(values)
		}
		return normalizeDuckDBExpressionList(values)
	}

	rv := reflect.ValueOf(raw)
	if rv.IsValid() && rv.Kind() != reflect.String && rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		values := parseDuckDBList(strings.TrimSpace(fmt.Sprintf("%v", raw)), normalize)
		if !normalize {
			return normalizeDuckDBExpressionList(values)
		}
		return values
	}
	if rv.IsValid() && (rv.Kind() == reflect.Slice || rv.Kind() == reflect.Array) {
		if rv.Kind() == reflect.Slice && rv.Type().Elem().Kind() == reflect.Uint8 {
			values := parseDuckDBList(strings.TrimSpace(fmt.Sprintf("%v", raw)), normalize)
			if !normalize {
				return normalizeDuckDBExpressionList(values)
			}
			return values
		}
		values := make([]string, 0, rv.Len())
		for i := 0; i < rv.Len(); i++ {
			values = append(values, strings.TrimSpace(fmt.Sprintf("%v", rv.Index(i).Interface())))
		}
		if normalize {
			return normalizeDuckDBIdentifierEntries(values)
		}
		return normalizeDuckDBExpressionList(values)
	}

	values := parseDuckDBList(strings.TrimSpace(fmt.Sprintf("%v", raw)), normalize)
	if !normalize {
		return normalizeDuckDBExpressionList(values)
	}
	return values
}

func normalizeDuckDBIdentifierEntries(values []string) []string {
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		normalized = append(normalized, normalizeDuckDBIdentifier(trimmed))
	}
	return normalized
}

func normalizeDuckDBExpressionList(values []string) []string {
	if len(values) == 0 {
		return values
	}
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		trimmed = normalizeDuckDBExpressionIdentifierLiteral(trimmed)
		switch {
		case trimmed == "":
			continue
		case isDuckDBSimpleIdentifierExpression(trimmed):
			normalized = append(normalized, normalizeDuckDBIdentifier(trimmed))
		default:
			normalized = append(normalized, trimmed)
		}
	}
	return normalized
}

func normalizeDuckDBExpressionIdentifierLiteral(raw string) string {
	text := strings.TrimSpace(raw)
	if len(text) < 2 || text[0] != '\'' || text[len(text)-1] != '\'' {
		return text
	}

	inner := strings.TrimSpace(text[1 : len(text)-1])
	inner = strings.ReplaceAll(inner, `''`, `'`)
	inner = normalizeSQLIdentifierEscapes(inner)
	if inner == "" {
		return text
	}
	if strings.ContainsAny(inner, "() +-/*%") {
		return text
	}
	if len(inner) >= 2 {
		first := inner[0]
		last := inner[len(inner)-1]
		if (first == '"' && last == '"') || (first == '`' && last == '`') {
			return inner
		}
	}
	if strings.ContainsAny(inner, `"'`) {
		return text
	}
	return inner
}

func parseDuckDBList(raw string, normalize bool) []string {
	text := strings.TrimSpace(normalizeSQLIdentifierEscapes(raw))
	if text == "" {
		return nil
	}
	if strings.HasPrefix(text, "[") && strings.HasSuffix(text, "]") {
		text = text[1 : len(text)-1]
	}
	values := make([]string, 0)
	var current strings.Builder
	inDouble := false
	inBacktick := false
	depth := 0

	flush := func() {
		value := strings.TrimSpace(current.String())
		current.Reset()
		if value == "" {
			return
		}
		if normalize {
			value = normalizeDuckDBIdentifier(value)
		}
		values = append(values, value)
	}

	for i := 0; i < len(text); i++ {
		ch := text[i]
		switch ch {
		case '"':
			current.WriteByte(ch)
			if inDouble && i+1 < len(text) && text[i+1] == '"' {
				current.WriteByte(text[i+1])
				i++
				continue
			}
			if !inBacktick {
				inDouble = !inDouble
			}
		case '`':
			current.WriteByte(ch)
			if inBacktick && i+1 < len(text) && text[i+1] == '`' {
				current.WriteByte(text[i+1])
				i++
				continue
			}
			if !inDouble {
				inBacktick = !inBacktick
			}
		case '(':
			current.WriteByte(ch)
			if !inDouble && !inBacktick {
				depth++
			}
		case ')':
			current.WriteByte(ch)
			if !inDouble && !inBacktick && depth > 0 {
				depth--
			}
		case ',':
			if !inDouble && !inBacktick && depth == 0 {
				flush()
				continue
			}
			current.WriteByte(ch)
		default:
			current.WriteByte(ch)
		}
	}
	flush()

	return values
}

func splitDuckDBQualifiedName(raw string) []string {
	text := strings.TrimSpace(normalizeSQLIdentifierEscapes(raw))
	if text == "" {
		return nil
	}
	parts := make([]string, 0, 3)
	var current strings.Builder
	inDouble := false
	inBacktick := false
	inBracket := false

	flush := func() {
		value := strings.TrimSpace(current.String())
		current.Reset()
		if value == "" {
			return
		}
		parts = append(parts, value)
	}

	for i := 0; i < len(text); i++ {
		ch := text[i]
		if inDouble {
			current.WriteByte(ch)
			if ch == '"' && i+1 < len(text) && text[i+1] == '"' {
				current.WriteByte(text[i+1])
				i++
				continue
			}
			if ch == '"' {
				inDouble = false
			}
			continue
		}
		if inBacktick {
			current.WriteByte(ch)
			if ch == '`' && i+1 < len(text) && text[i+1] == '`' {
				current.WriteByte(text[i+1])
				i++
				continue
			}
			if ch == '`' {
				inBacktick = false
			}
			continue
		}
		if inBracket {
			current.WriteByte(ch)
			if ch == ']' && i+1 < len(text) && text[i+1] == ']' {
				current.WriteByte(text[i+1])
				i++
				continue
			}
			if ch == ']' {
				inBracket = false
			}
			continue
		}

		switch ch {
		case '"':
			inDouble = true
			current.WriteByte(ch)
		case '`':
			inBacktick = true
			current.WriteByte(ch)
		case '[':
			inBracket = true
			current.WriteByte(ch)
		case '.':
			flush()
		default:
			current.WriteByte(ch)
		}
	}
	flush()

	return parts
}

func isDuckDBSimpleIdentifierExpression(raw string) bool {
	text := strings.TrimSpace(raw)
	if text == "" {
		return false
	}
	if strings.ContainsAny(text, "() +-/*%") {
		return false
	}
	return true
}

func escapeDuckDBLiteral(raw string) string {
	return strings.ReplaceAll(raw, "'", "''")
}
