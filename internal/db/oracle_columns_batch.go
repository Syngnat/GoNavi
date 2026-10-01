package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// oracleInListChunk 是 Oracle IN 列表的元素上限。
//
// ORA-01795 规定单条 IN 列表最多 1000 个表达式，超了直接报错。批量查询必须按
// 这个上限分块，否则表数一多，原本用来加速的批量查询反而会失败。
const oracleInListChunk = 1000

// GetColumnsBatch 一次读取同 schema 下多张表的列定义。
//
// 预检逐表读字段时，N 张表就是 N 次往返；这里合并成 ceil(N/1000) 条查询。
// 返回的 map 以调用方传入的表名为键，未命中的表缺席（见接口契约）—— 缺席让
// 调用方回退到逐表查询，从而覆盖大小写不一致、同义词等批量查询覆盖不到的情况。
var _ TableColumnsBatcher = (*OracleDB)(nil)

func (o *OracleDB) GetColumnsBatch(dbName string, tableNames []string) (map[string][]connection.ColumnDefinition, error) {
	result := make(map[string][]connection.ColumnDefinition)
	unique := make([]string, 0, len(tableNames))
	seen := make(map[string]struct{}, len(tableNames))
	for _, name := range tableNames {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			continue
		}
		key := strings.ToUpper(trimmed)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, trimmed)
	}
	if len(unique) == 0 {
		return result, nil
	}

	withIdentity := o.oracleIdentityViewAvailable(dbName)
	for start := 0; start < len(unique); start += oracleInListChunk {
		end := start + oracleInListChunk
		if end > len(unique) {
			end = len(unique)
		}
		chunk := unique[start:end]
		data, _, err := o.Query(buildOracleColumnsBatchQuery(dbName, chunk, withIdentity))
		if err != nil {
			return nil, err
		}
		groupOracleColumnsBatchRows(data, chunk, result, withIdentity)
	}
	return result, nil
}

// groupOracleColumnsBatchRows 按 TABLE_NAME 把结果行归组回调用方传入的表名。
//
// 键必须映射回「调用方传入的写法」，而不是字典返回的写法：调用方后续要用这个
// 表名去匹配自己的映射配置，大写化的键会让它查不到。
func groupOracleColumnsBatchRows(data []map[string]interface{}, requested []string, result map[string][]connection.ColumnDefinition, withIdentity bool) {
	// 字典里的大小写是库内真实值，可能与请求写法不同，因此按大小写不敏感查找。
	requestedByKey := make(map[string]string, len(requested))
	for _, name := range requested {
		requestedByKey[strings.ToUpper(name)] = name
	}
	grouped := make(map[string][]map[string]interface{}, len(requested))
	for _, row := range data {
		tableName := strings.ToUpper(strings.TrimSpace(oracleRowString(row, "TABLE_NAME")))
		if tableName == "" {
			continue
		}
		grouped[tableName] = append(grouped[tableName], row)
	}
	for key, rows := range grouped {
		requestedName, ok := requestedByKey[key]
		if !ok {
			continue
		}
		columns := parseOracleColumns(rows)
		if withIdentity {
			columns = applyOracleIdentityColumns(columns, oracleIdentityRowsFromColumnsData(rows))
		}
		result[requestedName] = columns
	}
}

// buildOracleColumnsBatchQuery 组装多表列查询。
//
// 投影与单表版保持一致（含注释与主键标记），只是把 WHERE 从等值改成 IN 列表，
// 并多带一个 TABLE_NAME 供归组。
func buildOracleColumnsBatchQuery(schema string, tableNames []string, withIdentity bool) string {
	identitySelect := ""
	identityJoin := ""
	if withIdentity {
		identitySelect = `
		CASE WHEN ic.column_name IS NOT NULL THEN 'YES' ELSE '' END AS "IDENTITY_COLUMN",`
	}
	quoted := make([]string, 0, len(tableNames))
	for _, name := range tableNames {
		quoted = append(quoted, "'"+escapeOracleMetadataLiteralExact(name)+"'")
	}
	inList := strings.Join(quoted, ", ")

	if strings.TrimSpace(schema) == "" {
		if withIdentity {
			identityJoin = `
		LEFT JOIN user_tab_identity_cols ic
		  ON ic.table_name = c.table_name AND ic.column_name = c.column_name`
		}
		return fmt.Sprintf(`SELECT c.table_name AS "TABLE_NAME", c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",%s
		cc.comments AS "COMMENT"
		FROM user_tab_columns c
		LEFT JOIN user_col_comments cc
		  ON cc.table_name = c.table_name AND cc.column_name = c.column_name%s
		LEFT JOIN (
			SELECT cols.table_name, cols.column_name
			FROM user_constraints cons
			JOIN user_cons_columns cols USING (constraint_name)
			WHERE cons.constraint_type = 'P'
		) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
		WHERE c.table_name IN (%s)
		ORDER BY c.table_name, c.column_id`, identitySelect, identityJoin, inList)
	}

	if withIdentity {
		identityJoin = `
		LEFT JOIN all_tab_identity_cols ic
		  ON ic.owner = c.owner AND ic.table_name = c.table_name AND ic.column_name = c.column_name`
	}
	return fmt.Sprintf(`SELECT c.table_name AS "TABLE_NAME", c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",%s
		cc.comments AS "COMMENT"
		FROM all_tab_columns c
		LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name%s
		LEFT JOIN (
			SELECT cols.owner, cols.table_name, cols.column_name
			FROM all_constraints cons
			JOIN all_cons_columns cols
			  ON cons.owner = cols.owner AND cons.constraint_name = cols.constraint_name
			WHERE cons.constraint_type = 'P'
		) pk ON c.owner = pk.owner AND c.table_name = pk.table_name AND c.column_name = pk.column_name
		WHERE c.owner = '%s' AND c.table_name IN (%s)
		ORDER BY c.table_name, c.column_id`, identitySelect, identityJoin, escapeOracleMetadataLiteralExact(schema), inList)
}
