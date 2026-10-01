package sync

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// 写入报「值太长」(22001) 时的失败诊断。
//
// 数据库返回的错误里没有列名，用户只看到 "varchar(120) 值太长了"，无从判断是哪一列、
// 到底是数据真的更长，还是目标按字节计长而源按字符计长。这里在失败后（不影响成功路径）
// 把本次要写入的数据与目标列的声明长度逐列比对，给出具体字段、最长字节数/字符数和参考 ALTER。
// 只在失败后运行，不会因为判断口径（字节 / 字符）不同而误拦成功的同步。

const (
	// valueLengthFindingLimit 限制提示里列出的字段数，避免宽表刷屏。
	valueLengthFindingLimit = 5
)

// valueLengthFinding 是某一目标列上超出声明长度的写入数据统计。
type valueLengthFinding struct {
	Column   string
	Type     string
	Limit    int
	MaxBytes int
	MaxChars int
	Rows     int
}

// charsOverflow 表示连字符数都超过了声明长度：数据本身比列长，与字节/字符计长口径无关。
func (f valueLengthFinding) charsOverflow() bool {
	return f.MaxChars > f.Limit
}

// charColumnLimit 解析目标列类型里的字符长度（varchar(n) / character varying(n) / char(n) 等）。
func charColumnLimit(rawType string) (int, bool) {
	match := charLengthTypePattern.FindStringSubmatch(rawType)
	if match == nil {
		return 0, false
	}
	limit, err := strconv.Atoi(match[2])
	if err != nil || limit <= 0 {
		return 0, false
	}
	return limit, true
}

// findValueLengthOverflows 扫描待写入的新增 / 更新行，返回按最长字节数降序的超长字段。
func findValueLengthOverflows(targetCols []connection.ColumnDefinition, changes connection.ChangeSet) []valueLengthFinding {
	type columnInfo struct {
		name  string
		typ   string
		limit int
	}
	limits := make(map[string]columnInfo, len(targetCols))
	for _, col := range targetCols {
		if limit, ok := charColumnLimit(col.Type); ok {
			limits[strings.ToLower(strings.TrimSpace(col.Name))] = columnInfo{name: col.Name, typ: strings.TrimSpace(col.Type), limit: limit}
		}
	}
	if len(limits) == 0 {
		return nil
	}

	found := make(map[string]*valueLengthFinding)
	observe := func(row map[string]any) {
		for name, value := range row {
			text, ok := value.(string)
			if !ok {
				continue
			}
			key := strings.ToLower(strings.TrimSpace(name))
			info, tracked := limits[key]
			if !tracked {
				continue
			}
			byteLen := len(text)
			if byteLen <= info.limit {
				continue
			}
			finding := found[key]
			if finding == nil {
				finding = &valueLengthFinding{Column: info.name, Type: info.typ, Limit: info.limit}
				found[key] = finding
			}
			finding.Rows++
			finding.MaxBytes = max(finding.MaxBytes, byteLen)
			finding.MaxChars = max(finding.MaxChars, utf8.RuneCountInString(text))
		}
	}
	for _, row := range changes.Inserts {
		observe(row)
	}
	for _, update := range changes.Updates {
		observe(update.Values)
	}

	findings := make([]valueLengthFinding, 0, len(found))
	for _, finding := range found {
		findings = append(findings, *finding)
	}
	sort.Slice(findings, func(i, j int) bool {
		if findings[i].MaxBytes != findings[j].MaxBytes {
			return findings[i].MaxBytes > findings[j].MaxBytes
		}
		return findings[i].Column < findings[j].Column
	})
	return findings
}

// suggestedCharColumnLength 给出参考加宽后的长度：至少放得下本次最长的数据，并留出 4 倍字节余量。
func suggestedCharColumnLength(f valueLengthFinding) int {
	return min(max(f.Limit*byteLengthWidenFactor, f.MaxBytes), byteLengthTypeMaxLength)
}

// buildValueTooLongDetail 把诊断结果渲染成一句提示（字段明细 + 参考 ALTER）。
func buildValueTooLongDetail(targetType, targetTable string, findings []valueLengthFinding) string {
	shown := findings
	if len(shown) > valueLengthFindingLimit {
		shown = shown[:valueLengthFindingLimit]
	}
	items := make([]string, 0, len(shown))
	alters := make([]string, 0, len(shown))
	for _, finding := range shown {
		items = append(items, localizedSyncBackendText("data_sync.backend.hint.value_too_long_column_item", map[string]any{
			"column": finding.Column,
			"type":   finding.Type,
			"bytes":  finding.MaxBytes,
			"chars":  finding.MaxChars,
			"rows":   finding.Rows,
		}))
		alters = append(alters, fmt.Sprintf("ALTER TABLE %s ALTER COLUMN %s TYPE varchar(%d);",
			quoteQualifiedIdentByType(targetType, targetTable),
			quoteIdentByType(targetType, finding.Column),
			suggestedCharColumnLength(finding)))
	}
	return localizedSyncBackendText("data_sync.backend.hint.value_too_long_columns", map[string]any{
		"columns": strings.Join(items, "；"),
	}) + " " + localizedSyncBackendText("data_sync.backend.hint.value_too_long_alter", map[string]any{
		"statements": strings.Join(alters, " "),
	})
}

// valueTooLongHint 为落库失败补充可操作的提示：
//   - 非「值太长」或目标不是按字节计长的库：不加提示；
//   - 能读到目标列定义：列出具体字段与参考 ALTER；数据本身字符数就超长时不再归因于字节计长；
//   - 读不到目标列定义：只给通用的字节计长提示。
func valueTooLongHint(targetType, targetTable string, applier db.BatchApplier, changes connection.ChangeSet, err error) string {
	generic := byteLengthOverflowHint(targetType, err)
	if generic == "" {
		return ""
	}
	database, ok := applier.(db.Database)
	if !ok {
		return generic
	}
	schema, table := splitQualifiedSyncObject(targetTable)
	targetCols, colErr := database.GetColumns(schema, table)
	if colErr != nil || len(targetCols) == 0 {
		return generic
	}
	findings := findValueLengthOverflows(targetCols, changes)
	if len(findings) == 0 {
		return generic
	}
	detail := buildValueTooLongDetail(targetType, targetTable, findings)
	for _, finding := range findings {
		if !finding.charsOverflow() {
			// 至少一个字段是「字符数没超、字节数超」，说明是目标按字节计长，补上口径说明。
			return generic + " " + detail
		}
	}
	return detail
}
