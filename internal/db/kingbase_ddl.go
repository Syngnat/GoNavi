//go:build gonavi_full_drivers || gonavi_kingbase_driver

package db

import (
	"fmt"
	"strings"
)

// KingbaseES 没有可依赖的建表语句函数：sys_get_tabledef 只在部分发行版/兼容模式里注册，
// V9R3 的 MySQL 兼容版直接没有该函数，V9R1 上各参数取值又都返回空。
// 因此这里用 pg_catalog 自行拼装 CREATE TABLE —— 这些系统表在 V8/V9、各兼容模式下都稳定存在，
// 与 GetColumns/GetIndexes 用的是同一批关系，避免再引入一处版本差异。

const kingbaseDdlColumnsQuery = `
SELECT
	a.attname AS column_name,
	pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
	CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
	pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
	col_description(a.attrelid, a.attnum) AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid
LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
WHERE %s
  AND c.relname = '%s'
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum`

const kingbaseDdlConstraintsQuery = `
SELECT
	c.conname AS constraint_name,
	c.contype AS constraint_type,
	pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE %s
  AND t.relname = '%s'
  AND c.contype IN ('p', 'u', 'f')
ORDER BY c.contype, c.conname`

const kingbaseDdlIndexesQuery = `
SELECT
	i.relname AS index_name,
	pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_index ix ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
WHERE %s
  AND t.relname = '%s'
  AND NOT ix.indisprimary
  AND NOT EXISTS (
	SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid AND c.contype IN ('p', 'u')
  )
ORDER BY i.relname`

const kingbaseDdlTableCommentQuery = `
SELECT obj_description(c.oid, 'pg_class') AS table_comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE %s
  AND c.relname = '%s'`

type kingbaseDdlConstraint struct {
	name       string
	kind       string
	definition string
}

// buildKingbaseCreateTableStatement 拼装一个可直接执行的建表脚本：
// CREATE TABLE（列 + 主键/唯一约束）、注释、普通索引、外键。
func (k *KingbaseDB) buildKingbaseCreateTableStatement(dbName, tableName string) (string, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return "", localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	qualified := quoteKingbaseIdentifier(table)
	if schema != "" {
		qualified = quoteKingbaseIdentifier(schema) + "." + qualified
	}

	visible := buildPGLikeVisibleRelationPredicate("c", schema)
	visibleT := buildPGLikeVisibleRelationPredicate("t", schema)
	rows, _, err := k.Query(fmt.Sprintf(kingbaseDdlColumnsQuery, visible, escapePGLikeMetadataLiteral(table)))
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		// 表不存在时退回空字符串，与其它驱动保持一致，不抛错阻断 UI。
		return "", nil
	}

	lines := make([]string, 0, len(rows)+4)
	comments := make([]string, 0, len(rows)+2)
	for _, row := range rows {
		name := strings.TrimSpace(ddlText(row["column_name"]))
		if name == "" {
			continue
		}
		columnType := strings.TrimSpace(ddlText(row["data_type"]))
		def := ddlText(row["column_default"])
		nullable := strings.EqualFold(strings.TrimSpace(ddlText(row["is_nullable"])), "YES")

		parts := []string{quoteKingbaseIdentifier(name), columnType}
		if strings.TrimSpace(def) != "" {
			parts = append(parts, "DEFAULT "+strings.TrimSpace(def))
		}
		if !nullable {
			parts = append(parts, "NOT NULL")
		}
		lines = append(lines, "    "+strings.Join(parts, " "))

		if comment := strings.TrimSpace(ddlText(row["comment"])); comment != "" {
			comments = append(comments, fmt.Sprintf(
				"COMMENT ON COLUMN %s.%s IS %s;",
				qualified, quoteKingbaseIdentifier(name), quoteKingbaseLiteral(comment),
			))
		}
	}

	constraints, err := k.loadKingbaseDdlConstraints(visibleT, table)
	if err != nil {
		return "", err
	}
	foreignKeys := make([]string, 0, 2)
	for _, constraint := range constraints {
		if constraint.kind == "f" {
			foreignKeys = append(foreignKeys, fmt.Sprintf(
				"ALTER TABLE %s ADD CONSTRAINT %s %s;",
				qualified, quoteKingbaseIdentifier(constraint.name), constraint.definition,
			))
			continue
		}
		lines = append(lines, fmt.Sprintf(
			"    CONSTRAINT %s %s", quoteKingbaseIdentifier(constraint.name), constraint.definition,
		))
	}

	script := strings.Builder{}
	script.WriteString("CREATE TABLE ")
	script.WriteString(qualified)
	script.WriteString(" (\n")
	script.WriteString(strings.Join(lines, ",\n"))
	script.WriteString("\n);")

	if comment, commentErr := k.loadKingbaseDdlTableComment(visible, table); commentErr == nil && strings.TrimSpace(comment) != "" {
		comments = append([]string{fmt.Sprintf("COMMENT ON TABLE %s IS %s;", qualified, quoteKingbaseLiteral(comment))}, comments...)
	}
	for _, comment := range comments {
		script.WriteString("\n")
		script.WriteString(comment)
	}

	indexes, indexErr := k.loadKingbaseDdlIndexes(visibleT, table)
	if indexErr == nil {
		for _, index := range indexes {
			script.WriteString("\n")
			script.WriteString(index)
			script.WriteString(";")
		}
	}
	for _, fk := range foreignKeys {
		script.WriteString("\n")
		script.WriteString(fk)
	}
	return script.String(), nil
}

func (k *KingbaseDB) loadKingbaseDdlConstraints(visible, table string) ([]kingbaseDdlConstraint, error) {
	rows, _, err := k.Query(fmt.Sprintf(kingbaseDdlConstraintsQuery, visible, escapePGLikeMetadataLiteral(table)))
	if err != nil {
		return nil, err
	}
	out := make([]kingbaseDdlConstraint, 0, len(rows))
	for _, row := range rows {
		out = append(out, kingbaseDdlConstraint{
			name:       strings.TrimSpace(ddlText(row["constraint_name"])),
			kind:       strings.TrimSpace(ddlText(row["constraint_type"])),
			definition: strings.TrimSpace(ddlText(row["definition"])),
		})
	}
	return out, nil
}

func (k *KingbaseDB) loadKingbaseDdlIndexes(visible, table string) ([]string, error) {
	rows, _, err := k.Query(fmt.Sprintf(kingbaseDdlIndexesQuery, visible, escapePGLikeMetadataLiteral(table)))
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		if definition := strings.TrimSpace(ddlText(row["definition"])); definition != "" {
			out = append(out, definition)
		}
	}
	return out, nil
}

func (k *KingbaseDB) loadKingbaseDdlTableComment(visible, table string) (string, error) {
	rows, _, err := k.Query(fmt.Sprintf(kingbaseDdlTableCommentQuery, visible, escapePGLikeMetadataLiteral(table)))
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", nil
	}
	return strings.TrimSpace(ddlText(rows[0]["table_comment"])), nil
}

func ddlText(value interface{}) string {
	if value == nil {
		return ""
	}
	return fmt.Sprintf("%v", value)
}

func quoteKingbaseIdentifier(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return `""`
	}
	return `"` + strings.ReplaceAll(trimmed, `"`, `""`) + `"`
}

func quoteKingbaseLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
