package app

import "testing"

// TestFormatAppOracleColumnTypePreservesNegativeScale 锁住 app 兜底路径的
// 负 scale 显示。Oracle 的 NUMBER(10,-2) 表示向左舍入到百位，丢掉负号会
// 显示成 NUMBER(10) 改变精度语义；db 层返回空列表时才走本兜底，两侧必须
// 显示一致。
func TestFormatAppOracleColumnTypePreservesNegativeScale(t *testing.T) {
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
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := formatAppOracleColumnType(tc.row); got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}
