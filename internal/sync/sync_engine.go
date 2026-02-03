package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"fmt"
	"sort"
	"strings"
	"time"
)

// SyncConfig defines the parameters for a synchronization task
type SyncConfig struct {
	SourceConfig   connection.ConnectionConfig `json:"sourceConfig"`
	TargetConfig   connection.ConnectionConfig `json:"targetConfig"`
	Tables         []string                    `json:"tables"`            // Tables to sync
	Content        string                      `json:"content,omitempty"` // "data", "schema", "both"
	Mode           string                      `json:"mode"`              // "insert_update", "insert_only", "full_overwrite"
	JobID          string                      `json:"jobId,omitempty"`
	AutoAddColumns bool                        `json:"autoAddColumns,omitempty"` // 自动补齐缺失字段（当前仅 MySQL 目标支持）
	TableOptions   map[string]TableOptions     `json:"tableOptions,omitempty"`
}

// SyncResult holds the result of the sync operation
type SyncResult struct {
	Success      bool     `json:"success"`
	Message      string   `json:"message"`
	Logs         []string `json:"logs"`
	TablesSynced int      `json:"tablesSynced"`
	RowsInserted int      `json:"rowsInserted"`
	RowsUpdated  int      `json:"rowsUpdated"`
	RowsDeleted  int      `json:"rowsDeleted"`
}

type SyncEngine struct {
	reporter Reporter
}

func NewSyncEngine(reporter Reporter) *SyncEngine {
	return &SyncEngine{reporter: reporter}
}

// CompareAndSync performs the synchronization
func (s *SyncEngine) RunSync(config SyncConfig) SyncResult {
	result := SyncResult{Success: true, Logs: []string{}}
	logger.Infof("开始数据同步：源=%s 目标=%s 表数量=%d", formatConnSummaryForSync(config.SourceConfig), formatConnSummaryForSync(config.TargetConfig), len(config.Tables))
	totalTables := len(config.Tables)
	s.progress(config.JobID, 0, totalTables, "", "开始同步")

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
		s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("未知同步内容 %q，已自动使用仅同步数据", config.Content))
		syncData = true
	}

	modeRaw := strings.ToLower(strings.TrimSpace(config.Mode))
	if modeRaw != "" && modeRaw != "insert_update" && modeRaw != "insert_only" && modeRaw != "full_overwrite" {
		s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("未知同步模式 %q，已自动使用 insert_update", config.Mode))
	}
	defaultMode := normalizeSyncMode(config.Mode)

	contentLabel := "仅同步数据"
	if syncSchema && syncData {
		contentLabel = "同步结构+数据"
	} else if syncSchema {
		contentLabel = "仅同步结构"
	}
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("同步内容：%s；模式：%s；自动补字段：%v", contentLabel, defaultMode, config.AutoAddColumns))

	sourceDB, err := db.NewDatabase(config.SourceConfig.Type)
	if err != nil {
		logger.Error(err, "初始化源数据库驱动失败：类型=%s", config.SourceConfig.Type)
		return s.fail(config.JobID, totalTables, result, "初始化源数据库驱动失败: "+err.Error())
	}
	if config.SourceConfig.Type == "custom" {
		// Custom DB setup would go here if needed
	}

	targetDB, err := db.NewDatabase(config.TargetConfig.Type)
	if err != nil {
		logger.Error(err, "初始化目标数据库驱动失败：类型=%s", config.TargetConfig.Type)
		return s.fail(config.JobID, totalTables, result, "初始化目标数据库驱动失败: "+err.Error())
	}

	// Connect Source
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("正在连接源数据库: %s...", config.SourceConfig.Host))
	s.progress(config.JobID, 0, totalTables, "", "连接源数据库")
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		logger.Error(err, "源数据库连接失败：%s", formatConnSummaryForSync(config.SourceConfig))
		return s.fail(config.JobID, totalTables, result, "源数据库连接失败: "+err.Error())
	}
	defer sourceDB.Close()

	// Connect Target
	s.appendLog(config.JobID, &result, "info", fmt.Sprintf("正在连接目标数据库: %s...", config.TargetConfig.Host))
	s.progress(config.JobID, 0, totalTables, "", "连接目标数据库")
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		logger.Error(err, "目标数据库连接失败：%s", formatConnSummaryForSync(config.TargetConfig))
		return s.fail(config.JobID, totalTables, result, "目标数据库连接失败: "+err.Error())
	}
	defer targetDB.Close()

	// Iterate Tables
	for i, tableName := range config.Tables {
		func() {
			tableMode := defaultMode
			s.appendLog(config.JobID, &result, "info", fmt.Sprintf("正在同步表: %s", tableName))
			s.progress(config.JobID, i, totalTables, tableName, fmt.Sprintf("同步表(%d/%d)", i+1, totalTables))
			defer s.progress(config.JobID, i+1, totalTables, tableName, "表处理完成")

			if syncSchema {
				s.progress(config.JobID, i, totalTables, tableName, "同步表结构")
				if err := s.syncTableSchema(config, &result, sourceDB, targetDB, tableName); err != nil {
					s.appendLog(config.JobID, &result, "error", fmt.Sprintf("表结构同步失败：表=%s 错误=%v", tableName, err))
					return
				}
			}
			if !syncData {
				result.TablesSynced++
				return
			}

			sourceSchema, sourceTable := normalizeSchemaAndTable(config.SourceConfig.Type, config.SourceConfig.Database, tableName)
			targetSchema, targetTable := normalizeSchemaAndTable(config.TargetConfig.Type, config.TargetConfig.Database, tableName)
			sourceQueryTable := qualifiedNameForQuery(config.SourceConfig.Type, sourceSchema, sourceTable, tableName)
			targetQueryTable := qualifiedNameForQuery(config.TargetConfig.Type, targetSchema, targetTable, tableName)

			// 1. Get Columns & PKs
			cols, err := sourceDB.GetColumns(sourceSchema, sourceTable)
			if err != nil {
				logger.Error(err, "获取源表列信息失败：表=%s", tableName)
				s.appendLog(config.JobID, &result, "error", fmt.Sprintf("获取表 %s 的列信息失败: %v", tableName, err))
				return
			}
			sourceColsByLower := make(map[string]connection.ColumnDefinition, len(cols))
			for _, col := range cols {
				if strings.TrimSpace(col.Name) == "" {
					continue
				}
				sourceColsByLower[strings.ToLower(strings.TrimSpace(col.Name))] = col
			}

			pkCols := make([]string, 0, 2)
			for _, col := range cols {
				if col.Key == "PRI" || col.Key == "PK" {
					pkCols = append(pkCols, col.Name)
				}
			}

			if len(pkCols) == 0 {
				s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("表 %s 未找到主键，已跳过数据同步（避免产生重复数据）", tableName))
				return
			}
			if len(pkCols) > 1 {
				s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("表 %s 为复合主键（%s），当前暂不支持数据同步", tableName, strings.Join(pkCols, ",")))
				return
			}
			pkCol := pkCols[0]

			opts := TableOptions{Insert: true, Update: true, Delete: false}
			if config.TableOptions != nil {
				if t, ok := config.TableOptions[tableName]; ok {
					opts = t
					// 默认防护：如用户未设置任意一个字段，保持 insert/update 默认 true、delete 默认 false
					if !t.Insert && !t.Update && !t.Delete {
						opts = t
					}
				}
			}
			if !opts.Insert && !opts.Update && !opts.Delete {
				s.appendLog(config.JobID, &result, "info", fmt.Sprintf("表 %s 未勾选任何操作，已跳过", tableName))
				return
			}

			// 2. Fetch Data (MEMORY INTENSIVE - PROTOTYPE ONLY)
			// TODO: Implement paging/streaming
			s.progress(config.JobID, i, totalTables, tableName, "读取源表数据")
			sourceRows, _, err := sourceDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(config.SourceConfig.Type, sourceQueryTable)))
			if err != nil {
				logger.Error(err, "读取源表失败：表=%s", tableName)
				s.appendLog(config.JobID, &result, "error", fmt.Sprintf("读取源表 %s 失败: %v", tableName, err))
				return
			}

			var inserts []map[string]interface{}
			var updates []connection.UpdateRow

			if tableMode == "insert_update" {
				s.progress(config.JobID, i, totalTables, tableName, "读取目标表数据")
				targetRows, _, err := targetDB.Query(fmt.Sprintf("SELECT * FROM %s", quoteQualifiedIdentByType(config.TargetConfig.Type, targetQueryTable)))
				if err != nil {
					logger.Error(err, "读取目标表失败：表=%s", tableName)
					s.appendLog(config.JobID, &result, "error", fmt.Sprintf("读取目标表 %s 失败: %v", tableName, err))
					return
				}

				// 3. Compare (In-Memory Hash Map)
				s.progress(config.JobID, i, totalTables, tableName, "对比差异")
				targetMap := make(map[string]map[string]interface{})
				for _, row := range targetRows {
					if row[pkCol] == nil {
						continue
					}
					pkVal := fmt.Sprintf("%v", row[pkCol])
					if strings.TrimSpace(pkVal) == "" || pkVal == "<nil>" {
						continue
					}
					targetMap[pkVal] = row
				}
				sourcePKSet := make(map[string]struct{}, len(sourceRows))

				for _, sRow := range sourceRows {
					if sRow[pkCol] == nil {
						continue
					}
					pkVal := fmt.Sprintf("%v", sRow[pkCol])
					if strings.TrimSpace(pkVal) == "" || pkVal == "<nil>" {
						continue
					}
					sourcePKSet[pkVal] = struct{}{}

					if tRow, exists := targetMap[pkVal]; exists {
						changes := make(map[string]interface{})
						for k, v := range sRow {
							if fmt.Sprintf("%v", v) != fmt.Sprintf("%v", tRow[k]) {
								changes[k] = v
							}
						}
						if len(changes) > 0 {
							updates = append(updates, connection.UpdateRow{
								Keys:   map[string]interface{}{pkCol: sRow[pkCol]},
								Values: changes,
							})
						}
					} else {
						inserts = append(inserts, sRow)
					}
				}

				var deletes []map[string]interface{}
				if opts.Delete {
					for pkStr, row := range targetMap {
						if _, ok := sourcePKSet[pkStr]; ok {
							continue
						}
						deletes = append(deletes, map[string]interface{}{pkCol: row[pkCol]})
					}
				}

				// apply operation selection
				inserts = filterRowsByPKSelection(pkCol, inserts, opts.Insert, opts.SelectedInsertPKs)
				updates = filterUpdatesByPKSelection(pkCol, updates, opts.Update, opts.SelectedUpdatePKs)
				deletes = filterRowsByPKSelection(pkCol, deletes, opts.Delete, opts.SelectedDeletePKs)

				changeSet := connection.ChangeSet{
					Inserts: inserts,
					Updates: updates,
					Deletes: deletes,
				}

				// 4. Align schema (target missing columns)
				s.progress(config.JobID, i, totalTables, tableName, "检查字段一致性")
				requiredCols := collectRequiredColumns(changeSet.Inserts, changeSet.Updates)
				targetCols, err := targetDB.GetColumns(targetSchema, targetTable)
				if err != nil {
					s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 获取目标表字段失败，已跳过字段一致性检查: %v", err))
				} else {
					targetColSet := make(map[string]struct{}, len(targetCols))
					for _, c := range targetCols {
						name := strings.ToLower(strings.TrimSpace(c.Name))
						if name == "" {
							continue
						}
						targetColSet[name] = struct{}{}
					}

					missing := make([]string, 0)
					for lower, original := range requiredCols {
						if _, ok := targetColSet[lower]; !ok {
							missing = append(missing, original)
						}
					}
					sort.Strings(missing)

					if len(missing) > 0 {
						if config.AutoAddColumns && strings.ToLower(strings.TrimSpace(config.TargetConfig.Type)) == "mysql" {
							s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个，开始自动补齐: %s", len(missing), strings.Join(missing, ", ")))
							added := 0
							for _, colName := range missing {
								colLower := strings.ToLower(strings.TrimSpace(colName))
								colType := "TEXT"
								if strings.ToLower(strings.TrimSpace(config.SourceConfig.Type)) == "mysql" {
									if srcCol, ok := sourceColsByLower[colLower]; ok {
										colType = sanitizeMySQLColumnType(srcCol.Type)
									}
								}

								alterSQL := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
									quoteQualifiedIdentByType("mysql", targetQueryTable),
									quoteIdentByType("mysql", colName),
									colType,
								)
								if _, err := targetDB.Exec(alterSQL); err != nil {
									s.appendLog(config.JobID, &result, "error", fmt.Sprintf("  -> 自动补字段失败：字段=%s 错误=%v", colName, err))
									continue
								}
								added++
							}
							s.appendLog(config.JobID, &result, "info", fmt.Sprintf("  -> 自动补字段完成：成功=%d 失败=%d", added, len(missing)-added))

							// refresh columns
							targetCols, err = targetDB.GetColumns(targetSchema, targetTable)
							if err == nil {
								targetColSet = make(map[string]struct{}, len(targetCols))
								for _, c := range targetCols {
									name := strings.ToLower(strings.TrimSpace(c.Name))
									if name == "" {
										continue
									}
									targetColSet[name] = struct{}{}
								}
							}
						} else {
							s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个（未开启自动补齐），将自动忽略：%s", len(missing), strings.Join(missing, ", ")))
						}

						// filter out still-missing columns to avoid apply failure
						changeSet.Inserts = filterInsertRows(changeSet.Inserts, targetColSet)
						changeSet.Updates = filterUpdateRows(changeSet.Updates, targetColSet)
					}
				}

				// 5. Apply Changes
				s.progress(config.JobID, i, totalTables, tableName, "应用变更")

				if len(changeSet.Inserts) > 0 || len(changeSet.Updates) > 0 || len(changeSet.Deletes) > 0 {
					s.appendLog(config.JobID, &result, "info", fmt.Sprintf("  -> 需插入: %d 行, 需更新: %d 行, 需删除: %d 行", len(changeSet.Inserts), len(changeSet.Updates), len(changeSet.Deletes)))

					if applier, ok := targetDB.(db.BatchApplier); ok {
						if err := applier.ApplyChanges(targetTable, changeSet); err != nil {
							s.appendLog(config.JobID, &result, "error", fmt.Sprintf("  -> 应用变更失败: %v", err))
						} else {
							result.RowsInserted += len(changeSet.Inserts)
							result.RowsUpdated += len(changeSet.Updates)
							result.RowsDeleted += len(changeSet.Deletes)
						}
					} else {
						s.appendLog(config.JobID, &result, "warn", "  -> 目标驱动不支持应用数据变更 (ApplyChanges).")
					}
				} else {
					s.appendLog(config.JobID, &result, "info", "  -> 数据一致，无需变更.")
				}

				result.TablesSynced++
				return
			} else {
				// insert_only / full_overwrite: do not compare target, just insert source rows
				inserts = sourceRows
			}

			// full_overwrite: clear target table first
			if tableMode == "full_overwrite" {
				s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 全量覆盖模式：即将清空目标表 %s", tableName))
				s.progress(config.JobID, i, totalTables, tableName, "清空目标表")
				clearSQL := ""
				if strings.ToLower(strings.TrimSpace(config.TargetConfig.Type)) == "mysql" {
					clearSQL = fmt.Sprintf("TRUNCATE TABLE %s", quoteQualifiedIdentByType(config.TargetConfig.Type, targetQueryTable))
				} else {
					clearSQL = fmt.Sprintf("DELETE FROM %s", quoteQualifiedIdentByType(config.TargetConfig.Type, targetQueryTable))
				}
				if _, err := targetDB.Exec(clearSQL); err != nil {
					s.appendLog(config.JobID, &result, "error", fmt.Sprintf("  -> 清空目标表失败: %v", err))
					return
				}
			}

			// 4. Align schema (target missing columns)
			s.progress(config.JobID, i, totalTables, tableName, "检查字段一致性")
			requiredCols := collectRequiredColumns(inserts, updates)
			targetCols, err := targetDB.GetColumns(targetSchema, targetTable)
			if err != nil {
				s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 获取目标表字段失败，已跳过字段一致性检查: %v", err))
			} else {
				targetColSet := make(map[string]struct{}, len(targetCols))
				for _, c := range targetCols {
					name := strings.ToLower(strings.TrimSpace(c.Name))
					if name == "" {
						continue
					}
					targetColSet[name] = struct{}{}
				}

				missing := make([]string, 0)
				for lower, original := range requiredCols {
					if _, ok := targetColSet[lower]; !ok {
						missing = append(missing, original)
					}
				}
				sort.Strings(missing)

				if len(missing) > 0 {
					if config.AutoAddColumns && strings.ToLower(strings.TrimSpace(config.TargetConfig.Type)) == "mysql" {
						s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个，开始自动补齐: %s", len(missing), strings.Join(missing, ", ")))
						added := 0
						for _, colName := range missing {
							colLower := strings.ToLower(strings.TrimSpace(colName))
							colType := "TEXT"
							if strings.ToLower(strings.TrimSpace(config.SourceConfig.Type)) == "mysql" {
								if srcCol, ok := sourceColsByLower[colLower]; ok {
									colType = sanitizeMySQLColumnType(srcCol.Type)
								}
							}

							alterSQL := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
								quoteQualifiedIdentByType("mysql", targetQueryTable),
								quoteIdentByType("mysql", colName),
								colType,
							)
							if _, err := targetDB.Exec(alterSQL); err != nil {
								s.appendLog(config.JobID, &result, "error", fmt.Sprintf("  -> 自动补字段失败：字段=%s 错误=%v", colName, err))
								continue
							}
							added++
						}
						s.appendLog(config.JobID, &result, "info", fmt.Sprintf("  -> 自动补字段完成：成功=%d 失败=%d", added, len(missing)-added))

						// refresh columns
						targetCols, err = targetDB.GetColumns(targetSchema, targetTable)
						if err == nil {
							targetColSet = make(map[string]struct{}, len(targetCols))
							for _, c := range targetCols {
								name := strings.ToLower(strings.TrimSpace(c.Name))
								if name == "" {
									continue
								}
								targetColSet[name] = struct{}{}
							}
						}
					} else {
						s.appendLog(config.JobID, &result, "warn", fmt.Sprintf("  -> 目标表缺少字段 %d 个（未开启自动补齐），将自动忽略：%s", len(missing), strings.Join(missing, ", ")))
					}

					// filter out still-missing columns to avoid apply failure
					inserts = filterInsertRows(inserts, targetColSet)
					updates = filterUpdateRows(updates, targetColSet)
				}
			}

			// 5. Apply Changes
			s.progress(config.JobID, i, totalTables, tableName, "应用变更")
			changeSet := connection.ChangeSet{
				Inserts: inserts,
				Updates: updates,
			}

			if len(changeSet.Inserts) > 0 || len(changeSet.Updates) > 0 {
				s.appendLog(config.JobID, &result, "info", fmt.Sprintf("  -> 需插入: %d 行, 需更新: %d 行", len(changeSet.Inserts), len(changeSet.Updates)))

				if applier, ok := targetDB.(db.BatchApplier); ok {
					if err := applier.ApplyChanges(targetTable, changeSet); err != nil {
						s.appendLog(config.JobID, &result, "error", fmt.Sprintf("  -> 应用变更失败: %v", err))
					} else {
						result.RowsInserted += len(changeSet.Inserts)
						result.RowsUpdated += len(changeSet.Updates)
					}
				} else {
					s.appendLog(config.JobID, &result, "warn", "  -> 目标驱动不支持应用数据变更 (ApplyChanges).")
				}
			} else {
				s.appendLog(config.JobID, &result, "info", "  -> 数据一致，无需变更.")
			}

			result.TablesSynced++
		}()
	}

	s.progress(config.JobID, totalTables, totalTables, "", "同步完成")
	return result
}

func formatConnSummaryForSync(config connection.ConnectionConfig) string {
	timeoutSeconds := config.Timeout
	if timeoutSeconds <= 0 {
		timeoutSeconds = 30
	}

	dbName := strings.TrimSpace(config.Database)
	if dbName == "" {
		dbName = "(default)"
	}

	return fmt.Sprintf("类型=%s 地址=%s:%d 数据库=%s 用户=%s 超时=%ds",
		config.Type, config.Host, config.Port, dbName, config.User, timeoutSeconds)
}

func (s *SyncEngine) appendLog(jobID string, res *SyncResult, level string, msg string) {
	if res != nil {
		res.Logs = append(res.Logs, msg)
	}
	if s.reporter.OnLog != nil && strings.TrimSpace(jobID) != "" {
		s.reporter.OnLog(SyncLogEvent{
			JobID:   jobID,
			Level:   level,
			Message: msg,
			Ts:      time.Now().UnixMilli(),
		})
	}
}

func (s *SyncEngine) progress(jobID string, current, total int, table string, stage string) {
	if s.reporter.OnProgress == nil || strings.TrimSpace(jobID) == "" {
		return
	}
	percent := 0
	if total <= 0 {
		if current > 0 {
			percent = 100
		}
	} else {
		if current < 0 {
			current = 0
		}
		if current > total {
			current = total
		}
		percent = (current * 100) / total
	}
	s.reporter.OnProgress(SyncProgressEvent{
		JobID:   jobID,
		Percent: percent,
		Current: current,
		Total:   total,
		Table:   table,
		Stage:   stage,
	})
}

func (s *SyncEngine) fail(jobID string, totalTables int, res SyncResult, msg string) SyncResult {
	res.Success = false
	res.Message = msg
	s.appendLog(jobID, &res, "error", "致命错误: "+msg)
	s.progress(jobID, res.TablesSynced, totalTables, "", "同步失败")
	return res
}
