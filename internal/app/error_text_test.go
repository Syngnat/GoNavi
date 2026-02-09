package app

import "testing"

func TestNormalizeMixedEncodingText_GBKErrorMessage(t *testing.T) {
	raw := []byte("pq: ")
	raw = append(raw, 0xD3, 0xC3, 0xBB, 0xA7) // 用户
	raw = append(raw, []byte(` "root" Password `)...)
	raw = append(raw, 0xC8, 0xCF, 0xD6, 0xA4, 0xCA, 0xA7, 0xB0, 0xDC) // 认证失败
	raw = append(raw, []byte(" (28P01)")...)

	got := normalizeMixedEncodingText(string(raw))
	want := `pq: 用户 "root" Password 认证失败 (28P01)`
	if got != want {
		t.Fatalf("normalizeMixedEncodingText() mismatch\nwant: %q\ngot:  %q", want, got)
	}
}

func TestNormalizeMixedEncodingText_KeepUTF8(t *testing.T) {
	input := `连接建立后验证失败：pq: password authentication failed for user "root"`
	got := normalizeMixedEncodingText(input)
	if got != input {
		t.Fatalf("expected unchanged utf8 text, got: %q", got)
	}
}
