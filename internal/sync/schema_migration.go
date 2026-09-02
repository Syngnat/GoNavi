package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type SchemaMigrationPlan struct {
	SourceSchema       string
	SourceTable        string
	SourceQueryTable   string
	TargetSchema       string
	TargetTable        string
	TargetQueryTable   string
	TargetTableExists  bool
	AutoCreate         bool
	PlannedAction      string
	Warnings           []string
	UnsupportedObjects []string
	UnmigratedIndexes  []UnmigratedIndex
	IndexesToCreate    int
	IndexesSkipped     int
	CreateTableSQL     string
	PreDataSQL         []string
	PostDataSQL        []string
}

type IndexMigrationColumn struct {
	Name         string `json:"name"`
	PrefixLength int    `json:"prefixLength,omitempty"`
}

type UnmigratedIndex struct {
	Name                  string                 `json:"name"`
	Columns               []IndexMigrationColumn `json:"columns"`
	Unique                bool                   `json:"unique"`
	IndexType             string                 `json:"indexType"`
	ReasonCode            string                 `json:"reasonCode"`
	Reason                string                 `json:"reason"`
	RemediationStatements []string               `json:"remediationStatements,omitempty"`
}

type groupedIndex struct {
	Name      string
	Columns   []IndexMigrationColumn
	Unique    bool
	IndexType string
}

func normalizeTargetTableStrategy(strategy string) string {
	switch strings.ToLower(strings.TrimSpace(strategy)) {
	case "smart":
		return "smart"
	case "auto_create_if_missing":
		return "auto_create_if_missing"
	case "existing_only", "":
		return "existing_only"
	default:
		return "existing_only"
	}
}

func supportsAutoCreateMigration(sourceType, targetType string) bool {
	return normalizeMigrationDBType(sourceType) == "mysql" && normalizeMigrationDBType(targetType) == "kingbase"
}

func inspectTableColumns(database db.Database, schema, table string) ([]connection.ColumnDefinition, bool, error) {
	cols, err := database.GetColumns(schema, table)
	if err != nil {
		if isLikelyTableNotFound(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	if len(cols) == 0 {
		return cols, false, nil
	}
	return cols, true, nil
}

func isLikelyTableNotFound(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	if text == "" {
		return false
	}
	keywords := []string{
		"doesn't exist",
		"does not exist",
		"not exist",
		"unknown table",
		"未找到表",
		"不存在",
		"invalid object",
		"relation",
	}
	for _, keyword := range keywords {
		if strings.Contains(text, keyword) {
			return true
		}
	}
	return false
}

func buildSchemaMigrationPlanLegacy(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedNameForQuery(targetType, plan.TargetSchema, plan.TargetTable, tableName)
	plan.PlannedAction = "使用已有目标表导入"
	if targetType == "tdengine" {
		plan.Warnings = append(plan.Warnings, "TDengine 目标端当前仅支持 INSERT 写入；若存在差异更新/删除，执行期会被拒绝，请优先使用仅插入或全量覆盖模式")
	} else if targetType == "iotdb" {
		plan.Warnings = append(plan.Warnings, "IoTDB 目标端当前仅支持 INSERT 写入；若存在差异更新/删除，执行期会被拒绝，请优先使用仅插入模式")
	}

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{
			"table": tableName,
		})
	}

	targetCols, targetExists, err := inspectTableColumns(targetDB, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_table_columns_failed", err)
	}
	plan.TargetTableExists = targetExists

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		missing := diffMissingColumnNames(sourceCols, targetCols)
		if len(missing) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
		}
		if len(missing) == 0 {
			plan.PlannedAction = "表结构已一致"
		} else if config.AutoAddColumns && supportsAutoAddColumnsForPair(sourceType, targetType) {
			targetSet := make(map[string]struct{}, len(targetCols))
			for _, col := range targetCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				targetSet[key] = struct{}{}
			}
			for _, col := range sourceCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				if _, ok := targetSet[key]; ok {
					continue
				}
				addSQL, err := buildAddColumnSQLForPair(sourceType, targetType, plan.TargetQueryTable, col)
				if err != nil {
					plan.Warnings = append(plan.Warnings, fmt.Sprintf("字段 %s 自动补齐 SQL 生成失败：%v", col.Name, err))
					continue
				}
				plan.PreDataSQL = append(plan.PreDataSQL, addSQL)
				if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
					plan.Warnings = append(plan.Warnings, warning)
				}
			}
			if len(plan.PreDataSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(plan.PreDataSQL))
			} else {
				plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，但未生成可执行补齐 SQL", len(missing))
			}
		} else {
			if config.AutoAddColumns {
				plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，当前库对暂不支持自动补齐", len(missing))
			} else {
				plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，未开启自动补齐", len(missing))
			}
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "目标表已存在，当前仅执行数据导入；不会自动重建已有索引/约束")
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标表不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标表已存在，执行时不会自动建表")
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	case "smart", "auto_create_if_missing":
		if !supportsAutoCreateMigration(config.SourceConfig.Type, config.TargetConfig.Type) {
			plan.PlannedAction = "当前库对暂不支持自动建表"
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("当前组合未接入专用自动建表规划器：%s -> %s", config.SourceConfig.Type, config.TargetConfig.Type))
			return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
		}
		plan.AutoCreate = true
		plan.PlannedAction = "目标表不存在，将自动建表后导入"
		createSQL, postSQL, warnings, unsupported, unmigrated, idxCreate, idxSkip, err := buildMySQLToKingbaseCreateTablePlan(config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.UnmigratedIndexes = append(plan.UnmigratedIndexes, unmigrated...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func dedupeSchemaMigrationPlan(plan SchemaMigrationPlan) SchemaMigrationPlan {
	plan.Warnings = dedupeStrings(plan.Warnings)
	plan.UnsupportedObjects = dedupeStrings(plan.UnsupportedObjects)
	return plan
}

func InspectSchemaMigrationPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, error) {
	plan, _, _, err := buildSchemaMigrationPlan(config, tableName, sourceDB, targetDB)
	return plan, err
}

func dedupeStrings(items []string) []string {
	if len(items) == 0 {
		return items
	}
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		text := strings.TrimSpace(item)
		if text == "" {
			continue
		}
		if _, ok := seen[text]; ok {
			continue
		}
		seen[text] = struct{}{}
		out = append(out, text)
	}
	return out
}

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

func buildMySQLToKingbaseAddColumnSQL(targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
	targetSet := make(map[string]struct{}, len(targetCols))
	for _, col := range targetCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		targetSet[key] = struct{}{}
	}

	var sqlList []string
	var warnings []string
	for _, col := range sourceCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		if _, ok := targetSet[key]; ok {
			continue
		}
		colType, _, mapWarnings := mapMySQLColumnToKingbase(col)
		warnings = append(warnings, mapWarnings...)
		if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
			warnings = append(warnings, warning)
		}
		if col.Extra != "" && strings.Contains(strings.ToLower(col.Extra), "auto_increment") {
			warnings = append(warnings, fmt.Sprintf("字段 %s 为自增列，补齐到已有目标表时不会自动补建 identity/sequence", col.Name))
		}
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType("kingbase", targetQueryTable),
			quoteIdentByType("kingbase", col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildMySQLToKingbaseCreateTablePlan(config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)

	for _, col := range sourceCols {
		def, colWarnings := buildMySQLToKingbaseColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("kingbase", col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType("kingbase", col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("kingbase", targetQueryTable), strings.Join(columnDefs, ",\n  "))

	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}

	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	postSQL, unsupported, unmigrated, created, skipped := buildMySQLSourceIndexPlan("kingbase", targetQueryTable, indexes)
	return createSQL, postSQL, dedupeStrings(warnings), unsupported, unmigrated, created, skipped, nil
}

func buildMySQLToKingbaseColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, useIdentity, warnings := mapMySQLColumnToKingbase(col)
	parts := []string{targetType}
	if useIdentity {
		parts = append(parts, "GENERATED BY DEFAULT AS IDENTITY")
	}
	if !useIdentity {
		if defaultSQL, ok, warningText := mapMySQLDefaultToKingbase(col, targetType); warningText != "" {
			warnings = append(warnings, warningText)
		} else if ok {
			parts = append(parts, "DEFAULT "+defaultSQL)
		}
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func mapMySQLColumnToKingbase(col connection.ColumnDefinition) (string, bool, []string) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	warnings := make([]string, 0)
	if raw == "" {
		return "text", false, []string{fmt.Sprintf("字段 %s 类型为空，已降级为 text", col.Name)}
	}
	unsigned := strings.Contains(raw, "unsigned")
	clean := strings.ReplaceAll(raw, " unsigned", "")
	clean = strings.ReplaceAll(clean, " zerofill", "")
	isAutoIncrement := strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment")

	switch {
	case strings.HasPrefix(clean, "tinyint(1)") && !unsigned && !isAutoIncrement:
		return "boolean", false, warnings
	case strings.HasPrefix(clean, "tinyint"):
		return ternaryString(unsigned, "smallint", "smallint"), false, warnings
	case strings.HasPrefix(clean, "smallint"):
		return ternaryString(unsigned, "integer", "smallint"), isAutoIncrement, warnings
	case strings.HasPrefix(clean, "mediumint"):
		return ternaryString(unsigned, "bigint", "integer"), isAutoIncrement, warnings
	case strings.HasPrefix(clean, "int") || strings.HasPrefix(clean, "integer"):
		return ternaryString(unsigned, "bigint", "integer"), isAutoIncrement, warnings
	case strings.HasPrefix(clean, "bigint"):
		if unsigned {
			if isAutoIncrement {
				warnings = append(warnings, fmt.Sprintf("字段 %s 为 unsigned bigint auto_increment，已降级为 numeric(20,0) 且不保留自增语义", col.Name))
			}
			return "numeric(20,0)", false, warnings
		}
		return "bigint", isAutoIncrement, warnings
	case strings.HasPrefix(clean, "decimal"), strings.HasPrefix(clean, "numeric"):
		return replaceTypeBase(clean, []string{"decimal", "numeric"}, "numeric"), false, warnings
	case strings.HasPrefix(clean, "float"):
		return "real", false, warnings
	case strings.HasPrefix(clean, "double"):
		return "double precision", false, warnings
	case strings.HasPrefix(clean, "bit("):
		if clean == "bit(1)" {
			return "boolean", false, warnings
		}
		return clean, false, warnings
	case strings.HasPrefix(clean, "bool"), strings.HasPrefix(clean, "boolean"):
		return "boolean", false, warnings
	case strings.HasPrefix(clean, "char("), strings.HasPrefix(clean, "varchar("):
		return clean, false, warnings
	case strings.HasPrefix(clean, "tinytext"), strings.HasPrefix(clean, "text"), strings.HasPrefix(clean, "mediumtext"), strings.HasPrefix(clean, "longtext"):
		return "text", false, warnings
	case strings.HasPrefix(clean, "json"):
		return "jsonb", false, warnings
	case strings.HasPrefix(clean, "date"):
		return "date", false, warnings
	case strings.HasPrefix(clean, "time"):
		return "time", false, warnings
	case strings.HasPrefix(clean, "datetime"), strings.HasPrefix(clean, "timestamp"):
		return "timestamp", false, warnings
	case strings.HasPrefix(clean, "year"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 year 已映射为 integer", col.Name))
		return "integer", false, warnings
	case strings.HasPrefix(clean, "binary"), strings.HasPrefix(clean, "varbinary"), strings.HasPrefix(clean, "tinyblob"), strings.HasPrefix(clean, "blob"), strings.HasPrefix(clean, "mediumblob"), strings.HasPrefix(clean, "longblob"):
		return "bytea", false, warnings
	case strings.HasPrefix(clean, "enum"), strings.HasPrefix(clean, "set"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 text", col.Name, col.Type))
		return "text", false, warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门映射，已降级为 text", col.Name, col.Type))
		return "text", false, warnings
	}
}

func replaceTypeBase(raw string, bases []string, target string) string {
	for _, base := range bases {
		if strings.HasPrefix(raw, base) {
			return target + strings.TrimPrefix(raw, base)
		}
	}
	return target
}

var numericPattern = regexp.MustCompile(`^[+-]?\d+(\.\d+)?$`)

func mapMySQLDefaultToKingbase(col connection.ColumnDefinition, targetType string) (string, bool, string) {
	if col.Default == nil {
		return "", false, ""
	}
	raw := strings.TrimSpace(*col.Default)
	if raw == "" {
		if isStringLikeTargetType(targetType) {
			return "''", true, ""
		}
		return "", false, fmt.Sprintf("字段 %s 的空字符串默认值未保留", col.Name)
	}
	lower := strings.ToLower(raw)
	if lower == "null" {
		return "", false, ""
	}
	if strings.HasPrefix(lower, "current_timestamp") {
		return "CURRENT_TIMESTAMP", true, ""
	}
	if targetType == "boolean" {
		switch lower {
		case "1", "true":
			return "TRUE", true, ""
		case "0", "false":
			return "FALSE", true, ""
		}
	}
	if numericPattern.MatchString(raw) && !isStringLikeTargetType(targetType) {
		return raw, true, ""
	}
	if strings.ContainsAny(raw, "()") && !strings.HasPrefix(lower, "current_timestamp") {
		return "", false, fmt.Sprintf("字段 %s 的默认值 %s 包含表达式，当前未自动迁移", col.Name, raw)
	}
	return "'" + strings.ReplaceAll(raw, "'", "''") + "'", true, ""
}

func isStringLikeTargetType(targetType string) bool {
	text := strings.ToLower(strings.TrimSpace(targetType))
	return strings.Contains(text, "char") || strings.Contains(text, "text") || strings.Contains(text, "json") || strings.Contains(text, "bytea")
}

func ternaryString(ok bool, a, b string) string {
	if ok {
		return a
	}
	return b
}

func groupIndexDefinitions(indexes []connection.IndexDefinition) []groupedIndex {
	if len(indexes) == 0 {
		return nil
	}
	groupMap := make(map[string][]connection.IndexDefinition)
	order := make([]string, 0)
	for _, idx := range indexes {
		name := strings.TrimSpace(idx.Name)
		if name == "" {
			continue
		}
		if _, ok := groupMap[name]; !ok {
			order = append(order, name)
		}
		groupMap[name] = append(groupMap[name], idx)
	}
	grouped := make([]groupedIndex, 0, len(groupMap))
	for _, name := range order {
		rows := groupMap[name]
		sort.SliceStable(rows, func(i, j int) bool {
			return rows[i].SeqInIndex < rows[j].SeqInIndex
		})
		gi := groupedIndex{Name: name, Unique: true, IndexType: "BTREE"}
		for _, row := range rows {
			if row.NonUnique != 0 {
				gi.Unique = false
			}
			if strings.TrimSpace(row.IndexType) != "" {
				gi.IndexType = row.IndexType
			}
			col := strings.TrimSpace(row.ColumnName)
			if col != "" {
				gi.Columns = append(gi.Columns, IndexMigrationColumn{
					Name:         col,
					PrefixLength: row.SubPart,
				})
			}
		}
		grouped = append(grouped, gi)
	}
	return grouped
}

func sameColumnNameList(a []IndexMigrationColumn, b []string) bool {
	if len(a) == 0 || len(a) != len(b) {
		return false
	}
	for i := range a {
		if !strings.EqualFold(strings.TrimSpace(a[i].Name), strings.TrimSpace(b[i])) {
			return false
		}
	}
	return true
}

func hasIndexPrefix(columns []IndexMigrationColumn) bool {
	for _, column := range columns {
		if column.PrefixLength > 0 {
			return true
		}
	}
	return false
}

func buildQuotedIndexColumns(targetType string, columns []IndexMigrationColumn, preservePrefix bool) []string {
	quoted := make([]string, 0, len(columns))
	for _, column := range columns {
		name := strings.TrimSpace(column.Name)
		if name == "" {
			continue
		}
		value := quoteIdentByType(targetType, name)
		if preservePrefix && column.PrefixLength > 0 {
			value += fmt.Sprintf("(%d)", column.PrefixLength)
		}
		quoted = append(quoted, value)
	}
	return quoted
}

func buildCreateIndexSQL(targetType, targetQueryTable string, idx groupedIndex, preservePrefix bool) string {
	prefix := "CREATE INDEX"
	if idx.Unique {
		prefix = "CREATE UNIQUE INDEX"
	}
	return fmt.Sprintf("%s %s ON %s (%s)",
		prefix,
		quoteIdentByType(targetType, idx.Name),
		quoteQualifiedIdentByType(targetType, targetQueryTable),
		strings.Join(buildQuotedIndexColumns(targetType, idx.Columns, preservePrefix), ", "),
	)
}

func buildIndexRemediationStatements(targetType, targetQueryTable string, idx groupedIndex) []string {
	kind := strings.ToLower(strings.TrimSpace(idx.IndexType))
	if isMySQLRowStoreType(targetType) {
		if kind == "fulltext" {
			return []string{fmt.Sprintf("CREATE FULLTEXT INDEX %s ON %s (%s)",
				quoteIdentByType(targetType, idx.Name),
				quoteQualifiedIdentByType(targetType, targetQueryTable),
				strings.Join(buildQuotedIndexColumns(targetType, idx.Columns, true), ", "),
			)}
		}
		if hasIndexPrefix(idx.Columns) {
			return []string{buildCreateIndexSQL(targetType, targetQueryTable, idx, true)}
		}
		return nil
	}
	if kind == "fulltext" && isPGLikeSameFamilyDDLType(targetType) {
		parts := make([]string, 0, len(idx.Columns))
		for _, column := range idx.Columns {
			parts = append(parts, fmt.Sprintf("coalesce(CAST(%s AS text), '')", quoteIdentByType(targetType, column.Name)))
		}
		return []string{fmt.Sprintf("CREATE INDEX %s ON %s USING GIN (to_tsvector('simple', %s))",
			quoteIdentByType(targetType, idx.Name),
			quoteQualifiedIdentByType(targetType, targetQueryTable),
			strings.Join(parts, " || ' ' || "),
		)}
	}
	if hasIndexPrefix(idx.Columns) && isPGLikeSameFamilyDDLType(targetType) {
		columns := make([]string, 0, len(idx.Columns))
		for _, column := range idx.Columns {
			value := quoteIdentByType(targetType, column.Name)
			if column.PrefixLength > 0 {
				value = fmt.Sprintf("left(CAST(%s AS text), %d)", value, column.PrefixLength)
			}
			columns = append(columns, value)
		}
		prefix := "CREATE INDEX"
		if idx.Unique {
			prefix = "CREATE UNIQUE INDEX"
		}
		return []string{fmt.Sprintf("%s %s ON %s (%s)",
			prefix,
			quoteIdentByType(targetType, idx.Name),
			quoteQualifiedIdentByType(targetType, targetQueryTable),
			strings.Join(columns, ", "),
		)}
	}
	return nil
}

func buildMySQLSourceIndexPlan(targetType, targetQueryTable string, indexes []connection.IndexDefinition) ([]string, []string, []UnmigratedIndex, int, int) {
	grouped := groupIndexDefinitions(indexes)
	postSQL := make([]string, 0, len(grouped))
	unsupported := make([]string, 0)
	unmigrated := make([]UnmigratedIndex, 0)
	created := 0
	skipped := 0
	for _, idx := range grouped {
		name := strings.TrimSpace(idx.Name)
		if name == "" || strings.EqualFold(name, "primary") {
			continue
		}
		if len(idx.Columns) == 0 {
			reason := fmt.Sprintf("索引 %s 缺少列定义，已跳过", name)
			unsupported = append(unsupported, reason)
			unmigrated = append(unmigrated, UnmigratedIndex{
				Name:       name,
				Columns:    []IndexMigrationColumn{},
				Unique:     idx.Unique,
				IndexType:  idx.IndexType,
				ReasonCode: "missing_columns",
				Reason:     reason,
			})
			skipped++
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(idx.IndexType))
		if (kind == "" || kind == "btree") && !hasIndexPrefix(idx.Columns) {
			postSQL = append(postSQL, buildCreateIndexSQL(targetType, targetQueryTable, idx, false))
			created++
			continue
		}

		reasonCode := "unsupported_index_type"
		reason := fmt.Sprintf("索引 %s 类型=%s，当前暂不支持等价自动迁移", name, idx.IndexType)
		if hasIndexPrefix(idx.Columns) {
			reasonCode = "prefix_index_requires_review"
			reason = fmt.Sprintf("索引 %s 使用前缀长度，当前目标方言暂不支持等价自动迁移", name)
		} else if kind == "fulltext" {
			reasonCode = "fulltext_requires_review"
		}
		unsupported = append(unsupported, reason)
		unmigrated = append(unmigrated, UnmigratedIndex{
			Name:                  name,
			Columns:               append([]IndexMigrationColumn(nil), idx.Columns...),
			Unique:                idx.Unique,
			IndexType:             idx.IndexType,
			ReasonCode:            reasonCode,
			Reason:                reason,
			RemediationStatements: buildIndexRemediationStatements(targetType, targetQueryTable, idx),
		})
		skipped++
	}
	return postSQL, dedupeStrings(unsupported), unmigrated, created, skipped
}

func intFromAny(v interface{}) int {
	switch typed := v.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		i, _ := strconv.Atoi(strings.TrimSpace(typed))
		return i
	default:
		return 0
	}
}

func isPGLikeSource(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb":
		return true
	default:
		return false
	}
}

func isPGLikeSameFamilyDDLType(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return true
	default:
		return false
	}
}

func buildMySQLToMySQLPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedNameForQuery(targetType, plan.TargetSchema, plan.TargetTable, tableName)
	plan.PlannedAction = "使用已有目标表导入"

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{
			"table": tableName,
		})
	}

	targetCols, targetExists, err := inspectTableColumns(targetDB, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_table_columns_failed", err)
	}
	plan.TargetTableExists = targetExists

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		missing := diffMissingColumnNames(sourceCols, targetCols)
		if len(missing) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
		}
		if len(missing) == 0 {
			plan.PlannedAction = "表结构已一致"
		} else if config.AutoAddColumns {
			targetSet := make(map[string]struct{}, len(targetCols))
			for _, col := range targetCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				targetSet[key] = struct{}{}
			}
			for _, col := range sourceCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				if _, ok := targetSet[key]; ok {
					continue
				}
				addSQL, err := buildAddColumnSQLForPair(sourceType, targetType, plan.TargetQueryTable, col)
				if err != nil {
					plan.Warnings = append(plan.Warnings, fmt.Sprintf("字段 %s 自动补齐 SQL 生成失败：%v", col.Name, err))
					continue
				}
				plan.PreDataSQL = append(plan.PreDataSQL, addSQL)
				if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
					plan.Warnings = append(plan.Warnings, warning)
				}
			}
			if len(plan.PreDataSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(plan.PreDataSQL))
			} else {
				plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，但未生成可执行补齐 SQL", len(missing))
			}
		} else {
			plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，未开启自动补齐", len(missing))
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "目标表已存在，当前仅执行数据导入；不会自动重建已有索引/约束")
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标表不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标表已存在，执行时不会自动建表")
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	case "smart", "auto_create_if_missing":
		plan.AutoCreate = true
		plan.PlannedAction = "目标表不存在，将自动建表后导入"
		createSQL, postSQL, warnings, unsupported, unmigrated, idxCreate, idxSkip, err := buildMySQLToMySQLCreateTablePlan(targetType, config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.UnmigratedIndexes = append(plan.UnmigratedIndexes, unmigrated...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildMySQLToMySQLCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)
	for _, col := range sourceCols {
		def, colWarnings := buildMySQLToMySQLColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		if strings.EqualFold(col.Key, "PRI") || strings.EqualFold(col.Key, "PK") {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))
	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	postSQL, unsupported, unmigrated, created, skipped := buildMySQLSourceIndexPlan(targetType, targetQueryTable, indexes)
	return createSQL, postSQL, dedupeStrings(warnings), unsupported, unmigrated, created, skipped, nil
}

func buildMySQLToMySQLColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType := sanitizeMySQLColumnType(col.Type)
	parts := []string{targetType}
	warnings := make([]string, 0)
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	} else {
		parts = append(parts, "NULL")
	}
	isAutoIncrement := strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment")
	if isAutoIncrement {
		if canUseMySQLAutoIncrement(targetType) {
			parts = append(parts, "AUTO_INCREMENT")
		} else {
			warnings = append(warnings, fmt.Sprintf("字段 %s 的类型 %s 不适合保留 AUTO_INCREMENT，已跳过", col.Name, targetType))
		}
	} else if defaultSQL, ok, warningText := mapMySQLDefaultToMySQL(col, targetType); warningText != "" {
		warnings = append(warnings, warningText)
	} else if ok {
		parts = append(parts, "DEFAULT "+defaultSQL)
	}
	extra := strings.ToLower(strings.TrimSpace(col.Extra))
	if strings.Contains(extra, "on update current_timestamp") {
		parts = append(parts, "ON UPDATE CURRENT_TIMESTAMP")
	}
	if comment := strings.TrimSpace(col.Comment); comment != "" {
		parts = append(parts, "COMMENT '"+escapeMySQLStringLiteral(comment)+"'")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func mapMySQLDefaultToMySQL(col connection.ColumnDefinition, targetType string) (string, bool, string) {
	if col.Default == nil {
		return "", false, ""
	}
	raw := strings.TrimSpace(*col.Default)
	if raw == "" {
		if isMySQLStringLikeTargetType(targetType) {
			return "''", true, ""
		}
		return "", false, fmt.Sprintf("字段 %s 的空字符串默认值未保留", col.Name)
	}
	lower := strings.ToLower(raw)
	if lower == "null" {
		return "", false, ""
	}
	if strings.ContainsAny(raw, ";\n\r") {
		return "", false, fmt.Sprintf("字段 %s 的默认值包含不安全字符，当前未自动迁移", col.Name)
	}
	switch {
	case strings.HasPrefix(lower, "current_timestamp"):
		return "CURRENT_TIMESTAMP", true, ""
	case lower == "current_date":
		return "CURRENT_DATE", true, ""
	case lower == "current_time":
		return "CURRENT_TIME", true, ""
	}
	if numericPattern.MatchString(raw) && !isMySQLStringLikeTargetType(targetType) {
		return raw, true, ""
	}
	if strings.ContainsAny(raw, "()") && !strings.HasPrefix(lower, "current_timestamp") {
		return "", false, fmt.Sprintf("字段 %s 的默认值 %s 包含表达式，当前未自动迁移", col.Name, raw)
	}
	return "'" + escapeMySQLStringLiteral(raw) + "'", true, ""
}

func isMySQLStringLikeTargetType(targetType string) bool {
	text := strings.ToLower(strings.TrimSpace(targetType))
	return strings.Contains(text, "char") ||
		strings.Contains(text, "text") ||
		strings.Contains(text, "json") ||
		strings.Contains(text, "blob") ||
		strings.Contains(text, "binary") ||
		strings.Contains(text, "enum") ||
		strings.Contains(text, "set")
}

// escapeMySQLStringLiteral 转义内联进 MySQL/ClickHouse DDL 的字符串字面量
// （列注释、DEFAULT 值）。这两个方言的字面量都以反斜杠转义，必须先翻倍反斜杠再翻倍单引号：
// 否则以反斜杠结尾的注释会让 COMMENT '...\' 吞掉闭合引号并生成语法错误的 DDL，
// 含 \n \t 的注释也会被静默改写。
func escapeMySQLStringLiteral(value string) string {
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	return strings.ReplaceAll(escaped, "'", "''")
}

func buildPGLikeToPGLikePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedNameForQuery(targetType, plan.TargetSchema, plan.TargetTable, tableName)
	plan.PlannedAction = "使用已有目标表导入"

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{
			"table": tableName,
		})
	}

	targetCols, targetExists, err := inspectTableColumns(targetDB, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_table_columns_failed", err)
	}
	plan.TargetTableExists = targetExists

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		missing := diffMissingColumnNames(sourceCols, targetCols)
		if len(missing) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
		}
		if len(missing) == 0 {
			plan.PlannedAction = "表结构已一致"
		} else if config.AutoAddColumns {
			targetSet := make(map[string]struct{}, len(targetCols))
			for _, col := range targetCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				targetSet[key] = struct{}{}
			}
			for _, col := range sourceCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				if _, ok := targetSet[key]; ok {
					continue
				}
				addSQL, err := buildAddColumnSQLForPair(sourceType, targetType, plan.TargetQueryTable, col)
				if err != nil {
					plan.Warnings = append(plan.Warnings, fmt.Sprintf("字段 %s 自动补齐 SQL 生成失败：%v", col.Name, err))
					continue
				}
				plan.PreDataSQL = append(plan.PreDataSQL, addSQL)
				if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
					plan.Warnings = append(plan.Warnings, warning)
				}
			}
			if len(plan.PreDataSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(plan.PreDataSQL))
			} else {
				plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，但未生成可执行补齐 SQL", len(missing))
			}
		} else {
			plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，未开启自动补齐", len(missing))
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "目标表已存在，当前仅执行数据导入；不会自动重建已有索引/约束")
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标表不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标表已存在，执行时不会自动建表")
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	case "smart", "auto_create_if_missing":
		plan.AutoCreate = true
		plan.PlannedAction = "目标表不存在，将自动建表后导入"
		createSQL, postSQL, warnings, unsupported, idxCreate, idxSkip, err := buildPGLikeToPGLikeCreateTablePlan(targetType, config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildPGLikeToPGLikeCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)
	pkColNames := make([]string, 0, 2)
	for _, col := range sourceCols {
		def, colWarnings := buildPGLikeToPGLikeColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		if strings.EqualFold(col.Key, "PRI") || strings.EqualFold(col.Key, "PK") {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
			pkColNames = append(pkColNames, col.Name)
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))
	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	grouped := groupIndexDefinitions(indexes)
	postSQL := make([]string, 0, len(grouped))
	created := 0
	skipped := 0
	for _, idx := range grouped {
		name := strings.TrimSpace(idx.Name)
		if name == "" || strings.EqualFold(name, "primary") {
			continue
		}
		if idx.Unique && sameColumnNameList(idx.Columns, pkColNames) {
			continue
		}
		if len(idx.Columns) == 0 {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 缺少列定义，已跳过", name))
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(idx.IndexType))
		if hasIndexPrefix(idx.Columns) {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 使用前缀长度，当前暂不支持迁移", name))
			continue
		}
		if kind != "" && kind != "btree" {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 类型=%s，当前暂不支持自动迁移", name, idx.IndexType))
			continue
		}
		quotedCols := make([]string, 0, len(idx.Columns))
		for _, col := range idx.Columns {
			quotedCols = append(quotedCols, quoteIdentByType(targetType, col.Name))
		}
		prefix := "CREATE INDEX"
		if idx.Unique {
			prefix = "CREATE UNIQUE INDEX"
		}
		postSQL = append(postSQL, fmt.Sprintf("%s %s ON %s (%s)", prefix, quoteIdentByType(targetType, name), quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(quotedCols, ", ")))
		created++
	}
	return createSQL, postSQL, dedupeStrings(warnings), dedupeStrings(unsupported), created, skipped, nil
}

func buildPGLikeToPGLikeColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType := sanitizePGLikeColumnType(col.Type)
	parts := []string{targetType}
	warnings := make([]string, 0)
	if strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") {
		if canUsePGLikeIdentity(targetType) {
			parts = append(parts, "GENERATED BY DEFAULT AS IDENTITY")
		} else {
			warnings = append(warnings, fmt.Sprintf("字段 %s 的类型 %s 不适合保留 identity/sequence 语义，已跳过", col.Name, targetType))
		}
	} else if defaultSQL, ok, warningText := mapPGLikeDefaultToPGLike(col, targetType); warningText != "" {
		warnings = append(warnings, warningText)
	} else if ok {
		parts = append(parts, "DEFAULT "+defaultSQL)
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	if comment := strings.TrimSpace(col.Comment); comment != "" {
		warnings = append(warnings, fmt.Sprintf("字段 %s 注释未内联到 CREATE TABLE，请按需使用 COMMENT ON COLUMN 补充", col.Name))
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func sanitizePGLikeColumnType(t string) string {
	tt := strings.TrimSpace(t)
	if tt == "" {
		return "text"
	}
	if strings.ContainsAny(tt, "\";\n\r") {
		return "text"
	}
	return tt
}

func canUsePGLikeIdentity(targetType string) bool {
	text := strings.ToLower(strings.TrimSpace(targetType))
	switch {
	case strings.HasPrefix(text, "smallint"), strings.HasPrefix(text, "integer"), strings.HasPrefix(text, "int"), strings.HasPrefix(text, "bigint"):
		return true
	default:
		return false
	}
}

func mapPGLikeDefaultToPGLike(col connection.ColumnDefinition, targetType string) (string, bool, string) {
	if col.Default == nil {
		return "", false, ""
	}
	raw := strings.TrimSpace(*col.Default)
	if raw == "" || strings.EqualFold(raw, "null") {
		return "", false, ""
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "nextval(") {
		return "", false, ""
	}
	if strings.ContainsAny(raw, ";\n\r") {
		return "", false, fmt.Sprintf("字段 %s 的默认值包含不安全字符，当前未自动迁移", col.Name)
	}
	if strings.Contains(lower, "current_timestamp") || strings.Contains(lower, "now()") {
		return "CURRENT_TIMESTAMP", true, ""
	}
	if lower == "current_date" {
		return "CURRENT_DATE", true, ""
	}
	if lower == "current_time" {
		return "CURRENT_TIME", true, ""
	}
	if targetType == "boolean" {
		switch lower {
		case "true", "1":
			return "TRUE", true, ""
		case "false", "0":
			return "FALSE", true, ""
		}
	}
	if numericPattern.MatchString(raw) && !isStringLikeTargetType(targetType) {
		return raw, true, ""
	}
	return raw, true, ""
}

func buildPGLikeToMySQLPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedNameForQuery(targetType, plan.TargetSchema, plan.TargetTable, tableName)
	plan.PlannedAction = "使用已有目标表导入"

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{
			"table": tableName,
		})
	}

	targetCols, targetExists, err := inspectTableColumns(targetDB, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_table_columns_failed", err)
	}
	plan.TargetTableExists = targetExists

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		missing := diffMissingColumnNames(sourceCols, targetCols)
		if len(missing) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
		}
		if config.AutoAddColumns {
			addSQL, addWarnings := buildPGLikeToMySQLAddColumnSQL(plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "目标表已存在，当前仅执行数据导入；不会自动重建已有索引/约束")
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标表不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标表已存在，执行时不会自动建表")
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	case "smart", "auto_create_if_missing":
		plan.AutoCreate = true
		plan.PlannedAction = "目标表不存在，将自动建表后导入"
		createSQL, postSQL, warnings, unsupported, idxCreate, idxSkip, err := buildPGLikeToMySQLCreateTablePlan(config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildPGLikeToMySQLAddColumnSQL(targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
	targetSet := make(map[string]struct{}, len(targetCols))
	for _, col := range targetCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		targetSet[key] = struct{}{}
	}
	var sqlList []string
	var warnings []string
	for _, col := range sourceCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		if _, ok := targetSet[key]; ok {
			continue
		}
		colType, mapWarnings := mapPGLikeColumnToMySQL(col)
		warnings = append(warnings, mapWarnings...)
		if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
			warnings = append(warnings, warning)
		}
		if col.Extra != "" && strings.Contains(strings.ToLower(col.Extra), "auto_increment") {
			warnings = append(warnings, fmt.Sprintf("字段 %s 为自增列，补齐到已有目标表时不会自动补建 AUTO_INCREMENT 属性", col.Name))
		}
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType("mysql", targetQueryTable),
			quoteIdentByType("mysql", col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildPGLikeToMySQLCreateTablePlan(config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)
	for _, col := range sourceCols {
		def, colWarnings := buildPGLikeToMySQLColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("mysql", col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType("mysql", col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("mysql", targetQueryTable), strings.Join(columnDefs, ",\n  "))
	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	grouped := groupIndexDefinitions(indexes)
	postSQL := make([]string, 0, len(grouped))
	created := 0
	skipped := 0
	for _, idx := range grouped {
		name := strings.TrimSpace(idx.Name)
		if name == "" || strings.EqualFold(name, "primary") {
			continue
		}
		if len(idx.Columns) == 0 {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 缺少列定义，已跳过", name))
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(idx.IndexType))
		if hasIndexPrefix(idx.Columns) {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 使用前缀长度，当前暂不支持迁移", name))
			continue
		}
		if kind != "" && kind != "btree" {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 类型=%s，当前暂不支持自动迁移", name, idx.IndexType))
			continue
		}
		quotedCols := make([]string, 0, len(idx.Columns))
		for _, col := range idx.Columns {
			quotedCols = append(quotedCols, quoteIdentByType("mysql", col.Name))
		}
		prefix := "CREATE INDEX"
		if idx.Unique {
			prefix = "CREATE UNIQUE INDEX"
		}
		postSQL = append(postSQL, fmt.Sprintf("%s %s ON %s (%s)", prefix, quoteIdentByType("mysql", name), quoteQualifiedIdentByType("mysql", targetQueryTable), strings.Join(quotedCols, ", ")))
		created++
	}
	return createSQL, postSQL, dedupeStrings(warnings), dedupeStrings(unsupported), created, skipped, nil
}

func buildPGLikeToMySQLColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, warnings := mapPGLikeColumnToMySQL(col)
	parts := []string{targetType}
	if strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") && canUseMySQLAutoIncrement(targetType) {
		parts = append(parts, "AUTO_INCREMENT")
	}
	if defaultSQL, ok, warningText := mapPGLikeDefaultToMySQL(col, targetType); warningText != "" {
		warnings = append(warnings, warningText)
	} else if ok {
		parts = append(parts, "DEFAULT "+defaultSQL)
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func mapPGLikeColumnToMySQL(col connection.ColumnDefinition) (string, []string) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	warnings := make([]string, 0)
	if raw == "" {
		return "text", []string{fmt.Sprintf("字段 %s 类型为空，已降级为 text", col.Name)}
	}
	switch {
	case raw == "boolean" || strings.HasPrefix(raw, "bool"):
		return "tinyint(1)", warnings
	case raw == "smallint":
		return "smallint", warnings
	case raw == "integer" || raw == "int4":
		return "int", warnings
	case raw == "bigint" || raw == "int8":
		return "bigint", warnings
	case strings.HasPrefix(raw, "numeric") || strings.HasPrefix(raw, "decimal"):
		return replaceTypeBase(raw, []string{"numeric", "decimal"}, "decimal"), warnings
	case raw == "real" || raw == "float4":
		return "float", warnings
	case raw == "double precision" || raw == "float8":
		return "double", warnings
	case strings.HasPrefix(raw, "character varying"):
		return strings.Replace(raw, "character varying", "varchar", 1), warnings
	case strings.HasPrefix(raw, "character("):
		return strings.Replace(raw, "character", "char", 1), warnings
	case raw == "character":
		return "char(1)", warnings
	case raw == "text":
		return "text", warnings
	case raw == "json" || raw == "jsonb":
		return "json", warnings
	case raw == "bytea":
		return "longblob", warnings
	case raw == "date":
		return "date", warnings
	case strings.HasPrefix(raw, "time"):
		return "time", warnings
	case strings.HasPrefix(raw, "timestamp"):
		return "datetime", warnings
	case strings.HasPrefix(raw, "uuid"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 uuid 已映射为 varchar(36)", col.Name))
		return "varchar(36)", warnings
	case strings.Contains(raw, "without time zone") || strings.Contains(raw, "with time zone"):
		return "datetime", warnings
	case strings.HasPrefix(raw, "json"):
		return "json", warnings
	case strings.HasSuffix(raw, "[]") || strings.HasPrefix(raw, "array"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 json", col.Name, col.Type))
		return "json", warnings
	case raw == "user-defined":
		warnings = append(warnings, fmt.Sprintf("字段 %s 为用户自定义类型，已降级为 text", col.Name))
		return "text", warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门映射，已降级为 text", col.Name, col.Type))
		return "text", warnings
	}
}

func canUseMySQLAutoIncrement(targetType string) bool {
	text := strings.ToLower(strings.TrimSpace(targetType))
	switch {
	case strings.HasPrefix(text, "tinyint"), strings.HasPrefix(text, "smallint"), strings.HasPrefix(text, "mediumint"), strings.HasPrefix(text, "int"), strings.HasPrefix(text, "bigint"):
		return true
	default:
		return false
	}
}

func mapPGLikeDefaultToMySQL(col connection.ColumnDefinition, targetType string) (string, bool, string) {
	if col.Default == nil {
		return "", false, ""
	}
	raw := strings.TrimSpace(*col.Default)
	if raw == "" || strings.EqualFold(raw, "null") {
		return "", false, ""
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "nextval(") {
		return "", false, ""
	}
	if strings.Contains(lower, "current_timestamp") || strings.Contains(lower, "now()") {
		return "CURRENT_TIMESTAMP", true, ""
	}
	if targetType == "tinyint(1)" {
		switch lower {
		case "true", "1":
			return "1", true, ""
		case "false", "0":
			return "0", true, ""
		}
	}
	if numericPattern.MatchString(raw) && !isStringLikeTargetType(targetType) {
		return raw, true, ""
	}
	if strings.ContainsAny(raw, "()") && !strings.Contains(lower, "current_timestamp") && !strings.Contains(lower, "now()") {
		return "", false, fmt.Sprintf("字段 %s 的默认值 %s 包含表达式，当前未自动迁移", col.Name, raw)
	}
	return "'" + strings.ReplaceAll(raw, "'", "''") + "'", true, ""
}

func isPGLikeTarget(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb":
		return true
	default:
		return false
	}
}

func buildMySQLToPGLikePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedNameForQuery(targetType, plan.TargetSchema, plan.TargetTable, tableName)
	plan.PlannedAction = "使用已有目标表导入"

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{
			"table": tableName,
		})
	}

	targetCols, targetExists, err := inspectTableColumns(targetDB, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_table_columns_failed", err)
	}
	plan.TargetTableExists = targetExists

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		missing := diffMissingColumnNames(sourceCols, targetCols)
		if len(missing) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
		}
		if config.AutoAddColumns {
			addSQL, addWarnings := buildMySQLToPGLikeAddColumnSQL(targetType, plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "目标表已存在，当前仅执行数据导入；不会自动重建已有索引/约束")
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标表不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标表已存在，执行时不会自动建表")
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	case "smart", "auto_create_if_missing":
		plan.AutoCreate = true
		plan.PlannedAction = "目标表不存在，将自动建表后导入"
		createSQL, postSQL, warnings, unsupported, unmigrated, idxCreate, idxSkip, err := buildMySQLToPGLikeCreateTablePlan(targetType, config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.UnmigratedIndexes = append(plan.UnmigratedIndexes, unmigrated...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildMySQLToPGLikeAddColumnSQL(targetType string, targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
	targetSet := make(map[string]struct{}, len(targetCols))
	for _, col := range targetCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		targetSet[key] = struct{}{}
	}
	var sqlList []string
	var warnings []string
	for _, col := range sourceCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		if _, ok := targetSet[key]; ok {
			continue
		}
		colType, _, mapWarnings := mapMySQLColumnToKingbase(col)
		warnings = append(warnings, mapWarnings...)
		if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
			warnings = append(warnings, warning)
		}
		if col.Extra != "" && strings.Contains(strings.ToLower(col.Extra), "auto_increment") {
			warnings = append(warnings, fmt.Sprintf("字段 %s 为自增列，补齐到已有目标表时不会自动补建 identity/sequence", col.Name))
		}
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(targetType, targetQueryTable),
			quoteIdentByType(targetType, col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildMySQLToPGLikeCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)
	for _, col := range sourceCols {
		def, colWarnings := buildMySQLToPGLikeColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))
	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	postSQL, unsupported, unmigrated, created, skipped := buildMySQLSourceIndexPlan(targetType, targetQueryTable, indexes)
	return createSQL, postSQL, dedupeStrings(warnings), unsupported, unmigrated, created, skipped, nil
}

func buildMySQLToPGLikeColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, useIdentity, warnings := mapMySQLColumnToKingbase(col)
	parts := []string{targetType}
	if useIdentity {
		parts = append(parts, "GENERATED BY DEFAULT AS IDENTITY")
	}
	if !useIdentity {
		if defaultSQL, ok, warningText := mapMySQLDefaultToKingbase(col, targetType); warningText != "" {
			warnings = append(warnings, warningText)
		} else if ok {
			parts = append(parts, "DEFAULT "+defaultSQL)
		}
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}
