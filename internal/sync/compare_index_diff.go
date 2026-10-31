package sync

import (
	"sort"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// IndexStructureDiff 是一条索引级结构差异。
//
// 索引在两端的元数据里没有稳定的唯一标识：名字相同不代表定义相同，
// 列集合相同也可能只是被重命名。这里用「规范化定义」做键来比较，
// 改列、改唯一性、改索引类型都会被识别成 changed；定义完全相同但名字
// 不同则识别成 renamed（跨引擎默认命名差异很常见，不该报成增删）。
type IndexStructureDiff struct {
	// Name 是差异在源端的索引名；只在目标端存在时取目标端的名字。
	Name string `json:"name"`
	// Kind is one of missing_in_target, extra_in_target, changed, renamed.
	Kind      string   `json:"kind"`
	Source    string   `json:"source,omitempty"`
	Target    string   `json:"target,omitempty"`
	Columns   []string `json:"columns,omitempty"`
	Unique    bool     `json:"unique,omitempty"`
	IndexType string   `json:"indexType,omitempty"`
}

// TableDiffStats 是前端仪表盘需要的分维度计数。
//
// 对比结果的明细里既有列差异也有索引差异，两边口径不同：列差异按
// missing/extra/type/nullable 分，索引按 missing/extra/changed 分。
// 这个结构把两边的计数一次给全，避免前端各算一遍还要处理模式差异。
type TableDiffStats struct {
	Columns TableColumnDiffStats `json:"columns"`
	Indexes TableIndexDiffStats  `json:"indexes"`
	// TargetTableMissing 表示目标整表不存在：此时列差异展开的是整表，
	// 前端应渲染成「整表缺失」而不是逐列差异。
	TargetTableMissing bool `json:"targetTableMissing,omitempty"`
}

type TableColumnDiffStats struct {
	MissingInTarget int `json:"missingInTarget"`
	ExtraInTarget   int `json:"extraInTarget"`
	TypeChanged     int `json:"typeChanged"`
	NullableChanged int `json:"nullableChanged"`
	Renamed         int `json:"renamed"`
	// CapacityDegraded 是同一容量族内部缩小（如 longtext → mediumtext）。
	CapacityDegraded int `json:"capacityDegraded"`
}

type TableIndexDiffStats struct {
	MissingInTarget int `json:"missingInTarget"`
	ExtraInTarget   int `json:"extraInTarget"`
	Changed         int `json:"changed"`
	Renamed         int `json:"renamed"`
}

// 索引差异的 kind 常量：与列差异保持同一套命名，前端可以共用渲染逻辑。
const (
	IndexDiffMissingInTarget = "missing_in_target"
	IndexDiffExtraInTarget   = "extra_in_target"
	IndexDiffChanged         = "changed"
	IndexDiffRenamed         = "renamed"
)

// describeIndex 生成索引的可读定义，用于差异摘要与前端展示。
func describeIndex(index groupedIndex) string {
	columns := make([]string, 0, len(index.Columns))
	for _, column := range index.Columns {
		if column.PrefixLength > 0 {
			columns = append(columns, column.Name+"("+strconv.Itoa(column.PrefixLength)+")")
			continue
		}
		columns = append(columns, column.Name)
	}
	attrs := make([]string, 0, 2)
	if index.Unique {
		attrs = append(attrs, "UNIQUE")
	}
	if indexType := strings.ToUpper(strings.TrimSpace(index.IndexType)); indexType != "" {
		attrs = append(attrs, indexType)
	}
	head := strings.Join(columns, ",")
	if len(attrs) == 0 {
		return head
	}
	return strings.Join(attrs, " ") + " (" + head + ")"
}

// indexComparisonKey 把索引归一到可比较的键：列顺序、唯一性、索引类型
// 都参与，名字不参与（名字差异单独按 rename 处理会误报跨引擎的默认命名差异）。
func indexComparisonKey(index groupedIndex) string {
	columns := make([]string, 0, len(index.Columns))
	for _, column := range index.Columns {
		name := strings.ToLower(strings.TrimSpace(column.Name))
		if column.PrefixLength > 0 {
			name += "(" + strconv.Itoa(column.PrefixLength) + ")"
		}
		columns = append(columns, name)
	}
	uniqueness := "0"
	if index.Unique {
		uniqueness = "1"
	}
	return strings.ToLower(strings.Join(columns, ",")) + "|" + uniqueness +
		"|" + strings.ToLower(strings.TrimSpace(index.IndexType))
}

// diffIndexStructures 对比两端索引定义。
//
// 只有在两端都能读到索引元数据时才应该调用：索引读取失败与「没有索引」
// 无法区分，把失败当成空集合会把整表误报成全缺索引。调用方负责这个判断。
func diffIndexStructures(
	sourceIndexes, targetIndexes []connection.IndexDefinition,
) []IndexStructureDiff {
	sourceGrouped := groupIndexDefinitions(sourceIndexes)
	targetGrouped := groupIndexDefinitions(targetIndexes)
	if len(sourceGrouped) == 0 && len(targetGrouped) == 0 {
		return nil
	}

	// 按规范化定义配对：先消掉「同定义不同名」的重命名，剩下的才是真差异。
	targetByKey := make(map[string][]groupedIndex, len(targetGrouped))
	for _, index := range targetGrouped {
		key := indexComparisonKey(index)
		targetByKey[key] = append(targetByKey[key], index)
	}
	matchedTarget := make(map[int]struct{}, len(targetGrouped))
	sourceKeys := make(map[string]struct{}, len(sourceGrouped))
	diffs := make([]IndexStructureDiff, 0)

	// 同名索引优先配对，这样「同名但定义变了」能稳定报成 changed。
	for _, index := range sourceGrouped {
		sourceKeys[indexComparisonKey(index)] = struct{}{}
	}
	for _, source := range sourceGrouped {
		sameName := -1
		for position, target := range targetGrouped {
			if _, taken := matchedTarget[position]; taken {
				continue
			}
			if !strings.EqualFold(strings.TrimSpace(target.Name), strings.TrimSpace(source.Name)) {
				continue
			}
			sameName = position
			break
		}
		if sameName >= 0 {
			matchedTarget[sameName] = struct{}{}
			target := targetGrouped[sameName]
			if indexComparisonKey(source) != indexComparisonKey(target) {
				diffs = append(diffs, indexDiffFor(source, target, IndexDiffChanged))
			}
			continue
		}
		candidates := targetByKey[indexComparisonKey(source)]
		reused := -1
		for _, candidate := range candidates {
			for position, target := range targetGrouped {
				if target.Name != candidate.Name {
					continue
				}
				if _, taken := matchedTarget[position]; taken {
					continue
				}
				matchedTarget[position] = struct{}{}
				reused = position
				break
			}
			if reused >= 0 {
				break
			}
		}
		// 同定义但换了名字：这是一次重命名，不是「一删一增」。跨引擎的默认
		// 索引命名本来就不一致，把它报成增删会让整库索引全变成差异。
		if reused >= 0 {
			diffs = append(diffs, indexDiffFor(source, targetGrouped[reused], IndexDiffRenamed))
			continue
		}
		diffs = append(diffs, indexDiffFor(source, groupedIndex{}, IndexDiffMissingInTarget))
	}

	for position, target := range targetGrouped {
		if _, taken := matchedTarget[position]; taken {
			continue
		}
		diffs = append(diffs, indexDiffFor(groupedIndex{}, target, IndexDiffExtraInTarget))
	}

	sort.SliceStable(diffs, func(i, j int) bool {
		if diffs[i].Kind == diffs[j].Kind {
			return diffs[i].Name < diffs[j].Name
		}
		return indexDiffKindOrder(diffs[i].Kind) < indexDiffKindOrder(diffs[j].Kind)
	})
	return diffs
}

func indexDiffKindOrder(kind string) int {
	switch kind {
	case IndexDiffMissingInTarget:
		return 0
	case IndexDiffExtraInTarget:
		return 1
	case IndexDiffRenamed:
		return 2
	default:
		return 3
	}
}

func indexDiffFor(source, target groupedIndex, kind string) IndexStructureDiff {
	diff := IndexStructureDiff{Kind: kind}
	switch kind {
	case IndexDiffMissingInTarget:
		diff.Name = source.Name
		diff.Source = describeIndex(source)
		diff.Columns, diff.Unique, diff.IndexType = indexColumns(source)
	case IndexDiffRenamed:
		diff.Name = source.Name
		diff.Source = source.Name
		diff.Target = target.Name
		diff.Columns, diff.Unique, diff.IndexType = indexColumns(source)
	case IndexDiffExtraInTarget:
		diff.Name = target.Name
		diff.Target = describeIndex(target)
		diff.Columns, diff.Unique, diff.IndexType = indexColumns(target)
	default:
		diff.Name = source.Name
		diff.Source = describeIndex(source)
		diff.Target = describeIndex(target)
		diff.Columns, diff.Unique, diff.IndexType = indexColumns(source)
	}
	return diff
}

func indexColumns(index groupedIndex) ([]string, bool, string) {
	columns := make([]string, 0, len(index.Columns))
	for _, column := range index.Columns {
		columns = append(columns, column.Name)
	}
	return columns, index.Unique, strings.TrimSpace(index.IndexType)
}

// summarizeIndexStructureDiffs 生成索引差异的一句话摘要。
func summarizeIndexStructureDiffs(diffs []IndexStructureDiff) string {
	counts := make(map[string]int, 3)
	for _, diff := range diffs {
		counts[diff.Kind]++
	}
	parts := make([]string, 0, 3)
	if n := counts[IndexDiffMissingInTarget]; n > 0 {
		parts = append(parts, "目标缺失 "+strconv.Itoa(n)+" 个索引")
	}
	if n := counts[IndexDiffExtraInTarget]; n > 0 {
		parts = append(parts, "目标多出 "+strconv.Itoa(n)+" 个索引")
	}
	if n := counts[IndexDiffChanged]; n > 0 {
		parts = append(parts, strconv.Itoa(n)+" 个索引定义不同")
	}
	if n := counts[IndexDiffRenamed]; n > 0 {
		parts = append(parts, strconv.Itoa(n)+" 个索引疑似重命名")
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, "，")
}

// compareTableIndexes 读取两端索引并比对。
//
// 任一端读取失败都返回 nil：索引读失败与「该表没有索引」无法区分，
// 把失败当成空集合会把整表误报成「全是缺失索引」，那比不报告更糟。
func compareTableIndexes(
	sourceDB, targetDB db.Database,
	sourceSchema, sourceTable, targetSchema, targetTable string,
) []IndexStructureDiff {
	if sourceDB == nil || targetDB == nil {
		return nil
	}
	sourceIndexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		return nil
	}
	targetIndexes, err := targetDB.GetIndexes(targetSchema, targetTable)
	if err != nil {
		return nil
	}
	return diffIndexStructures(sourceIndexes, targetIndexes)
}

// buildTableDiffStats 汇总一张表的列/索引差异计数。
func buildTableDiffStats(
	columnDiffs []ColumnStructureDiff,
	indexDiffs []IndexStructureDiff,
	targetTableMissing bool,
) *TableDiffStats {
	if len(columnDiffs) == 0 && len(indexDiffs) == 0 && !targetTableMissing {
		return nil
	}
	stats := TableDiffStats{TargetTableMissing: targetTableMissing}
	for _, diff := range columnDiffs {
		switch diff.Kind {
		case "missing_in_target":
			stats.Columns.MissingInTarget++
		case "extra_in_target":
			stats.Columns.ExtraInTarget++
		case "type":
			stats.Columns.TypeChanged++
		case ColumnDiffNullable:
			stats.Columns.NullableChanged++
		case ColumnDiffRenamed:
			stats.Columns.Renamed++
		case ColumnDiffCapacityDegraded:
			stats.Columns.CapacityDegraded++
		}
	}
	for _, diff := range indexDiffs {
		switch diff.Kind {
		case IndexDiffMissingInTarget:
			stats.Indexes.MissingInTarget++
		case IndexDiffExtraInTarget:
			stats.Indexes.ExtraInTarget++
		case IndexDiffChanged:
			stats.Indexes.Changed++
		case IndexDiffRenamed:
			stats.Indexes.Renamed++
		}
	}
	return &stats
}
