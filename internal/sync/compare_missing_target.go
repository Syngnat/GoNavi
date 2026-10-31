package sync

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

// compareMissingTargetColumns 把源表全部列标成「目标缺失」。
//
// 对比任务的目标表整表不存在时，没有目标列可比，缺表本身就是差异的全部内容。
// 上层据此在前端渲染整表缺表并生成 CREATE TABLE，所以这里保留源列顺序与列定义
// 文本（含类型与 NOT NULL），不做任何方言改写。
func compareMissingTargetColumns(cols []connection.ColumnDefinition) ([]string, []ColumnStructureDiff) {
	missing := make([]string, 0, len(cols))
	diffs := make([]ColumnStructureDiff, 0, len(cols))
	for _, column := range cols {
		name := strings.TrimSpace(column.Name)
		if name == "" {
			continue
		}
		missing = append(missing, name)
		diffs = append(diffs, ColumnStructureDiff{
			Column: name,
			Kind:   "missing_in_target",
			Source: describeColumnStructure(column),
		})
	}
	return missing, diffs
}
