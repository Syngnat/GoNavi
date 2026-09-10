package db

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestBuildDamengColumnsQuery_IncludesPrimaryKeyMetadata(t *testing.T) {
	t.Parallel()

	ownerQuery := buildDamengColumnsQuery("biz", "orders")
	if !strings.Contains(ownerQuery, "constraint_type = 'P'") {
		t.Fatalf("owner query 应包含主键约束过滤, got=%s", ownerQuery)
	}
	if !strings.Contains(ownerQuery, "AS column_key") {
		t.Fatalf("owner query 应返回 column_key, got=%s", ownerQuery)
	}
	for _, want := range []string{"c.data_length", "c.char_length", "c.data_precision", "c.data_scale"} {
		if !strings.Contains(ownerQuery, want) {
			t.Fatalf("owner query 应返回字段类型长度信息 %q, got=%s", want, ownerQuery)
		}
	}
	if !strings.Contains(ownerQuery, "WHERE c.owner = 'BIZ' AND c.table_name = 'ORDERS'") {
		t.Fatalf("owner query 应按 owner/table 过滤, got=%s", ownerQuery)
	}
	for _, want := range []string{
		"AND cons.owner = 'BIZ'",
		"AND cons.table_name = 'ORDERS'",
		"AND cols.owner = 'BIZ'",
		"AND cols.table_name = 'ORDERS'",
	} {
		if !strings.Contains(ownerQuery, want) {
			t.Fatalf("owner query 主键子查询应按 owner/table 预过滤 %q, got=%s", want, ownerQuery)
		}
	}

	userQuery := buildDamengColumnsQuery("", "orders")
	if !strings.Contains(userQuery, "FROM user_tab_columns c") {
		t.Fatalf("user query 应使用 user_tab_columns, got=%s", userQuery)
	}
	if !strings.Contains(userQuery, "JOIN user_cons_columns cols") {
		t.Fatalf("user query 应关联 user_cons_columns, got=%s", userQuery)
	}
	for _, want := range []string{
		"AND cons.table_name = 'ORDERS'",
		"AND cols.table_name = 'ORDERS'",
	} {
		if !strings.Contains(userQuery, want) {
			t.Fatalf("user query 主键子查询应按 table 预过滤 %q, got=%s", want, userQuery)
		}
	}
}

func TestBuildDamengForeignKeysQuery_PreFiltersLocalColumnsByTargetTable(t *testing.T) {
	t.Parallel()

	ownerQuery := buildDamengForeignKeysQuery("biz", "orders")
	for _, want := range []string{
		"FROM (",
		"FROM all_cons_columns",
		"WHERE owner = 'BIZ' AND table_name = 'ORDERS'",
		"WHERE c.constraint_type = 'R' AND c.owner = 'BIZ' AND c.table_name = 'ORDERS'",
	} {
		if !strings.Contains(ownerQuery, want) {
			t.Fatalf("owner foreign-key query 应按 owner/table 预过滤 %q, got=%s", want, ownerQuery)
		}
	}

	userQuery := buildDamengForeignKeysQuery("", "orders")
	for _, want := range []string{
		"FROM user_cons_columns",
		"WHERE table_name = 'ORDERS'",
		"WHERE c.constraint_type = 'R' AND c.table_name = 'ORDERS'",
	} {
		if !strings.Contains(userQuery, want) {
			t.Fatalf("user foreign-key query 应按 table 预过滤 %q, got=%s", want, userQuery)
		}
	}
}

func TestBuildDamengColumnDefinitions_MarksPrimaryKeyColumns(t *testing.T) {
	t.Parallel()

	columns := buildDamengColumnDefinitions([]map[string]interface{}{
		{
			"COLUMN_NAME":  "ID",
			"DATA_TYPE":    "INTEGER",
			"NULLABLE":     "N",
			"DATA_DEFAULT": nil,
			"COLUMN_KEY":   "PRI",
		},
		{
			"COLUMN_NAME":  "NAME",
			"DATA_TYPE":    "VARCHAR2",
			"DATA_LENGTH":  128,
			"CHAR_LENGTH":  64,
			"NULLABLE":     "Y",
			"DATA_DEFAULT": "guest",
			"COLUMN_KEY":   "",
		},
		{
			"COLUMN_NAME":    "AMOUNT",
			"DATA_TYPE":      "NUMBER",
			"DATA_PRECISION": 10,
			"DATA_SCALE":     2,
			"NULLABLE":       "N",
			"DATA_DEFAULT":   nil,
			"COLUMN_KEY":     "",
		},
	})

	if len(columns) != 3 {
		t.Fatalf("unexpected column count: %d", len(columns))
	}
	if columns[0].Name != "ID" || columns[0].Key != "PRI" || columns[0].Nullable != "NO" {
		t.Fatalf("主键列未正确标记: %+v", columns[0])
	}
	if columns[1].Name != "NAME" || columns[1].Type != "VARCHAR2(64)" || columns[1].Nullable != "YES" || columns[1].Key != "" {
		t.Fatalf("非主键列标记异常: %+v", columns[1])
	}
	if columns[1].Default == nil || *columns[1].Default != "guest" {
		t.Fatalf("默认值未保留: %+v", columns[1])
	}
	if columns[2].Name != "AMOUNT" || columns[2].Type != "NUMBER(10,2)" || columns[2].Nullable != "NO" {
		t.Fatalf("数值字段定义异常: %+v", columns[2])
	}
}

func TestBuildDamengAutoIncrementColumnsQuery_UsesSystemColumnMetadata(t *testing.T) {
	t.Parallel()

	ownerQuery := buildDamengAutoIncrementColumnsQuery("biz", "orders")
	for _, want := range []string{
		"FROM SYS.SYSCOLUMNS sc",
		"JOIN SYS.SYSOBJECTS t ON sc.ID = t.ID",
		"JOIN SYS.SYSOBJECTS s ON t.SCHID = s.ID",
		"s.NAME = 'BIZ'",
		"t.NAME = 'ORDERS'",
		"(sc.INFO2 & 0x01) = 0x01",
	} {
		if !strings.Contains(ownerQuery, want) {
			t.Fatalf("owner query 应包含自增字段元数据条件 %q, got=%s", want, ownerQuery)
		}
	}

	userQuery := buildDamengAutoIncrementColumnsQuery("", "orders")
	if !strings.Contains(userQuery, "s.NAME = USER") {
		t.Fatalf("user query 应按当前登录 schema 过滤, got=%s", userQuery)
	}
}

func TestApplyDamengAutoIncrementColumns_MarksOnlyMatchedColumns(t *testing.T) {
	t.Parallel()

	columns := []connection.ColumnDefinition{
		{Name: "ID"},
		{Name: "NAME"},
	}
	got := applyDamengAutoIncrementColumns(columns, []map[string]interface{}{
		{"COLUMN_NAME": "id"},
	})

	if got[0].Extra != "auto_increment" {
		t.Fatalf("自增字段未标记: %+v", got[0])
	}
	if got[1].Extra != "" {
		t.Fatalf("非自增字段不应被标记: %+v", got[1])
	}
}

// TestFormatDamengColumnTypePreservesNegativeScale 锁住达梦列类型的负 scale。
// 达梦兼容 Oracle 语法，NUMBER(10,-2) 表示向左舍入到百位，丢掉负号会改变
// 精度语义；scale 为 0 时仍按惯例省略小数位。
func TestFormatDamengColumnTypePreservesNegativeScale(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		row  map[string]interface{}
		want string
	}{
		{
			name: "negative scale preserved",
			row: map[string]interface{}{
				"DATA_TYPE":      "NUMBER",
				"DATA_PRECISION": 10,
				"DATA_SCALE":     -2,
			},
			want: "NUMBER(10,-2)",
		},
		{
			name: "zero scale omits scale",
			row: map[string]interface{}{
				"DATA_TYPE":      "NUMBER",
				"DATA_PRECISION": 10,
				"DATA_SCALE":     0,
			},
			want: "NUMBER(10)",
		},
		{
			name: "positive scale kept",
			row: map[string]interface{}{
				"DATA_TYPE":      "NUMBER",
				"DATA_PRECISION": 10,
				"DATA_SCALE":     2,
			},
			want: "NUMBER(10,2)",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := formatDamengColumnType(tc.row); got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}
