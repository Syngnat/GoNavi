package db

import (
	"math/big"
	"net"
	"testing"
)

// TestNormalizeQueryValuePreservesBigIntDecimalValue 覆盖指针接收者 Stringer 的探测。
//
// 回归背景：reflect.Struct 分支原先只断言值接收者的 fmt.Stringer，而 big.Int 的 String()
// 定义在 *big.Int 上。clickhouse-go 对 Int128/UInt128/Int256/UInt256 列返回 big.Int **值**，
// 因此会落到 fmt.Sprintf("%v")，前端与 CSV/JSON/XLSX 导出得到的都是
// `{false [18446744073709551615 9223372036854775807]}` 这类内部结构体转储，原始数值不可恢复。
func TestNormalizeQueryValuePreservesBigIntDecimalValue(t *testing.T) {
	// Int128 上界：170141183460469231731687303715884105727
	huge, ok := new(big.Int).SetString("170141183460469231731687303715884105727", 10)
	if !ok {
		t.Fatal("构造 big.Int 失败")
	}

	got := normalizeQueryValue(*huge)
	want := "170141183460469231731687303715884105727"
	if got != want {
		t.Fatalf("big.Int 值 = %v (%T)，期望 %q", got, got, want)
	}

	// 负数与小数值同样应得到精确十进制串。
	if got := normalizeQueryValue(*big.NewInt(-42)); got != "-42" {
		t.Errorf("big.NewInt(-42) = %v (%T)，期望 \"-42\"", got, got)
	}

	// 指针形式本就满足值接收者断言路径，结果必须一致。
	if got := normalizeQueryValue(huge); got != want {
		t.Errorf("*big.Int = %v，期望 %q", got, want)
	}
}

// TestNormalizeQueryValueRendersNamedByteSlicesReadably 覆盖具名字节切片。
//
// 回归背景：reflect.Slice 分支原先在任何 Stringer 判定之前就无条件展开为 []interface{}，
// 而 net.IP 是 `type IP []byte`（具名类型，不匹配上层的 case []byte）。
// clickhouse-go 对 IPv4/IPv6 列返回 net.IP，于是前端显示 [192,168,0,1] 而非 "192.168.0.1"，
// CSV/JSON 导出落盘的也是数组，无法用于回灌或比对。
func TestNormalizeQueryValueRendersNamedByteSlicesReadably(t *testing.T) {
	if got := normalizeQueryValue(net.ParseIP("192.168.0.1")); got != "192.168.0.1" {
		t.Errorf("IPv4 = %v (%T)，期望 \"192.168.0.1\"", got, got)
	}
	if got := normalizeQueryValue(net.ParseIP("::1")); got != "::1" {
		t.Errorf("IPv6 = %v (%T)，期望 \"::1\"", got, got)
	}
}

// namedByteSliceWithoutStringer 是没有 String() 的具名字节切片，
// 应回退到与普通 []byte 相同的展示逻辑，而不是被展开成数字数组。
type namedByteSliceWithoutStringer []byte

func TestNormalizeQueryValueFallsBackToBytesDisplayForNamedByteSlices(t *testing.T) {
	got := normalizeQueryValue(namedByteSliceWithoutStringer("hello"))
	if got != "hello" {
		t.Fatalf("具名字节切片 = %v (%T)，期望 \"hello\"", got, got)
	}
}

// TestNormalizeQueryValueKeepsNonByteSliceExpansion 非字节切片必须仍然递归展开。
func TestNormalizeQueryValueKeepsNonByteSliceExpansion(t *testing.T) {
	got := normalizeQueryValue([]int32{1, 2, 3})
	items, ok := got.([]interface{})
	if !ok {
		t.Fatalf("[]int32 未被展开为 []interface{}，实际 %T", got)
	}
	if len(items) != 3 {
		t.Fatalf("展开长度 = %d，期望 3", len(items))
	}
}

// TestBitLikeBytesKeepMySQLBitmaskSemantics 守住既有的 MySQL BIT 位掩码语义，
// 确认本次改动没有把 BIT 列的字节当成具名切片或文本处理。
func TestBitLikeBytesKeepMySQLBitmaskSemantics(t *testing.T) {
	if got := normalizeQueryValueWithDBType([]byte{0x00}, "BIT"); got != int64(0) {
		t.Errorf("BIT 0x00 = %v (%T)，期望 int64(0)", got, got)
	}
	if got := normalizeQueryValueWithDBType([]byte{0x01}, "BIT"); got != int64(1) {
		t.Errorf("BIT 0x01 = %v (%T)，期望 int64(1)", got, got)
	}
	if got := normalizeQueryValueWithDBType([]byte{0x01, 0x02}, "BIT VARYING"); got != int64(258) {
		t.Errorf("BIT 0x0102 = %v (%T)，期望 int64(258)", got, got)
	}
}
