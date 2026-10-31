package db

import "testing"

// 批量列查询的字段语义必须与 SHOW FULL COLUMNS 完全对齐：可空性是 YES/NO、
// 默认值为 NULL 表示「无默认」、排序规则前缀决定字符集。任何偏差都会让结构
// 对比报出假的列差异，所以这里逐项钉住。
func TestBuildMySQLBatchColumnDefinitionMatchesShowFullColumnsSemantics(t *testing.T) {
	row := map[string]interface{}{
		"COLUMN_NAME":    "name",
		"COLUMN_TYPE":    "varchar(64)",
		"IS_NULLABLE":    "NO",
		"COLUMN_KEY":     "PRI",
		"COLUMN_DEFAULT": "abc",
		"EXTRA":          "auto_increment",
		"COLUMN_COMMENT": "名字",
		"COLLATION_NAME": "utf8mb4_general_ci",
	}

	column := buildMySQLBatchColumnDefinition(row)

	if column.Name != "name" || column.Type != "varchar(64)" {
		t.Fatalf("unexpected name/type: %+v", column)
	}
	if column.Nullable != "NO" {
		t.Fatalf("nullable must stay YES/NO like SHOW FULL COLUMNS, got %q", column.Nullable)
	}
	if column.Key != "PRI" || column.Extra != "auto_increment" || column.Comment != "名字" {
		t.Fatalf("unexpected key/extra/comment: %+v", column)
	}
	if column.Default == nil || *column.Default != "abc" || !column.HasDefault {
		t.Fatalf("default value lost: %+v", column)
	}
	if column.Collation != "utf8mb4_general_ci" || column.Charset != "utf8mb4" {
		t.Fatalf("collation/charset mismatch: %+v", column)
	}
}

func TestBuildMySQLBatchColumnDefinitionOmitsAbsentDefault(t *testing.T) {
	column := buildMySQLBatchColumnDefinition(map[string]interface{}{
		"COLUMN_NAME":    "id",
		"COLUMN_TYPE":    "bigint",
		"IS_NULLABLE":    "NO",
		"COLUMN_DEFAULT": nil,
	})

	if column.Default != nil || column.HasDefault {
		t.Fatalf("NULL default must not become a literal: %+v", column)
	}
}
