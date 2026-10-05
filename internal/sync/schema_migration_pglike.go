package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func buildPGLikeToPGLikePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedTargetNameForQuery(targetType, plan.TargetSchema, plan.TargetTable)
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
				addSQL, addWarnings, err := buildAddColumnSQLForPair(sourceType, targetType, plan.TargetQueryTable, col)
				if err != nil {
					plan.Warnings = append(plan.Warnings, fmt.Sprintf("字段 %s 自动补齐 SQL 生成失败：%v", col.Name, err))
					continue
				}
				plan.Warnings = append(plan.Warnings, addWarnings...)
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
	byteLengthWidener := newByteLengthWidener(resolveMigrationDBType(config.SourceConfig), targetType)
	for _, col := range sourceCols {
		col = byteLengthWidener.Adapt(col)
		def, colWarnings := buildPGLikeToPGLikeColumnDefinition(col, isCockroachFamilyEndpoint(config.TargetConfig))
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		if strings.EqualFold(col.Key, "PRI") || strings.EqualFold(col.Key, "PK") {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
			pkColNames = append(pkColNames, col.Name)
		}
	}
	warnings = append(warnings, byteLengthWidener.Warnings()...)
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))
	postSQL := make([]string, 0)
	created := 0
	skipped := 0
	seqSQL, seqWarnings, seqUnsupported := buildPGLikeOwnedSequenceSQL(targetType, targetQueryTable, sourceCols)
	postSQL = append(postSQL, seqSQL...)
	warnings = append(warnings, seqWarnings...)
	unsupported = append(unsupported, seqUnsupported...)
	postSQL = append(postSQL, buildPGLikeColumnCommentSQL(targetType, targetQueryTable, sourceCols)...)
	if commenter, ok := sourceDB.(db.TableCommentProvider); ok {
		if tableComment, commentErr := commenter.GetTableComment(sourceSchema, sourceTable); commentErr != nil {
			warnings = append(warnings, fmt.Sprintf("读取源表注释失败，已跳过表注释：%v", commentErr))
		} else if strings.TrimSpace(tableComment) != "" {
			postSQL = append(postSQL, fmt.Sprintf("COMMENT ON TABLE %s IS %s", quoteQualifiedIdentByType(targetType, targetQueryTable), pgLikeSQLLiteral(tableComment)))
		}
	}
	triggerSQL, triggerUnsupported := buildPGLikeTriggerSQL(targetType, targetQueryTable, sourceDB, sourceSchema, sourceTable)
	postSQL = append(postSQL, triggerSQL...)
	unsupported = append(unsupported, triggerUnsupported...)
	if fks, fkErr := sourceDB.GetForeignKeys(sourceSchema, sourceTable); fkErr != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表外键失败，已跳过外键：%v", fkErr))
	} else if len(fks) > 0 {
		unsupported = append(unsupported, fmt.Sprintf("外键 %d 个不会随单表自动创建，避免引用尚未同步的表", len(fks)))
	}
	if !config.CreateIndexes {
		return createSQL, postSQL, dedupeStrings(warnings), dedupeStrings(unsupported), created, skipped, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, postSQL, dedupeStrings(warnings), dedupeStrings(unsupported), created, skipped, nil
	}
	grouped := groupIndexDefinitions(indexes)
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

func buildPGLikeToPGLikeColumnDefinition(col connection.ColumnDefinition, cockroachTarget bool) (string, []string) {
	if !cockroachTarget {
		col.Type = adaptCockroachColumnType(col.Type)
	}
	targetType := sanitizePGLikeColumnType(col.Type)
	parts := []string{targetType}
	warnings := make([]string, 0)
	if strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") {
		if canUsePGLikeIdentity(targetType) {
			parts = append(parts, "GENERATED BY DEFAULT AS IDENTITY")
		} else {
			warnings = append(warnings, fmt.Sprintf("字段 %s 的类型 %s 不适合保留 identity/sequence 语义，已跳过", col.Name, targetType))
		}
	} else if adapted, adaptWarning := adaptCockroachDefault(col, cockroachTarget); adaptWarning != "" {
		warnings = append(warnings, adaptWarning)
	} else if defaultSQL, ok, warningText := mapPGLikeDefaultToPGLike(adapted, targetType); warningText != "" {
		warnings = append(warnings, warningText)
	} else if ok {
		parts = append(parts, "DEFAULT "+defaultSQL)
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func pgLikeSQLLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func parsePGLikeNextvalSequence(raw string) string {
	match := pgLikeNextvalPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if len(match) < 2 {
		return ""
	}
	return strings.ReplaceAll(match[1], "''", "'")
}

func splitPGLikeSequenceName(raw string) (schema, name string) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", ""
	}
	if dot := strings.LastIndex(value, "."); dot > 0 && dot < len(value)-1 {
		return strings.Trim(value[:dot], `"`), strings.Trim(value[dot+1:], `"`)
	}
	return "", strings.Trim(value, `"`)
}

func buildPGLikeOwnedSequenceSQL(targetType, targetQueryTable string, sourceCols []connection.ColumnDefinition) ([]string, []string, []string) {
	targetSchema, _ := splitQualifiedSyncObject(targetQueryTable)
	postSQL := make([]string, 0)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	quotedTable := quoteQualifiedIdentByType(targetType, targetQueryTable)
	for _, col := range sourceCols {
		if strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") {
			continue
		}
		if col.Default == nil {
			continue
		}
		sequenceRef := parsePGLikeNextvalSequence(*col.Default)
		if sequenceRef == "" {
			continue
		}
		_, sequenceName := splitPGLikeSequenceName(sequenceRef)
		if sequenceName == "" {
			unsupported = append(unsupported, fmt.Sprintf("字段 %s 的序列默认值无法解析，已跳过", col.Name))
			continue
		}
		if targetSchema != "" {
			sequenceRef = targetSchema + "." + sequenceName
		} else {
			sequenceRef = sequenceName
		}
		quotedSequence := quoteQualifiedIdentByType(targetType, sequenceRef)
		quotedColumn := quoteIdentByType(targetType, col.Name)
		sequenceRegclass := pgLikeSQLLiteral(quotedSequence) + "::regclass"
		postSQL = append(postSQL,
			fmt.Sprintf("CREATE SEQUENCE IF NOT EXISTS %s", quotedSequence),
			fmt.Sprintf("ALTER SEQUENCE %s OWNED BY %s.%s", quotedSequence, quotedTable, quotedColumn),
			fmt.Sprintf("ALTER TABLE %s ALTER COLUMN %s SET DEFAULT pg_catalog.nextval(%s)", quotedTable, quotedColumn, sequenceRegclass),
			fmt.Sprintf(
				"SELECT pg_catalog.setval(%s, COALESCE((SELECT pg_catalog.max(%s) FROM %s), 1), EXISTS (SELECT 1 FROM %s))",
				sequenceRegclass,
				quotedColumn,
				quotedTable,
				quotedTable,
			),
		)
	}
	return postSQL, warnings, unsupported
}

func buildPGLikeColumnCommentSQL(targetType, targetQueryTable string, sourceCols []connection.ColumnDefinition) []string {
	quotedTable := quoteQualifiedIdentByType(targetType, targetQueryTable)
	sql := make([]string, 0)
	for _, col := range sourceCols {
		comment := strings.TrimSpace(col.Comment)
		if comment == "" {
			continue
		}
		sql = append(sql, fmt.Sprintf(
			"COMMENT ON COLUMN %s.%s IS %s",
			quotedTable,
			quoteIdentByType(targetType, col.Name),
			pgLikeSQLLiteral(comment),
		))
	}
	return sql
}

func buildPGLikeTriggerSQL(targetType, targetQueryTable string, sourceDB db.Database, sourceSchema, sourceTable string) ([]string, []string) {
	triggers, err := sourceDB.GetTriggers(sourceSchema, sourceTable)
	if err != nil {
		return nil, []string{fmt.Sprintf("读取源表触发器失败，已跳过触发器：%v", err)}
	}
	sql := make([]string, 0, len(triggers))
	unsupported := make([]string, 0)
	quotedTable := quoteQualifiedIdentByType(targetType, targetQueryTable)
	for _, trigger := range triggers {
		name := strings.TrimSpace(trigger.Name)
		timing := strings.ToUpper(strings.TrimSpace(trigger.Timing))
		event := strings.ToUpper(strings.TrimSpace(trigger.Event))
		statement := strings.TrimSpace(trigger.Statement)
		if name == "" || statement == "" {
			unsupported = append(unsupported, fmt.Sprintf("触发器缺少名称或语句，已跳过"))
			continue
		}
		if timing != "BEFORE" && timing != "AFTER" && timing != "INSTEAD OF" {
			unsupported = append(unsupported, fmt.Sprintf("触发器 %s 的时机 %s 暂不支持自动迁移", name, trigger.Timing))
			continue
		}
		if event != "INSERT" && event != "UPDATE" && event != "DELETE" && event != "TRUNCATE" {
			unsupported = append(unsupported, fmt.Sprintf("触发器 %s 的事件 %s 暂不支持自动迁移", name, trigger.Event))
			continue
		}
		if strings.ContainsAny(statement, ";") {
			unsupported = append(unsupported, fmt.Sprintf("触发器 %s 语句包含多条命令，已跳过以免误执行", name))
			continue
		}
		if isExtensionInternalTrigger(statement) {
			// TimescaleDB 超表自带的 ts_insert_blocker 等触发器属于扩展内部实现，目标库没有对应函数。
			continue
		}
		orientation := strings.ToUpper(strings.TrimSpace(trigger.Orientation))
		forEach := "FOR EACH ROW"
		if orientation == "STATEMENT" {
			forEach = "FOR EACH STATEMENT"
		}
		sql = append(sql, fmt.Sprintf(
			"CREATE TRIGGER %s %s %s ON %s %s %s",
			quoteIdentByType(targetType, name),
			timing,
			event,
			quotedTable,
			forEach,
			statement,
		))
	}
	return sql, unsupported
}

func splitQualifiedSyncObject(name string) (schema, object string) {
	value := strings.TrimSpace(name)
	if value == "" {
		return "", ""
	}
	if dot := strings.LastIndex(value, "."); dot > 0 && dot < len(value)-1 {
		return value[:dot], value[dot+1:]
	}
	return "", value
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
