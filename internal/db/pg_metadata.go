package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func normalizePGLikeMetadataTable(schemaName, tableName string) (string, string) {
	schema := strings.TrimSpace(schemaName)
	table := strings.TrimSpace(tableName)
	if parsedSchema, parsedTable := SplitSQLQualifiedNamePreserveTableQuoteForDialect(table, "postgres"); parsedSchema != "" && parsedTable != "" {
		schema = parsedSchema
		table = parsedTable
	}
	return normalizePGLikeMetadataParts(schema, table)
}

func normalizePGLikeMetadataParts(schemaName, tableName string) (string, string) {
	schema := strings.TrimSpace(schemaName)
	table := strings.TrimSpace(tableName)
	schema = strings.TrimSpace(normalizeSQLIdentifierEscapes(schema))
	table = strings.TrimSpace(normalizeSQLIdentifierEscapes(table))
	schema = normalizeSQLIdentPartWithBracketMode(schema, false, false)
	table = normalizeSQLIdentPartWithBracketMode(table, false, false)
	return schema, table
}

func escapePGLikeMetadataLiteral(raw string) string {
	text := strings.TrimSpace(raw)
	text = strings.Trim(text, `"`)
	return strings.ReplaceAll(text, "'", "''")
}

func buildPGLikeVisibleRelationPredicate(alias string, schemaName string) string {
	return buildPGLikeVisibleRelationPredicateWithNamespace(alias, "n", schemaName)
}

func buildPGLikeVisibleRelationPredicateWithNamespace(alias string, namespaceAlias string, schemaName string) string {
	relAlias := strings.TrimSpace(alias)
	if relAlias == "" {
		relAlias = "c"
	}
	nsAlias := strings.TrimSpace(namespaceAlias)
	if nsAlias == "" {
		nsAlias = "n"
	}
	if strings.TrimSpace(schemaName) == "" {
		return fmt.Sprintf("pg_catalog.pg_table_is_visible(%s.oid)", relAlias)
	}
	return fmt.Sprintf("%s.nspname = '%s'", nsAlias, escapePGLikeMetadataLiteral(schemaName))
}

func buildPGLikeColumnsMetadataQuery(schemaName, tableName string) string {
	return fmt.Sprintf(`
SELECT
	a.attname AS column_name,
	pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
	CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
	pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
	COALESCE(pg_catalog.to_jsonb(a)->>'attidentity', '') AS identity_generation,
	col_description(a.attrelid, a.attnum) AS comment,
	CASE WHEN pk.attname IS NOT NULL THEN 'PRI' ELSE '' END AS column_key
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid
LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
LEFT JOIN (
	SELECT i.indrelid, a3.attname
	FROM pg_index i
	JOIN pg_attribute a3 ON a3.attrelid = i.indrelid AND a3.attnum = ANY(i.indkey)
	WHERE i.indisprimary
) pk ON pk.indrelid = c.oid AND pk.attname = a.attname
WHERE c.relkind IN ('r', 'p')
  AND %s
  AND c.relname = '%s'
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum`, buildPGLikeVisibleRelationPredicate("c", schemaName), escapePGLikeMetadataLiteral(tableName))
}

func buildPGLikeIndexesMetadataQuery(schemaName, tableName string) string {
	return fmt.Sprintf(`
SELECT
	i.relname AS index_name,
	a.attname AS column_name,
	ix.indisunique AS is_unique,
	x.ordinality AS seq_in_index,
	am.amname AS index_type
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_index ix ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_am am ON i.relam = am.oid
JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality) ON TRUE
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
WHERE t.relkind IN ('r', 'p')
  AND t.relname = '%s'
  AND %s
  AND ix.indisvalid
  AND ix.indpred IS NULL
  AND x.ordinality <= ix.indnkeyatts
  AND NOT EXISTS (
    SELECT 1 FROM unnest(ix.indkey) AS expr_key(attnum) WHERE expr_key.attnum <= 0
  )
ORDER BY i.relname, x.ordinality`, escapePGLikeMetadataLiteral(tableName), buildPGLikeVisibleRelationPredicate("t", schemaName))
}

func buildPGLikeForeignKeysMetadataQuery(schemaName, tableName string) string {
	return fmt.Sprintf(`
SELECT
	tc.constraint_name AS constraint_name,
	kcu.column_name AS column_name,
	ccu.table_schema AS foreign_table_schema,
	ccu.table_name AS foreign_table_name,
	ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.constraint_catalog = kcu.constraint_catalog
  AND tc.constraint_schema = kcu.constraint_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.constraint_catalog = tc.constraint_catalog
  AND ccu.constraint_schema = tc.constraint_schema
JOIN pg_catalog.pg_namespace AS n ON n.nspname = tc.table_schema
JOIN pg_catalog.pg_class AS c ON c.relnamespace = n.oid AND c.relname = tc.table_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name = '%s'
  AND %s
ORDER BY tc.constraint_name, kcu.ordinal_position`, escapePGLikeMetadataLiteral(tableName), buildPGLikeVisibleRelationPredicate("c", schemaName))
}

func buildPGLikeTriggersMetadataQuery(schemaName, tableName string) string {
	return buildPGLikeTriggersMetadataQueryWithOrientation(schemaName, tableName, true)
}

func buildPGLikeTriggersMetadataQueryWithoutOrientation(schemaName, tableName string) string {
	return buildPGLikeTriggersMetadataQueryWithOrientation(schemaName, tableName, false)
}

func buildPGLikeTriggersMetadataQueryWithOrientation(schemaName, tableName string, includeOrientation bool) string {
	orientationColumn := ""
	if includeOrientation {
		orientationColumn = ", t.action_orientation"
	}
	return fmt.Sprintf(`
SELECT t.trigger_name, t.action_timing, t.event_manipulation, t.action_statement%s
FROM information_schema.triggers AS t
JOIN pg_catalog.pg_namespace AS n ON n.nspname = t.event_object_schema
JOIN pg_catalog.pg_class AS c ON c.relnamespace = n.oid AND c.relname = t.event_object_table
WHERE t.event_object_table = '%s'
  AND %s
ORDER BY t.trigger_name, t.event_manipulation`, orientationColumn, escapePGLikeMetadataLiteral(tableName), buildPGLikeVisibleRelationPredicate("c", schemaName))
}

// buildPGLikeTriggerOrientationMetadataQuery derives trigger granularity from
// pg_trigger.tgtype. Some PostgreSQL-compatible servers omit
// information_schema.triggers.action_orientation, while the catalog bit is
// still available and preserves statement-level versus row-level semantics.
func buildPGLikeTriggerOrientationMetadataQuery(schemaName, tableName string) string {
	return fmt.Sprintf(`
SELECT pt.tgname AS trigger_name,
       CASE WHEN (pt.tgtype & 1) <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS action_orientation
FROM pg_catalog.pg_trigger AS pt
JOIN pg_catalog.pg_class AS c ON c.oid = pt.tgrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE NOT pt.tgisinternal
  AND c.relname = '%s'
  AND %s
ORDER BY pt.tgname`, escapePGLikeMetadataLiteral(tableName), buildPGLikeVisibleRelationPredicate("c", schemaName))
}

type triggerMetadataQueryer interface {
	Query(string) ([]map[string]interface{}, []string, error)
}

func queryPGLikeTriggersMetadata(queryer triggerMetadataQueryer, schemaName, tableName string) ([]map[string]interface{}, error) {
	data, _, firstErr := queryer.Query(buildPGLikeTriggersMetadataQuery(schemaName, tableName))
	if firstErr == nil {
		return data, nil
	}
	// A few PostgreSQL-compatible servers expose information_schema.triggers
	// without the optional orientation column. Keep trigger metadata usable on
	// those versions and make a best-effort catalog lookup so rollback can still
	// preserve the original firing granularity. Do not key this fallback only on
	// the English column name: compatible servers may localize or redact the
	// original database error.
	fallbackData, _, fallbackErr := queryer.Query(buildPGLikeTriggersMetadataQueryWithoutOrientation(schemaName, tableName))
	if fallbackErr != nil {
		return data, firstErr
	}
	data = fallbackData
	if len(data) == 0 {
		return data, nil
	}
	orientationRows, _, orientationErr := queryer.Query(buildPGLikeTriggerOrientationMetadataQuery(schemaName, tableName))
	if orientationErr != nil {
		// The compatibility query itself succeeded; an unavailable catalog bit
		// lookup should not turn usable trigger metadata into a hard failure.
		return data, nil
	}
	orientations := make(map[string]string, len(orientationRows))
	foldedOrientations := make(map[string]map[string]string, len(orientationRows))
	for _, row := range orientationRows {
		name := getPGLikeTriggerName(row)
		orientation := getPGLikeTriggerOrientation(row)
		if name != "" && orientation != "" {
			orientations[name] = orientation
			foldedName := strings.ToLower(name)
			if foldedOrientations[foldedName] == nil {
				foldedOrientations[foldedName] = make(map[string]string)
			}
			foldedOrientations[foldedName][name] = orientation
		}
	}
	for _, row := range data {
		if getPGLikeTriggerOrientation(row) != "" {
			continue
		}
		name := getPGLikeTriggerName(row)
		orientation := orientations[name]
		if orientation == "" {
			candidates := foldedOrientations[strings.ToLower(name)]
			if len(candidates) == 1 {
				for _, candidate := range candidates {
					orientation = candidate
				}
			}
		}
		if orientation != "" {
			row["action_orientation"] = orientation
		}
	}
	return data, nil
}

func getPGLikeTriggerName(row map[string]interface{}) string {
	for key, value := range row {
		if strings.EqualFold(key, "trigger_name") && value != nil {
			return getPGLikeMetadataString(value)
		}
	}
	return ""
}

func getPGLikeTriggerOrientation(row map[string]interface{}) string {
	for key, value := range row {
		if !strings.EqualFold(key, "action_orientation") || value == nil {
			continue
		}
		return getPGLikeMetadataString(value)
	}
	return ""
}

func getPGLikeMetadataString(value interface{}) string {
	if value == nil {
		return ""
	}
	if typed, ok := value.([]byte); ok {
		return strings.TrimSpace(string(typed))
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}

func buildPGLikeTableCommentMetadataQuery(schemaName, tableName string) string {
	return fmt.Sprintf(`
SELECT pg_catalog.obj_description(c.oid, 'pg_class') AS table_comment
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND %s
  AND c.relname = '%s'
LIMIT 1`, buildPGLikeVisibleRelationPredicate("c", schemaName), escapePGLikeMetadataLiteral(tableName))
}

func parsePGLikeTableComment(data []map[string]interface{}) string {
	for _, row := range data {
		for key, value := range row {
			if !strings.EqualFold(key, "table_comment") || value == nil {
				continue
			}
			return fmt.Sprintf("%v", value)
		}
	}
	return ""
}

func buildPGLikeColumnDefinitions(data []map[string]interface{}) []connection.ColumnDefinition {
	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     fmt.Sprintf("%v", row["column_name"]),
			Type:     fmt.Sprintf("%v", row["data_type"]),
			Nullable: fmt.Sprintf("%v", row["is_nullable"]),
			Key:      fmt.Sprintf("%v", row["column_key"]),
			Extra:    "",
			Comment:  "",
		}

		if v, ok := row["comment"]; ok && v != nil {
			col.Comment = fmt.Sprintf("%v", v)
		}

		if v, ok := row["column_default"]; ok && v != nil {
			def := fmt.Sprintf("%v", v)
			col.Default = &def
			normalizedDefault := strings.ToLower(strings.TrimSpace(def))
			if strings.HasPrefix(normalizedDefault, "nextval(") || strings.HasPrefix(normalizedDefault, "pg_catalog.nextval(") {
				col.Extra = "auto_increment"
			}
		}
		if v, ok := row["identity_generation"]; ok && v != nil && strings.TrimSpace(fmt.Sprintf("%v", v)) != "" {
			col.Extra = "auto_increment"
		}

		columns = append(columns, col)
	}
	return columns
}

func buildPGLikeIndexDefinitions(data []map[string]interface{}) []connection.IndexDefinition {
	indexes := make([]connection.IndexDefinition, 0, len(data))
	for _, row := range data {
		isUnique := false
		if v, ok := row["is_unique"]; ok && v != nil {
			isUnique = parseMetadataBool(v)
		}

		nonUnique := 1
		if isUnique {
			nonUnique = 0
		}

		seq := 0
		if v, ok := row["seq_in_index"]; ok && v != nil {
			seq = parseMetadataInt(v)
		}

		indexType := ""
		if v, ok := row["index_type"]; ok && v != nil {
			indexType = strings.ToUpper(fmt.Sprintf("%v", v))
		}
		if indexType == "" {
			indexType = "BTREE"
		}

		indexes = append(indexes, connection.IndexDefinition{
			Name:       fmt.Sprintf("%v", row["index_name"]),
			ColumnName: fmt.Sprintf("%v", row["column_name"]),
			NonUnique:  nonUnique,
			SeqInIndex: seq,
			IndexType:  indexType,
		})
	}
	return indexes
}
