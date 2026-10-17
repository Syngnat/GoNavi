package sqlparam

import (
	"strings"
	"testing"
	"time"
)

// 审查发现：未闭合 q' 的回退路径曾把最坏情况拖成 O(n²)（500KB 输入 51 秒）。
// altQuoteFailFrom 水位按定界符记忆失败位置后应保持线性，此测试钉住该约束。
func TestScanOracleAlternativeQuoteLinearFallback(t *testing.T) {
	opts := OptionsForDBType("oracle")
	cases := []struct {
		name string
		sql  string
	}{
		{name: "同一定界符大量未闭合", sql: strings.Repeat("q'!x' ", 83333)},
		{name: "混合定界符大量未闭合", sql: strings.Repeat("q'!x' q'[y' q'{z' ", 33333)},
		{name: "正常 SQL 不受影响", sql: strings.Repeat("SELECT * FROM t WHERE id = :id AND c = q'[ok]'; ", 5000)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			start := time.Now()
			Scan(tc.sql, opts)
			if elapsed := time.Since(start); elapsed > 2*time.Second {
				t.Fatalf("扫描耗时 %v，疑似退化为二次方", elapsed)
			}
		})
	}
}
