package db

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestApplyOracleIdentityColumns 锁住 identity 列的 auto_increment 标记回填。
// 跨库自动建表只认 Extra 里的这个标记识别自增，缺失会让目标表建成普通数字列。
func TestApplyOracleIdentityColumns(t *testing.T) {
	t.Parallel()

	columns := []connection.ColumnDefinition{
		{Name: "ID", Type: "NUMBER(19)"},
		{Name: "NAME", Type: "VARCHAR2(50)"},
	}
	data := []map[string]interface{}{
		{"COLUMN_NAME": "ID"},
	}
	got := applyOracleIdentityColumns(columns, data)
	if got[0].Extra != "auto_increment" {
		t.Fatalf("identity 列未标记 auto_increment: %+v", got[0])
	}
	if got[1].Extra != "" {
		t.Fatalf("普通列被误标记: %+v", got[1])
	}

	// 无 identity 列时原样返回。
	plain := []connection.ColumnDefinition{{Name: "NAME", Type: "VARCHAR2(50)"}}
	if plainGot := applyOracleIdentityColumns(plain, nil); plainGot[0].Extra != "" {
		t.Fatalf("无 identity 数据不应改动: %+v", plainGot[0])
	}
}

// TestBuildOracleIdentityColumnsQuery 锁住 identity 元数据查询的方言分派：
// 11g 及更早版本没有该视图，受限账号也可能缺权限，查询必须独立于主查询，
// 且按 schema 是否为空分别走 user_/all_ 视图。
func TestBuildOracleIdentityColumnsQuery(t *testing.T) {
	t.Parallel()

	userQuery := buildOracleIdentityColumnsQuery("", "ORDERS")
	if !strings.Contains(userQuery, "FROM user_tab_identity_cols") {
		t.Fatalf("无 schema 时应查 user_tab_identity_cols: %s", userQuery)
	}
	if strings.Contains(userQuery, "owner =") {
		t.Fatalf("user 视图查询不应带 owner 过滤: %s", userQuery)
	}

	allQuery := buildOracleIdentityColumnsQuery("BIZ", "ORDERS")
	if !strings.Contains(allQuery, "FROM all_tab_identity_cols") {
		t.Fatalf("有 schema 时应查 all_tab_identity_cols: %s", allQuery)
	}
	if !strings.Contains(allQuery, "owner = 'BIZ'") || !strings.Contains(allQuery, "table_name = 'ORDERS'") {
		t.Fatalf("all 视图查询应按 owner/table 过滤: %s", allQuery)
	}
}
