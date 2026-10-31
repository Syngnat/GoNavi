package sync

import (
	"regexp"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func diffMissingColumnNames(sourceCols, targetCols []connection.ColumnDefinition) []string {
	if len(sourceCols) == 0 {
		return nil
	}
	targetSet := make(map[string]struct{}, len(targetCols))
	for _, col := range targetCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		targetSet[key] = struct{}{}
	}
	missing := make([]string, 0)
	for _, col := range sourceCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		if _, ok := targetSet[key]; ok {
			continue
		}
		missing = append(missing, col.Name)
	}
	sort.Strings(missing)
	return missing
}

// ColumnStructureDiff is one column-level structural difference between the
// source and the target table.
type ColumnStructureDiff struct {
	Column string `json:"column"`
	// Kind is one of missing_in_target, extra_in_target, type, nullable, renamed.
	//
	// renamed is inferred, not read from metadata: no driver reports a rename,
	// so it is a pair of one source-only and one target-only column that share
	// type and nullability. It is only emitted when that pairing is
	// unambiguous (exactly one candidate on each side); otherwise the two
	// columns stay reported as missing + extra, which is always true.
	Kind string `json:"kind"`
	// Source/Target describe the column payload: the type for type/nullable
	// diffs, and the column name for renamed diffs.
	Source string `json:"source,omitempty"`
	Target string `json:"target,omitempty"`
}

// 列差异 kind 常量。
const (
	ColumnDiffMissingInTarget = "missing_in_target"
	ColumnDiffExtraInTarget   = "extra_in_target"
	ColumnDiffType            = "type"
	ColumnDiffNullable        = "nullable"
	ColumnDiffRenamed         = "renamed"
)

// diffColumnStructures compares two column sets in BOTH directions.
//
// diffMissingColumnNames only reports source columns absent from the target, so
// a target with extra columns, a widened type or a flipped nullability was
// reported as "structurally identical". This covers those cases.
//
// Type and nullability are compared only when both endpoints normalize to the
// same database type: equivalent types spell differently across engines (MySQL
// "int" vs PostgreSQL "integer"), so comparing them cross-engine would flag
// every column and bury the real differences.
func diffColumnStructures(sourceCols, targetCols []connection.ColumnDefinition, sourceType, targetType string) []ColumnStructureDiff {
	sourceByKey := make(map[string]connection.ColumnDefinition, len(sourceCols))
	sourceOrder := make([]string, 0, len(sourceCols))
	for _, col := range sourceCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		if _, seen := sourceByKey[key]; !seen {
			sourceOrder = append(sourceOrder, key)
		}
		sourceByKey[key] = col
	}
	targetByKey := make(map[string]connection.ColumnDefinition, len(targetCols))
	targetOrder := make([]string, 0, len(targetCols))
	for _, col := range targetCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		if _, seen := targetByKey[key]; !seen {
			targetOrder = append(targetOrder, key)
		}
		targetByKey[key] = col
	}

	sameEngine := normalizeMigrationDBType(sourceType) == normalizeMigrationDBType(targetType)
	diffs := make([]ColumnStructureDiff, 0)
	for _, key := range sourceOrder {
		sourceCol := sourceByKey[key]
		targetCol, ok := targetByKey[key]
		if !ok {
			diffs = append(diffs, ColumnStructureDiff{
				Column: sourceCol.Name,
				Kind:   "missing_in_target",
				Source: describeColumnStructure(sourceCol),
			})
			continue
		}
		if !sameEngine {
			continue
		}
		sourceTypeText := normalizeComparableColumnType(sourceType, sourceCol.Type)
		targetTypeText := normalizeComparableColumnType(targetType, targetCol.Type)
		if !strings.EqualFold(sourceTypeText, targetTypeText) {
			// 同族容量缩小单独成一种差异：它不会让建表失败，但存量数据超长
			// 会被截断，风险等级与「类型不同」不同，不能混在一起。
			kind := ColumnDiffType
			if isWithinFamilyCapacityShrink(sourceTypeText, targetTypeText) {
				kind = ColumnDiffCapacityDegraded
			}
			diffs = append(diffs, ColumnStructureDiff{
				Column: sourceCol.Name,
				Kind:   kind,
				Source: sourceTypeText,
				Target: targetTypeText,
			})
		}
		sourceNullable := normalizeColumnNullable(sourceCol.Nullable)
		targetNullable := normalizeColumnNullable(targetCol.Nullable)
		if sourceNullable != "" && targetNullable != "" &&
			!strings.EqualFold(sourceNullable, targetNullable) {
			diffs = append(diffs, ColumnStructureDiff{
				Column: sourceCol.Name,
				Kind:   "nullable",
				Source: sourceNullable,
				Target: targetNullable,
			})
		}
	}
	for _, key := range targetOrder {
		if _, ok := sourceByKey[key]; ok {
			continue
		}
		targetCol := targetByKey[key]
		diffs = append(diffs, ColumnStructureDiff{
			Column: targetCol.Name,
			Kind:   "extra_in_target",
			Target: describeColumnStructure(targetCol),
		})
	}
	return foldColumnRenames(diffs, sourceByKey, targetByKey)
}

// foldColumnRenames 把「一缺一多」收敛成 renamed，但只在配对无歧义时。
//
// 没有任何驱动会报告重命名，所以只能从「源端独有 + 目标端独有」里推断。
// 判据是结构完全相同（类型 + 可空性），且两侧候选各自唯一：一旦源端有两个
// 同结构的新列、目标端也有两个同结构的旧列，谁改成谁就无从判断，此时保留
// missing + extra——那是永远成立的陈述，而猜错的重命名会误导用户去改错列。
func foldColumnRenames(
	diffs []ColumnStructureDiff,
	sourceByKey, targetByKey map[string]connection.ColumnDefinition,
) []ColumnStructureDiff {
	sourceOnly := make([]connection.ColumnDefinition, 0)
	targetOnly := make([]connection.ColumnDefinition, 0)
	for _, diff := range diffs {
		switch diff.Kind {
		case ColumnDiffMissingInTarget:
			if col, ok := sourceByKey[strings.ToLower(strings.TrimSpace(diff.Column))]; ok {
				sourceOnly = append(sourceOnly, col)
			}
		case ColumnDiffExtraInTarget:
			if col, ok := targetByKey[strings.ToLower(strings.TrimSpace(diff.Column))]; ok {
				targetOnly = append(targetOnly, col)
			}
		}
	}
	if len(sourceOnly) == 0 || len(targetOnly) == 0 {
		return diffs
	}

	// 结构签名相同的列才可能是一对改名。
	signature := func(col connection.ColumnDefinition) string {
		return strings.ToLower(strings.TrimSpace(col.Type)) + "|" +
			normalizeColumnNullable(col.Nullable)
	}
	sourceBySignature := make(map[string][]connection.ColumnDefinition, len(sourceOnly))
	targetBySignature := make(map[string][]connection.ColumnDefinition, len(targetOnly))
	for _, col := range sourceOnly {
		key := signature(col)
		sourceBySignature[key] = append(sourceBySignature[key], col)
	}
	for _, col := range targetOnly {
		key := signature(col)
		targetBySignature[key] = append(targetBySignature[key], col)
	}

	renamed := make(map[string]string, len(sourceOnly))
	for key, sources := range sourceBySignature {
		targets := targetBySignature[key]
		// 只有一对一才敢下结论；一对多/多对多退化为原来的增删。
		if len(sources) != 1 || len(targets) != 1 {
			continue
		}
		if strings.EqualFold(sources[0].Name, targets[0].Name) {
			continue
		}
		renamed[strings.ToLower(strings.TrimSpace(sources[0].Name))] = targets[0].Name
	}
	if len(renamed) == 0 {
		return diffs
	}

	folded := make([]ColumnStructureDiff, 0, len(diffs))
	for _, diff := range diffs {
		key := strings.ToLower(strings.TrimSpace(diff.Column))
		if diff.Kind == ColumnDiffMissingInTarget {
			if targetName, ok := renamed[key]; ok {
				folded = append(folded, ColumnStructureDiff{
					Column: diff.Column,
					Kind:   ColumnDiffRenamed,
					Source: diff.Column,
					Target: targetName,
				})
				continue
			}
		}
		if diff.Kind == ColumnDiffExtraInTarget {
			// 已被并进 renamed 的目标列不再单独报「多出」。
			consumed := false
			for _, targetName := range renamed {
				if strings.EqualFold(targetName, diff.Column) {
					consumed = true
					break
				}
			}
			if consumed {
				continue
			}
		}
		folded = append(folded, diff)
	}
	return folded
}

// unsupportedExistingTargetSchemaDiffs leaves only the differences that the
// current planner cannot repair. It intentionally excludes missing_in_target,
// because the supported repair is ADD COLUMN.
func unsupportedExistingTargetSchemaDiffs(diffs []ColumnStructureDiff) []ColumnStructureDiff {
	unsupported := make([]ColumnStructureDiff, 0, len(diffs))
	for _, diff := range diffs {
		switch diff.Kind {
		case "type":
			unsupported = append(unsupported, diff)
		case "nullable":
			// A nullable source cannot be safely imported into a NOT NULL target.
			// The reverse is compatible and commonly results from the supported
			// ADD COLUMN ... NULL migration path.
			if normalizeColumnNullable(diff.Source) == "YES" && normalizeColumnNullable(diff.Target) == "NO" {
				unsupported = append(unsupported, diff)
			}
		case ColumnDiffRenamed:
			// 重命名是推断出来的，不能据此跳过「补列」：如果猜测错了，真正
			// 需要的 ADD COLUMN 就漏了。写任务一律按不可自动修复处理，让用户
			// 自己确认是改名还是新增。
			unsupported = append(unsupported, diff)
		}
	}
	return unsupported
}

// UnsupportedExistingTargetSchemaDiffs reports only existing-target column
// differences that the migration runtime cannot repair automatically.
func UnsupportedExistingTargetSchemaDiffs(sourceCols, targetCols []connection.ColumnDefinition, sourceType, targetType string) []ColumnStructureDiff {
	return unsupportedExistingTargetSchemaDiffs(diffColumnStructures(sourceCols, targetCols, sourceType, targetType))
}

// DescribeColumnStructureDiffs returns the same concise structural summary
// used by analysis and execution diagnostics.
func DescribeColumnStructureDiffs(diffs []ColumnStructureDiff) string {
	return summarizeColumnStructureDiffs(diffs)
}

func describeColumnStructure(col connection.ColumnDefinition) string {
	text := strings.TrimSpace(col.Type)
	if normalizeColumnNullable(col.Nullable) == "NO" {
		text = strings.TrimSpace(text + " NOT NULL")
	}
	return text
}

var (
	columnTypeWhitespacePattern     = regexp.MustCompile(`\s*([(),])\s*`)
	mysqlIntegerDisplayWidthPattern = regexp.MustCompile(`\b(tinyint|smallint|mediumint|int|integer|bigint|year)\s*\(\s*\d+\s*\)`)
	pgLikeNextvalPattern            = regexp.MustCompile(`(?i)^nextval\s*\(\s*'((?:[^']|'')+)'`)
)

// normalizeComparableColumnType removes metadata-only spelling differences
// before a same-engine schema comparison. MySQL 8 no longer reports integer
// display widths that MySQL 5.7 returned, and drivers vary around spaces in
// precision/scale clauses; neither changes the value domain.
//
// The display width must be stripped before the whitespace collapse: collapsing
// first turns "int(11) unsigned" into "int(11)unsigned", so removing the width
// then yields "intunsigned" while MySQL 8 reports "int unsigned".
func normalizeComparableColumnType(dbType, raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.Join(strings.Fields(value), " ")
	if normalizeMigrationDBType(dbType) == "mysql" {
		value = mysqlIntegerDisplayWidthPattern.ReplaceAllString(value, "$1")
	}
	return columnTypeWhitespacePattern.ReplaceAllString(value, "$1")
}

// normalizeColumnNullable unifies the metadata spellings emitted by the
// supported drivers, notably Oracle's Y/N and information_schema's YES/NO.
func normalizeColumnNullable(raw string) string {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "YES", "Y", "TRUE", "1":
		return "YES"
	case "NO", "N", "FALSE", "0", "NOT NULL":
		return "NO"
	default:
		return strings.ToUpper(strings.TrimSpace(raw))
	}
}
