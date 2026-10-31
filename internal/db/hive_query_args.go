//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/hivesql"
)

var hiveNumericArgPattern = regexp.MustCompile(`^[+-]?[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?$`)

// QueryContextWithArgs binds positional ? arguments into HiveQL literals and
// executes the resulting statement. HiveServer2 has no prepared-statement
// protocol, so binding is textual; strings are quoted with hivesql.Value to
// keep backslashes, control characters and ${...} substitution safe.
func (h *HiveDB) QueryContextWithArgs(ctx context.Context, query string, args []any) ([]map[string]interface{}, []string, error) {
	if len(args) == 0 {
		return h.QueryContext(ctx, query)
	}
	bound, err := hiveBindArgs(query, args)
	if err != nil {
		return nil, nil, err
	}
	return h.QueryContext(ctx, bound)
}

// ExecContextWithArgs is the write-side counterpart of QueryContextWithArgs.
func (h *HiveDB) ExecContextWithArgs(ctx context.Context, query string, args []any) (int64, error) {
	if len(args) == 0 {
		return h.ExecContext(ctx, query)
	}
	bound, err := hiveBindArgs(query, args)
	if err != nil {
		return 0, err
	}
	return h.ExecContext(ctx, bound)
}

// hiveBindArgs replaces positional ? placeholders outside quoted identifiers,
// string literals and comments with HiveQL literals.
func hiveBindArgs(query string, args []any) (string, error) {
	if len(args) == 0 {
		return query, nil
	}
	var out strings.Builder
	out.Grow(len(query) + len(args)*16)
	argIndex := 0
	var quote byte
	for i := 0; i < len(query); i++ {
		ch := query[i]
		if quote != 0 {
			out.WriteByte(ch)
			if ch == '\\' && i+1 < len(query) {
				i++
				out.WriteByte(query[i])
				continue
			}
			if ch == quote {
				if i+1 < len(query) && query[i+1] == quote {
					i++
					out.WriteByte(query[i])
					continue
				}
				quote = 0
			}
			continue
		}
		if ch == '\'' || ch == '"' || ch == '`' {
			quote = ch
			out.WriteByte(ch)
			continue
		}
		if ch == '-' && i+1 < len(query) && query[i+1] == '-' {
			if end := strings.IndexByte(query[i:], '\n'); end >= 0 {
				out.WriteString(query[i : i+end+1])
				i += end
			} else {
				out.WriteString(query[i:])
				i = len(query)
			}
			continue
		}
		if ch == '/' && i+1 < len(query) && query[i+1] == '*' {
			if end := strings.Index(query[i+2:], "*/"); end >= 0 {
				out.WriteString(query[i : i+2+end+2])
				i += 2 + end + 1
			} else {
				out.WriteString(query[i:])
				i = len(query)
			}
			continue
		}
		if ch == '?' {
			if argIndex >= len(args) {
				return "", fmt.Errorf("Hive argument binding: more placeholders than arguments (%d)", len(args))
			}
			literal, err := hiveArgLiteral(args[argIndex])
			if err != nil {
				return "", fmt.Errorf("Hive argument %d: %w", argIndex+1, err)
			}
			out.WriteString(literal)
			argIndex++
			continue
		}
		out.WriteByte(ch)
	}
	if argIndex != len(args) {
		return "", fmt.Errorf("Hive argument binding: %d placeholders but %d arguments", argIndex, len(args))
	}
	return out.String(), nil
}

func hiveArgLiteral(value any) (string, error) {
	switch v := value.(type) {
	case nil:
		return "NULL", nil
	case bool:
		return hivesql.Value("boolean", v)
	case int:
		return strconv.FormatInt(int64(v), 10), nil
	case int8:
		return strconv.FormatInt(int64(v), 10), nil
	case int16:
		return strconv.FormatInt(int64(v), 10), nil
	case int32:
		return strconv.FormatInt(int64(v), 10), nil
	case int64:
		return strconv.FormatInt(v, 10), nil
	case uint:
		return strconv.FormatUint(uint64(v), 10), nil
	case uint8:
		return strconv.FormatUint(uint64(v), 10), nil
	case uint16:
		return strconv.FormatUint(uint64(v), 10), nil
	case uint32:
		return strconv.FormatUint(uint64(v), 10), nil
	case uint64:
		return strconv.FormatUint(v, 10), nil
	case float32:
		value := float64(v)
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return "", fmt.Errorf("non-finite float argument")
		}
		return strconv.FormatFloat(value, 'g', -1, 32), nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return "", fmt.Errorf("non-finite float argument")
		}
		return strconv.FormatFloat(v, 'g', -1, 64), nil
	case json.Number:
		text := strings.TrimSpace(v.String())
		if !hiveNumericArgPattern.MatchString(text) {
			return "", fmt.Errorf("invalid numeric argument %q", text)
		}
		return text, nil
	case time.Time:
		return hivesql.Value("timestamp", v)
	case []byte:
		return hivesql.Value("binary", v)
	case string:
		return hivesql.Value("string", v)
	default:
		return "", fmt.Errorf("unsupported Hive argument type %T", value)
	}
}
