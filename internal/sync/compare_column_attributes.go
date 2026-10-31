package sync

import (
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// ColumnAttributeDiff 是「不改变列存在性与类型」的附属属性差异：默认值与注释。
//
// 这类差异不影响能否建表、也不影响数据能否写入，但会让同一份数据在两端的
// 行为不同（默认值不同意味着漏填的列会写进不同的值），所以单列一张附表。
type ColumnAttributeDiff struct {
	Column string `json:"column"`
	// Kind is one of default, comment.
	Kind   string `json:"kind"`
	Source string `json:"source,omitempty"`
	Target string `json:"target,omitempty"`
}

const (
	ColumnAttributeDefault = "default"
	ColumnAttributeComment = "comment"
)

// describeColumnDefault 把默认值渲染成可读文本。
//
// 「没有 DEFAULT 子句」与「DEFAULT NULL」是两件事，前者必须显式说成「无」，
// 留空会让人以为后端没取到值。
func describeColumnDefault(col connection.ColumnDefinition) string {
	if col.Default == nil {
		if col.HasDefault {
			return "NULL"
		}
		return ""
	}
	value := strings.TrimSpace(*col.Default)
	if value == "" && !col.HasDefault {
		return ""
	}
	return value
}

// diffColumnAttributes 对比默认值与注释。
//
// 只在两端都读到了有效元数据时才比较该维度：驱动不给注释时两边都是空串，
// 那不代表「一致」，而「取不到」与「空值」无法区分，报差异会全是噪音。
func diffColumnAttributes(
	sourceCols, targetCols []connection.ColumnDefinition,
) []ColumnAttributeDiff {
	targetByKey := make(map[string]connection.ColumnDefinition, len(targetCols))
	for _, col := range targetCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		if _, seen := targetByKey[key]; !seen {
			targetByKey[key] = col
		}
	}

	diffs := make([]ColumnAttributeDiff, 0)
	for _, sourceCol := range sourceCols {
		key := strings.ToLower(strings.TrimSpace(sourceCol.Name))
		if key == "" {
			continue
		}
		targetCol, ok := targetByKey[key]
		if !ok {
			// 列本身缺失由列差异负责，这里不重复报。
			continue
		}

		sourceDefault := describeColumnDefault(sourceCol)
		targetDefault := describeColumnDefault(targetCol)
		// 两端都没有 DEFAULT 子句 = 一致；只有一端有才是差异。
		// 「没有子句」与「DEFAULT NULL」在 MySQL 里语义不同，所以用
		// 「是否为空串」区分，而不是把两者都当成 NULL。
		if sourceDefault != targetDefault &&
			(sourceDefault != "" || targetDefault != "" || sourceCol.HasDefault != targetCol.HasDefault) {
			diffs = append(diffs, ColumnAttributeDiff{
				Column: sourceCol.Name,
				Kind:   ColumnAttributeDefault,
				Source: sourceDefault,
				Target: targetDefault,
			})
		}

		sourceComment := strings.TrimSpace(sourceCol.Comment)
		targetComment := strings.TrimSpace(targetCol.Comment)
		// 两端都读不到注释（驱动不支持）时不报：那是取不到，不是一致。
		if sourceComment != targetComment && (sourceComment != "" || targetComment != "") {
			diffs = append(diffs, ColumnAttributeDiff{
				Column: sourceCol.Name,
				Kind:   ColumnAttributeComment,
				Source: sourceComment,
				Target: targetComment,
			})
		}
	}

	sort.SliceStable(diffs, func(i, j int) bool {
		if diffs[i].Kind == diffs[j].Kind {
			return diffs[i].Column < diffs[j].Column
		}
		return diffs[i].Kind < diffs[j].Kind
	})
	return diffs
}
