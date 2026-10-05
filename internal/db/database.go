package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// Database 定义了统一的数据源访问接口。
// 所有数据库驱动（MySQL、PostgreSQL、Oracle 等）均需实现此接口。
// 方法调用方可通过 NewDatabase 工厂函数获取对应驱动的实例。
//
// 取消契约：MCP 元数据请求通过 BindMetadataContext 把请求上下文绑定到隔离的
// Database 实例，驱动实现必须在底层调用中传递 metadataContextFor 返回的上下文
// （如 QueryContext / HTTP request context）。若驱动忽略该上下文，取消将退化为
// 等待查询自然结束，连接与 goroutine 会残留至查询完成。
type Database interface {
	// Connect 根据连接配置建立数据库连接。
	Connect(config connection.ConnectionConfig) error
	// Close 关闭数据库连接并释放底层资源。
	Close() error
	// Ping 测试连接是否仍然可用。
	Ping() error
	// Query 执行查询语句，返回结果行（列名→值映射）和列名列表。
	Query(query string) ([]map[string]interface{}, []string, error)
	// Exec 执行非查询语句（INSERT/UPDATE/DELETE 等），返回受影响行数。
	Exec(query string) (int64, error)
	// GetDatabases 返回当前连接可访问的数据库列表。
	GetDatabases() ([]string, error)
	// GetTables 返回指定数据库下的表列表。
	GetTables(dbName string) ([]string, error)
	// GetCreateStatement 返回指定表的建表 DDL 语句。
	GetCreateStatement(dbName, tableName string) (string, error)
	// GetColumns 返回指定表的列定义列表。
	GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error)
	// GetAllColumns 返回指定数据库下所有表的列定义（含表名标识）。
	GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error)
	// GetIndexes 返回指定表的索引定义列表。
	GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error)
	// GetForeignKeys 返回指定表的外键定义列表。
	GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error)
	// GetTriggers 返回指定表的触发器定义列表。
	GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error)
}

// BatchApplier 定义了批量变更提交接口。
// 支持批量编辑的驱动实现此接口，用于一次性提交前端 DataGrid 中的增删改操作。
type BatchApplier interface {
	// ApplyChanges 将一组变更（新增、修改、删除）批量提交到指定表。
	ApplyChanges(tableName string, changes connection.ChangeSet) error
}

// BatchApplierContext is the optional cancellation-aware form of BatchApplier.
// Long-running import and synchronization jobs prefer it so cancellation can
// reach an in-flight driver transaction. BatchApplier remains for backwards
// compatibility with drivers that cannot yet expose context cancellation.
type BatchApplierContext interface {
	BatchApplier
	ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error
}

// ChangePreviewer 是可选的变更预览接口。
// 驱动可实现此接口提供自定义 SQL 预览格式；若未实现，调用方回退到 GenerateChangePreview。
type ChangePreviewer interface {
	PreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string)
}

type rowMutationAction string

const (
	rowMutationActionDelete rowMutationAction = "delete"
	rowMutationActionUpdate rowMutationAction = "update"
)

func localizedRowMutationAction(action rowMutationAction) string {
	switch action {
	case rowMutationActionDelete:
		return localizedDriverRuntimeText("db.backend.action.delete", nil)
	case rowMutationActionUpdate:
		return localizedDriverRuntimeText("db.backend.action.update", nil)
	default:
		return strings.TrimSpace(string(action))
	}
}

func requireSingleRowAffected(result sql.Result, action rowMutationAction) error {
	actionLabel := localizedRowMutationAction(action)
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("%s", localizedDriverRuntimeText("db.backend.error.row_action_not_effective_rows_affected_unknown", map[string]any{
			"action": actionLabel,
			"detail": err.Error(),
		}))
	}
	if affected == 0 {
		return fmt.Errorf("%s", localizedDriverRuntimeText("db.backend.error.row_action_not_effective_no_rows_matched", map[string]any{
			"action": actionLabel,
		}))
	}
	if affected != 1 {
		return fmt.Errorf("%s", localizedDriverRuntimeText("db.backend.error.row_action_not_effective_multiple_rows", map[string]any{
			"action": actionLabel,
			"count":  affected,
		}))
	}
	return nil
}
