package db

import (
	"database/sql/driver"
	"strings"
	"testing"
)

// TestOracleGetColumnsBatchGroupsRowsByRequestedName 锁住批量读取的归组契约：
// 结果以「调用方传入的写法」为键，且未命中的表直接缺席。
//
// 键若被字典返回的大写覆盖，调用方就拿不到自己那张映射的字段；缺席若被填成空
// 切片，调用方无法区分「空表」与「没找到」，也就不会回退到逐表查询。
func TestOracleGetColumnsBatchGroupsRowsByRequestedName(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.disableDefaultTabColumns = true
	// 批量实现把本次请求的全部表名合并成同一条查询，因此注册键必须包含 missing。
	query := buildOracleColumnsBatchQuery("MYCIMLED", []string{"orders", "Users", "missing"}, false)
	state.queryResults[query] = oracleRecordingQueryResult{
		columns: []string{"TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "NULLABLE", "DATA_DEFAULT", "COLUMN_KEY", "COMMENT"},
		rows: [][]driver.Value{
			{"ORDERS", "ID", "NUMBER", "NO", nil, "PRI", "订单号"},
			{"ORDERS", "AMOUNT", "NUMBER", "YES", nil, "", "金额"},
			{"USERS", "NAME", "VARCHAR2", "YES", nil, "", "姓名"},
		},
	}
	state.mu.Unlock()

	got, err := (&OracleDB{conn: dbConn}).GetColumnsBatch("MYCIMLED", []string{"orders", "Users", "missing"})
	if err != nil {
		t.Fatalf("GetColumnsBatch 返回错误: %v", err)
	}
	if len(got["orders"]) != 2 || got["orders"][0].Name != "ID" || got["orders"][0].Key != "PRI" {
		t.Fatalf("orders 应保留请求写法并带主键标记, got %#v", got["orders"])
	}
	if len(got["Users"]) != 1 || got["Users"][0].Comment != "姓名" {
		t.Fatalf("Users 应按请求写法归组, got %#v", got["Users"])
	}
	if _, exists := got["missing"]; exists {
		t.Fatalf("未命中的表必须缺席而不是空切片, got %#v", got["missing"])
	}
}

// TestOracleGetColumnsBatchChunksInListsAboveOracleLimit 锁住 ORA-01795 防护：
// Oracle 单条 IN 列表上限 1000，超出必须拆成多条查询而不是直接失败。
func TestOracleGetColumnsBatchChunksInListsAboveOracleLimit(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.disableDefaultTabColumns = true
	// 每条查询都返回空结果集，但查询本身必须被发出；只校验分块数量。
	names := make([]string, 0, oracleInListChunk+1)
	for index := 0; index <= oracleInListChunk; index++ {
		names = append(names, "T"+strings.Repeat("0", 4)+string(rune('A'+index%26))+string(rune('a'+index/26)))
	}
	if _, err := (&OracleDB{conn: dbConn}).GetColumnsBatch("MYCIMLED", names); err != nil {
		t.Fatalf("GetColumnsBatch 返回错误: %v", err)
	}

	batches := 0
	for _, query := range state.snapshotQueries() {
		if strings.Contains(query, "IN (") {
			batches++
		}
	}
	if batches != 2 {
		t.Fatalf("1001 张表应拆成 2 条批量查询, got %d", batches)
	}
}

// TestOracleGetColumnsBatchEscapesTableNames 锁住注入防护：表名带单引号时
// 必须转义后再拼进 IN 列表，不能让输入改变 SQL 结构。
func TestOracleGetColumnsBatchEscapesTableNames(t *testing.T) {
	t.Parallel()

	query := buildOracleColumnsBatchQuery("MYCIMLED", []string{"o'brien"}, false)
	if !strings.Contains(query, `'o''brien'`) {
		t.Fatalf("表名中的单引号必须被转义, got %s", query)
	}
}
