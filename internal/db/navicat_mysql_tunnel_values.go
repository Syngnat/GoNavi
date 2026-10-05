package db

import (
	"database/sql/driver"
	"encoding/hex"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"
)

func navicatMySQLDatabaseTypeName(typeID uint32) string {
	switch typeID {
	case 0:
		return "DECIMAL"
	case 1:
		return "TINYINT"
	case 2:
		return "SMALLINT"
	case 3:
		return "INT"
	case 4:
		return "FLOAT"
	case 5:
		return "DOUBLE"
	case 6:
		return "NULL"
	case 7:
		return "TIMESTAMP"
	case 8:
		return "BIGINT"
	case 9:
		return "MEDIUMINT"
	case 10, 14:
		return "DATE"
	case 11, 19:
		return "TIME"
	case 12, 18:
		return "DATETIME"
	case 13:
		return "YEAR"
	case 15:
		return "VARCHAR"
	case 16:
		return "BIT"
	case 17:
		return "TIMESTAMP"
	case 245:
		return "JSON"
	case 246:
		return "DECIMAL"
	case 247:
		return "ENUM"
	case 248:
		return "SET"
	case 249:
		return "TINYBLOB"
	case 250:
		return "MEDIUMBLOB"
	case 251:
		return "LONGBLOB"
	case 252:
		return "BLOB"
	case 253:
		return "VAR_STRING"
	case 254:
		return "STRING"
	case 255:
		return "GEOMETRY"
	default:
		return fmt.Sprintf("MYSQL_%d", typeID)
	}
}

func interpolateNavicatMySQLQuery(query string, args []driver.NamedValue) (string, error) {
	if len(args) == 0 {
		return query, nil
	}
	for _, arg := range args {
		if arg.Name != "" {
			return "", fmt.Errorf("Navicat HTTP 隧道不支持命名参数 %q", arg.Name)
		}
	}

	var result strings.Builder
	result.Grow(len(query) + len(args)*8)
	argIndex := 0
	state := byte(0)
	for index := 0; index < len(query); index++ {
		current := query[index]
		switch state {
		case '\'':
			result.WriteByte(current)
			if current == '\\' && index+1 < len(query) {
				index++
				result.WriteByte(query[index])
			} else if current == '\'' {
				if index+1 < len(query) && query[index+1] == '\'' {
					index++
					result.WriteByte(query[index])
				} else {
					state = 0
				}
			}
		case '"':
			result.WriteByte(current)
			if current == '\\' && index+1 < len(query) {
				index++
				result.WriteByte(query[index])
			} else if current == '"' {
				if index+1 < len(query) && query[index+1] == '"' {
					index++
					result.WriteByte(query[index])
				} else {
					state = 0
				}
			}
		case '`':
			result.WriteByte(current)
			if current == '`' {
				if index+1 < len(query) && query[index+1] == '`' {
					index++
					result.WriteByte(query[index])
				} else {
					state = 0
				}
			}
		case '#':
			result.WriteByte(current)
			if current == '\n' || current == '\r' {
				state = 0
			}
		case '-':
			result.WriteByte(current)
			if current == '\n' || current == '\r' {
				state = 0
			}
		case '*':
			result.WriteByte(current)
			if current == '*' && index+1 < len(query) && query[index+1] == '/' {
				index++
				result.WriteByte('/')
				state = 0
			}
		default:
			switch {
			case current == '\'', current == '"', current == '`':
				state = current
				result.WriteByte(current)
			case current == '#':
				state = '#'
				result.WriteByte(current)
			case current == '-' && index+2 < len(query) && query[index+1] == '-' && query[index+2] <= ' ':
				state = '-'
				result.WriteString("--")
				index++
			case current == '/' && index+1 < len(query) && query[index+1] == '*':
				state = '*'
				result.WriteString("/*")
				index++
			case current == '?':
				if argIndex >= len(args) {
					return "", fmt.Errorf("Navicat HTTP 隧道 SQL 参数不足")
				}
				literal, err := navicatMySQLLiteral(args[argIndex].Value)
				if err != nil {
					return "", fmt.Errorf("Navicat HTTP 隧道 SQL 参数 %d 无法编码：%w", argIndex+1, err)
				}
				result.WriteString(literal)
				argIndex++
			default:
				result.WriteByte(current)
			}
		}
	}
	if argIndex != len(args) {
		return "", fmt.Errorf("Navicat HTTP 隧道 SQL 参数过多：需要 %d，收到 %d", argIndex, len(args))
	}
	return result.String(), nil
}

func navicatMySQLLiteral(value interface{}) (string, error) {
	switch typed := value.(type) {
	case nil:
		return "NULL", nil
	case bool:
		if typed {
			return "1", nil
		}
		return "0", nil
	case int64:
		return strconv.FormatInt(typed, 10), nil
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return "", fmt.Errorf("不支持非有限浮点数")
		}
		return strconv.FormatFloat(typed, 'g', -1, 64), nil
	case []byte:
		return "X'" + hex.EncodeToString(typed) + "'", nil
	case string:
		if typed == "" {
			return "''", nil
		}
		return "CONVERT(X'" + hex.EncodeToString([]byte(typed)) + "' USING utf8mb4)", nil
	case time.Time:
		return "'" + typed.Format("2006-01-02 15:04:05.999999") + "'", nil
	default:
		converted, err := driver.DefaultParameterConverter.ConvertValue(value)
		if err != nil {
			return "", err
		}
		if reflect.DeepEqual(converted, value) {
			return "", fmt.Errorf("不支持参数类型 %T", value)
		}
		return navicatMySQLLiteral(converted)
	}
}
