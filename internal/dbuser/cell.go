package dbuser

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Cell 以大小写不敏感的列名读取一行中的值；多个候选名按顺序尝试。
// Oracle/达梦返回大写列名，agent 转发后值可能是 float64/json.Number/[]byte，
// 因此所有 catalog 解析都必须走这里而不是直接断言类型。
func Cell(row map[string]any, names ...string) (any, bool) {
	for _, name := range names {
		if value, ok := row[name]; ok {
			return value, true
		}
	}
	for _, name := range names {
		for key, value := range row {
			if strings.EqualFold(key, name) {
				return value, true
			}
		}
	}
	return nil, false
}

// CellString 读取字符串值；nil 返回空串。
func CellString(row map[string]any, names ...string) string {
	value, _ := Cell(row, names...)
	return AsString(value)
}

// CellInt 读取整数值。
func CellInt(row map[string]any, names ...string) (int64, bool) {
	value, ok := Cell(row, names...)
	if !ok {
		return 0, false
	}
	return AsInt(value)
}

// CellBool 读取布尔值，兼容 Y/YES/TRUE/T/ON/1 等形态。
func CellBool(row map[string]any, names ...string) bool {
	value, _ := Cell(row, names...)
	return AsBool(value)
}

// AsString 把驱动返回的任意标量转为字符串。
func AsString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []byte:
		return string(typed)
	case json.Number:
		return typed.String()
	case float64:
		if typed == math.Trunc(typed) && math.Abs(typed) < 1e15 {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return AsString(float64(typed))
	case time.Time:
		if typed.IsZero() {
			return ""
		}
		return typed.Format(time.RFC3339)
	case fmt.Stringer:
		return typed.String()
	default:
		return fmt.Sprint(typed)
	}
}

// AsInt 把驱动返回的数值转为 int64。
func AsInt(value any) (int64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false
	case int:
		return int64(typed), true
	case int8:
		return int64(typed), true
	case int16:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case int64:
		return typed, true
	case uint:
		return int64(typed), true
	case uint8:
		return int64(typed), true
	case uint16:
		return int64(typed), true
	case uint32:
		return int64(typed), true
	case uint64:
		if typed > math.MaxInt64 {
			return 0, false
		}
		return int64(typed), true
	case float64:
		return int64(typed), true
	case float32:
		return int64(typed), true
	case bool:
		if typed {
			return 1, true
		}
		return 0, true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			floatValue, floatErr := typed.Float64()
			if floatErr != nil {
				return 0, false
			}
			return int64(floatValue), true
		}
		return parsed, true
	default:
		text := strings.TrimSpace(AsString(value))
		if text == "" {
			return 0, false
		}
		parsed, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			floatValue, floatErr := strconv.ParseFloat(text, 64)
			if floatErr != nil {
				return 0, false
			}
			return int64(floatValue), true
		}
		return parsed, true
	}
}

// AsBool 把驱动返回值转为布尔。
func AsBool(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	}
	if number, ok := AsInt(value); ok {
		if _, isString := value.(string); !isString {
			return number != 0
		}
	}
	switch strings.ToUpper(strings.TrimSpace(AsString(value))) {
	case "Y", "YES", "TRUE", "T", "ON", "1":
		return true
	default:
		return false
	}
}

// NormalizeDocument 通过 JSON 往返把 bson.M / bson.A / agent 回传的 map 统一为
// map[string]any / []any，供 Mongo 等文档结果解析。
func NormalizeDocument(value any) (map[string]any, bool) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, false
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, false
	}
	return out, true
}
