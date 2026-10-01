package sync

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// 字符列长度按「字节」计的目标：openGauss 系（Vastbase 海量 / openGauss / GaussDB）。
//
// 这一族数据库在非 PG 兼容模式（默认的 A 兼容等）下，varchar(n) / char(n) 的 n 是
// 字节数，而不是 PostgreSQL 那样的字符数。源库的长度声明大多按字符计（MySQL、
// PostgreSQL 系、Oracle 的 VARCHAR2(n CHAR)），或者按源库自己的编码计字节
// （Oracle 库是 GBK 时一个汉字 2 字节，到 UTF-8 的目标里变成 3 字节）。原样把
// varchar(120) 建到目标里，含中文的数据就会以
// "value too long for type character varying(120) (22001)" 写入失败。
//
// 处理方式：建表 / 补列时把字符列的长度放宽到 4 倍（UTF-8 单字符最多 4 字节），
// 并用一条告警说明。放宽只会让约束变松，PG 兼容模式的库里同样能正常写入。

const (
	// byteLengthWidenFactor 为 UTF-8 单个字符的最大字节数。
	byteLengthWidenFactor = 4
	// byteLengthTypeMaxLength 是 openGauss 系变长字符类型的长度上限（字节）。
	byteLengthTypeMaxLength = 10485760
	// byteLengthWarningColumnLimit 限制告警里列出的字段数，避免宽表刷屏。
	byteLengthWarningColumnLimit = 5
)

// charLengthTypePattern 匹配带长度的定长/变长字符类型（中间表示与 PG 系写法都覆盖）。
var charLengthTypePattern = regexp.MustCompile(`(?i)^(\s*(?:character\s+varying|varchar|character|char|bpchar)\s*\(\s*)(\d+)(\s*\)\s*)$`)

// targetCountsCharLengthInBytes 判定目标方言的 varchar/char 长度是否按字节计。
func targetCountsCharLengthInBytes(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "vastbase", "opengauss", "gaussdb":
		return true
	default:
		return false
	}
}

// byteLengthWidener 在建表 / 补列阶段放宽字符列长度，并汇总告警。
// 零值与 nil 都是「不生效」，调用方无需判空。
type byteLengthWidener struct {
	targetType string
	active     bool
	widened    []string
}

// newByteLengthWidener 只在「目标按字节计长、源不是同一族」时生效：
// 同为 openGauss 系时两端语义一致，长度原样保留才是无损的。
func newByteLengthWidener(sourceType, targetType string) *byteLengthWidener {
	return &byteLengthWidener{
		targetType: strings.TrimSpace(targetType),
		active:     targetCountsCharLengthInBytes(targetType) && !targetCountsCharLengthInBytes(sourceType),
	}
}

// widenCharLengthType 把 varchar(n)/char(n) 的 n 放宽到 4 倍，返回新类型与放宽前后的长度。
func widenCharLengthType(rawType string) (string, int, int, bool) {
	match := charLengthTypePattern.FindStringSubmatch(rawType)
	if match == nil {
		return rawType, 0, 0, false
	}
	length, err := strconv.Atoi(match[2])
	if err != nil || length <= 0 || length >= byteLengthTypeMaxLength {
		return rawType, 0, 0, false
	}
	widened := min(length*byteLengthWidenFactor, byteLengthTypeMaxLength)
	return match[1] + strconv.Itoa(widened) + match[3], length, widened, true
}

// Adapt 返回放宽长度后的列定义；不需要放宽时原样返回。
func (w *byteLengthWidener) Adapt(col connection.ColumnDefinition) connection.ColumnDefinition {
	if w == nil || !w.active {
		return col
	}
	widenedType, from, to, ok := widenCharLengthType(col.Type)
	if !ok {
		return col
	}
	w.widened = append(w.widened, fmt.Sprintf("%s(%d→%d)", col.Name, from, to))
	col.Type = widenedType
	return col
}

// Warnings 汇总为一条告警；没有放宽任何列时返回 nil。
func (w *byteLengthWidener) Warnings() []string {
	if w == nil || len(w.widened) == 0 {
		return nil
	}
	shown := w.widened
	suffix := ""
	if len(shown) > byteLengthWarningColumnLimit {
		shown = shown[:byteLengthWarningColumnLimit]
		suffix = fmt.Sprintf(" 等 %d 个字段", len(w.widened))
	}
	return []string{fmt.Sprintf(
		"目标 %s 的 varchar/char 长度按字节计（PG 兼容模式除外），源端按字符计长，含中文等多字节字符的数据会超出原声明长度而写入失败；已将字符列长度放宽为 %d 倍：%s%s",
		w.targetType, byteLengthWidenFactor, strings.Join(shown, "、"), suffix,
	)}
}

// isValueTooLongError 判定写入错误是否为「值超出列长度」（SQLSTATE 22001）。
func isValueTooLongError(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "22001") ||
		strings.Contains(text, "value too long") ||
		strings.Contains(text, "值太长")
}

// byteLengthOverflowHint 给「目标按字节计长 + 值太长」的写入失败补一句可操作的提示。
// 目标表已存在时无法由同步自动改长度，只能提示用户处理。
func byteLengthOverflowHint(targetType string, err error) string {
	if !targetCountsCharLengthInBytes(targetType) || !isValueTooLongError(err) {
		return ""
	}
	return localizedSyncBackendText("data_sync.backend.hint.byte_length_overflow", map[string]any{
		"target": strings.TrimSpace(targetType),
	})
}
