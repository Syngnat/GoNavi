//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"fmt"
	"regexp"
	"strings"
)

// GBase 8s 没有类似 SHOW CREATE 的语句（dbschema 是服务端命令行工具），建表语句按系统目录拼出：
// 列（类型、默认值、NOT NULL）、主键 / 唯一 / 检查约束、普通索引、外键与注释；视图取 sysviews 里的原文。

// gbase8sGeneratedConstraint 匹配系统生成的约束名（u1004_6、r1001_3、c1004_9……），生成 DDL 时不写 CONSTRAINT 子句。
var gbase8sGeneratedConstraint = regexp.MustCompile(`^[uprcn]\d+_\d+$`)

func (g *GBase8sDB) GetCreateStatement(dbName, tableName string) (string, error) {
	name := strings.Trim(strings.TrimSpace(tableName), `"`)
	rows, _, err := g.Query(fmt.Sprintf("SELECT tabid, tabtype FROM %s WHERE tabname = %s", g.catalog(dbName, "systables"), gbase8sLiteral(name)))
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		// 不是表或视图时按存储过程 / 函数、触发器查找，供定义查看器展示 SPL 原文。
		if body := g.routineDefinition(dbName, name); body != "" {
			return body, nil
		}
		if body := g.triggerDefinition(dbName, name); body != "" {
			return body, nil
		}
		return "", localizedDatabaseRuntimeError("db.backend.error.gbase8s_object_not_found", map[string]any{"name": name})
	}
	tabid := gbase8sInt(rows[0]["tabid"])
	if strings.EqualFold(gbase8sText(rows[0]["tabtype"]), "V") {
		return g.viewDefinition(dbName, tabid)
	}
	return g.tableDefinition(dbName, name, tabid)
}

// viewDefinition 拼接 sysviews 的分段原文（每段固定 64 字符，段尾空格是原文的一部分，只修剪整体末尾）。
func (g *GBase8sDB) viewDefinition(dbName string, tabid int) (string, error) {
	rows, _, err := g.Query(fmt.Sprintf("SELECT viewtext FROM %s WHERE tabid = %d ORDER BY seqno", g.catalog(dbName, "sysviews"), tabid))
	if err != nil {
		return "", err
	}
	var text strings.Builder
	for _, row := range rows {
		text.WriteString(gbase8sChunkText(row["viewtext"]))
	}
	return strings.TrimRight(strings.TrimSpace(text.String()), ";") + ";", nil
}

func (g *GBase8sDB) tableDefinition(dbName, table string, tabid int) (string, error) {
	columns, err := g.loadColumns(dbName, table)
	if err != nil {
		return "", err
	}
	indexes, err := g.loadIndexes(dbName, table)
	if err != nil {
		return "", err
	}
	names := gbase8sColumnNames(columns)
	quotedTable := gbase8sQuoteIdent(table)
	lines := make([]string, 0, len(columns)+4)
	for _, column := range columns {
		line := "    " + gbase8sQuoteIdent(column.name) + " " + column.typeName()
		if clause, ok := column.defaultClause(); ok {
			line += " DEFAULT " + clause
		}
		if column.notNull() {
			line += " NOT NULL"
		}
		lines = append(lines, line)
	}
	var trailing []string
	for _, index := range indexes {
		columnList := gbase8sIndexColumnList(index.columns, names)
		switch index.kind {
		case "P":
			lines = append(lines, "    PRIMARY KEY ("+columnList+")"+gbase8sConstraintSuffix(index.constraint))
		case "U":
			lines = append(lines, "    UNIQUE ("+columnList+")"+gbase8sConstraintSuffix(index.constraint))
		case "R":
		default:
			keyword := "INDEX"
			if index.unique {
				keyword = "UNIQUE INDEX"
			}
			trailing = append(trailing, fmt.Sprintf("CREATE %s %s ON %s (%s);", keyword, gbase8sQuoteIdent(index.name), quotedTable, columnList))
		}
	}
	for _, check := range g.checkConstraints(dbName, tabid) {
		lines = append(lines, "    CHECK "+check[1]+gbase8sConstraintSuffix(check[0]))
	}
	statement := "CREATE TABLE " + quotedTable + " (\n" + strings.Join(lines, ",\n") + "\n);"
	parts := append([]string{statement}, trailing...)
	parts = append(parts, g.foreignKeyStatements(dbName, table)...)
	parts = append(parts, g.commentStatements(dbName, table, columns)...)
	return strings.Join(parts, "\n"), nil
}

func gbase8sConstraintSuffix(name string) string {
	if name == "" || gbase8sGeneratedConstraint.MatchString(name) {
		return ""
	}
	return " CONSTRAINT " + gbase8sQuoteIdent(name)
}

func gbase8sIndexColumnList(colnos []int, names map[int]string) string {
	parts := make([]string, 0, len(colnos))
	for _, colno := range colnos {
		part := gbase8sQuoteIdent(names[gbase8sAbs(colno)])
		if colno < 0 {
			part += " DESC"
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, ", ")
}

// checkConstraints 返回 [约束名, 检查条件] 列表（syschecks 里 type = 'T' 的分段原文）。
func (g *GBase8sDB) checkConstraints(dbName string, tabid int) [][2]string {
	rows, _, err := g.Query(fmt.Sprintf(`SELECT TRIM(k.constrname) AS constrname, c.seqno, c.checktext
FROM %s k JOIN %s c ON c.constrid = k.constrid
WHERE k.tabid = %d AND k.constrtype = 'C' AND c.type = 'T'
ORDER BY k.constrname, c.seqno`, g.catalog(dbName, "sysconstraints"), g.catalog(dbName, "syschecks"), tabid))
	if err != nil {
		return nil
	}
	var checks [][2]string
	for _, row := range rows {
		name := gbase8sText(row["constrname"])
		if len(checks) == 0 || checks[len(checks)-1][0] != name {
			checks = append(checks, [2]string{name, ""})
		}
		checks[len(checks)-1][1] += gbase8sChunkText(row["checktext"])
	}
	for i := range checks {
		checks[i][1] = strings.TrimSpace(checks[i][1])
	}
	return checks
}

// foreignKeyStatements 按约束分组外键列，生成 ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY 语句（Informix 语法约束名在末尾）。
func (g *GBase8sDB) foreignKeyStatements(dbName, table string) []string {
	keys, err := g.GetForeignKeys(dbName, table)
	if err != nil {
		return nil
	}
	type foreignKey struct {
		refTable   string
		local, ref []string
	}
	var order []string
	grouped := map[string]*foreignKey{}
	for _, key := range keys {
		entry := grouped[key.ConstraintName]
		if entry == nil {
			entry = &foreignKey{refTable: key.RefTableName}
			grouped[key.ConstraintName] = entry
			order = append(order, key.ConstraintName)
		}
		entry.local = append(entry.local, gbase8sQuoteIdent(key.ColumnName))
		entry.ref = append(entry.ref, gbase8sQuoteIdent(key.RefColumnName))
	}
	statements := make([]string, 0, len(order))
	for _, name := range order {
		entry := grouped[name]
		statements = append(statements, fmt.Sprintf("ALTER TABLE %s ADD CONSTRAINT FOREIGN KEY (%s) REFERENCES %s (%s)%s;",
			gbase8sQuoteIdent(table), strings.Join(entry.local, ", "), gbase8sQuoteIdent(entry.refTable), strings.Join(entry.ref, ", "), gbase8sConstraintSuffix(name)))
	}
	return statements
}

func (g *GBase8sDB) commentStatements(dbName, table string, columns []gbase8sColumnInfo) []string {
	var statements []string
	rows, _, err := g.Query(fmt.Sprintf("SELECT comments FROM %s WHERE tabname = %s", g.catalog(dbName, "syscomments"), gbase8sLiteral(table)))
	if err == nil && len(rows) > 0 {
		if comment := gbase8sText(rows[0]["comments"]); comment != "" {
			statements = append(statements, fmt.Sprintf("COMMENT ON TABLE %s IS %s;", gbase8sQuoteIdent(table), gbase8sLiteral(comment)))
		}
	}
	for _, column := range columns {
		if column.comment != "" {
			statements = append(statements, fmt.Sprintf("COMMENT ON COLUMN %s.%s IS %s;", gbase8sQuoteIdent(table), gbase8sQuoteIdent(column.name), gbase8sLiteral(column.comment)))
		}
	}
	return statements
}

// GetTableComment 返回表注释（GBase 8s 的 syscomments 视图）。
func (g *GBase8sDB) GetTableComment(dbName, tableName string) (string, error) {
	rows, _, err := g.Query(fmt.Sprintf("SELECT comments FROM %s WHERE tabname = %s", g.catalog(dbName, "syscomments"), gbase8sLiteral(strings.TrimSpace(tableName))))
	if err != nil || len(rows) == 0 {
		return "", err
	}
	return gbase8sText(rows[0]["comments"]), nil
}

// routineDefinition 拼接 sysprocbody 里 datakey = 'T' 的分段原文；同名重载的多个例程用空行分隔。
func (g *GBase8sDB) routineDefinition(dbName, name string) string {
	rows, _, err := g.Query(fmt.Sprintf(`SELECT b.procid, b.data FROM %s p JOIN %s b ON b.procid = p.procid
WHERE p.procname = %s AND b.datakey = 'T' ORDER BY b.procid, b.seqno`, g.catalog(dbName, "sysprocedures"), g.catalog(dbName, "sysprocbody"), gbase8sLiteral(name)))
	if err != nil || len(rows) == 0 {
		return ""
	}
	var bodies []string
	var current strings.Builder
	lastID := -1
	for _, row := range rows {
		if id := gbase8sInt(row["procid"]); id != lastID {
			if current.Len() > 0 {
				bodies = append(bodies, strings.TrimSpace(current.String()))
				current.Reset()
			}
			lastID = id
		}
		current.WriteString(gbase8sChunkText(row["data"]))
	}
	if current.Len() > 0 {
		bodies = append(bodies, strings.TrimSpace(current.String()))
	}
	return strings.Join(bodies, "\n\n")
}

// triggerDefinition 返回触发器的完整文本（systrigbody 的头部与动作）。
func (g *GBase8sDB) triggerDefinition(dbName, name string) string {
	rows, _, err := g.Query(fmt.Sprintf("SELECT trigid FROM %s WHERE trigname = %s", g.catalog(dbName, "systriggers"), gbase8sLiteral(name)))
	if err != nil || len(rows) == 0 {
		return ""
	}
	return g.triggerBody(dbName, gbase8sInt(rows[0]["trigid"]))
}
