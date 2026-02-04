package db

import "testing"

func TestNormalizeQueryValueWithDBType_BitBytes(t *testing.T) {
	v := normalizeQueryValueWithDBType([]byte{0x00}, "BIT")
	if v != int64(0) {
		t.Fatalf("BIT 0x00 期望为 0，实际=%v(%T)", v, v)
	}

	v = normalizeQueryValueWithDBType([]byte{0x01}, "bit")
	if v != int64(1) {
		t.Fatalf("BIT 0x01 期望为 1，实际=%v(%T)", v, v)
	}

	v = normalizeQueryValueWithDBType([]byte{0x01, 0x02}, "BIT VARYING")
	if v != int64(258) {
		t.Fatalf("BIT 0x0102 期望为 258，实际=%v(%T)", v, v)
	}
}

func TestNormalizeQueryValueWithDBType_BitLargeAsString(t *testing.T) {
	v := normalizeQueryValueWithDBType([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, "BIT")
	if s, ok := v.(string); !ok || s != "18446744073709551615" {
		t.Fatalf("BIT 0xffffffffffffffff 期望为 string(18446744073709551615)，实际=%v(%T)", v, v)
	}
}

func TestNormalizeQueryValueWithDBType_ByteFallbacks(t *testing.T) {
	v := normalizeQueryValueWithDBType([]byte("abc"), "")
	if v != "abc" {
		t.Fatalf("文本 []byte 期望返回 string，实际=%v(%T)", v, v)
	}

	v = normalizeQueryValueWithDBType([]byte{0x00}, "")
	if v != int64(0) {
		t.Fatalf("未知类型 0x00 期望返回 0，实际=%v(%T)", v, v)
	}

	v = normalizeQueryValueWithDBType([]byte{0xff}, "")
	if v != "0xff" {
		t.Fatalf("未知类型 0xff 期望返回 0xff，实际=%v(%T)", v, v)
	}
}
