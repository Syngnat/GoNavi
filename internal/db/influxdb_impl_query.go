//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

func (x *InfluxDB) Query(query string) ([]map[string]interface{}, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultInfluxDBQueryTimeout)
	defer cancel()
	return x.QueryContext(ctx, query)
}

// QueryContext 按语言分发：Flux（2.x）走 /api/v2/query，3.x 的 SQL 走 /api/v3/query_sql，
// InfluxQL 走 /query；网格生成的简单 SELECT 先按 schema 改写成 InfluxQL 能执行的写法。
func (x *InfluxDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if x.client == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	text := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	if IsInfluxFluxQuery(text) {
		if !x.isV2() {
			return nil, nil, localizedDatabaseRuntimeError("db.backend.error.influxdb_flux_unsupported", nil)
		}
		return x.flux(ctx, text)
	}
	if x.isV3() && !isInfluxQLOnlyStatement(text) {
		return x.sqlV3(ctx, x.database, text)
	}
	rewritten, countStar, err := x.rewriteInfluxSelect(ctx, text)
	if err != nil {
		return nil, nil, err
	}
	results, err := x.influxQL(ctx, x.database, rewritten, false)
	if err != nil {
		return nil, nil, err
	}
	rows, columns := influxQLRows(results)
	if countStar {
		return []map[string]interface{}{{"total": influxCountTotal(rows)}}, []string{"total"}, nil
	}
	return rows, columns, nil
}

// isInfluxQLOnlyStatement 识别只有 InfluxQL 才有的 SHOW 语句：3.x 默认走 SQL，这些语句仍交给 InfluxQL。
func isInfluxQLOnlyStatement(text string) bool {
	fields := strings.Fields(strings.ToUpper(text))
	if len(fields) < 2 || fields[0] != "SHOW" {
		return false
	}
	switch fields[1] {
	case "MEASUREMENTS", "MEASUREMENT", "TAG", "FIELD", "SERIES", "RETENTION", "DATABASES":
		return true
	}
	return false
}

// rewriteInfluxSelect 改写网格生成的简单 SELECT（单个 measurement、无 GROUP BY / fill / INTO 等）：
// WHERE 按 schema 写成带类型的 InfluxQL，ORDER BY 只保留 time，COUNT(*) 去掉分页。
// 用户自己写的复杂语句或解析不了的 WHERE 原样执行。
func (x *InfluxDB) rewriteInfluxSelect(ctx context.Context, text string) (string, bool, error) {
	if !strings.HasPrefix(strings.ToLower(text), "select") {
		return text, false, nil
	}
	projection := sqlSelectProjection(text)
	countStar := isInfluxCountStar(projection)
	for _, keyword := range influxGridUnsafeKeywords {
		if findSQLKeyword(text, keyword, 0) >= 0 {
			return text, countStar, nil
		}
	}
	measurement := parseSQLFromName(text)
	if measurement == "" || strings.Contains(measurement, ".") || influxQualifiedFrom(text) {
		return text, countStar, nil
	}
	schema, err := x.measurementSchema(ctx, x.database, measurement)
	if err != nil {
		return text, countStar, nil
	}
	clauses := splitRegistrySelectClauses(text, 0)
	where := clauses.where
	if where != "" {
		if node, parseErr := parseRegistryWhere(where); parseErr == nil {
			rendered, renderErr := renderInfluxWhere(schema, node)
			if renderErr != nil {
				return "", false, renderErr
			}
			where = rendered
		}
	}
	var b strings.Builder
	b.WriteString("SELECT ")
	b.WriteString(projection)
	b.WriteString(" FROM ")
	b.WriteString(influxQuoteIdent(measurement))
	if where != "" {
		b.WriteString(" WHERE ")
		b.WriteString(where)
	}
	if !countStar {
		if orderBy := influxOrderByTime(clauses.orderBy); orderBy != "" {
			b.WriteString(" ")
			b.WriteString(orderBy)
		}
		if clauses.hasLimit {
			b.WriteString(" LIMIT ")
			b.WriteString(strconv.Itoa(clauses.limit))
		}
		if clauses.offset > 0 {
			b.WriteString(" OFFSET ")
			b.WriteString(strconv.Itoa(clauses.offset))
		}
	}
	return b.String(), countStar, nil
}

// influxQualifiedFrom 报告 FROM 是否带了库或保留策略前缀（如 "autogen"."cpu"），这种写法不改写。
func influxQualifiedFrom(text string) bool {
	fromAt := findSQLKeyword(text, "FROM", 0)
	if fromAt < 0 {
		return false
	}
	i := skipSQLSpaceAndComments(text, fromAt+len("FROM"))
	if i < len(text) && (text[i] == '"' || text[i] == '`') {
		next, ok := skipSQLQuotedLiteral(text, i)
		return ok && next < len(text) && text[next] == '.'
	}
	return false
}

// influxQLRows 把各语句的 series 展开成行：GROUP BY 的 tag 并入每行，多个 measurement 时加 _measurement 列。
func influxQLRows(results []influxQLResult) ([]map[string]interface{}, []string) {
	rows := make([]map[string]interface{}, 0)
	columns := make([]string, 0)
	seen := map[string]bool{}
	addColumn := func(name string) {
		if !seen[name] {
			seen[name] = true
			columns = append(columns, name)
		}
	}
	names := map[string]bool{}
	for _, result := range results {
		for _, series := range result.Series {
			names[series.Name] = true
		}
	}
	multiple := len(names) > 1
	if multiple {
		addColumn("_measurement")
	}
	for _, result := range results {
		for _, series := range result.Series {
			for _, column := range series.Columns {
				addColumn(column)
			}
			tagKeys := make([]string, 0, len(series.Tags))
			for key := range series.Tags {
				tagKeys = append(tagKeys, key)
			}
			sort.Strings(tagKeys)
			for _, key := range tagKeys {
				addColumn(key)
			}
			for _, values := range series.Values {
				row := make(map[string]interface{}, len(series.Columns)+len(series.Tags)+1)
				for index, column := range series.Columns {
					if index < len(values) {
						row[column] = influxValue(values[index])
					}
				}
				for key, value := range series.Tags {
					row[key] = value
				}
				if multiple {
					row["_measurement"] = series.Name
				}
				rows = append(rows, row)
			}
		}
	}
	fillInfluxRows(rows, columns)
	return rows, columns
}

// influxCountTotal 把 InfluxQL 的 COUNT(*)（每个字段一列 count_<字段>）收敛成点数：取各字段计数的最大值，
// 字段齐全的 measurement 就是精确点数。
func influxCountTotal(rows []map[string]interface{}) int64 {
	var total int64
	for _, row := range rows {
		for key, value := range row {
			if !strings.HasPrefix(key, "count") {
				continue
			}
			if count, ok := value.(int64); ok && count > total {
				total = count
			}
		}
	}
	return total
}
