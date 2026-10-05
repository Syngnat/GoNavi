//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

type influxField struct {
	name      string
	fieldType string // float、integer、unsigned、string、boolean
}

type influxMeasurementSchema struct {
	tags     []string
	fields   []influxField
	loadedAt time.Time
}

func (s influxMeasurementSchema) hasTag(name string) bool {
	for _, tag := range s.tags {
		if tag == name {
			return true
		}
	}
	return false
}

func (s influxMeasurementSchema) field(name string) (influxField, bool) {
	for _, field := range s.fields {
		if field.name == name {
			return field, true
		}
	}
	return influxField{}, false
}

// influxQuoteIdent 给 InfluxQL 标识符加双引号。
func influxQuoteIdent(name string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(name, `\`, `\\`), `"`, `\"`) + `"`
}

// influxQuoteString 给 InfluxQL 字符串字面量加单引号。
func influxQuoteString(value string) string {
	return "'" + strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), "'", `\'`) + "'"
}

func newInfluxMetadataContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), defaultInfluxDBQueryTimeout)
}

func (x *InfluxDB) databaseOrDefault(name string) string {
	if trimmed := strings.TrimSpace(name); trimmed != "" {
		return trimmed
	}
	return x.database
}

// influxFirstColumn 取 SHOW 语句结果每行的第一列（库名、measurement 名、tag 名）。
func influxFirstColumn(results []influxQLResult) []string {
	names := make([]string, 0)
	for _, result := range results {
		for _, series := range result.Series {
			for _, row := range series.Values {
				if len(row) > 0 {
					if name, ok := row[0].(string); ok && name != "" {
						names = append(names, name)
					}
				}
			}
		}
	}
	return names
}

// GetDatabases 返回 1.x 的 database、2.x 的 bucket、3.x 的 database。
func (x *InfluxDB) GetDatabases() ([]string, error) {
	ctx, cancel := newInfluxMetadataContext()
	defer cancel()
	switch {
	case x.isV3():
		return x.listV3Databases(ctx)
	case x.isV2():
		if buckets, err := x.listBuckets(ctx, 0); err == nil {
			sort.Strings(buckets)
			return buckets, nil
		}
	}
	results, err := x.influxQL(ctx, "", "SHOW DATABASES", false)
	if err != nil {
		return nil, err
	}
	names := influxFirstColumn(results)
	sort.Strings(names)
	return names, nil
}

func (x *InfluxDB) GetTables(dbName string) ([]string, error) {
	ctx, cancel := newInfluxMetadataContext()
	defer cancel()
	results, err := x.influxQL(ctx, x.databaseOrDefault(dbName), "SHOW MEASUREMENTS", false)
	if err != nil {
		return nil, err
	}
	names := influxFirstColumn(results)
	sort.Strings(names)
	return names, nil
}

// measurementSchema 读取 measurement 的 tag 与字段类型，短时缓存，供列定义、网格筛选与写入共用。
func (x *InfluxDB) measurementSchema(ctx context.Context, database, measurement string) (influxMeasurementSchema, error) {
	key := database + "\x00" + measurement
	x.schemaMu.Lock()
	if cached, ok := x.schemaCache[key]; ok && time.Since(cached.loadedAt) < influxSchemaCacheTTL {
		x.schemaMu.Unlock()
		return cached, nil
	}
	x.schemaMu.Unlock()

	from := " FROM " + influxQuoteIdent(measurement)
	tagResults, err := x.influxQL(ctx, database, "SHOW TAG KEYS"+from, false)
	if err != nil {
		return influxMeasurementSchema{}, err
	}
	fieldResults, err := x.influxQL(ctx, database, "SHOW FIELD KEYS"+from, false)
	if err != nil {
		return influxMeasurementSchema{}, err
	}
	schema := influxMeasurementSchema{tags: influxFirstColumn(tagResults), loadedAt: time.Now()}
	for _, result := range fieldResults {
		for _, series := range result.Series {
			for _, row := range series.Values {
				if len(row) < 2 {
					continue
				}
				name, _ := row[0].(string)
				fieldType, _ := row[1].(string)
				if name != "" {
					schema.fields = append(schema.fields, influxField{name: name, fieldType: fieldType})
				}
			}
		}
	}
	sort.Strings(schema.tags)
	sort.Slice(schema.fields, func(i, j int) bool { return schema.fields[i].name < schema.fields[j].name })

	x.schemaMu.Lock()
	if x.schemaCache == nil {
		x.schemaCache = make(map[string]influxMeasurementSchema)
	}
	x.schemaCache[key] = schema
	x.schemaMu.Unlock()
	return schema, nil
}

func (x *InfluxDB) invalidateSchema() {
	x.schemaMu.Lock()
	x.schemaCache = nil
	x.schemaMu.Unlock()
}

// GetColumns 返回 time、tag 与字段：time 与全部 tag 一起标为主键（点由 series key + 时间确定），网格据此定位要改的点。
func (x *InfluxDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	ctx, cancel := newInfluxMetadataContext()
	defer cancel()
	schema, err := x.measurementSchema(ctx, x.databaseOrDefault(dbName), tableName)
	if err != nil {
		return nil, err
	}
	return influxColumns(schema), nil
}

func influxColumns(schema influxMeasurementSchema) []connection.ColumnDefinition {
	columns := []connection.ColumnDefinition{{Name: influxTimeColumn, Type: "timestamp", Nullable: "NO", Key: "PRI"}}
	for _, tag := range schema.tags {
		columns = append(columns, connection.ColumnDefinition{Name: tag, Type: "tag", Nullable: "YES", Key: "PRI"})
	}
	for _, field := range schema.fields {
		columns = append(columns, connection.ColumnDefinition{Name: field.name, Type: field.fieldType, Nullable: "YES"})
	}
	return columns
}

func (x *InfluxDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := x.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	ctx, cancel := newInfluxMetadataContext()
	defer cancel()
	result := make([]connection.ColumnDefinitionWithTable, 0)
	for _, table := range tables {
		schema, err := x.measurementSchema(ctx, x.databaseOrDefault(dbName), table)
		if err != nil {
			return nil, err
		}
		for _, column := range influxColumns(schema) {
			result = append(result, connection.ColumnDefinitionWithTable{TableName: table, Name: column.Name, Type: column.Type})
		}
	}
	return result, nil
}

// GetIndexes 返回主键（time + tag）与 tag 的 series 索引。
func (x *InfluxDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	ctx, cancel := newInfluxMetadataContext()
	defer cancel()
	schema, err := x.measurementSchema(ctx, x.databaseOrDefault(dbName), tableName)
	if err != nil {
		return nil, err
	}
	indexes := []connection.IndexDefinition{{Name: "PRIMARY", ColumnName: influxTimeColumn, SeqInIndex: 1, IndexType: "SERIES"}}
	for index, tag := range schema.tags {
		indexes = append(indexes, connection.IndexDefinition{Name: "PRIMARY", ColumnName: tag, SeqInIndex: index + 2, IndexType: "SERIES"})
	}
	for _, tag := range schema.tags {
		indexes = append(indexes, connection.IndexDefinition{Name: "tag:" + tag, ColumnName: tag, NonUnique: 1, SeqInIndex: 1, IndexType: "TAG"})
	}
	return indexes, nil
}

// GetCreateStatement 返回 measurement 的结构说明与一行 line protocol 写入模板；1.x 附带保留策略的 DDL。
func (x *InfluxDB) GetCreateStatement(dbName, tableName string) (string, error) {
	ctx, cancel := newInfluxMetadataContext()
	defer cancel()
	database := x.databaseOrDefault(dbName)
	schema, err := x.measurementSchema(ctx, database, tableName)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	if !x.isV2() && !x.isV3() && database != "" {
		fmt.Fprintf(&b, "CREATE DATABASE %s;\n", influxQuoteIdent(database))
		if results, err := x.influxQL(ctx, database, "SHOW RETENTION POLICIES ON "+influxQuoteIdent(database), false); err == nil {
			for _, result := range results {
				for _, series := range result.Series {
					for _, row := range series.Values {
						if policy := influxRetentionPolicyDDL(database, series.Columns, row); policy != "" {
							b.WriteString(policy)
							b.WriteString("\n")
						}
					}
				}
			}
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "-- measurement: %s\n", tableName)
	fmt.Fprintf(&b, "-- tags: %s\n", strings.Join(schema.tags, ", "))
	fieldNames := make([]string, 0, len(schema.fields))
	for _, field := range schema.fields {
		fieldNames = append(fieldNames, field.name+" ("+field.fieldType+")")
	}
	fmt.Fprintf(&b, "-- fields: %s\n", strings.Join(fieldNames, ", "))
	b.WriteString("-- line protocol:\n")
	b.WriteString("INSERT ")
	b.WriteString(influxLineProtocolTemplate(tableName, schema))
	b.WriteString("\n")
	return b.String(), nil
}

func influxRetentionPolicyDDL(database string, columns []string, row []interface{}) string {
	values := map[string]interface{}{}
	for index, column := range columns {
		if index < len(row) {
			values[column] = row[index]
		}
	}
	name, _ := values["name"].(string)
	if name == "" {
		return ""
	}
	ddl := fmt.Sprintf("CREATE RETENTION POLICY %s ON %s DURATION %v REPLICATION %v SHARD DURATION %v",
		influxQuoteIdent(name), influxQuoteIdent(database), values["duration"], values["replicaN"], values["shardGroupDuration"])
	if isDefault, _ := values["default"].(bool); isDefault {
		ddl += " DEFAULT"
	}
	return ddl + ";"
}

func (x *InfluxDB) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (x *InfluxDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}
