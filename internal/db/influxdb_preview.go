//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"context"
	"net/http"

	"GoNavi-Wails/internal/connection"
)

var _ ChangePreviewer = (*InfluxDB)(nil)

// PreviewChanges 按 ApplyChanges 的做法列出控制台可执行的语句（每行一条）：更新与新增写成 INSERT <line protocol>，
// 删除在 1.x 是 InfluxQL DELETE、2.x 是删除接口请求，3.x 及无法生成的改动给出原因。
func (x *InfluxDB) PreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultInfluxDBQueryTimeout)
	defer cancel()
	reason := func(err error) string { return "# " + err.Error() }
	if x.database == "" {
		return []string{reason(localizedDatabaseRuntimeError("db.backend.error.influxdb_database_required", nil))}, nil, nil
	}
	schema, err := x.measurementSchema(ctx, x.database, tableName)
	if err != nil {
		return []string{reason(err)}, nil, nil
	}
	for _, keys := range changes.Deletes {
		timestamp, tags, err := influxPointIdentity(schema, keys)
		if err != nil {
			deletes = append(deletes, reason(err))
			continue
		}
		statement, path, body, err := x.deleteRequest(tableName, schema, timestamp, tags)
		switch {
		case err != nil:
			deletes = append(deletes, reason(err))
		case path != "":
			deletes = append(deletes, formatConsoleRequest(http.MethodPost, path, body))
		default:
			deletes = append(deletes, statement)
		}
	}
	for _, update := range changes.Updates {
		line, err := influxUpdateLine(tableName, schema, update)
		switch {
		case err != nil:
			updates = append(updates, reason(err))
		case line != "":
			updates = append(updates, "INSERT "+line)
		}
	}
	for _, row := range changes.Inserts {
		point, err := influxInsertPoint(tableName, schema, row)
		if err != nil {
			inserts = append(inserts, reason(err))
			continue
		}
		line, err := point.encode()
		if err != nil {
			inserts = append(inserts, reason(err))
			continue
		}
		inserts = append(inserts, "INSERT "+line)
	}
	return deletes, updates, inserts
}
