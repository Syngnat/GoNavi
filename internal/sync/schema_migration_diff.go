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
	// Kind is one of missing_in_target, extra_in_target, type, nullable.
	Kind   string `json:"kind"`
	Source string `json:"source,omitempty"`
	Target string `json:"target,omitempty"`
}

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
			diffs = append(diffs, ColumnStructureDiff{
				Column: sourceCol.Name,
				Kind:   "type",
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
	return diffs
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
	mysqlIntegerDisplayWidthPattern = regexp.MustCompile(`\b(tinyint|smallint|mediumint|int|integer|bigint)\s*\(\s*\d+\s*\)`)
	pgLikeNextvalPattern            = regexp.MustCompile(`(?i)^nextval\s*\(\s*'((?:[^']|'')+)'`)
)

// normalizeComparableColumnType removes metadata-only spelling differences
// before a same-engine schema comparison. MySQL 8 no longer reports integer
// display widths that MySQL 5.7 returned, and drivers vary around spaces in
// precision/scale clauses; neither changes the value domain.
func normalizeComparableColumnType(dbType, raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.Join(strings.Fields(value), " ")
	value = columnTypeWhitespacePattern.ReplaceAllString(value, "$1")
	if normalizeMigrationDBType(dbType) == "mysql" {
		value = mysqlIntegerDisplayWidthPattern.ReplaceAllString(value, "$1")
	}
	return value
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
