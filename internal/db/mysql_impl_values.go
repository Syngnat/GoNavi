package db

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

func normalizeMySQLValueForInsert(columnName string, value interface{}, columnTypeMap map[string]string) (interface{}, bool) {
	columnType := strings.ToLower(strings.TrimSpace(columnTypeMap[strings.ToLower(strings.TrimSpace(columnName))]))
	if isMySQLBitColumnType(columnType) {
		return normalizeMySQLBitValue(value), false
	}
	if !isMySQLTemporalColumnType(columnType) {
		return normalizeMySQLComplexValue(value), false
	}
	text, ok := value.(string)
	if ok && strings.TrimSpace(text) == "" {
		// INSERT 空时间字段不写入，交给 DB 默认值处理（如 CURRENT_TIMESTAMP）。
		return nil, true
	}
	return normalizeMySQLDateTimeValue(value), false
}

func normalizeMySQLValueForWrite(columnName string, value interface{}, columnTypeMap map[string]string) interface{} {
	columnType := strings.ToLower(strings.TrimSpace(columnTypeMap[strings.ToLower(strings.TrimSpace(columnName))]))
	if isMySQLBitColumnType(columnType) {
		return normalizeMySQLBitValue(value)
	}
	if !isMySQLTemporalColumnType(columnType) {
		return value
	}
	text, ok := value.(string)
	if ok && strings.TrimSpace(text) == "" {
		return nil
	}
	return normalizeMySQLDateTimeValue(value)
}

func isMySQLTemporalColumnType(columnType string) bool {
	raw := strings.ToLower(strings.TrimSpace(columnType))
	if raw == "" {
		return false
	}
	if strings.Contains(raw, "datetime") || strings.Contains(raw, "timestamp") {
		return true
	}
	base := raw
	if idx := strings.IndexAny(base, "( "); idx >= 0 {
		base = base[:idx]
	}
	return base == "date" || base == "time" || base == "year"
}

func isMySQLBitColumnType(columnType string) bool {
	raw := strings.ToLower(strings.TrimSpace(columnType))
	if raw == "" {
		return false
	}
	base := raw
	if idx := strings.IndexAny(base, "( "); idx >= 0 {
		base = base[:idx]
	}
	return base == "bit"
}

func normalizeMySQLBitValue(value interface{}) interface{} {
	switch v := value.(type) {
	case nil:
		return nil
	case []byte:
		return v
	case bool:
		if v {
			return []byte{1}
		}
		return []byte{0}
	case string:
		if bitValue, ok := parseMySQLBitString(v); ok {
			return bitValue
		}
		return value
	case int:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case int8:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case int16:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case int32:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case int64:
		if v >= 0 {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case uint:
		if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
			return bitValue
		}
	case uint8:
		if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
			return bitValue
		}
	case uint16:
		if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
			return bitValue
		}
	case uint32:
		if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
			return bitValue
		}
	case uint64:
		if bitValue, ok := mysqlBitBytesFromUint64(v); ok {
			return bitValue
		}
	case float32:
		if v >= 0 && math.Trunc(float64(v)) == float64(v) {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	case float64:
		if v >= 0 && math.Trunc(v) == v {
			if bitValue, ok := mysqlBitBytesFromUint64(uint64(v)); ok {
				return bitValue
			}
		}
	}
	return value
}

func parseMySQLBitString(text string) ([]byte, bool) {
	raw := strings.TrimSpace(text)
	if raw == "" {
		return nil, false
	}

	switch strings.ToLower(raw) {
	case "true":
		return []byte{1}, true
	case "false":
		return []byte{0}, true
	}

	if len(raw) > 3 && (raw[0] == 'b' || raw[0] == 'B') && raw[1] == '\'' && raw[len(raw)-1] == '\'' {
		value, err := strconv.ParseUint(raw[2:len(raw)-1], 2, 64)
		if err == nil {
			return mysqlBitBytesFromUint64OrZero(value), true
		}
		return nil, false
	}

	if len(raw) > 2 && (strings.HasPrefix(raw, "0b") || strings.HasPrefix(raw, "0B")) {
		value, err := strconv.ParseUint(raw[2:], 2, 64)
		if err == nil {
			return mysqlBitBytesFromUint64OrZero(value), true
		}
		return nil, false
	}

	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return nil, false
	}
	return mysqlBitBytesFromUint64OrZero(value), true
}

func mysqlBitBytesFromUint64(value uint64) ([]byte, bool) {
	return mysqlBitBytesFromUint64OrZero(value), true
}

func mysqlBitBytesFromUint64OrZero(value uint64) []byte {
	if value == 0 {
		return []byte{0}
	}
	var buf [8]byte
	index := len(buf)
	for value > 0 {
		index--
		buf[index] = byte(value)
		value >>= 8
	}
	return append([]byte(nil), buf[index:]...)
}

func hasTimezoneOffset(text string) bool {
	pos := strings.LastIndexAny(text, "+-")
	if pos < 0 || pos < 10 || pos+1 >= len(text) {
		return false
	}
	offset := text[pos+1:]
	if len(offset) == 5 && offset[2] == ':' {
		return isAllDigits(offset[:2]) && isAllDigits(offset[3:])
	}
	if len(offset) == 4 {
		return isAllDigits(offset)
	}
	return false
}

func isAllDigits(text string) bool {
	if text == "" {
		return false
	}
	for _, r := range text {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func formatMySQLDateTime(t time.Time) string {
	base := t.Format("2006-01-02 15:04:05")
	nanos := t.Nanosecond()
	if nanos == 0 {
		return base
	}
	micro := nanos / 1000
	return fmt.Sprintf("%s.%06d", base, micro)
}
