package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
)

// SyncConfig defines the parameters for a synchronization task
type SyncConfig struct {
	SourceConfig connection.ConnectionConfig `json:"sourceConfig"`
	TargetConfig connection.ConnectionConfig `json:"targetConfig"`
	Tables       []string                    `json:"tables"` // Tables to sync
	Mode         string                      `json:"mode"`   // "insert_update", "full_overwrite"
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
}

func NewSyncEngine() *SyncEngine {
	return &SyncEngine{}
}

// CompareAndSync performs the synchronization
func (s *SyncEngine) RunSync(config SyncConfig) SyncResult {
	result := SyncResult{Success: true, Logs: []string{}}

	sourceDB, err := db.NewDatabase(config.SourceConfig.Type)
	if err != nil {
		return s.fail(result, "初始化源数据库驱动失败: "+err.Error())
	}
	if config.SourceConfig.Type == "custom" {
		// Custom DB setup would go here if needed
	}

	targetDB, err := db.NewDatabase(config.TargetConfig.Type)
	if err != nil {
		return s.fail(result, "初始化目标数据库驱动失败: "+err.Error())
	}

	// Connect Source
	result.Logs = append(result.Logs, fmt.Sprintf("正在连接源数据库: %s...", config.SourceConfig.Host))
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		return s.fail(result, "源数据库连接失败: "+err.Error())
	}
	defer sourceDB.Close()

	// Connect Target
	result.Logs = append(result.Logs, fmt.Sprintf("正在连接目标数据库: %s...", config.TargetConfig.Host))
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		return s.fail(result, "目标数据库连接失败: "+err.Error())
	}
	defer targetDB.Close()

	// Iterate Tables
	for _, tableName := range config.Tables {
		result.Logs = append(result.Logs, fmt.Sprintf("正在同步表: %s", tableName))

		// 1. Get Columns & PKs (Naive approach: assume same schema)
		cols, err := sourceDB.GetColumns(config.SourceConfig.Database, tableName)
		if err != nil {
			result.Logs = append(result.Logs, fmt.Sprintf("获取表 %s 的列信息失败: %v", tableName, err))
			continue
		}

		pkCol := ""
		for _, col := range cols {
			if col.Key == "PRI" || col.Key == "PK" {
				pkCol = col.Name
				break
			}
		}

		if pkCol == "" {
			result.Logs = append(result.Logs, fmt.Sprintf("跳过表 %s: 未找到主键 (同步需要主键)", tableName))
			continue
		}

		// 2. Fetch Data (MEMORY INTENSIVE - PROTOTYPE ONLY)
		// TODO: Implement paging/streaming
		sourceRows, _, err := sourceDB.Query(fmt.Sprintf("SELECT * FROM %s", tableName))
		if err != nil {
			result.Logs = append(result.Logs, fmt.Sprintf("读取源表 %s 失败: %v", tableName, err))
			continue
		}

		targetRows, _, err := targetDB.Query(fmt.Sprintf("SELECT * FROM %s", tableName))
		if err != nil {
			// Table might not exist in target?
			// Check if error is "table not found" -> Try to Create?
			// For now, assume table exists.
			result.Logs = append(result.Logs, fmt.Sprintf("读取目标表 %s 失败: %v", tableName, err))
			continue
		}

		// 3. Compare (In-Memory Hash Map)
		targetMap := make(map[string]map[string]interface{})
		for _, row := range targetRows {
			pkVal := fmt.Sprintf("%v", row[pkCol])
			targetMap[pkVal] = row
		}

		var inserts []map[string]interface{}
		var updates []connection.UpdateRow
		// var deletes []map[string]interface{} // Not implemented in "insert_update" mode usually

		for _, sRow := range sourceRows {
			pkVal := fmt.Sprintf("%v", sRow[pkCol])

			if tRow, exists := targetMap[pkVal]; exists {
				// Update? Compare values
				// Simplified: Compare string representations or iterate keys
				// For prototype: assume update if exists
				// Optimization: Check diff
				changes := make(map[string]interface{})
				for k, v := range sRow {
					if fmt.Sprintf("%v", v) != fmt.Sprintf("%v", tRow[k]) {
						changes[k] = v
					}
				}
				if len(changes) > 0 {
					updates = append(updates, connection.UpdateRow{
						Keys:   map[string]interface{}{pkCol: pkVal},
						Values: changes,
					})
				}
			} else {
				// Insert
				inserts = append(inserts, sRow)
			}
		}

		// 4. Apply Changes
		changeSet := connection.ChangeSet{
			Inserts: inserts,
			Updates: updates,
		}

		if len(inserts) > 0 || len(updates) > 0 {
			result.Logs = append(result.Logs, fmt.Sprintf("  -> 需插入: %d 行, 需更新: %d 行", len(inserts), len(updates)))

			// We need a BatchApplier interface or assume Database implements ApplyChanges
			if applier, ok := targetDB.(db.BatchApplier); ok {
				if err := applier.ApplyChanges(tableName, changeSet); err != nil {
					result.Logs = append(result.Logs, fmt.Sprintf("  -> 应用变更失败: %v", err))
				} else {
					result.RowsInserted += len(inserts)
					result.RowsUpdated += len(updates)
				}
			} else {
				result.Logs = append(result.Logs, "  -> 目标驱动不支持应用数据变更 (ApplyChanges).")
			}
		} else {
			result.Logs = append(result.Logs, "  -> 数据一致，无需变更.")
		}

		result.TablesSynced++
	}

	return result
}

func (s *SyncEngine) fail(res SyncResult, msg string) SyncResult {
	res.Success = false
	res.Message = msg
	res.Logs = append(res.Logs, "致命错误: "+msg)
	return res
}
