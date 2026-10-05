package db

import (
	"fmt"
	"strconv"
	"strings"
)

func getSQLiteTableRowCounts(query func(string) ([]map[string]interface{}, []string, error), tables []string) (map[string]int64, error) {
	counts := make(map[string]int64, len(tables))
	var firstErr error
	for _, rawTableName := range tables {
		tableName := strings.TrimSpace(rawTableName)
		if tableName == "" {
			continue
		}
		escapedTableName := strings.ReplaceAll(tableName, `"`, `""`)
		data, _, err := query(fmt.Sprintf(`SELECT COUNT(*) AS table_rows FROM "%s"`, escapedTableName))
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("读取 SQLite 表 %q 行数失败: %w", tableName, err)
			}
			continue
		}
		if len(data) == 0 {
			continue
		}
		rawCount, ok := data[0]["table_rows"]
		if !ok {
			if firstErr == nil {
				firstErr = fmt.Errorf("读取 SQLite 表 %q 行数失败: 查询结果缺少 table_rows", tableName)
			}
			continue
		}
		count, err := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(rawCount)), 10, 64)
		if err != nil || count < 0 {
			if firstErr == nil {
				firstErr = fmt.Errorf("读取 SQLite 表 %q 行数失败: 无效行数 %v", tableName, rawCount)
			}
			continue
		}
		counts[tableName] = count
	}
	return counts, firstErr
}

func getSQLiteTableStorageStats(query func(string) ([]map[string]interface{}, []string, error), tables []string) (map[string]TableStorageStats, error) {
	requestedTables := make(map[string]struct{}, len(tables))
	for _, rawTableName := range tables {
		tableName := strings.TrimSpace(rawTableName)
		if tableName != "" {
			requestedTables[tableName] = struct{}{}
		}
	}
	if len(requestedTables) == 0 {
		return map[string]TableStorageStats{}, nil
	}

	data, _, err := query(`
WITH object_sizes AS (
    SELECT name, SUM(pgsize) AS bytes
    FROM dbstat
    GROUP BY name
), index_sizes AS (
    SELECT idx.tbl_name AS table_name, SUM(object_sizes.bytes) AS bytes
    FROM sqlite_master AS idx
    JOIN object_sizes ON object_sizes.name = idx.name
    WHERE idx.type = 'index'
    GROUP BY idx.tbl_name
)
SELECT
    tbl.name AS table_name,
    COALESCE(table_sizes.bytes, 0) AS data_length,
    COALESCE(index_sizes.bytes, 0) AS index_length
FROM sqlite_master AS tbl
LEFT JOIN object_sizes AS table_sizes ON table_sizes.name = tbl.name
LEFT JOIN index_sizes ON index_sizes.table_name = tbl.name
WHERE tbl.type = 'table'`)
	if err != nil {
		return map[string]TableStorageStats{}, fmt.Errorf("读取 SQLite 表存储大小失败: %w", err)
	}

	stats := make(map[string]TableStorageStats, len(data))
	for _, row := range data {
		tableName := strings.TrimSpace(fmt.Sprint(metadataRowValue(row, "table_name")))
		if tableName == "" {
			continue
		}
		if len(requestedTables) > 0 {
			if _, ok := requestedTables[tableName]; !ok {
				continue
			}
		}
		dataLength, dataErr := metadataInt64(row, "data_length")
		indexLength, indexErr := metadataInt64(row, "index_length")
		if dataErr != nil || indexErr != nil || dataLength < 0 || indexLength < 0 {
			return map[string]TableStorageStats{}, fmt.Errorf("读取 SQLite 表 %q 存储大小失败: data_length=%v index_length=%v", tableName, metadataRowValue(row, "data_length"), metadataRowValue(row, "index_length"))
		}
		stats[tableName] = TableStorageStats{DataLength: dataLength, IndexLength: indexLength}
	}
	return stats, nil
}
