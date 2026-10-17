package sqlparam

import (
	"reflect"
	"testing"
)

func TestScanOracleAlternativeQuote(t *testing.T) {
	oracle := OptionsForDBType("oracle")
	dameng := OptionsForDBType("dameng")
	mysql := OptionsForDBType("mysql")
	cases := []struct {
		name string
		sql  string
		opts ScanOptions
		want []string
	}{
		// 误报修复：q-quote 内容不再被认成引号参数。
		{name: "q 花括号内容是字面量", sql: "SELECT q'{abc}' FROM dual", opts: oracle, want: nil},
		{name: "大写 Q 同样识别", sql: "SELECT Q'{abc}' FROM dual", opts: oracle, want: nil},
		{name: "nq 前缀同样识别", sql: "SELECT nq'{abc}' FROM dual", opts: oracle, want: nil},
		{name: "方括号定界符", sql: "UPDATE t SET c = q'[it's]' WHERE id = :id", opts: oracle, want: []string{"id"}},
		{name: "圆括号定界符", sql: "UPDATE t SET c = q'(it's)' WHERE id = :id", opts: oracle, want: []string{"id"}},
		{name: "尖括号定界符", sql: "UPDATE t SET c = q'<it's>' WHERE id = :id", opts: oracle, want: []string{"id"}},
		{name: "单字符定界符", sql: "SELECT q'!a!' || :id FROM dual", opts: oracle, want: []string{"id"}},
		{name: "达梦同样启用", sql: "SELECT q'{abc}' FROM dual", opts: dameng, want: nil},
		// 标识符守卫：abcq' 不是替代引号，引号参数识别不受影响。
		{name: "标识符结尾的 q 不触发", sql: "SELECT abcq'{a}' FROM dual", opts: oracle, want: []string{"a"}},
		// 回退：找不到合法闭合时按普通引号处理，不吞后续参数。
		{name: "无闭合回退为普通引号", sql: "SELECT q'!a' AND x = :id", opts: oracle, want: []string{"id"}},
		{name: "无闭合的括号定界符回退", sql: "SELECT q'[a' AND x = :id", opts: oracle, want: []string{"id"}},
		// MySQL 不启用替代引号，引号参数行为不变。
		{name: "MySQL 行为不变", sql: "SELECT q'{abc}' FROM dual", opts: mysql, want: []string{"abc"}},
		// 开关关闭时 q-quote 内容同样是字面量。
		{name: "开关关闭不影响字面量", sql: "SELECT q'{abc}' FROM dual WHERE id = :id", opts: func() ScanOptions {
			off := oracle
			off.QuotedPlaceholders = false
			return off
		}(), want: []string{"id"}},
		// 注释与字符串内的 q' 不触发。
		{name: "注释内不触发", sql: "-- q'{c}'\nSELECT :id FROM dual", opts: oracle, want: []string{"id"}},
		{name: "字符串内不触发替代引号", sql: "SELECT 'q''{c}''' FROM dual WHERE x = :id", opts: func() ScanOptions {
			off := oracle
			off.QuotedPlaceholders = false
			return off
		}(), want: []string{"id"}},
		// 审查发现：标识符守卫按 rune 解码，多字节字母与 @ 与参考实现一致。
		{name: "多字节标识符结尾的 q 不触发", sql: "SELECT 中q'{a}' FROM dual", opts: oracle, want: []string{"a"}},
		{name: "dblink 风格 @q 不触发", sql: "SELECT @q'{a}' FROM dual WHERE x = :id", opts: oracle, want: []string{"a", "id"}},
		{name: "多字节定界符", sql: "SELECT q'«a»' || :id FROM dual", opts: oracle, want: []string{"id"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Names(tc.sql, tc.opts)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Names(%q) = %v, want %v", tc.sql, got, tc.want)
			}
		})
	}
}

// 审查发现：失败水位线曾被普通文本里的 n/q 字母（name、AND、now 等）污染，
// 且不按定界符区分——一个失败定界符会跳过之后所有定界符的探测，导致真实
// q-quote 被回退成普通引号词法，原始误报/漏报在真实 SQL 上复现。此处钉住：
// 只有「定界符合法但找不到闭合」才记水位，且按定界符分别记忆。
func TestScanOracleAlternativeQuoteWatermarkNotPoisoned(t *testing.T) {
	oracle := OptionsForDBType("oracle")
	cases := []struct {
		name string
		sql  string
		want []string
	}{
		// q-quote 之前出现普通标识符/关键字里的 n、q 字母，不得污染水位线。
		{name: "name 在前", sql: "SELECT name FROM t WHERE x = q'[it's]' AND id = :id", want: []string{"id"}},
		{name: "cnt 在前", sql: "UPDATE t SET cnt = q'[it's]' WHERE id = :id", want: []string{"id"}},
		{name: "AND 在前", sql: "SELECT * FROM a WHERE b = 1 AND c = q'[it's]' AND id = :id", want: []string{"id"}},
		// 原始误报场景：q'{abc}' 前有 now()，q'{abc}' 内容仍是字面量。
		{name: "now 在前的误报", sql: "SELECT now() FROM t WHERE x = q'{abc}' AND id = :id", want: []string{"id"}},
		// 标识符守卫失败（abcq'）不记水位，之后的真实 q-quote 正常识别。
		{name: "守卫失败不污染", sql: "SELECT abcq'x' , q'[it's]' , :id FROM dual", want: []string{"id"}},
		// 一个定界符失败不跳过其他定界符的探测。
		{name: "跨定界符不互污染", sql: "SELECT q'!aaa' , q'[it's]' , :id FROM dual", want: []string{"id"}},
		// 同定界符失败后的后续 q-quote 跳过探测，回退普通引号不吞参数。
		{name: "同定界符跳过后不吞参数", sql: "SELECT q'!aaa' , q'!bbb' , :id FROM dual", want: []string{"id"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Names(tc.sql, oracle)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Names(%q) = %v, want %v", tc.sql, got, tc.want)
			}
		})
	}
}

// q-quote 内容整体保留为字面量，重写只替换引号外的真实参数。
func TestBindKeepsOracleAlternativeQuoteLiteral(t *testing.T) {
	sql := "UPDATE t SET c = q'[it's]', flag = '{keep}' WHERE id = :id"
	result, err := BindWithOptions(sql, "oracle", map[string]TypedValue{
		"id":   {Type: TypeString, Value: "42"},
		"keep": {Type: TypeString, Value: "Y"},
	}, OptionsForDBType("oracle"))
	if err != nil {
		t.Fatalf("BindWithOptions: %v", err)
	}
	want := "UPDATE t SET c = q'[it's]', flag = :1 WHERE id = :2"
	if result.SQL != want {
		t.Fatalf("SQL = %q, want %q", result.SQL, want)
	}
	if len(result.Args) != 2 {
		t.Fatalf("args = %v, want 2", result.Args)
	}
}
