package app

import "testing"

// TestXLSXCellRefColumnIndexRejectsOutOfRangeColumns 覆盖 xlsx 单元格 r 属性的列号上限。
//
// 回归背景：列号原先无任何上限。单元格的 r 属性完全来自文件内容且可被任意篡改，
// 形如 <c r="ZZZZZZZZ1"/> 会解析出约 2.2e11 的列号，直接驱动 readXLSXRow 的 slice
// 填充循环分配 TB 级内存，使整个桌面进程被 OOM 杀死——9 字节属性即可放大到 TB 级。
// 超限时返回 0，由调用方回退到顺序列号。
func TestXLSXCellRefColumnIndexRejectsOutOfRangeColumns(t *testing.T) {
	cases := []struct {
		ref  string
		want int
	}{
		// 合法范围内的既有行为必须保持不变。
		{ref: "A1", want: 1},
		{ref: "B2", want: 2},
		{ref: "Z1", want: 26},
		{ref: "AA1", want: 27},
		{ref: "a1", want: 1},
		{ref: "XFD1", want: xlsxMaxColumns}, // OOXML 最后一列
		{ref: "", want: 0},
		{ref: "1", want: 0},

		// 超出 OOXML 上限：一律判为非法。
		{ref: "XFE1", want: 0},
		{ref: "ZZZZZ1", want: 0},
		{ref: "ZZZZZZZZ1", want: 0},
		{ref: "ZZZZZZZZZZZZ1", want: 0},
	}

	for _, tc := range cases {
		if got := xlsxCellRefColumnIndex(tc.ref); got != tc.want {
			t.Errorf("xlsxCellRefColumnIndex(%q) = %d，期望 %d", tc.ref, got, tc.want)
		}
	}
}

// TestXLSXCellRefColumnIndexDoesNotOverflow 断言超长纯字母引用不会因持续累加而溢出成
// 正数或负数（溢出成正数会绕过上限守卫，溢出成负数会命中调用方的 <=0 回退但掩盖问题）。
func TestXLSXCellRefColumnIndexDoesNotOverflow(t *testing.T) {
	long := ""
	for i := 0; i < 64; i++ {
		long += "Z"
	}
	if got := xlsxCellRefColumnIndex(long + "1"); got != 0 {
		t.Fatalf("64 个 Z 的引用返回 %d，期望 0（存在整型溢出或未熔断）", got)
	}
}
