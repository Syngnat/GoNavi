//go:build gonavi_full_drivers || gonavi_firebird_driver

package db

import (
	"fmt"
	"strconv"
	"strings"
)

// firebirdField 是 RDB$FIELDS（列、参数的域）里描述类型的那几列。
type firebirdField struct {
	fieldType  int
	subType    int
	length     int
	precision  int
	scale      int
	charLength int
	charset    string
	segment    int
}

// Firebird 的 RDB$FIELD_TYPE 编码。
const (
	firebirdTypeSmallint    = 7
	firebirdTypeInteger     = 8
	firebirdTypeQuad        = 9
	firebirdTypeFloat       = 10
	firebirdTypeDFloat      = 11
	firebirdTypeDate        = 12
	firebirdTypeTime        = 13
	firebirdTypeChar        = 14
	firebirdTypeBigint      = 16
	firebirdTypeBoolean     = 23
	firebirdTypeDecFloat16  = 24
	firebirdTypeDecFloat34  = 25
	firebirdTypeInt128      = 26
	firebirdTypeDouble      = 27
	firebirdTypeTimeTZ      = 28
	firebirdTypeTimestampTZ = 29
	firebirdTypeTimestamp   = 35
	firebirdTypeVarchar     = 37
	firebirdTypeCString     = 40
	firebirdTypeBlob        = 261
)

// typeName 返回 DDL 里使用的类型写法：NUMERIC / DECIMAL 按精度标度还原，OCTETS 字符集的定长 / 变长串在 4.0 起
// 写成 BINARY / VARBINARY，文本大对象写成 BLOB SUB_TYPE TEXT。
func (f firebirdField) typeName(binaryTypes bool) string {
	switch f.fieldType {
	case firebirdTypeSmallint, firebirdTypeInteger, firebirdTypeBigint, firebirdTypeInt128, firebirdTypeDouble:
		if exact := f.exactNumeric(); exact != "" {
			return exact
		}
		switch f.fieldType {
		case firebirdTypeSmallint:
			return "SMALLINT"
		case firebirdTypeInteger:
			return "INTEGER"
		case firebirdTypeBigint:
			return "BIGINT"
		case firebirdTypeInt128:
			return "INT128"
		}
		return "DOUBLE PRECISION"
	case firebirdTypeFloat:
		return "FLOAT"
	case firebirdTypeDFloat:
		return "DOUBLE PRECISION"
	case firebirdTypeQuad:
		return "QUAD"
	case firebirdTypeDate:
		return "DATE"
	case firebirdTypeTime:
		return "TIME"
	case firebirdTypeTimeTZ:
		return "TIME WITH TIME ZONE"
	case firebirdTypeTimestamp:
		return "TIMESTAMP"
	case firebirdTypeTimestampTZ:
		return "TIMESTAMP WITH TIME ZONE"
	case firebirdTypeBoolean:
		return "BOOLEAN"
	case firebirdTypeDecFloat16:
		return "DECFLOAT(16)"
	case firebirdTypeDecFloat34:
		return "DECFLOAT(34)"
	case firebirdTypeChar, firebirdTypeVarchar, firebirdTypeCString:
		length := f.charLength
		if length <= 0 {
			length = f.length
		}
		if strings.EqualFold(f.charset, "OCTETS") {
			if binaryTypes {
				if f.fieldType == firebirdTypeChar {
					return fmt.Sprintf("BINARY(%d)", f.length)
				}
				return fmt.Sprintf("VARBINARY(%d)", f.length)
			}
			if f.fieldType == firebirdTypeChar {
				return fmt.Sprintf("CHAR(%d) CHARACTER SET OCTETS", f.length)
			}
			return fmt.Sprintf("VARCHAR(%d) CHARACTER SET OCTETS", f.length)
		}
		if f.fieldType == firebirdTypeChar {
			return fmt.Sprintf("CHAR(%d)", length)
		}
		return fmt.Sprintf("VARCHAR(%d)", length)
	case firebirdTypeBlob:
		switch f.subType {
		case 0:
			return "BLOB"
		case 1:
			return "BLOB SUB_TYPE TEXT"
		default:
			return "BLOB SUB_TYPE " + strconv.Itoa(f.subType)
		}
	}
	return "UNKNOWN(" + strconv.Itoa(f.fieldType) + ")"
}

// exactNumeric 还原 NUMERIC / DECIMAL：子类型 1、2 分别是 NUMERIC、DECIMAL；方言 1 的数据库里大精度定点数存成 DOUBLE，
// 只能从负标度认出来。整数类型的子类型为 0 且标度为 0 时返回空串。
func (f firebirdField) exactNumeric() string {
	if f.subType == 0 && f.scale == 0 {
		return ""
	}
	keyword := "NUMERIC"
	if f.subType == 2 {
		keyword = "DECIMAL"
	}
	precision := f.precision
	if precision <= 0 {
		precision = map[int]int{firebirdTypeSmallint: 4, firebirdTypeInteger: 9, firebirdTypeBigint: 18, firebirdTypeInt128: 38, firebirdTypeDouble: 15}[f.fieldType]
	}
	return fmt.Sprintf("%s(%d,%d)", keyword, precision, -f.scale)
}

// firebirdTriggerTiming 解码 DML 触发器的 RDB$TRIGGER_TYPE：最低位区分 BEFORE / AFTER，其余每两位是一个事件
// （1 INSERT、2 UPDATE、3 DELETE），多事件触发器按顺序排列（如 17 = BEFORE INSERT OR UPDATE）。
// 数据库级与 DDL 触发器（类型 ≥ 8192）返回空事件。
func firebirdTriggerTiming(triggerType int) (timing string, events []string) {
	if triggerType <= 0 || triggerType >= 8192 {
		return "", nil
	}
	timing = "AFTER"
	if (triggerType+1)&1 == 0 {
		timing = "BEFORE"
	}
	names := map[int]string{1: "INSERT", 2: "UPDATE", 3: "DELETE"}
	for slots := (triggerType + 1) >> 1; slots != 0; slots >>= 2 {
		if name, ok := names[slots&3]; ok {
			events = append(events, name)
		}
	}
	return timing, events
}

// firebirdQuoteIdent 给标识符加双引号（方言 3 下按原样区分大小写）。
func firebirdQuoteIdent(name string) string {
	return `"` + strings.ReplaceAll(strings.TrimSpace(name), `"`, `""`) + `"`
}

// firebirdLiteral 生成字符串字面量。
func firebirdLiteral(text string) string {
	return "'" + strings.ReplaceAll(text, "'", "''") + "'"
}

// firebirdText 取系统表列的文本值：CHAR 列右侧填充空格，文本大对象可能以字节返回。
func firebirdText(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case []byte:
		return strings.TrimSpace(string(typed))
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

// firebirdRawText 与 firebirdText 相同但只去掉右侧空白（源码文本保留缩进）。
func firebirdRawText(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimRight(typed, " \r\n\t")
	case []byte:
		return strings.TrimRight(string(typed), " \r\n\t")
	default:
		return fmt.Sprint(typed)
	}
}

func firebirdInt(value interface{}) int {
	switch typed := value.(type) {
	case int64:
		return int(typed)
	case int32:
		return int(typed)
	case int:
		return typed
	case float64:
		return int(typed)
	case string:
		number, _ := strconv.Atoi(strings.TrimSpace(typed))
		return number
	case []byte:
		number, _ := strconv.Atoi(strings.TrimSpace(string(typed)))
		return number
	}
	return 0
}

// firebirdDefaultValue 去掉 RDB$DEFAULT_SOURCE 开头的 DEFAULT 关键字。
func firebirdDefaultValue(source string) (string, bool) {
	text := strings.TrimSpace(source)
	if text == "" {
		return "", false
	}
	if len(text) >= len("DEFAULT") && strings.EqualFold(text[:len("DEFAULT")], "DEFAULT") {
		text = strings.TrimSpace(text[len("DEFAULT"):])
	}
	return text, text != ""
}

// firebirdGeneratedConstraintName 报告约束名是不是系统生成的（INTEG_n、RDB$PRIMARYn 等），生成 DDL 时省略这类名字。
func firebirdGeneratedConstraintName(name string) bool {
	upper := strings.ToUpper(strings.TrimSpace(name))
	return upper == "" || strings.HasPrefix(upper, "INTEG_") || strings.HasPrefix(upper, "RDB$")
}
