package db

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrTableInfoUnsupported 表示当前驱动方言没有实现表信息聚合查询；
// 调用方（绑定层/前端）应据此降级展示，而不是当作失败。
var ErrTableInfoUnsupported = errors.New("当前数据源不支持表信息查询")

// TableDetails 是右侧对象信息面板的表级聚合元数据。
// 数值与时间字段可能缺失（估算器返回 NULL、方言不暴露），
// 用指针/空串区分「没有」与「值为 0」。
type TableDetails struct {
	Engine        string `json:"engine"`
	Comment       string `json:"comment"`
	Collation     string `json:"collation"`
	RowFormat     string `json:"rowFormat"`
	Rows          *int64 `json:"rows,omitempty"`
	DataLength    *int64 `json:"dataLength,omitempty"`
	IndexLength   *int64 `json:"indexLength,omitempty"`
	AutoIncrement string `json:"autoIncrement,omitempty"`
	CreateTime    string `json:"createTime,omitempty"`
	UpdateTime    string `json:"updateTime,omitempty"`
}

// GetTableInfo 按驱动类型查询一张表的聚合信息（引擎/注释/编码/行数/大小）。
// 只覆盖有稳定字典视图的方言：MySQL 系、PostgreSQL 系、SQLite；
// 其余返回 ErrTableInfoUnsupported。
func GetTableInfo(ctx context.Context, database Database, driverType, dbName, schemaName, tableName string) (TableDetails, error) {
	if database == nil {
		return TableDetails{}, errors.New("连接未打开")
	}
	tableName = strings.TrimSpace(tableName)
	if tableName == "" {
		return TableDetails{}, errors.New("表名不能为空")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	queryFn := func(queryCtx context.Context, query string) ([]map[string]interface{}, error) {
		return queryRowsWithContext(queryCtx, database, query)
	}
	return dispatchTableInfoQuery(ctx, driverType, dbName, schemaName, tableName, queryFn)
}

// dispatchTableInfoQuery 按归一化后的驱动类型分发方言查询，测试直接注入 queryFn。
func dispatchTableInfoQuery(ctx context.Context, driverType, dbName, schemaName, tableName string, queryFn tableInfoQueryFunc) (TableDetails, error) {
	switch normalizeRuntimeDriverType(driverType) {
	case "mysql", "mariadb", "oceanbase", "goldendb", "starrocks", "diros", "sphinx", "gbase8a":
		return getMySQLFamilyTableInfo(ctx, queryFn, dbName, tableName)
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "cockroachdb", "gbase8c":
		return getPostgresFamilyTableInfo(ctx, queryFn, dbName, schemaName, tableName)
	case "sqlite":
		return getSQLiteTableInfo(ctx, queryFn)
	default:
		return TableDetails{}, ErrTableInfoUnsupported
	}
}

func queryRowsWithContext(ctx context.Context, database Database, query string) ([]map[string]interface{}, error) {
	if contextQuerier, ok := database.(QueryContexter); ok {
		rows, _, err := contextQuerier.QueryContext(ctx, query)
		return rows, err
	}
	rows, _, err := database.Query(query)
	return rows, err
}

func sqlLiteral(value string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), "'", "''")
}

func nullableStringValue(row map[string]interface{}, key string) string {
	value := metadataRowValue(row, key)
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case time.Time:
		if typed.IsZero() {
			return ""
		}
		return typed.Format("2006-01-02 15:04:05")
	case []byte:
		return strings.TrimSpace(string(typed))
	default:
		text := strings.TrimSpace(fmt.Sprint(typed))
		if text == "<nil>" {
			return ""
		}
		return text
	}
}

func nullableInt64Value(row map[string]interface{}, key string) *int64 {
	text := nullableStringValue(row, key)
	if text == "" {
		return nil
	}
	var parsed int64
	if _, err := fmt.Sscanf(text, "%d", &parsed); err != nil {
		return nil
	}
	return &parsed
}

type tableInfoQueryFunc func(ctx context.Context, query string) ([]map[string]interface{}, error)

func getMySQLFamilyTableInfo(ctx context.Context, queryFn tableInfoQueryFunc, dbName, tableName string) (TableDetails, error) {
	query := fmt.Sprintf(
		"SELECT ENGINE, TABLE_COMMENT, TABLE_COLLATION, ROW_FORMAT, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME FROM information_schema.tables WHERE TABLE_SCHEMA = '%s' AND TABLE_NAME = '%s' LIMIT 1",
		sqlLiteral(dbName), sqlLiteral(tableName),
	)
	rows, err := queryFn(ctx, query)
	if err != nil {
		return TableDetails{}, err
	}
	if len(rows) == 0 {
		return TableDetails{}, fmt.Errorf("表 %s 不存在", tableName)
	}
	row := rows[0]
	return TableDetails{
		Engine:        nullableStringValue(row, "ENGINE"),
		Comment:       nullableStringValue(row, "TABLE_COMMENT"),
		Collation:     nullableStringValue(row, "TABLE_COLLATION"),
		RowFormat:     nullableStringValue(row, "ROW_FORMAT"),
		Rows:          nullableInt64Value(row, "TABLE_ROWS"),
		DataLength:    nullableInt64Value(row, "DATA_LENGTH"),
		IndexLength:   nullableInt64Value(row, "INDEX_LENGTH"),
		AutoIncrement: nullableStringValue(row, "AUTO_INCREMENT"),
		CreateTime:    nullableStringValue(row, "CREATE_TIME"),
		UpdateTime:    nullableStringValue(row, "UPDATE_TIME"),
	}, nil
}

func getPostgresFamilyTableInfo(ctx context.Context, queryFn tableInfoQueryFunc, dbName, schemaName, tableName string) (TableDetails, error) {
	schema := strings.TrimSpace(schemaName)
	if schema == "" {
		schema = "public"
	}
	query := fmt.Sprintf(
		"SELECT c.relkind::text AS relkind, c.reltuples::bigint AS est_rows, pg_relation_size(c.oid) AS data_length, pg_total_relation_size(c.oid) - pg_relation_size(c.oid) AS index_length, obj_description(c.oid, 'pg_class') AS table_comment, d.datcollate AS collation FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, pg_database d WHERE d.datname = current_database() AND n.nspname = '%s' AND c.relname = '%s' LIMIT 1",
		sqlLiteral(schema), sqlLiteral(tableName),
	)
	rows, err := queryFn(ctx, query)
	if err != nil {
		return TableDetails{}, err
	}
	if len(rows) == 0 {
		return TableDetails{}, fmt.Errorf("表 %s 不存在", tableName)
	}
	row := rows[0]
	engine := "heap"
	switch nullableStringValue(row, "relkind") {
	case "p":
		engine = "partitioned table"
	case "f":
		engine = "foreign table"
	}
	// reltuples = -1 表示从未 ANALYZE，与 NULL 一样当「未知」处理。
	rowCount := nullableInt64Value(row, "est_rows")
	if rowCount != nil && *rowCount < 0 {
		rowCount = nil
	}
	return TableDetails{
		Engine:      engine,
		Comment:     nullableStringValue(row, "table_comment"),
		Collation:   nullableStringValue(row, "collation"),
		Rows:        rowCount,
		DataLength:  nullableInt64Value(row, "data_length"),
		IndexLength: nullableInt64Value(row, "index_length"),
	}, nil
}

func getSQLiteTableInfo(ctx context.Context, queryFn tableInfoQueryFunc) (TableDetails, error) {
	pageCountRows, err := queryFn(ctx, "PRAGMA page_count")
	if err != nil {
		return TableDetails{}, err
	}
	pageSizeRows, err := queryFn(ctx, "PRAGMA page_size")
	if err != nil {
		return TableDetails{}, err
	}
	details := TableDetails{Engine: "SQLite"}
	if pageCount := nullableInt64Value(firstMetadataRow(pageCountRows), "page_count"); pageCount != nil {
		if pageSize := nullableInt64Value(firstMetadataRow(pageSizeRows), "page_size"); pageSize != nil {
			total := *pageCount * *pageSize
			details.DataLength = &total
		}
	}
	return details, nil
}

func firstMetadataRow(rows []map[string]interface{}) map[string]interface{} {
	if len(rows) == 0 {
		return map[string]interface{}{}
	}
	return rows[0]
}
