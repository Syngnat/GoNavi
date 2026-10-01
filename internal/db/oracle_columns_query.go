package db

import (
	"fmt"
	"strings"
)

// Oracle 列元数据查询。从 oracle_impl.go 析出：该文件已超出 800 行上限，
// 而本次改动要在此新增 identity 合并变体。

func buildOracleColumnsQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
			CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
			cc.comments AS "COMMENT"
			FROM user_tab_columns c
			LEFT JOIN user_col_comments cc
			  ON cc.table_name = c.table_name AND cc.column_name = c.column_name
			LEFT JOIN (
				SELECT cols.table_name, cols.column_name
				FROM user_constraints cons
				JOIN user_cons_columns cols USING (constraint_name)
				WHERE cons.constraint_type = 'P'
				  AND cons.table_name = '%s'
				  AND cols.table_name = '%s'
			) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
			WHERE c.table_name = '%s'
			ORDER BY c.column_id`, metadataTableName, metadataTableName, metadataTableName)
	}

	return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
		cc.comments AS "COMMENT"
		FROM all_tab_columns c
		LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
		LEFT JOIN (
			SELECT cols.owner, cols.table_name, cols.column_name
			FROM all_constraints cons
			JOIN all_cons_columns cols
			  ON cons.owner = cols.owner AND cons.constraint_name = cols.constraint_name
			WHERE cons.constraint_type = 'P'
			  AND cons.owner = '%s'
			  AND cons.table_name = '%s'
			  AND cols.owner = '%s'
			  AND cols.table_name = '%s'
		) pk ON c.owner = pk.owner AND c.table_name = pk.table_name AND c.column_name = pk.column_name
		WHERE c.owner = '%s' AND c.table_name = '%s'
		ORDER BY c.column_id`, metadataSchemaName, metadataTableName, metadataSchemaName, metadataTableName, metadataSchemaName, metadataTableName)
}

// buildOracleColumnsQueryWithIdentity 是带 identity 标记的列查询变体。
//
// 仅在探测确认 ALL_TAB_IDENTITY_COLS 可用后使用：把 identity 元数据并入主查询，
// 使每张表从「主查询 + identity 查询」两次往返降为一次。
//
// 刻意整段写出而非在主查询上做字符串插入 —— 拼接版本对外层 SQL 的分隔符与换行
// 位置有隐含依赖，改动上方投影就会静默失效。
//
// 与 buildOracleColumnsQuery 的差异只有两处：多一个 identity 投影，多一个 LEFT JOIN。
func buildOracleColumnsQueryWithIdentity(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
			CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
			CASE WHEN ic.column_name IS NOT NULL THEN 'YES' ELSE '' END AS "IDENTITY_COLUMN",
			cc.comments AS "COMMENT"
			FROM user_tab_columns c
			LEFT JOIN user_col_comments cc
			  ON cc.table_name = c.table_name AND cc.column_name = c.column_name
			LEFT JOIN user_tab_identity_cols ic
			  ON ic.table_name = c.table_name AND ic.column_name = c.column_name
			LEFT JOIN (
				SELECT cols.table_name, cols.column_name
				FROM user_constraints cons
				JOIN user_cons_columns cols USING (constraint_name)
				WHERE cons.constraint_type = 'P'
				  AND cons.table_name = '%s'
				  AND cols.table_name = '%s'
			) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
			WHERE c.table_name = '%s'
			ORDER BY c.column_id`, metadataTableName, metadataTableName, metadataTableName)
	}

	return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
		CASE WHEN ic.column_name IS NOT NULL THEN 'YES' ELSE '' END AS "IDENTITY_COLUMN",
		cc.comments AS "COMMENT"
		FROM all_tab_columns c
		LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
		LEFT JOIN all_tab_identity_cols ic
		  ON ic.owner = c.owner AND ic.table_name = c.table_name AND ic.column_name = c.column_name
		LEFT JOIN (
			SELECT cols.owner, cols.table_name, cols.column_name
			FROM all_constraints cons
			JOIN all_cons_columns cols
			  ON cons.owner = cols.owner AND cons.constraint_name = cols.constraint_name
			WHERE cons.constraint_type = 'P'
			  AND cons.owner = '%s'
			  AND cons.table_name = '%s'
			  AND cols.owner = '%s'
			  AND cols.table_name = '%s'
		) pk ON c.owner = pk.owner AND c.table_name = pk.table_name AND c.column_name = pk.column_name
		WHERE c.owner = '%s' AND c.table_name = '%s'
		ORDER BY c.column_id`, metadataSchemaName, metadataTableName, metadataSchemaName, metadataTableName, metadataSchemaName, metadataTableName)
}

// oracleIdentityRowsFromColumnsData 从合并查询的结果里挑出 identity 列，
// 交给既有的 applyOracleIdentityColumns 打 auto_increment 标记。
//
// 复用而非重写标记逻辑：那段判定已被 TestApplyOracleIdentityColumns 锁定，
// 重新实现一份会让两处逐渐分叉。
func oracleIdentityRowsFromColumnsData(data []map[string]interface{}) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, len(data))
	for _, row := range data {
		if strings.EqualFold(strings.TrimSpace(oracleRowString(row, "IDENTITY_COLUMN")), "YES") {
			rows = append(rows, row)
		}
	}
	return rows
}
