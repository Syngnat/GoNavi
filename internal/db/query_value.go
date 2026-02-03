package db

import (
	"encoding/hex"
	"unicode"
	"unicode/utf8"
)

// normalizeQueryValue normalizes driver-returned values for UI/JSON transport.
// 当前主要处理 []byte：如果是可读文本则转为 string，否则转为十六进制字符串，避免前端出现“空白值”。
func normalizeQueryValue(v interface{}) interface{} {
	if b, ok := v.([]byte); ok {
		return bytesToReadableString(b)
	}
	return v
}

func bytesToReadableString(b []byte) interface{} {
	if b == nil {
		return nil
	}
	if len(b) == 0 {
		return ""
	}

	if utf8.Valid(b) {
		s := string(b)
		if isMostlyPrintable(s) {
			return s
		}
	}

	return "0x" + hex.EncodeToString(b)
}

func isMostlyPrintable(s string) bool {
	if s == "" {
		return true
	}

	total := 0
	printable := 0
	for _, r := range s {
		total++
		switch r {
		case '\n', '\r', '\t':
			printable++
			continue
		default:
		}
		if unicode.IsPrint(r) {
			printable++
		}
	}

	// 允许少量不可见字符，避免把正常文本误判为二进制。
	return printable*100 >= total*90
}
