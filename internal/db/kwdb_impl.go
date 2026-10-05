//go:build gonavi_full_drivers || gonavi_kwdb_driver

package db

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"GoNavi-Wails/internal/connection"
)

var kwdbFlavor = cockroachFlavor{
	registryType:   "kwdb",
	internalSchema: "kwdb_internal",
	uriSchemes:     []string{"kwdb", "kaiwudb"},
	showMetadata:   true,
}

var kwdbPrimaryTagsPattern = regexp.MustCompile(`(?i)PRIMARY\s+TAGS\s*\(([^)]*)\)`)

// KWDB（KaiwuDB）基于 CockroachDB 早期版本，同时提供关系库与时序库（TS DATABASE）。
// 列与索引元数据改用 SHOW COLUMNS / SHOW INDEXES，时序表的 tag 列在列信息里标出。
type KWDB struct {
	CockroachDB
}

var _ Database = (*KWDB)(nil)

func (k *KWDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&k.PostgresDB, ctx)
}

func (k *KWDB) clearMetadataContext() {
	ClearMetadataContext(&k.PostgresDB)
}

// Connect 以 KWDB 风格复用 CockroachDB 连接链路。
func (k *KWDB) Connect(config connection.ConnectionConfig) error {
	flavor := kwdbFlavor
	k.flavor = &flavor
	return k.CockroachDB.Connect(config)
}

func showColumnsQuery(qualified string) string { return "SHOW COLUMNS FROM " + qualified }
func showIndexesQuery(qualified string) string { return "SHOW INDEXES FROM " + qualified }

// GetColumns 读取 SHOW COLUMNS：主键来自 primary 索引，时序表的 tag 列 Extra 标为 TAG / PRIMARY TAG。
func (k *KWDB) GetColumns(schemaName, tableName string) ([]connection.ColumnDefinition, error) {
	qualified, err := k.qualifiedTable(schemaName, tableName)
	if err != nil {
		return nil, err
	}
	rows, _, err := k.PostgresDB.Query(showColumnsQuery(qualified))
	if err != nil {
		return nil, err
	}
	primary := k.primaryKeyColumns(qualified)
	primaryTags := k.primaryTagColumns(schemaName, tableName)
	columns := make([]connection.ColumnDefinition, 0, len(rows))
	for _, row := range rows {
		name := strings.TrimSpace(fmt.Sprint(firstMapValueOf(row, "column_name")))
		column := connection.ColumnDefinition{
			Name:     name,
			Type:     strings.ToLower(strings.TrimSpace(fmt.Sprint(firstMapValueOf(row, "data_type")))),
			Nullable: yesNo(isTruthy(firstMapValueOf(row, "is_nullable"))),
		}
		if _, ok := primary[name]; ok {
			column.Key = "PRI"
		}
		if value := firstMapValueOf(row, "column_default"); value != nil {
			text := fmt.Sprint(value)
			column.Default = &text
			column.HasDefault = true
		}
		if isTruthy(firstMapValueOf(row, "is_tag")) {
			column.Extra = "TAG"
			if _, ok := primaryTags[strings.ToLower(name)]; ok {
				column.Extra = "PRIMARY TAG"
			}
		}
		columns = append(columns, column)
	}
	return columns, nil
}

func (k *KWDB) primaryKeyColumns(qualified string) map[string]struct{} {
	result := map[string]struct{}{}
	rows, _, err := k.PostgresDB.Query(showIndexesQuery(qualified))
	if err != nil {
		return result
	}
	for _, row := range rows {
		index := strings.ToLower(fmt.Sprint(firstMapValueOf(row, "index_name")))
		if (index == "primary" || strings.HasSuffix(index, "_pkey")) && !isTruthy(firstMapValueOf(row, "implicit")) {
			result[fmt.Sprint(firstMapValueOf(row, "column_name"))] = struct{}{}
		}
	}
	return result
}

func (k *KWDB) primaryTagColumns(schemaName, tableName string) map[string]struct{} {
	result := map[string]struct{}{}
	ddl, err := k.GetCreateStatement(schemaName, tableName)
	if err != nil {
		return result
	}
	match := kwdbPrimaryTagsPattern.FindStringSubmatch(ddl)
	if len(match) < 2 {
		return result
	}
	for _, name := range strings.Split(match[1], ",") {
		result[strings.ToLower(strings.Trim(strings.TrimSpace(name), `"`))] = struct{}{}
	}
	return result
}

// GetIndexes 读取 SHOW INDEXES，跳过为二级索引隐式存储的主键列。
func (k *KWDB) GetIndexes(schemaName, tableName string) ([]connection.IndexDefinition, error) {
	qualified, err := k.qualifiedTable(schemaName, tableName)
	if err != nil {
		return nil, err
	}
	rows, _, err := k.PostgresDB.Query(showIndexesQuery(qualified))
	if err != nil {
		return nil, err
	}
	indexes := make([]connection.IndexDefinition, 0, len(rows))
	for _, row := range rows {
		if isTruthy(firstMapValueOf(row, "implicit")) {
			continue
		}
		nonUnique := 0
		if isTruthy(firstMapValueOf(row, "non_unique")) {
			nonUnique = 1
		}
		seq := 0
		_, _ = fmt.Sscan(fmt.Sprint(firstMapValueOf(row, "seq_in_index")), &seq)
		indexes = append(indexes, connection.IndexDefinition{
			Name:       fmt.Sprint(firstMapValueOf(row, "index_name")),
			ColumnName: fmt.Sprint(firstMapValueOf(row, "column_name")),
			NonUnique:  nonUnique,
			SeqInIndex: seq,
			IndexType:  "BTREE",
		})
	}
	return indexes, nil
}

// ApplyChangesContext 拒绝修改时序表：KWDB 时序表只能追加写入，按行更新/删除会被服务端拒绝。
func (k *KWDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if k.isTimeSeriesTable(tableName) && (len(changes.Updates) > 0 || len(changes.Deletes) > 0) {
		return localizedDatabaseRuntimeError("db.backend.error.kwdb_timeseries_row_edit_unsupported", nil)
	}
	return k.PostgresDB.ApplyChangesContext(ctx, tableName, changes)
}

// ApplyChanges 与 ApplyChangesContext 保持同样的时序表保护。
func (k *KWDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return k.ApplyChangesContext(context.Background(), tableName, changes)
}

func (k *KWDB) isTimeSeriesTable(tableName string) bool {
	schema, table := normalizePGLikeMetadataTable("", tableName)
	if schema == "" {
		schema = "public"
	}
	query := fmt.Sprintf(
		"SELECT table_type FROM information_schema.tables WHERE table_schema = '%s' AND table_name = '%s'",
		strings.ReplaceAll(schema, "'", "''"), strings.ReplaceAll(table, "'", "''"),
	)
	rows, _, err := k.PostgresDB.Query(query)
	if err != nil || len(rows) == 0 {
		return false
	}
	return strings.Contains(strings.ToUpper(fmt.Sprint(firstMapValueOf(rows[0], "table_type"))), "TIME SERIES")
}
