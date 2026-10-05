//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// GBase 8s 的元数据来自当前库的系统目录（systables、syscolumns、sysindexes、sysconstraints……）。
// 用户对象的 tabid 从内部表 " VERSION" 之后开始（GBase 8s 是 1000，Informix 早期版本是 100），
// 之前的都是系统目录与 GBase 自带的 Oracle 兼容视图（user_*、dba_*、v$*、dual 等）。

// gbase8sSystemDatabases 是服务端内部库，不在导航树里展示。
var gbase8sSystemDatabases = map[string]struct{}{"sysmaster": {}, "sysutils": {}, "sysuser": {}, "sysadmin": {}, "sys": {}}

func (g *GBase8sDB) GetDatabases() ([]string, error) {
	rows, _, err := g.Query("SELECT TRIM(name) AS name FROM sysmaster:sysdatabases ORDER BY name")
	if err != nil {
		return nil, err
	}
	databases := make([]string, 0, len(rows))
	for _, row := range rows {
		name := gbase8sText(row["name"])
		if _, hidden := gbase8sSystemDatabases[strings.ToLower(name)]; !hidden && name != "" {
			databases = append(databases, name)
		}
	}
	return databases, nil
}

// catalog 返回系统目录表名；查询的库不是当前连接的库时用 "库:表" 跨库引用。
func (g *GBase8sDB) catalog(dbName, table string) string {
	db := strings.TrimSpace(dbName)
	if db == "" || strings.EqualFold(db, g.database) || !gbase8sSimpleIdentPattern.MatchString(strings.ToLower(db)) {
		return table
	}
	return strings.ToLower(db) + ":" + table
}

// userTabidFloor 返回用户对象的最小 tabid。
func (g *GBase8sDB) userTabidFloor(dbName string) int {
	rows, _, err := g.Query("SELECT tabid FROM " + g.catalog(dbName, "systables") + " WHERE tabname = ' VERSION'")
	if err == nil && len(rows) > 0 {
		if tabid := gbase8sInt(rows[0]["tabid"]); tabid > 0 {
			return tabid + 1
		}
	}
	return 100
}

func (g *GBase8sDB) GetTables(dbName string) ([]string, error) {
	query := fmt.Sprintf("SELECT TRIM(tabname) AS tabname FROM %s WHERE tabtype = 'T' AND tabid >= %d ORDER BY tabname",
		g.catalog(dbName, "systables"), g.userTabidFloor(dbName))
	rows, _, err := g.Query(query)
	if err != nil {
		return nil, err
	}
	tables := make([]string, 0, len(rows))
	for _, row := range rows {
		if name := gbase8sText(row["tabname"]); name != "" {
			tables = append(tables, name)
		}
	}
	return tables, nil
}

// loadColumns 读取列定义、默认值与列注释（老版本没有 syscolcomments 时不带注释重试）。
func (g *GBase8sDB) loadColumns(dbName, table string) ([]gbase8sColumnInfo, error) {
	query := fmt.Sprintf(`SELECT c.colno, TRIM(c.colname) AS colname, c.coltype, c.collength, c.extended_id, TRIM(x.name) AS xname,
	d.type AS deftype, d.default AS defval%%s
FROM %[1]s t
JOIN %[2]s c ON c.tabid = t.tabid
LEFT OUTER JOIN %[3]s x ON x.extended_id = c.extended_id AND c.extended_id > 0
LEFT OUTER JOIN %[4]s d ON d.tabid = c.tabid AND d.colno = c.colno%%s
WHERE t.tabname = %[5]s
ORDER BY c.colno`, g.catalog(dbName, "systables"), g.catalog(dbName, "syscolumns"), g.catalog(dbName, "sysxtdtypes"),
		g.catalog(dbName, "sysdefaults"), gbase8sLiteral(table))
	withComments := fmt.Sprintf(query, ", cc.comments AS comments",
		fmt.Sprintf("\nLEFT OUTER JOIN %s cc ON cc.tabname = t.tabname AND cc.colname = c.colname", g.catalog(dbName, "syscolcomments")))
	rows, _, err := g.Query(withComments)
	if err != nil {
		if rows, _, err = g.Query(fmt.Sprintf(query, "", "")); err != nil {
			return nil, err
		}
	}
	columns := make([]gbase8sColumnInfo, 0, len(rows))
	for _, row := range rows {
		columns = append(columns, gbase8sColumnInfo{
			no:         gbase8sInt(row["colno"]),
			name:       gbase8sText(row["colname"]),
			coltype:    gbase8sInt(row["coltype"]),
			collength:  gbase8sInt(row["collength"]),
			extendedID: gbase8sInt(row["extended_id"]),
			xtdName:    gbase8sText(row["xname"]),
			defType:    gbase8sText(row["deftype"]),
			defValue:   gbase8sRawText(row["defval"]),
			comment:    gbase8sText(row["comments"]),
		})
	}
	return columns, nil
}

func (g *GBase8sDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	columns, err := g.loadColumns(dbName, tableName)
	if err != nil {
		return nil, err
	}
	keys, err := g.constraintColumns(dbName, tableName, "P")
	if err != nil {
		return nil, err
	}
	primary := map[int]bool{}
	for _, key := range keys {
		for _, colno := range key.columns {
			primary[gbase8sAbs(colno)] = true
		}
	}
	definitions := make([]connection.ColumnDefinition, 0, len(columns))
	for _, column := range columns {
		definition := connection.ColumnDefinition{
			Name:     column.name,
			Type:     column.typeName(),
			Nullable: "YES",
			Comment:  column.comment,
		}
		if column.notNull() {
			definition.Nullable = "NO"
		}
		if primary[column.no] {
			definition.Key = "PRI"
		}
		if column.isSerial() {
			definition.Extra = "auto_increment"
		}
		if clause, ok := column.defaultClause(); ok {
			definition.Default = &clause
			definition.HasDefault = true
		}
		definitions = append(definitions, definition)
	}
	return definitions, nil
}

func (g *GBase8sDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := fmt.Sprintf(`SELECT TRIM(t.tabname) AS tabname, TRIM(c.colname) AS colname, c.coltype, c.collength, TRIM(x.name) AS xname
FROM %s t
JOIN %s c ON c.tabid = t.tabid
LEFT OUTER JOIN %s x ON x.extended_id = c.extended_id AND c.extended_id > 0
WHERE t.tabtype IN ('T', 'V') AND t.tabid >= %d
ORDER BY t.tabname, c.colno`, g.catalog(dbName, "systables"), g.catalog(dbName, "syscolumns"), g.catalog(dbName, "sysxtdtypes"), g.userTabidFloor(dbName))
	rows, _, err := g.Query(query)
	if err != nil {
		return nil, err
	}
	columns := make([]connection.ColumnDefinitionWithTable, 0, len(rows))
	for _, row := range rows {
		info := gbase8sColumnInfo{coltype: gbase8sInt(row["coltype"]), collength: gbase8sInt(row["collength"]), xtdName: gbase8sText(row["xname"])}
		columns = append(columns, connection.ColumnDefinitionWithTable{
			TableName: gbase8sText(row["tabname"]),
			Name:      gbase8sText(row["colname"]),
			Type:      info.typeName(),
		})
	}
	return columns, nil
}

// gbase8sIndexInfo 是 sysindexes 的一行：part1..part16 是列号，负数表示降序。
type gbase8sIndexInfo struct {
	name       string
	unique     bool
	constraint string
	kind       string
	columns    []int
}

// gbase8sPartList 生成 alias.part1 .. alias.part16 的选择列；prefix 非空时起别名 prefix1..prefix16。
func gbase8sPartList(alias, prefix string) string {
	parts := make([]string, 16)
	for i := range parts {
		parts[i] = fmt.Sprintf("%s.part%d", alias, i+1)
		if prefix != "" {
			parts[i] += fmt.Sprintf(" AS %s%d", prefix, i+1)
		}
	}
	return strings.Join(parts, ", ")
}

var gbase8sIndexParts = gbase8sPartList("i", "")

func gbase8sIndexColumns(row map[string]interface{}) []int {
	var columns []int
	for part := 1; part <= 16; part++ {
		if colno := gbase8sInt(row["part"+strconv.Itoa(part)]); colno != 0 {
			columns = append(columns, colno)
		}
	}
	return columns
}

// loadIndexes 读取表上的索引及其所属约束（主键、唯一、外键约束各自有一个以空格开头命名的索引）。
func (g *GBase8sDB) loadIndexes(dbName, table string) ([]gbase8sIndexInfo, error) {
	query := fmt.Sprintf(`SELECT TRIM(i.idxname) AS idxname, i.idxtype, %s, TRIM(k.constrname) AS constrname, k.constrtype
FROM %s t
JOIN %s i ON i.tabid = t.tabid
LEFT OUTER JOIN %s k ON k.tabid = i.tabid AND k.idxname = i.idxname
WHERE t.tabname = %s
ORDER BY i.idxname`, gbase8sIndexParts, g.catalog(dbName, "systables"), g.catalog(dbName, "sysindexes"), g.catalog(dbName, "sysconstraints"), gbase8sLiteral(table))
	rows, _, err := g.Query(query)
	if err != nil {
		return nil, err
	}
	indexes := make([]gbase8sIndexInfo, 0, len(rows))
	for _, row := range rows {
		indexes = append(indexes, gbase8sIndexInfo{
			name:       gbase8sText(row["idxname"]),
			unique:     strings.EqualFold(gbase8sText(row["idxtype"]), "U"),
			constraint: gbase8sText(row["constrname"]),
			kind:       strings.ToUpper(gbase8sText(row["constrtype"])),
			columns:    gbase8sIndexColumns(row),
		})
	}
	return indexes, nil
}

// constraintColumns 返回某类约束（P 主键 / U 唯一）及其列号。
func (g *GBase8sDB) constraintColumns(dbName, table, kind string) ([]gbase8sIndexInfo, error) {
	indexes, err := g.loadIndexes(dbName, table)
	if err != nil {
		return nil, err
	}
	var result []gbase8sIndexInfo
	for _, index := range indexes {
		if index.kind == kind {
			result = append(result, index)
		}
	}
	return result, nil
}

func gbase8sColumnNames(columns []gbase8sColumnInfo) map[int]string {
	names := make(map[int]string, len(columns))
	for _, column := range columns {
		names[column.no] = column.name
	}
	return names
}

// GetIndexes 列出普通索引与主键 / 唯一约束（约束用约束名展示）；外键约束自带的索引不单独列出。
func (g *GBase8sDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	columns, err := g.loadColumns(dbName, tableName)
	if err != nil {
		return nil, err
	}
	indexes, err := g.loadIndexes(dbName, tableName)
	if err != nil {
		return nil, err
	}
	names := gbase8sColumnNames(columns)
	var definitions []connection.IndexDefinition
	for _, index := range indexes {
		if index.kind == "R" {
			continue
		}
		name := index.name
		if index.constraint != "" {
			name = index.constraint
		}
		if index.kind == "P" {
			name = "PRIMARY"
		}
		nonUnique := 1
		if index.unique {
			nonUnique = 0
		}
		for seq, colno := range index.columns {
			definitions = append(definitions, connection.IndexDefinition{
				Name: name, ColumnName: names[gbase8sAbs(colno)], NonUnique: nonUnique, SeqInIndex: seq + 1, IndexType: "BTREE",
			})
		}
	}
	return definitions, nil
}

func (g *GBase8sDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	query := fmt.Sprintf(`SELECT TRIM(k.constrname) AS constrname, TRIM(pt.tabname) AS ptabname, r.ptabid, %s, %s
FROM %s t
JOIN %s k ON k.tabid = t.tabid AND k.constrtype = 'R'
JOIN %s r ON r.constrid = k.constrid
JOIN %s pk ON pk.constrid = r.primary
JOIN %s pt ON pt.tabid = r.ptabid
JOIN %s i ON i.tabid = k.tabid AND i.idxname = k.idxname
JOIN %s pi ON pi.tabid = pk.tabid AND pi.idxname = pk.idxname
WHERE t.tabname = %s
ORDER BY k.constrname`, gbase8sIndexParts, gbase8sPartList("pi", "pp"),
		g.catalog(dbName, "systables"), g.catalog(dbName, "sysconstraints"), g.catalog(dbName, "sysreferences"), g.catalog(dbName, "sysconstraints"),
		g.catalog(dbName, "systables"), g.catalog(dbName, "sysindexes"), g.catalog(dbName, "sysindexes"), gbase8sLiteral(tableName))
	rows, _, err := g.Query(query)
	if err != nil {
		return nil, err
	}
	columns, err := g.loadColumns(dbName, tableName)
	if err != nil {
		return nil, err
	}
	localNames := gbase8sColumnNames(columns)
	var keys []connection.ForeignKeyDefinition
	for _, row := range rows {
		refTable := gbase8sText(row["ptabname"])
		refColumns, err := g.loadColumns(dbName, refTable)
		if err != nil {
			return nil, err
		}
		refNames := gbase8sColumnNames(refColumns)
		local := gbase8sIndexColumns(row)
		for i, colno := range local {
			refColno := gbase8sInt(row["pp"+strconv.Itoa(i+1)])
			keys = append(keys, connection.ForeignKeyDefinition{
				Name:           gbase8sText(row["constrname"]),
				ColumnName:     localNames[gbase8sAbs(colno)],
				RefTableName:   refTable,
				RefColumnName:  refNames[gbase8sAbs(refColno)],
				ConstraintName: gbase8sText(row["constrname"]),
			})
		}
	}
	return keys, nil
}

func (g *GBase8sDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	query := fmt.Sprintf(`SELECT TRIM(g.trigname) AS trigname, g.event, g.trigid
FROM %s g JOIN %s t ON t.tabid = g.tabid
WHERE t.tabname = %s
ORDER BY g.trigname`, g.catalog(dbName, "systriggers"), g.catalog(dbName, "systables"), gbase8sLiteral(tableName))
	rows, _, err := g.Query(query)
	if err != nil {
		return nil, err
	}
	events := map[string]string{"I": "INSERT", "U": "UPDATE", "D": "DELETE", "S": "SELECT"}
	triggers := make([]connection.TriggerDefinition, 0, len(rows))
	for _, row := range rows {
		body := g.triggerBody(dbName, gbase8sInt(row["trigid"]))
		lower := strings.ToLower(body)
		timing := "AFTER"
		if strings.Contains(lower, " before ") || strings.Contains(lower, " before(") {
			timing = "BEFORE"
		}
		orientation := "STATEMENT"
		if strings.Contains(lower, "for each row") {
			orientation = "ROW"
		}
		triggers = append(triggers, connection.TriggerDefinition{
			Name:        gbase8sText(row["trigname"]),
			Timing:      timing,
			Event:       events[strings.ToUpper(gbase8sText(row["event"]))],
			Statement:   body,
			Orientation: orientation,
		})
	}
	return triggers, nil
}

// triggerBody 拼出触发器的完整文本（systrigbody：D 是头部，A 是动作，按 seqno 分段存放）。
func (g *GBase8sDB) triggerBody(dbName string, trigid int) string {
	rows, _, err := g.Query(fmt.Sprintf("SELECT datakey, data FROM %s WHERE trigid = %d AND datakey IN ('D', 'A') ORDER BY datakey DESC, seqno",
		g.catalog(dbName, "systrigbody"), trigid))
	if err != nil {
		return ""
	}
	var header, action strings.Builder
	for _, row := range rows {
		if strings.EqualFold(gbase8sText(row["datakey"]), "D") {
			header.WriteString(gbase8sChunkText(row["data"]))
		} else {
			action.WriteString(gbase8sChunkText(row["data"]))
		}
	}
	return strings.TrimSpace(strings.TrimSpace(header.String()) + " " + strings.TrimSpace(action.String()))
}

func gbase8sText(value interface{}) string {
	return strings.TrimSpace(gbase8sRawText(value))
}

// gbase8sChunkText 返回系统目录分段原文（sysviews、sysprocbody、systrigbody）的一段：定长字段末尾用 NUL 填充。
func gbase8sChunkText(value interface{}) string {
	return strings.ReplaceAll(gbase8sRawText(value), "\x00", "")
}

func gbase8sRawText(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case []byte:
		return string(typed)
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}

func gbase8sInt(value interface{}) int {
	switch typed := value.(type) {
	case int64:
		return int(typed)
	case int:
		return typed
	default:
		number, _ := strconv.Atoi(gbase8sText(value))
		return number
	}
}

func gbase8sAbs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
