package db

import (
	"fmt"
	"strings"
)

// TableExists 是 TableExistsChecker 的点查实现。
//
// 动机：此前的存在性检查会回退到 GetTables()，也就是
//
//	SELECT owner, table_name FROM all_tables WHERE owner = 'X' ORDER BY table_name
//
// 为了判断一张表在不在，把整个 schema 的表全查回来。预检对每条映射都要查一次
// 目标端，于是「N 张表」变成「N 次全库表清单」，在万级表的大库上这是预检超时的
// 主因 —— 单次往返成本极低，但传输量与解析量随表数线性放大。
//
// 这里改为按名点查，命中字典索引，且用 ROWNUM = 1 让优化器找到即停。
//
// 语义刻意与 GetTables 保持一致（只看表，不看视图），避免把原本判定为「目标表
// 不存在」的场景悄悄变成「存在」，从而改变预检结论。
var _ TableExistsChecker = (*OracleDB)(nil)

func (o *OracleDB) TableExists(dbName, tableName string) (bool, error) {
	target := strings.TrimSpace(tableName)
	if target == "" {
		return false, nil
	}
	var firstErr error
	// 复用「已命中的大小写变体」：首次与改动前一致，后续调用不再重复试错。
	for _, candidate := range o.oracleMetadataNameCandidates(dbName, target) {
		data, _, err := o.Query(buildOracleTableExistsQuery(candidate.schema, candidate.table))
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if len(data) > 0 {
			o.rememberOracleMetadataNamePair(dbName, target, candidate)
			return true, nil
		}
	}
	if firstErr != nil {
		// 查询本身出错与「确认不存在」是两回事：前者要让调用方知道检查失败，
		// 否则预检会把连不通误报成目标表缺失。
		return false, firstErr
	}
	return false, nil
}

func buildOracleTableExistsQuery(schema, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT table_name AS "TABLE_NAME"
			FROM user_tables
			WHERE table_name = '%s'
			  AND ROWNUM = 1`, metadataTableName)
	}
	return fmt.Sprintf(`SELECT table_name AS "TABLE_NAME"
		FROM all_tables
		WHERE owner = '%s'
		  AND table_name = '%s'
		  AND ROWNUM = 1`, escapeOracleMetadataLiteralExact(schema), metadataTableName)
}
