package app

import (
	"reflect"
	"testing"
)

// Oracle 替代引号 q'X...X' 的内容整体是字面量，其中的撇号不是字符串边界。
// 拆分器此前不认识 q-quote：q'[it's]' 的撇号会让后续文本进入幻影字符串，
// 分号不再切分、后续语句被��并（与 sqlparam.Scan 的边界判定不再吻合）。
func TestSplitSQLStatements_OracleAlternativeQuote(t *testing.T) {
	cases := []struct {
		name   string
		dbType string
		input  string
		want   []string
	}{
		{
			name:   "撇号不吞后续语句",
			dbType: "oracle",
			input:  "UPDATE t SET c = q'[it's]' WHERE id = 1; SELECT 2 FROM dual",
			want:   []string{"UPDATE t SET c = q'[it's]' WHERE id = 1", "SELECT 2 FROM dual"},
		},
		{
			name:   "花括号内容含分号不切分",
			dbType: "oracle",
			input:  "SELECT q'{a;b}' FROM dual; SELECT 2 FROM dual",
			want:   []string{"SELECT q'{a;b}' FROM dual", "SELECT 2 FROM dual"},
		},
		{
			name:   "nq 前缀同样识别",
			dbType: "oracle",
			input:  "SELECT nq'[it's]' FROM dual; SELECT 2 FROM dual",
			want:   []string{"SELECT nq'[it's]' FROM dual", "SELECT 2 FROM dual"},
		},
		{
			name:   "达梦同样启用",
			dbType: "dameng",
			input:  "SELECT q'{a;b}' FROM dual; SELECT 2 FROM dual",
			want:   []string{"SELECT q'{a;b}' FROM dual", "SELECT 2 FROM dual"},
		},
		{
			name:   "yashandb 借用 oracle 方言",
			dbType: "yashandb",
			input:  "SELECT q'{a;b}' FROM dual; SELECT 2 FROM dual",
			want:   []string{"SELECT q'{a;b}' FROM dual", "SELECT 2 FROM dual"},
		},
		{
			name:   "MySQL 不启用替代引号，行为与基线一致",
			dbType: "mysql",
			input:  "SELECT q'{a;b}' FROM dual; SELECT 2",
			want:   []string{"SELECT q'{a;b}' FROM dual", "SELECT 2"},
		},
		{
			name:   "找不到闭合回退普通引号词法",
			dbType: "oracle",
			input:  "SELECT q'!a' FROM dual; SELECT 2 FROM dual",
			want:   []string{"SELECT q'!a' FROM dual", "SELECT 2 FROM dual"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := splitSQLStatementsForDialect(tc.dbType, tc.input)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("splitSQLStatementsForDialect(%s, %q) = %#v, want %#v", tc.dbType, tc.input, got, tc.want)
			}
		})
	}
}

// 拆分器与参数扫描对同一份 SQL 的 q-quote 边界必须吻合：扫描器跳过的
// q-quote 区间，拆分器同样不把其中的分号当语句边界。
func TestSplitSQLStatements_OracleAlternativeQuoteAgreesWithParamScan(t *testing.T) {
	input := "UPDATE t SET c = q'[it's]' WHERE id = :id; SELECT :a FROM dual"
	statements := splitSQLStatementsForDialect("oracle", input)
	if len(statements) != 2 {
		t.Fatalf("应拆出两条语句，got %#v", statements)
	}
	wantFirst := "UPDATE t SET c = q'[it's]' WHERE id = :id"
	if statements[0] != wantFirst {
		t.Fatalf("第一条语句应原样保留，got %q", statements[0])
	}
}
