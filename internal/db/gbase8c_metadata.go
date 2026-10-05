//go:build gonavi_full_drivers || gonavi_gbase8c_driver

package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// GBase 8c 是 PostgreSQL 9.2 内核：没有 to_jsonb、WITH ORDINALITY 与 LATERAL，PostgresDB 的列与索引查询
// 在这里直接报错。另外每个库都带一批内部 schema（dbe_perf、blockchain、db4ai……），A 兼容模式的 orafce / whale、
// B 兼容模式的 dolphin 扩展还会建几十个 schema，并在 public 下放 dual、all_db_links 等对象。

// gbase8cUserNamespacePredicate 判断 schema 是否属于用户：内部 schema 的 oid 都小于 16384（FirstNormalObjectId，
// public 除外），扩展建的 schema 在 pg_depend 里记为扩展成员。
func gbase8cUserNamespacePredicate(alias string) string {
	return fmt.Sprintf(`(%[1]s.oid >= 16384 OR %[1]s.nspname = 'public')
  AND %[1]s.nspname NOT LIKE 'pg|_%%' ESCAPE '|'
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dn WHERE dn.classid = 'pg_catalog.pg_namespace'::regclass AND dn.objid = %[1]s.oid AND dn.deptype = 'e')`, alias)
}

// gbase8cNotExtensionRelation 排除扩展带入的表与视图（如 public.dual、public.all_db_links）。
func gbase8cNotExtensionRelation(alias string) string {
	return fmt.Sprintf(`NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dc WHERE dc.classid = 'pg_catalog.pg_class'::regclass AND dc.objid = %s.oid AND dc.deptype = 'e')`, alias)
}

var gbase8cUserSchemasQuery = `SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE ` + gbase8cUserNamespacePredicate("n") + ` ORDER BY n.nspname`

// GetTables 返回用户 schema 下的普通表与外表（MOT 内存表是外表），分区表的分区不单独列出。
func (g *GBase8cDB) GetTables(dbName string) ([]string, error) {
	query := `SELECT n.nspname AS schemaname, c.relname AS tablename
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'f')
  AND ` + gbase8cUserNamespacePredicate("n") + `
  AND ` + gbase8cNotExtensionRelation("c") + `
ORDER BY n.nspname, c.relname`
	rows, _, err := g.PostgresDB.Query(query)
	if err != nil {
		return nil, err
	}
	return parsePostgresTableNames(rows), nil
}

// GetColumns 与 PostgresDB 相同的列定义；B 兼容模式的 AUTO_INCREMENT 列默认值报告为自增而不是默认表达式。
func (g *GBase8cDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	rows, _, err := g.PostgresDB.Query(buildGBase8cColumnsQuery(schema, table))
	if err != nil {
		return nil, err
	}
	// A 兼容模式里空串就是 NULL，非主键列的 column_key 会以 NULL 返回。
	for _, row := range rows {
		if row["column_key"] == nil {
			row["column_key"] = ""
		}
	}
	return buildPGLikeColumnDefinitions(rows), nil
}

func buildGBase8cColumnsQuery(schema, table string) string {
	return fmt.Sprintf(`SELECT
	a.attname AS column_name,
	pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
	CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
	CASE WHEN upper(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)) = 'AUTO_INCREMENT' THEN NULL ELSE pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) END AS column_default,
	CASE WHEN upper(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)) = 'AUTO_INCREMENT' THEN 'AUTO_INCREMENT' ELSE '' END AS identity_generation,
	pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
	CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_index pk WHERE pk.indrelid = c.oid AND pk.indisprimary AND a.attnum = ANY (pk.indkey)) THEN 'PRI' ELSE '' END AS column_key
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
WHERE c.relkind IN ('r', 'f')
  AND %s
  AND c.relname = '%s'
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum`, buildPGLikeVisibleRelationPredicate("c", schema), escapePGLikeMetadataLiteral(table))
}

// GetIndexes 按 indkey 下标展开索引列（int2vector 从 0 开始）；表达式索引与部分索引不列出，与 PostgresDB 一致。
func (g *GBase8cDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if table == "" {
		return nil, localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	rows, _, err := g.PostgresDB.Query(buildGBase8cIndexesQuery(schema, table, "indnkeyatts"))
	if err != nil {
		// indnkeyatts（INCLUDE 列）不是每个版本都有，退回按全部索引列展开。
		var fallbackErr error
		if rows, _, fallbackErr = g.PostgresDB.Query(buildGBase8cIndexesQuery(schema, table, "indnatts")); fallbackErr != nil {
			return nil, err
		}
	}
	return buildPGLikeIndexDefinitions(rows), nil
}

func buildGBase8cIndexesQuery(schema, table, keyCountColumn string) string {
	return fmt.Sprintf(`SELECT
	i.relname AS index_name,
	a.attname AS column_name,
	x.indisunique AS is_unique,
	x.pos + 1 AS seq_in_index,
	am.amname AS index_type
FROM (
	SELECT ix.indexrelid, ix.indrelid, ix.indisunique, ix.indkey, generate_series(0, ix.%[3]s - 1) AS pos
	FROM pg_catalog.pg_index ix
	JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
	JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
	WHERE t.relkind IN ('r', 'f')
	  AND t.relname = '%[1]s'
	  AND %[2]s
	  AND ix.indisvalid
	  AND ix.indpred IS NULL
	  AND NOT EXISTS (SELECT 1 FROM generate_series(0, ix.indnatts - 1) AS k(p) WHERE ix.indkey[k.p] = 0)
) x
JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
JOIN pg_catalog.pg_am am ON am.oid = i.relam
JOIN pg_catalog.pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[x.pos]
ORDER BY i.relname, x.pos`, escapePGLikeMetadataLiteral(table), buildPGLikeVisibleRelationPredicate("t", schema), keyCountColumn)
}

// GetAllColumns 返回用户 schema 下表、视图与外表的列，供补全与 AI 工具使用（不含内部 schema 的上千个系统列）。
func (g *GBase8cDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := `SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name,
	pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
	pg_catalog.col_description(c.oid, a.attnum) AS comment
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
WHERE c.relkind IN ('r', 'v', 'm', 'f')
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND ` + gbase8cUserNamespacePredicate("n") + `
  AND ` + gbase8cNotExtensionRelation("c") + `
ORDER BY n.nspname, c.relname, a.attnum`
	rows, _, err := g.PostgresDB.Query(query)
	if err != nil {
		return nil, err
	}
	columns := make([]connection.ColumnDefinitionWithTable, 0, len(rows))
	for _, row := range rows {
		comment := ""
		if value := row["comment"]; value != nil {
			comment = fmt.Sprint(value)
		}
		columns = append(columns, connection.ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v.%v", row["table_schema"], row["table_name"]),
			Name:      fmt.Sprint(row["column_name"]),
			Type:      fmt.Sprint(row["data_type"]),
			Comment:   comment,
		})
	}
	return columns, nil
}

// GetCreateStatement 用服务端的 pg_get_tabledef 生成建表语句（含分区、行列存选项、注释、索引与约束），
// 并把它按 search_path 写出的表名补上 schema；视图与取不到定义的对象沿用 PostgresDB，由应用层回退。
func (g *GBase8cDB) GetCreateStatement(dbName, tableName string) (string, error) {
	schema, table := normalizePGLikeMetadataTable(dbName, tableName)
	if schema == "" {
		schema = "public"
	}
	query := fmt.Sprintf(`SELECT pg_catalog.pg_get_tabledef(c.oid) AS ddl, pg_catalog.quote_ident(n.nspname) AS schema_ident, pg_catalog.quote_ident(c.relname) AS table_ident
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = '%s' AND c.relname = '%s'`, escapePGLikeMetadataLiteral(schema), escapePGLikeMetadataLiteral(table))
	rows, _, err := g.PostgresDB.Query(query)
	if err != nil || len(rows) == 0 || rows[0]["ddl"] == nil {
		return g.PostgresDB.GetCreateStatement(dbName, tableName)
	}
	row := rows[0]
	return qualifyGBase8cTableDef(fmt.Sprint(row["ddl"]), fmt.Sprint(row["schema_ident"]), fmt.Sprint(row["table_ident"])), nil
}

// gbase8cTableDefStatementPrefixes 是 pg_get_tabledef 输出里以表名开头的语句前缀。
var gbase8cTableDefStatementPrefixes = []string{
	"CREATE TABLE ",
	"CREATE UNLOGGED TABLE ",
	"CREATE GLOBAL TEMPORARY TABLE ",
	"COMMENT ON TABLE ",
	"COMMENT ON COLUMN ",
	"ALTER TABLE ",
}

// qualifyGBase8cTableDef 去掉 pg_get_tabledef 开头的 SET search_path，并给按表名引用的语句补上 schema
// （表所在 schema 在会话 search_path 里时，CREATE INDEX 的 ON 子句也只写表名）。
func qualifyGBase8cTableDef(ddl, schemaIdent, tableIdent string) string {
	lines := strings.Split(strings.ReplaceAll(ddl, "\r\n", "\n"), "\n")
	result := make([]string, 0, len(lines))
	unqualifiedOn := " ON " + tableIdent + " "
	for index, line := range lines {
		if index == 0 && strings.HasPrefix(strings.ToUpper(strings.TrimSpace(line)), "SET SEARCH_PATH") {
			continue
		}
		if strings.HasPrefix(line, "CREATE INDEX ") || strings.HasPrefix(line, "CREATE UNIQUE INDEX ") {
			line = strings.Replace(line, unqualifiedOn, " ON "+schemaIdent+"."+tableIdent+" ", 1)
		}
		for _, prefix := range gbase8cTableDefStatementPrefixes {
			if !strings.HasPrefix(line, prefix) {
				continue
			}
			rest := line[len(prefix):]
			if strings.HasPrefix(rest, tableIdent) && len(rest) > len(tableIdent) && strings.ContainsRune(" (.", rune(rest[len(tableIdent)])) {
				line = prefix + schemaIdent + "." + rest
			}
			break
		}
		result = append(result, line)
	}
	return strings.TrimSpace(strings.Join(result, "\n"))
}
