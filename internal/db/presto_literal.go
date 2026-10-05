//go:build gonavi_full_drivers || gonavi_presto_driver

package db

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// prestoPreparedName 是参数化查询使用的预编译语句名；语句文本经 X-Presto-Prepared-Statement 头发送，不在服务端留存。
const prestoPreparedName = "gonavi_stmt"

// prestoBindArgs 把 ? 占位的参数化查询改写为 EXECUTE gonavi_stmt USING <字面量>…；参数按 Presto 字面量语法序列化。
func prestoBindArgs(query string, args []any) (string, map[string]string, error) {
	if len(args) == 0 {
		return query, nil, nil
	}
	literals := make([]string, 0, len(args))
	for _, arg := range args {
		literal, err := prestoLiteral(arg)
		if err != nil {
			return "", nil, err
		}
		literals = append(literals, literal)
	}
	statement := strings.TrimRight(strings.TrimSpace(query), "; \t\r\n")
	return "EXECUTE " + prestoPreparedName + " USING " + strings.Join(literals, ", "),
		map[string]string{prestoPreparedName: statement}, nil
}

func prestoLiteral(value any) (string, error) {
	switch v := value.(type) {
	case nil:
		return "NULL", nil
	case bool:
		return strconv.FormatBool(v), nil
	case string:
		return "'" + strings.ReplaceAll(v, "'", "''") + "'", nil
	case []byte:
		return "X'" + hex.EncodeToString(v) + "'", nil
	case time.Time:
		return "TIMESTAMP '" + v.Format("2006-01-02 15:04:05.000") + "'", nil
	case json.Number:
		return v.String(), nil
	case int:
		return strconv.Itoa(v), nil
	case int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return fmt.Sprintf("%d", v), nil
	case float32:
		return prestoDoubleLiteral(float64(v)), nil
	case float64:
		return prestoDoubleLiteral(v), nil
	case []any:
		items := make([]string, 0, len(v))
		for _, item := range v {
			literal, err := prestoLiteral(item)
			if err != nil {
				return "", err
			}
			items = append(items, literal)
		}
		return "ARRAY[" + strings.Join(items, ", ") + "]", nil
	default:
		return "'" + strings.ReplaceAll(fmt.Sprint(v), "'", "''") + "'", nil
	}
}

// prestoDoubleLiteral 用科学计数法写 DOUBLE（Presto 里不带指数的小数是 DECIMAL）。
func prestoDoubleLiteral(value float64) string {
	switch {
	case math.IsNaN(value):
		return "nan()"
	case math.IsInf(value, 1):
		return "infinity()"
	case math.IsInf(value, -1):
		return "-infinity()"
	default:
		return strconv.FormatFloat(value, 'E', -1, 64)
	}
}
