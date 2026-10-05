//go:build gonavi_full_drivers || gonavi_timescaledb_driver

package db

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// timescaleDBDefaultSearchPath 与 TimescaleDB / PostgreSQL 的会话默认值一致：扩展会建
// _timescaledb_catalog 等内部 schema，按 PostgresDB 的做法把它们全部放进 search_path，
// 用户表与扩展内部表（如 chunk、jobs）同名时会解析到内部表上。
const timescaleDBDefaultSearchPath = "$user,public"

// TimescaleDB 是装了 TimescaleDB 扩展的 PostgreSQL：连接与元数据复用 PostgresDB，
// 隐藏扩展内部 schema 下的 catalog 与 chunk 表，连续聚合按 CREATE MATERIALIZED VIEW ... WITH
// (timescaledb.continuous) 展示（超表的 create_hypertable 与压缩设置由应用层补在回退 DDL 之后）。
type TimescaleDB struct {
	PostgresDB
	driverVariantState
}

var (
	_ Database              = (*TimescaleDB)(nil)
	_ DriverVariantReporter = (*TimescaleDB)(nil)
)

func (t *TimescaleDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&t.PostgresDB, ctx)
}

func (t *TimescaleDB) clearMetadataContext() {
	ClearMetadataContext(&t.PostgresDB)
}

// Connect 复用 PostgreSQL 连接链路，并按 pg_extension 中的 timescaledb 版本确定档位；
// 当前库没有安装扩展时版本为空，按最新档位处理。
func (t *TimescaleDB) Connect(config connection.ConnectionConfig) error {
	runConfig := withDefaultSearchPath(rewriteURIScheme(config, "postgresql", "timescaledb", "timescale"), timescaleDBDefaultSearchPath)
	if err := t.PostgresDB.Connect(runConfig); err != nil {
		return err
	}
	version := ""
	if rows, _, err := t.PostgresDB.Query("SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'"); err == nil {
		version = FirstQueryRowValue(rows)
	} else {
		logger.Warnf("TimescaleDB 扩展版本识别失败：%v", err)
	}
	if err := t.resolve("timescaledb", config, version); err != nil {
		_ = t.PostgresDB.Close()
		return err
	}
	return nil
}

// IsTimescaleDBInternalSchema 报告 schema 是否属于 TimescaleDB 扩展内部（catalog、chunk、配置与信息视图）。
func IsTimescaleDBInternalSchema(schema string) bool {
	lower := strings.ToLower(strings.TrimSpace(schema))
	return strings.HasPrefix(lower, "_timescaledb_") || strings.HasPrefix(lower, "timescaledb_")
}

func timescaleQualifiedNameSchema(name string) string {
	schema, _, found := strings.Cut(name, ".")
	if !found {
		return ""
	}
	return strings.Trim(schema, `"`)
}

// GetTables 返回 PostgreSQL 的表，去掉扩展内部 schema 下的 catalog 与 chunk 表。
func (t *TimescaleDB) GetTables(dbName string) ([]string, error) {
	tables, err := t.PostgresDB.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	visible := make([]string, 0, len(tables))
	for _, table := range tables {
		if !IsTimescaleDBInternalSchema(timescaleQualifiedNameSchema(table)) {
			visible = append(visible, table)
		}
	}
	return visible, nil
}

// GetAllColumns 去掉扩展内部 schema 下的列，避免补全里出现 chunk 表。
func (t *TimescaleDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	columns, err := t.PostgresDB.GetAllColumns(dbName)
	if err != nil {
		return nil, err
	}
	visible := make([]connection.ColumnDefinitionWithTable, 0, len(columns))
	for _, column := range columns {
		if !IsTimescaleDBInternalSchema(timescaleQualifiedNameSchema(column.TableName)) {
			visible = append(visible, column)
		}
	}
	return visible, nil
}

// GetCreateStatement 连续聚合返回 TimescaleDB 语法的建视图语句（1.x 是 CREATE VIEW，2.x 是
// CREATE MATERIALIZED VIEW）；其他对象沿用 PostgresDB，由应用层按列与索引生成 DDL。
func (t *TimescaleDB) GetCreateStatement(schemaName, tableName string) (string, error) {
	schema, name := normalizePGLikeMetadataTable(schemaName, tableName)
	if schema == "" {
		schema = "public"
	}
	if ddl, ok := t.continuousAggregateDDL(schema, name); ok {
		return ddl, nil
	}
	return t.PostgresDB.GetCreateStatement(schemaName, tableName)
}

func (t *TimescaleDB) continuousAggregateDDL(schema, name string) (string, bool) {
	query := "SELECT view_definition FROM timescaledb_information.continuous_aggregates WHERE view_name::text = " + timescaleLiteral(name)
	keyword := "CREATE VIEW"
	if t.atLeast("2.0") {
		query += " AND view_schema = " + timescaleLiteral(schema)
		keyword = "CREATE MATERIALIZED VIEW"
	}
	rows, _, err := t.PostgresDB.Query(query)
	if err != nil || len(rows) == 0 {
		return "", false
	}
	definition := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(FirstQueryRowValue(rows)), ";"))
	if definition == "" {
		return "", false
	}
	return keyword + " " + timescaleQuoteIdent(schema) + "." + timescaleQuoteIdent(name) +
		" WITH (timescaledb.continuous) AS\n" + definition + ";", true
}

func timescaleLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func timescaleQuoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
