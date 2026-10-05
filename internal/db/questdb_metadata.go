//go:build gonavi_full_drivers || gonavi_questdb_driver

package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// questDBColumn 是 SHOW COLUMNS / table_columns() 的一行：除类型外还带 SYMBOL 索引、
// 指定时间戳（designated）与去重键（upsertKey）等 QuestDB 特有属性。
type questDBColumn struct {
	name           string
	typeName       string
	indexed        bool
	indexCapacity  string
	indexType      string
	symbolCached   bool
	symbolCapacity string
	designated     bool
	upsertKey      bool
}

func (q *QuestDB) showColumns(tableName string) ([]questDBColumn, error) {
	rows, _, err := q.PostgresDB.Query("SHOW COLUMNS FROM " + quoteQuestDBIdentifier(tableName))
	if err != nil {
		return nil, err
	}
	columns := make([]questDBColumn, 0, len(rows))
	for _, row := range rows {
		name := rowText(row, "column", "column_name")
		if name == "" {
			continue
		}
		columns = append(columns, questDBColumn{
			name:           name,
			typeName:       rowText(row, "type"),
			indexed:        isTruthy(firstMapValueOf(row, "indexed")),
			indexCapacity:  rowText(row, "indexBlockCapacity"),
			indexType:      rowText(row, "indexType"),
			symbolCached:   isTruthy(firstMapValueOf(row, "symbolCached")),
			symbolCapacity: rowText(row, "symbolCapacity"),
			designated:     isTruthy(firstMapValueOf(row, "designated")),
			upsertKey:      isTruthy(firstMapValueOf(row, "upsertKey")),
		})
	}
	return columns, nil
}

// GetColumns 读取 SHOW COLUMNS。QuestDB 没有 NOT NULL 与主键，指定时间戳、去重键和 SYMBOL 索引写进 Extra。
func (q *QuestDB) GetColumns(_ string, tableName string) ([]connection.ColumnDefinition, error) {
	columns, err := q.showColumns(tableName)
	if err != nil {
		return nil, err
	}
	result := make([]connection.ColumnDefinition, 0, len(columns))
	for _, column := range columns {
		extras := make([]string, 0, 3)
		if column.designated {
			extras = append(extras, "DESIGNATED TIMESTAMP")
		}
		if column.upsertKey {
			extras = append(extras, "UPSERT KEY")
		}
		if column.indexed {
			extras = append(extras, "INDEXED")
		}
		result = append(result, connection.ColumnDefinition{
			Name:     column.name,
			Type:     column.typeName,
			Nullable: yesNo(true),
			Extra:    strings.Join(extras, ", "),
		})
	}
	return result, nil
}

// GetIndexes 把带索引的 SYMBOL 列映射为单列非唯一索引（QuestDB 的索引没有独立名字，以列名命名）。
func (q *QuestDB) GetIndexes(_ string, tableName string) ([]connection.IndexDefinition, error) {
	columns, err := q.showColumns(tableName)
	if err != nil {
		return nil, err
	}
	indexes := make([]connection.IndexDefinition, 0)
	for _, column := range columns {
		if !column.indexed {
			continue
		}
		indexType := strings.ToUpper(column.indexType)
		if indexType == "" {
			indexType = "BITMAP"
		}
		indexes = append(indexes, connection.IndexDefinition{
			Name:       column.name,
			ColumnName: column.name,
			NonUnique:  1,
			SeqInIndex: 1,
			IndexType:  indexType,
		})
	}
	return indexes, nil
}

// GetAllColumns 逐表读取列（补全用）；单表失败时跳过，不影响其他表。
func (q *QuestDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := q.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	result := make([]connection.ColumnDefinitionWithTable, 0)
	for _, table := range tables {
		columns, err := q.showColumns(table)
		if err != nil {
			logger.Warnf("QuestDB 读取表 %s 的列失败，跳过：%v", table, err)
			continue
		}
		for _, column := range columns {
			result = append(result, connection.ColumnDefinitionWithTable{TableName: table, Name: column.name, Type: column.typeName})
		}
	}
	return result, nil
}

// GetCreateStatement 视图与物化视图用各自的 SHOW CREATE；普通表 8.0 起用 SHOW CREATE TABLE，
// 更早版本（或该语句失败时）按 tables() 与 SHOW COLUMNS 合成等价 DDL。
func (q *QuestDB) GetCreateStatement(_ string, tableName string) (string, error) {
	name := strings.TrimSpace(tableName)
	switch q.objectKind(name) {
	case questDBView:
		return q.showCreate("SHOW CREATE VIEW " + quoteQuestDBIdentifier(name))
	case questDBMaterializedView:
		return q.showCreate("SHOW CREATE MATERIALIZED VIEW " + quoteQuestDBIdentifier(name))
	}
	if q.atLeast("8.0") {
		ddl, err := q.showCreate("SHOW CREATE TABLE " + quoteQuestDBIdentifier(name))
		if err == nil {
			return ddl, nil
		}
		logger.Warnf("QuestDB SHOW CREATE TABLE 失败，改为合成 DDL：%v", err)
	}
	return q.synthesizeCreateTable(name)
}

func (q *QuestDB) showCreate(statement string) (string, error) {
	rows, _, err := q.PostgresDB.Query(statement)
	if err != nil {
		return "", err
	}
	ddl := strings.TrimSpace(FirstQueryRowValue(rows))
	if ddl == "" {
		return "", fmt.Errorf("%s returned no DDL", statement)
	}
	return ddl, nil
}

// questDBTableInfo 是 tables() 里与建表语句相关的几列。
type questDBTableInfo struct {
	designatedTimestamp string
	partitionBy         string
	walEnabled          bool
	dedup               bool
}

func (q *QuestDB) tableInfo(tableName string) questDBTableInfo {
	rows, _, err := q.PostgresDB.Query("SELECT * FROM tables() WHERE table_name = " + quoteQuestDBLiteral(tableName))
	if err != nil || len(rows) == 0 {
		return questDBTableInfo{}
	}
	row := rows[0]
	return questDBTableInfo{
		designatedTimestamp: rowText(row, "designatedTimestamp"),
		partitionBy:         rowText(row, "partitionBy"),
		walEnabled:          isTruthy(firstMapValueOf(row, "walEnabled")),
		dedup:               isTruthy(firstMapValueOf(row, "dedup")),
	}
}

func (q *QuestDB) synthesizeCreateTable(tableName string) (string, error) {
	columns, err := q.showColumns(tableName)
	if err != nil {
		return "", err
	}
	return buildQuestDBCreateTable(tableName, q.tableInfo(tableName), columns), nil
}

// buildQuestDBCreateTable 按 QuestDB 语法拼出建表语句，格式与 8.x 的 SHOW CREATE TABLE 一致。
func buildQuestDBCreateTable(tableName string, info questDBTableInfo, columns []questDBColumn) string {
	definitions := make([]string, 0, len(columns))
	upsertKeys := make([]string, 0)
	for _, column := range columns {
		definition := column.name + " " + column.typeName
		if strings.EqualFold(column.typeName, "SYMBOL") {
			if column.symbolCapacity != "" && column.symbolCapacity != "0" {
				definition += " CAPACITY " + column.symbolCapacity
			}
			if column.symbolCached {
				definition += " CACHE"
			} else {
				definition += " NOCACHE"
			}
			if column.indexed {
				definition += " INDEX"
				if column.indexCapacity != "" && column.indexCapacity != "0" {
					definition += " CAPACITY " + column.indexCapacity
				}
			}
		}
		definitions = append(definitions, "\t"+definition)
		if column.upsertKey {
			upsertKeys = append(upsertKeys, column.name)
		}
	}
	var builder strings.Builder
	builder.WriteString("CREATE TABLE " + quoteQuestDBLiteral(tableName) + " (\n")
	builder.WriteString(strings.Join(definitions, ",\n"))
	builder.WriteString("\n)")
	if info.designatedTimestamp != "" {
		builder.WriteString(" timestamp(" + info.designatedTimestamp + ")")
	}
	if partition := strings.ToUpper(info.partitionBy); partition != "" && partition != "NONE" && partition != "N/A" {
		builder.WriteString(" PARTITION BY " + partition)
		if info.walEnabled {
			builder.WriteString(" WAL")
		} else {
			builder.WriteString(" BYPASS WAL")
		}
	}
	if info.dedup && len(upsertKeys) > 0 {
		builder.WriteString("\nDEDUP UPSERT KEYS(" + strings.Join(upsertKeys, ", ") + ")")
	}
	builder.WriteString(";")
	return builder.String()
}
