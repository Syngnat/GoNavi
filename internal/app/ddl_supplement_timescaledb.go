package app

import (
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/datasource"
	"GoNavi-Wails/internal/db"
)

// appendRegistryCreateStatementSupplement 在按列与索引回退生成的建表语句后补充描述表数据源特有的语句。
// 查询经驱动代理执行，不需要扩展代理协议；目前只有 TimescaleDB 的超表需要（create_hypertable 与压缩设置）。
func appendRegistryCreateStatementSupplement(dbInst db.Database, config connection.ConnectionConfig, schemaName, tableName, ddl string) string {
	spec, ok := db.DataSourceSpec(config.Type)
	if !ok || spec.Type != "timescaledb" || strings.TrimSpace(ddl) == "" {
		return ddl
	}
	statements := timescaleHypertableStatements(dbInst, schemaName, tableName)
	if len(statements) == 0 {
		return ddl
	}
	return strings.TrimRight(ddl, "\n") + "\n\n-- TimescaleDB\n" + strings.Join(statements, "\n")
}

type timescaleDimension struct {
	column     string
	space      bool
	interval   string
	integer    bool
	partitions string
}

type timescaleCompressionColumn struct {
	name         string
	segmentIndex int
	orderIndex   int
	ascending    bool
	nullsFirst   bool
}

// timescaleHypertableStatements 按服务端版本生成重建超表的语句：2.13 起用 by_range / by_hash 维度构造器，
// 更早版本用 create_hypertable(table, column, chunk_time_interval => ...) 与 add_dimension(table, column, number_partitions => ...)。
func timescaleHypertableStatements(dbInst db.Database, schemaName, tableName string) []string {
	schema := strings.TrimSpace(schemaName)
	if schema == "" {
		schema = "public"
	}
	table := strings.TrimSpace(tableName)
	version := ""
	if reporter, ok := dbInst.(db.DriverVariantReporter); ok {
		_, version = reporter.DriverVariantInfo()
	}
	atLeast := func(minimum string) bool {
		return version == "" || datasource.CompareServerVersions(version, minimum) >= 0
	}
	dimensions := loadTimescaleDimensions(dbInst, schema, table, atLeast("2.0"))
	if len(dimensions) == 0 {
		return nil
	}
	target := timescaleSQLLiteral(timescaleIdent(schema) + "." + timescaleIdent(table))
	modern := atLeast("2.13")
	statements := make([]string, 0, len(dimensions)+1)
	for index, dimension := range dimensions {
		switch {
		case index == 0 && modern:
			statements = append(statements, fmt.Sprintf("SELECT create_hypertable(%s, by_range(%s, %s));", target, timescaleSQLLiteral(dimension.column), dimension.intervalSQL()))
		case index == 0:
			statements = append(statements, fmt.Sprintf("SELECT create_hypertable(%s, %s, chunk_time_interval => %s);", target, timescaleSQLLiteral(dimension.column), dimension.intervalSQL()))
		case dimension.space && modern:
			statements = append(statements, fmt.Sprintf("SELECT add_dimension(%s, by_hash(%s, %s));", target, timescaleSQLLiteral(dimension.column), dimension.partitions))
		case dimension.space:
			statements = append(statements, fmt.Sprintf("SELECT add_dimension(%s, %s, number_partitions => %s);", target, timescaleSQLLiteral(dimension.column), dimension.partitions))
		case modern:
			statements = append(statements, fmt.Sprintf("SELECT add_dimension(%s, by_range(%s, %s));", target, timescaleSQLLiteral(dimension.column), dimension.intervalSQL()))
		default:
			statements = append(statements, fmt.Sprintf("SELECT add_dimension(%s, %s, chunk_time_interval => %s);", target, timescaleSQLLiteral(dimension.column), dimension.intervalSQL()))
		}
	}
	if compression := timescaleCompressionStatement(loadTimescaleCompression(dbInst, schema, table, atLeast("2.0")), schema, table); compression != "" {
		statements = append(statements, compression)
	}
	return statements
}

func (d timescaleDimension) intervalSQL() string {
	if d.integer {
		return d.interval
	}
	return "INTERVAL " + timescaleSQLLiteral(d.interval)
}

func loadTimescaleDimensions(dbInst db.Database, schema, table string, v2 bool) []timescaleDimension {
	query := `SELECT column_name, dimension_type, time_interval::text AS time_interval, integer_interval::text AS integer_interval, num_partitions::text AS num_partitions
FROM timescaledb_information.dimensions WHERE hypertable_schema = ` + timescaleSQLLiteral(schema) + ` AND hypertable_name = ` + timescaleSQLLiteral(table) + ` ORDER BY dimension_number`
	if !v2 {
		query = `SELECT d.column_name, CASE WHEN d.num_slices IS NULL THEN 'Time' ELSE 'Space' END AS dimension_type,
	CASE WHEN d.column_type IN ('timestamp'::regtype, 'timestamptz'::regtype, 'date'::regtype) THEN (d.interval_length * interval '1 microsecond')::text END AS time_interval,
	CASE WHEN d.column_type IN ('timestamp'::regtype, 'timestamptz'::regtype, 'date'::regtype) THEN NULL ELSE d.interval_length::text END AS integer_interval,
	d.num_slices::text AS num_partitions
FROM _timescaledb_catalog.dimension d JOIN _timescaledb_catalog.hypertable h ON h.id = d.hypertable_id
WHERE h.schema_name = ` + timescaleSQLLiteral(schema) + ` AND h.table_name = ` + timescaleSQLLiteral(table) + ` ORDER BY d.id`
	}
	rows, _, err := dbInst.Query(query)
	if err != nil {
		return nil
	}
	dimensions := make([]timescaleDimension, 0, len(rows))
	for _, row := range rows {
		dimension := timescaleDimension{
			column:     timescaleRowText(row, "column_name"),
			space:      strings.EqualFold(timescaleRowText(row, "dimension_type"), "Space"),
			interval:   timescaleRowText(row, "time_interval"),
			partitions: timescaleRowText(row, "num_partitions"),
		}
		if dimension.interval == "" {
			dimension.interval = timescaleRowText(row, "integer_interval")
			dimension.integer = true
		}
		if dimension.column != "" {
			dimensions = append(dimensions, dimension)
		}
	}
	return dimensions
}

func loadTimescaleCompression(dbInst db.Database, schema, table string, v2 bool) []timescaleCompressionColumn {
	query := `SELECT attname, segmentby_column_index, orderby_column_index, orderby_asc, orderby_nullsfirst
FROM timescaledb_information.compression_settings WHERE hypertable_schema = ` + timescaleSQLLiteral(schema) + ` AND hypertable_name = ` + timescaleSQLLiteral(table)
	if !v2 {
		query = `SELECT c.attname, c.segmentby_column_index, c.orderby_column_index, c.orderby_asc, c.orderby_nullsfirst
FROM _timescaledb_catalog.hypertable_compression c JOIN _timescaledb_catalog.hypertable h ON h.id = c.hypertable_id
WHERE h.schema_name = ` + timescaleSQLLiteral(schema) + ` AND h.table_name = ` + timescaleSQLLiteral(table)
	}
	rows, _, err := dbInst.Query(query)
	if err != nil {
		return nil
	}
	columns := make([]timescaleCompressionColumn, 0, len(rows))
	for _, row := range rows {
		column := timescaleCompressionColumn{name: timescaleRowText(row, "attname")}
		_, _ = fmt.Sscan(timescaleRowText(row, "segmentby_column_index"), &column.segmentIndex)
		_, _ = fmt.Sscan(timescaleRowText(row, "orderby_column_index"), &column.orderIndex)
		column.ascending = timescaleRowBool(row, "orderby_asc")
		column.nullsFirst = timescaleRowBool(row, "orderby_nullsfirst")
		columns = append(columns, column)
	}
	return columns
}

// timescaleCompressionStatement 拼出 ALTER TABLE ... SET (timescaledb.compress, ...)；未启用压缩时返回空串。
func timescaleCompressionStatement(columns []timescaleCompressionColumn, schema, table string) string {
	if len(columns) == 0 {
		return ""
	}
	segments := make([]timescaleCompressionColumn, 0)
	orders := make([]timescaleCompressionColumn, 0)
	for _, column := range columns {
		if column.segmentIndex > 0 {
			segments = append(segments, column)
		}
		if column.orderIndex > 0 {
			orders = append(orders, column)
		}
	}
	sort.Slice(segments, func(i, j int) bool { return segments[i].segmentIndex < segments[j].segmentIndex })
	sort.Slice(orders, func(i, j int) bool { return orders[i].orderIndex < orders[j].orderIndex })
	options := []string{"timescaledb.compress"}
	if len(segments) > 0 {
		names := make([]string, 0, len(segments))
		for _, column := range segments {
			names = append(names, column.name)
		}
		options = append(options, "timescaledb.compress_segmentby = "+timescaleSQLLiteral(strings.Join(names, ", ")))
	}
	if len(orders) > 0 {
		parts := make([]string, 0, len(orders))
		for _, column := range orders {
			part := column.name
			if !column.ascending {
				part += " DESC"
			}
			// PostgreSQL 默认 ASC 配 NULLS LAST、DESC 配 NULLS FIRST，与默认不同时才写出。
			if column.nullsFirst == column.ascending {
				if column.nullsFirst {
					part += " NULLS FIRST"
				} else {
					part += " NULLS LAST"
				}
			}
			parts = append(parts, part)
		}
		options = append(options, "timescaledb.compress_orderby = "+timescaleSQLLiteral(strings.Join(parts, ", ")))
	}
	return "ALTER TABLE " + timescaleIdent(schema) + "." + timescaleIdent(table) + " SET (" + strings.Join(options, ", ") + ");"
}

func timescaleRowText(row map[string]interface{}, key string) string {
	for name, value := range row {
		if strings.EqualFold(name, key) {
			if value == nil {
				return ""
			}
			return strings.TrimSpace(fmt.Sprint(value))
		}
	}
	return ""
}

func timescaleRowBool(row map[string]interface{}, key string) bool {
	text := strings.ToLower(timescaleRowText(row, key))
	return text == "true" || text == "t"
}

func timescaleIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func timescaleSQLLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
