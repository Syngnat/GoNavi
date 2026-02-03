package sync

import (
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"fmt"
	"strings"
)

type TableDiffSummary struct {
	Table     string `json:"table"`
	PKColumn  string `json:"pkColumn,omitempty"`
	CanSync   bool   `json:"canSync"`
	Inserts   int    `json:"inserts"`
	Updates   int    `json:"updates"`
	Deletes   int    `json:"deletes"`
	Same      int    `json:"same"`
	Message   string `json:"message,omitempty"`
	HasSchema bool   `json:"hasSchema,omitempty"`
}

type SyncAnalyzeResult struct {
	Success bool               `json:"success"`
	Message string             `json:"message"`
	Tables  []TableDiffSummary `json:"tables"`
}

func (s *SyncEngine) Analyze(config SyncConfig) SyncAnalyzeResult {
	result := SyncAnalyzeResult{Success: true, Tables: []TableDiffSummary{}}

	contentRaw := strings.ToLower(strings.TrimSpace(config.Content))
	syncSchema := false
	syncData := true
	switch contentRaw {
	case "", "data":
		syncData = true
	case "schema":
		syncSchema = true
		syncData = false
	case "both":
		syncSchema = true
		syncData = true
	default:
		s.appendLog(config.JobID, nil, "warn", fmt.Sprintf("未知同步内容 %q，已自动使用仅同步数据", config.Content))
		syncData = true
	}

	totalTables := len(config.Tables)
	s.progress(config.JobID, 0, totalTables, "", "差异分析开始")

	sourceDB, err := db.NewDatabase(config.SourceConfig.Type)
	if err != nil {
		logger.Error(err, "初始化源数据库驱动失败：类型=%s", config.SourceConfig.Type)
		return SyncAnalyzeResult{Success: false, Message: "初始化源数据库驱动失败: " + err.Error()}
	}
	targetDB, err := db.NewDatabase(config.TargetConfig.Type)
	if err != nil {
		logger.Error(err, "初始化目标数据库驱动失败：类型=%s", config.TargetConfig.Type)
		return SyncAnalyzeResult{Success: false, Message: "初始化目标数据库驱动失败: " + err.Error()}
	}

	// Connect Source
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		logger.Error(err, "源数据库连接失败：%s", formatConnSummaryForSync(config.SourceConfig))
		return SyncAnalyzeResult{Success: false, Message: "源数据库连接失败: " + err.Error()}
	}
	defer sourceDB.Close()

	// Connect Target
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		logger.Error(err, "目标数据库连接失败：%s", formatConnSummaryForSync(config.TargetConfig))
		return SyncAnalyzeResult{Success: false, Message: "目标数据库连接失败: " + err.Error()}
	}
	defer targetDB.Close()

	for i, tableName := range config.Tables {
		func() {
			s.progress(config.JobID, i, totalTables, tableName, fmt.Sprintf("分析表(%d/%d)", i+1, totalTables))

			summary := TableDiffSummary{
				Table:     tableName,
				CanSync:   false,
				Inserts:   0,
				Updates:   0,
				Deletes:   0,
				Same:      0,
				Message:   "",
				HasSchema: syncSchema,
			}

			sourceSchema, sourceTable := normalizeSchemaAndTable(config.SourceConfig.Type, config.SourceConfig.Database, tableName)
			targetSchema, targetTable := normalizeSchemaAndTable(config.TargetConfig.Type, config.TargetConfig.Database, tableName)
			sourceQueryTable := qualifiedNameForQuery(config.SourceConfig.Type, sourceSchema, sourceTable, tableName)
			targetQueryTable := qualifiedNameForQuery(config.TargetConfig.Type, targetSchema, targetTable, tableName)

			cols, err := sourceDB.GetColumns(sourceSchema, sourceTable)
			if err != nil {
				summary.Message = "获取源表字段失败: " + err.Error()
				result.Tables = append(result.Tables, summary)
				return
			}

			if !syncData {
				summary.CanSync = true
				summary.Message = "仅同步结构，未执行数据差异分析"
				result.Tables = append(result.Tables, summary)
				return
			}

			pkCols := make([]string, 0, 2)
			for _, c := range cols {
				if c.Key == "PRI" || c.Key == "PK" {
					pkCols = append(pkCols, c.Name)
				}
			}
			if len(pkCols) == 0 {
				summary.Message = "无主键，不支持数据对比/同步"
				result.Tables = append(result.Tables, summary)
				return
			}
			if len(pkCols) > 1 {
				summary.Message = fmt.Sprintf("复合主键（%s），暂不支持数据对比/同步", strings.Join(pkCols, ","))
				result.Tables = append(result.Tables, summary)
				return
			}
			summary.PKColumn = pkCols[0]

			// Query data for diff
			sourceRows, _, err := sourceDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(config.SourceConfig.Type, sourceQueryTable)))
			if err != nil {
				summary.Message = "读取源表失败: " + err.Error()
				result.Tables = append(result.Tables, summary)
				return
			}
			targetRows, _, err := targetDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(config.TargetConfig.Type, targetQueryTable)))
			if err != nil {
				summary.Message = "读取目标表失败: " + err.Error()
				result.Tables = append(result.Tables, summary)
				return
			}

			pkCol := summary.PKColumn
			targetMap := make(map[string]map[string]interface{}, len(targetRows))
			for _, row := range targetRows {
				if row[pkCol] == nil {
					continue
				}
				pkVal := strings.TrimSpace(fmt.Sprintf("%v", row[pkCol]))
				if pkVal == "" || pkVal == "<nil>" {
					continue
				}
				targetMap[pkVal] = row
			}

			sourcePKSet := make(map[string]struct{}, len(sourceRows))
			for _, sRow := range sourceRows {
				if sRow[pkCol] == nil {
					continue
				}
				pkVal := strings.TrimSpace(fmt.Sprintf("%v", sRow[pkCol]))
				if pkVal == "" || pkVal == "<nil>" {
					continue
				}
				sourcePKSet[pkVal] = struct{}{}

				if tRow, exists := targetMap[pkVal]; exists {
					changed := false
					for k, v := range sRow {
						if fmt.Sprintf("%v", v) != fmt.Sprintf("%v", tRow[k]) {
							changed = true
							break
						}
					}
					if changed {
						summary.Updates++
					} else {
						summary.Same++
					}
				} else {
					summary.Inserts++
				}
			}

			for pkVal := range targetMap {
				if _, ok := sourcePKSet[pkVal]; !ok {
					summary.Deletes++
				}
			}

			summary.CanSync = true
			result.Tables = append(result.Tables, summary)
		}()
	}

	s.progress(config.JobID, totalTables, totalTables, "", "差异分析完成")
	result.Message = fmt.Sprintf("已完成 %d 张表的差异分析", len(result.Tables))
	return result
}
