//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"fmt"
	"regexp"
	"strings"
)

// gbase8sColumnInfo 是 syscolumns 的一行（coltype 低 8 位是类型码，0x100 表示 NOT NULL）。
type gbase8sColumnInfo struct {
	no         int
	name       string
	coltype    int
	collength  int
	extendedID int
	xtdName    string
	defType    string
	defValue   string
	comment    string
}

func (c gbase8sColumnInfo) baseType() int { return c.coltype & 0xFF }
func (c gbase8sColumnInfo) notNull() bool { return c.coltype&0x100 != 0 }

func (c gbase8sColumnInfo) isSerial() bool {
	switch c.baseType() {
	case 6, 18, 53:
		return true
	}
	return false
}

func (c gbase8sColumnInfo) isNumeric() bool {
	switch c.baseType() {
	case 1, 2, 3, 4, 5, 6, 8, 17, 18, 52, 53:
		return true
	}
	return false
}

// typeName 按 Informix 的 coltype / collength 编码还原列类型（含长度、精度与 DATETIME / INTERVAL 限定符）。
func (c gbase8sColumnInfo) typeName() string {
	length := c.collength
	switch c.baseType() {
	case 0:
		return fmt.Sprintf("CHAR(%d)", length)
	case 1:
		return "SMALLINT"
	case 2:
		return "INTEGER"
	case 3:
		return "FLOAT"
	case 4:
		return "SMALLFLOAT"
	case 5:
		return gbase8sDecimalType("DECIMAL", length)
	case 6:
		return "SERIAL"
	case 7:
		return "DATE"
	case 8:
		return gbase8sDecimalType("MONEY", length)
	case 10:
		return "DATETIME " + gbase8sQualifier(length, false)
	case 11:
		return "BYTE"
	case 12:
		return "TEXT"
	case 13:
		return gbase8sVarcharType("VARCHAR", length)
	case 14:
		return "INTERVAL " + gbase8sQualifier(length, true)
	case 15:
		return fmt.Sprintf("NCHAR(%d)", length)
	case 16:
		return gbase8sVarcharType("NVARCHAR", length)
	case 17:
		return "INT8"
	case 18:
		return "SERIAL8"
	case 19, 20, 21, 22:
		return strings.ToUpper(map[int]string{19: "SET", 20: "MULTISET", 21: "LIST", 22: "ROW"}[c.baseType()])
	case 40, 41:
		name := strings.ToUpper(strings.TrimSpace(c.xtdName))
		if name == "" {
			name = "LVARCHAR"
		}
		if name == "LVARCHAR" && length > 0 {
			return fmt.Sprintf("LVARCHAR(%d)", length)
		}
		return name
	case 43:
		return fmt.Sprintf("LVARCHAR(%d)", length)
	case 45:
		return "BOOLEAN"
	case 52:
		return "BIGINT"
	case 53:
		return "BIGSERIAL"
	}
	if name := strings.TrimSpace(c.xtdName); name != "" {
		return strings.ToUpper(name)
	}
	return fmt.Sprintf("UNKNOWN(%d)", c.baseType())
}

func gbase8sDecimalType(name string, length int) string {
	precision, scale := length>>8, length&0xFF
	if scale == 0xFF {
		return fmt.Sprintf("%s(%d)", name, precision)
	}
	return fmt.Sprintf("%s(%d,%d)", name, precision, scale)
}

// gbase8sVarcharType 解码 VARCHAR / NVARCHAR 的 collength：Informix 是 预留*256 + 最大长度，
// GBase 8s 8.8 是 预留*65536 + 最大长度（最大长度不超过 255，高位出现在 16 位以上时按后者解码）。
func gbase8sVarcharType(name string, length int) string {
	maxSize, minSize := length&0xFF, length>>8
	if length > 0xFFFF {
		maxSize, minSize = length&0xFFFF, length>>16
	}
	if minSize > 0 {
		return fmt.Sprintf("%s(%d,%d)", name, maxSize, minSize)
	}
	return fmt.Sprintf("%s(%d)", name, maxSize)
}

var gbase8sQualifierNames = map[int]string{0: "YEAR", 2: "MONTH", 4: "DAY", 6: "HOUR", 8: "MINUTE", 10: "SECOND"}

// gbase8sQualifier 解码 DATETIME / INTERVAL 的限定符：collength = 总位数*256 + 起始字段*16 + 结束字段。
// INTERVAL 的首字段可以带精度，用总位数减去后续字段的位数得到。
func gbase8sQualifier(length int, interval bool) string {
	digits, first, last := length>>8, (length>>4)&0x0F, length&0x0F
	field := func(code int) string {
		if code > 10 {
			return fmt.Sprintf("FRACTION(%d)", code-10)
		}
		return gbase8sQualifierNames[code]
	}
	start := field(first)
	if first > 10 {
		start = "FRACTION"
	}
	if interval && first <= 10 {
		rest := 0
		for code := first + 2; code <= min(last, 10); code += 2 {
			rest += 2
		}
		if last > 10 {
			rest += last - 10
		}
		defaultPrecision := 2
		if first == 0 {
			defaultPrecision = 4
		}
		if precision := digits - rest; precision > 0 && precision != defaultPrecision {
			start = fmt.Sprintf("%s(%d)", start, precision)
		}
	}
	return start + " TO " + field(last)
}

// defaultClause 把 sysdefaults 的默认值还原成 SQL 片段（数值字面量前面带有内部编码，取最后一段）。
func (c gbase8sColumnInfo) defaultClause() (string, bool) {
	switch strings.TrimSpace(c.defType) {
	case "L":
		// sysdefaults.default 是定长字段，尾部可能是空格或 NUL。
		value := strings.TrimRight(c.defValue, " \x00")
		if c.isNumeric() {
			if index := strings.LastIndex(value, " "); index >= 0 {
				value = value[index+1:]
			}
			return value, value != ""
		}
		if c.baseType() == 45 || strings.EqualFold(c.xtdName, "boolean") {
			value = strings.TrimSpace(strings.ReplaceAll(value, "\x00", ""))
		}
		return "'" + strings.ReplaceAll(value, "'", "''") + "'", true
	case "U":
		return "USER", true
	case "C":
		if c.baseType() == 10 {
			return "CURRENT " + gbase8sQualifier(c.collength, false), true
		}
		return "CURRENT", true
	case "N":
		return "NULL", true
	case "T":
		return "TODAY", true
	case "S":
		return "DBSERVERNAME", true
	}
	return "", false
}

var gbase8sSimpleIdentPattern = regexp.MustCompile(`^[a-z_][a-z0-9_$]*$`)

// gbase8sQuoteIdent 只在必要时加双引号（连接打开了 DELIMIDENT，引号内区分大小写）。
func gbase8sQuoteIdent(name string) string {
	if gbase8sSimpleIdentPattern.MatchString(name) && !gbase8sReservedWords[strings.ToUpper(name)] {
		return name
	}
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func gbase8sLiteral(text string) string {
	return "'" + strings.ReplaceAll(text, "'", "''") + "'"
}

// gbase8sReservedWords 是生成 DDL 时需要加引号的常见保留字（不求完整，只覆盖容易用作列名的词）。
var gbase8sReservedWords = map[string]bool{
	"ALL": true, "AND": true, "AS": true, "BY": true, "CHECK": true, "COLUMN": true, "CREATE": true, "CURRENT": true,
	"DATE": true, "DEFAULT": true, "DELETE": true, "DESC": true, "DISTINCT": true, "FROM": true, "GROUP": true,
	"INDEX": true, "INSERT": true, "INTO": true, "KEY": true, "LEVEL": true, "MODE": true, "NOT": true, "NULL": true,
	"ON": true, "OR": true, "ORDER": true, "PRIMARY": true, "REFERENCES": true, "ROWID": true, "SELECT": true,
	"SIZE": true, "TABLE": true, "TODAY": true, "TYPE": true, "UNIQUE": true, "UPDATE": true, "USER": true,
	"VALUES": true, "VIEW": true, "WHERE": true,
}
