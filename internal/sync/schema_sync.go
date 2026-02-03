package sync

import (
	"GoNavi-Wails/internal/db"
	"fmt"
	"strings"
)

func (s *SyncEngine) syncTableSchema(config SyncConfig, res *SyncResult, sourceDB db.Database, targetDB db.Database, tableName string) error {
	targetType := strings.ToLower(strings.TrimSpace(config.TargetConfig.Type))
	if targetType != "mysql" {
		s.appendLog(config.JobID, res, "warn", fmt.Sprintf("目标数据库类型=%s 暂不支持结构同步，已跳过表 %s", config.TargetConfig.Type, tableName))
		return nil
	}

	sourceSchema, sourceTable := normalizeSchemaAndTable(config.SourceConfig.Type, config.SourceConfig.Database, tableName)
	targetSchema, targetTable := normalizeSchemaAndTable(config.TargetConfig.Type, config.TargetConfig.Database, tableName)
	targetQueryTable := qualifiedNameForQuery(config.TargetConfig.Type, targetSchema, targetTable, tableName)

	// 1) 获取源表字段
	sourceCols, err := sourceDB.GetColumns(sourceSchema, sourceTable)
	if err != nil {
		return fmt.Errorf("获取源表字段失败: %w", err)
	}

	// 2) 确保目标表存在
	targetCols, err := targetDB.GetColumns(targetSchema, targetTable)
	if err != nil {
		sourceType := strings.ToLower(strings.TrimSpace(config.SourceConfig.Type))
		if sourceType != "mysql" {
			return fmt.Errorf("目标表不存在且源类型=%s 暂不支持自动建表: %w", config.SourceConfig.Type, err)
		}

		s.appendLog(config.JobID, res, "warn", fmt.Sprintf("目标表 %s 不存在，开始尝试创建表结构", tableName))
		createSQL, errCreate := sourceDB.GetCreateStatement(sourceSchema, sourceTable)
		if errCreate != nil || strings.TrimSpace(createSQL) == "" {
			if errCreate == nil {
				errCreate = fmt.Errorf("建表语句为空")
			}
			return fmt.Errorf("获取源表建表语句失败: %w", errCreate)
		}

		if _, errExec := targetDB.Exec(createSQL); errExec != nil {
			return fmt.Errorf("创建目标表失败: %w", errExec)
		}
		s.appendLog(config.JobID, res, "info", fmt.Sprintf("目标表创建成功：%s", tableName))

		targetCols, err = targetDB.GetColumns(targetSchema, targetTable)
		if err != nil {
			return fmt.Errorf("创建目标表后获取字段失败: %w", err)
		}
	}

	targetColSet := make(map[string]struct{}, len(targetCols))
	for _, c := range targetCols {
		name := strings.ToLower(strings.TrimSpace(c.Name))
		if name == "" {
			continue
		}
		targetColSet[name] = struct{}{}
	}

	// 3) 补齐目标缺失字段（安全策略：新增字段统一允许 NULL）
	missing := make([]string, 0)
	sourceType := strings.ToLower(strings.TrimSpace(config.SourceConfig.Type))
	for _, c := range sourceCols {
		colName := strings.TrimSpace(c.Name)
		if colName == "" {
			continue
		}
		lower := strings.ToLower(colName)
		if _, ok := targetColSet[lower]; ok {
			continue
		}
		missing = append(missing, colName)

		colType := "TEXT"
		if sourceType == "mysql" {
			colType = sanitizeMySQLColumnType(c.Type)
		}

		alterSQL := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType("mysql", targetQueryTable),
			quoteIdentByType("mysql", colName),
			colType,
		)
		if _, err := targetDB.Exec(alterSQL); err != nil {
			s.appendLog(config.JobID, res, "error", fmt.Sprintf("  -> 补字段失败：表=%s 字段=%s 错误=%v", tableName, colName, err))
			continue
		}
		s.appendLog(config.JobID, res, "info", fmt.Sprintf("  -> 已补齐字段：表=%s 字段=%s 类型=%s", tableName, colName, colType))
	}

	if len(missing) == 0 {
		s.appendLog(config.JobID, res, "info", fmt.Sprintf("表结构一致：%s", tableName))
	} else {
		s.appendLog(config.JobID, res, "info", fmt.Sprintf("表结构同步完成：%s（新增字段 %d 个）", tableName, len(missing)))
	}

	return nil
}
