//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

func (x *InfluxDB) Exec(query string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultInfluxDBQueryTimeout)
	defer cancel()
	return x.ExecContext(ctx, query)
}

// ExecContext 执行写入：INSERT <line protocol>（与 influx CLI 相同，三个大版本通用）、Flux 的 to()、
// 1.x 的 InfluxQL 管理语句，以及 3.x 的 CREATE / DROP DATABASE 与 DROP MEASUREMENT（映射到配置接口）。
func (x *InfluxDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if x.client == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	text := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	defer x.invalidateSchema()
	if strings.HasPrefix(strings.ToUpper(text), "INSERT") {
		retention, lines := parseInfluxInsert(text)
		if err := x.writeLines(ctx, x.database, retention, lines); err != nil {
			return 0, err
		}
		return int64(len(lines)), nil
	}
	if IsInfluxFluxQuery(text) {
		rows, _, err := x.QueryContext(ctx, text)
		return int64(len(rows)), err
	}
	if x.isV3() {
		return x.execV3Management(ctx, text)
	}
	if _, err := x.influxQL(ctx, x.database, text, true); err != nil {
		return 0, influxWriteError(err)
	}
	return 0, nil
}

// parseInfluxInsert 解析 INSERT [INTO <保留策略>] <line protocol>，多行时每行一个点（后续行可省略 INSERT）。
func parseInfluxInsert(text string) (string, []string) {
	retention := ""
	lines := make([]string, 0, 1)
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		upper := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(upper, "INSERT INTO "):
			rest := strings.TrimSpace(line[len("INSERT INTO "):])
			if name, point, ok := strings.Cut(rest, " "); ok {
				retention = strings.Trim(name, `"`)
				line = strings.TrimSpace(point)
			}
		case strings.HasPrefix(upper, "INSERT "):
			line = strings.TrimSpace(line[len("INSERT "):])
		}
		if line != "" {
			lines = append(lines, line)
		}
	}
	return retention, lines
}

// writeLines 按版本选写入接口：1.x /write，2.x /api/v2/write（需要 org），3.x /api/v3/write_lp。
func (x *InfluxDB) writeLines(ctx context.Context, database, retention string, lines []string) error {
	if len(lines) == 0 {
		return nil
	}
	if database == "" {
		return localizedDatabaseRuntimeError("db.backend.error.influxdb_database_required", nil)
	}
	var path string
	switch {
	case x.isV3():
		path = "/api/v3/write_lp?" + url.Values{"db": {database}, "precision": {"nanosecond"}}.Encode()
	case x.isV2():
		if x.org == "" {
			return localizedDatabaseRuntimeError("db.backend.error.influxdb_org_required", nil)
		}
		path = "/api/v2/write?" + url.Values{"org": {x.org}, "bucket": {database}, "precision": {"ns"}}.Encode()
	default:
		values := url.Values{"db": {database}, "precision": {"ns"}}
		if retention != "" {
			values.Set("rp", retention)
		}
		path = "/write?" + values.Encode()
	}
	plain := "text/plain; charset=utf-8"
	status, _, body, err := x.request(ctx, http.MethodPost, path, &plain, []byte(strings.Join(lines, "\n")))
	if err != nil {
		return MarkWriteOutcomeUnknown(err)
	}
	if status < 200 || status >= 300 {
		return x.httpError(http.MethodPost, path, status, body)
	}
	return nil
}

// execV3Management 把 3.x 不支持的 SQL 写语句里常用的几条映射到配置接口；其余提示用 INSERT 写入。
func (x *InfluxDB) execV3Management(ctx context.Context, text string) (int64, error) {
	fields := strings.Fields(text)
	unquote := func(value string) string { return strings.Trim(value, "\"`") }
	if len(fields) == 3 {
		verb, object, name := strings.ToUpper(fields[0]), strings.ToUpper(fields[1]), unquote(fields[2])
		switch {
		case verb == "CREATE" && object == "DATABASE":
			return 1, influxWriteError(x.doJSON(ctx, http.MethodPost, "/api/v3/configure/database", map[string]string{"db": name}, nil))
		case verb == "DROP" && object == "DATABASE":
			return 1, influxWriteError(x.doJSON(ctx, http.MethodDelete, "/api/v3/configure/database?"+url.Values{"db": {name}}.Encode(), nil, nil))
		case verb == "DROP" && (object == "MEASUREMENT" || object == "TABLE"):
			if x.database == "" {
				return 0, localizedDatabaseRuntimeError("db.backend.error.influxdb_database_required", nil)
			}
			return 1, influxWriteError(x.doJSON(ctx, http.MethodDelete, "/api/v3/configure/table?"+url.Values{"db": {x.database}, "table": {name}}.Encode(), nil, nil))
		}
	}
	return 0, localizedDatabaseRuntimeError("db.backend.error.influxdb_statement_unsupported", nil)
}

// influxWriteError 区分服务端拒绝与传输失败：后者请求可能已经生效，标记为结果未知。
func influxWriteError(err error) error {
	if err == nil {
		return nil
	}
	var httpErr *influxHTTPError
	if errors.As(err, &httpErr) || errors.Is(err, context.Canceled) || IsWriteOutcomeUnknown(err) {
		return err
	}
	return MarkWriteOutcomeUnknown(err)
}

func (x *InfluxDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return x.ApplyChangesContext(context.Background(), tableName, changes)
}

// ApplyChangesContext 提交数据网格改动。点由 series key（measurement + tag）与时间确定：
// 更新是在同一 series 同一时间写入新的字段值（未改的字段保留），新增是写入新点，删除按版本走 DELETE 语句或删除接口。
// 改 tag 或时间等于换一个点，需删除后新增；字段不能清空为 NULL。InfluxDB 没有事务，中途失败时报告已生效条数。
func (x *InfluxDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if x.client == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	if x.database == "" {
		return localizedDatabaseRuntimeError("db.backend.error.influxdb_database_required", nil)
	}
	ctx, cancel := context.WithTimeout(ctx, defaultInfluxDBQueryTimeout)
	defer cancel()
	schema, err := x.measurementSchema(ctx, x.database, tableName)
	if err != nil {
		return err
	}
	defer x.invalidateSchema()

	total := len(changes.Deletes) + len(changes.Updates) + len(changes.Inserts)
	applied := 0
	fail := func(err error) error {
		if applied == 0 {
			return err
		}
		wrapped := localizedDatabaseRuntimeError("db.backend.error.influxdb_changes_partial", map[string]any{"applied": applied, "total": total, "detail": err.Error()})
		if IsWriteOutcomeUnknown(err) {
			return MarkWriteOutcomeUnknown(wrapped)
		}
		return wrapped
	}

	for _, keys := range changes.Deletes {
		timestamp, tags, err := influxPointIdentity(schema, keys)
		if err != nil {
			return fail(err)
		}
		if err := x.deletePoint(ctx, tableName, schema, timestamp, tags); err != nil {
			return fail(err)
		}
		applied++
	}

	lines := make([]string, 0, len(changes.Updates)+len(changes.Inserts))
	for _, update := range changes.Updates {
		line, err := influxUpdateLine(tableName, schema, update)
		if err != nil {
			return fail(err)
		}
		if line != "" {
			lines = append(lines, line)
		}
	}
	for _, row := range changes.Inserts {
		point, err := influxInsertPoint(tableName, schema, row)
		if err != nil {
			return fail(err)
		}
		line, err := point.encode()
		if err != nil {
			return fail(err)
		}
		lines = append(lines, line)
	}
	if err := x.writeLines(ctx, x.database, "", lines); err != nil {
		return fail(err)
	}
	return nil
}

// influxUpdateLine 把一行更新写成 line protocol：同一 series 同一时间写入新的字段值；没有字段改动时返回空串。
// 改 tag 或时间等于换一个点，字段也不能清空为 NULL，这两种改动直接报错。
func influxUpdateLine(measurement string, schema influxMeasurementSchema, update connection.UpdateRow) (string, error) {
	timestamp, tags, err := influxPointIdentity(schema, update.Keys)
	if err != nil {
		return "", err
	}
	point := influxPoint{measurement: measurement, tags: tags, fields: map[string]interface{}{}, fieldTypes: map[string]string{}, timestamp: &timestamp}
	for name, value := range update.Values {
		if strings.EqualFold(name, influxTimeColumn) || schema.hasTag(name) {
			return "", localizedDatabaseRuntimeError("db.backend.error.influxdb_identity_change_unsupported", map[string]any{"column": name})
		}
		if value == nil {
			return "", localizedDatabaseRuntimeError("db.backend.error.influxdb_field_clear_unsupported", map[string]any{"field": name})
		}
		converted, fieldType, err := influxCoerceField(name, schema, value)
		if err != nil {
			return "", err
		}
		point.fields[name], point.fieldTypes[name] = converted, fieldType
	}
	if len(point.fields) == 0 {
		return "", nil
	}
	return point.encode()
}

// influxPointIdentity 从主键取出时间与全部 tag（没有值的 tag 记为空串，表示该点不带这个 tag）。
func influxPointIdentity(schema influxMeasurementSchema, keys map[string]interface{}) (int64, map[string]string, error) {
	timestamp, err := influxParseTimestamp(keys[influxTimeColumn])
	if err != nil {
		return 0, nil, err
	}
	if timestamp == nil {
		return 0, nil, localizedDatabaseRuntimeError("db.backend.error.influxdb_time_required", nil)
	}
	tags := make(map[string]string, len(schema.tags))
	for _, tag := range schema.tags {
		if value, ok := keys[tag]; ok && value != nil {
			tags[tag] = fmt.Sprint(value)
		} else {
			tags[tag] = ""
		}
	}
	return *timestamp, tags, nil
}

func influxInsertPoint(measurement string, schema influxMeasurementSchema, row map[string]interface{}) (influxPoint, error) {
	point := influxPoint{measurement: measurement, tags: map[string]string{}, fields: map[string]interface{}{}, fieldTypes: map[string]string{}}
	timestamp, err := influxParseTimestamp(row[influxTimeColumn])
	if err != nil {
		return point, err
	}
	point.timestamp = timestamp
	for name, value := range row {
		if strings.EqualFold(name, influxTimeColumn) || value == nil {
			continue
		}
		if schema.hasTag(name) {
			if text := strings.TrimSpace(fmt.Sprint(value)); text != "" {
				point.tags[name] = text
			}
			continue
		}
		converted, fieldType, err := influxCoerceField(name, schema, value)
		if err != nil {
			return point, err
		}
		point.fields[name], point.fieldTypes[name] = converted, fieldType
	}
	return point, nil
}

// deletePoint 删除一个点（请求见 deleteRequest）。
func (x *InfluxDB) deletePoint(ctx context.Context, measurement string, schema influxMeasurementSchema, timestamp int64, tags map[string]string) error {
	statement, path, body, err := x.deleteRequest(measurement, schema, timestamp, tags)
	if err != nil {
		return err
	}
	if path != "" {
		return influxWriteError(x.doJSON(ctx, http.MethodPost, path, body, nil))
	}
	_, err = x.influxQL(ctx, x.database, statement, true)
	return influxWriteError(err)
}

// deleteRequest 生成删除一个点的请求：1.x 是 InfluxQL DELETE（tag 全部写明，空串匹配不带该 tag 的 series），
// 2.x 是 /api/v2/delete 的路径与请求体（谓词无法表达“不带某 tag”，有空 tag 时拒绝以免误删其他 series），
// 3.x 不支持按点删除。
func (x *InfluxDB) deleteRequest(measurement string, schema influxMeasurementSchema, timestamp int64, tags map[string]string) (string, string, map[string]string, error) {
	switch {
	case x.isV3():
		return "", "", nil, localizedDatabaseRuntimeError("db.backend.error.influxdb_delete_unsupported", nil)
	case x.isV2():
		if x.org == "" {
			return "", "", nil, localizedDatabaseRuntimeError("db.backend.error.influxdb_org_required", nil)
		}
		predicate := []string{`_measurement="` + influxPredicateEscape(measurement) + `"`}
		empty := make([]string, 0)
		for _, tag := range schema.tags {
			if tags[tag] == "" {
				empty = append(empty, tag)
				continue
			}
			predicate = append(predicate, tag+`="`+influxPredicateEscape(tags[tag])+`"`)
		}
		if len(empty) > 0 {
			return "", "", nil, localizedDatabaseRuntimeError("db.backend.error.influxdb_delete_ambiguous", map[string]any{"tags": strings.Join(empty, ", ")})
		}
		start := time.Unix(0, timestamp).UTC()
		body := map[string]string{
			"start":     start.Format(time.RFC3339Nano),
			"stop":      start.Add(time.Nanosecond).Format(time.RFC3339Nano),
			"predicate": strings.Join(predicate, " AND "),
		}
		return "", "/api/v2/delete?" + url.Values{"org": {x.org}, "bucket": {x.database}}.Encode(), body, nil
	}
	conditions := make([]string, 0, len(schema.tags)+1)
	tagNames := append([]string(nil), schema.tags...)
	sort.Strings(tagNames)
	for _, tag := range tagNames {
		conditions = append(conditions, influxQuoteIdent(tag)+" = "+influxQuoteString(tags[tag]))
	}
	conditions = append(conditions, fmt.Sprintf("time = %d", timestamp))
	return "DELETE FROM " + influxQuoteIdent(measurement) + " WHERE " + strings.Join(conditions, " AND "), "", nil, nil
}

func influxPredicateEscape(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), `"`, `\"`)
}
