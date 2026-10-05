//go:build gonavi_full_drivers || gonavi_firebird_driver

package db

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

// Firebird 的元数据都在 RDB$ 系统表里：RDB$SYSTEM_FLAG 非 0 的是系统对象；名字列是定长 CHAR，需要去掉右侧空格。
// 一个连接只有一个数据库，导航树里的库名只是展示用的标签。

func (f *FirebirdDB) GetDatabases() ([]string, error) {
	return []string{f.label}, nil
}

func (f *FirebirdDB) GetTables(string) ([]string, error) {
	rows, err := f.queryArgs(`SELECT TRIM(RDB$RELATION_NAME) AS name FROM RDB$RELATIONS
WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0 AND RDB$VIEW_BLR IS NULL ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	tables := make([]string, 0, len(rows))
	for _, row := range rows {
		if name := firebirdText(row["NAME"]); name != "" {
			tables = append(tables, name)
		}
	}
	return tables, nil
}

// relationName 返回库里精确的表 / 视图名：先按原样匹配，再按大写匹配（未加引号创建的对象名是大写）。
func (f *FirebirdDB) relationName(name string) string {
	name = strings.Trim(strings.TrimSpace(name), `"`)
	for _, candidate := range []string{name, strings.ToUpper(name)} {
		rows, err := f.queryArgs("SELECT 1 AS found FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ?", candidate)
		if err == nil && len(rows) > 0 {
			return candidate
		}
	}
	return name
}

// firebirdColumn 是一列的完整定义。
type firebirdColumn struct {
	name       string
	field      firebirdField
	notNull    bool
	defaultSrc string
	comment    string
	computed   string
	identity   int // -1 不是标识列；0 ALWAYS；1 BY DEFAULT
}

// loadColumns 读取表 / 视图的列；3.0 起才有 RDB$IDENTITY_TYPE，2.5 去掉该列重试。
func (f *FirebirdDB) loadColumns(table string) ([]firebirdColumn, error) {
	query := `SELECT TRIM(rf.RDB$FIELD_NAME) AS name, fd.RDB$FIELD_TYPE AS ftype, fd.RDB$FIELD_SUB_TYPE AS subtype,
	fd.RDB$FIELD_LENGTH AS flen, fd.RDB$FIELD_PRECISION AS fprec, fd.RDB$FIELD_SCALE AS fscale,
	fd.RDB$CHARACTER_LENGTH AS clen, fd.RDB$SEGMENT_LENGTH AS seglen, TRIM(cs.RDB$CHARACTER_SET_NAME) AS charset,
	COALESCE(rf.RDB$NULL_FLAG, fd.RDB$NULL_FLAG, 0) AS notnull, COALESCE(rf.RDB$DEFAULT_SOURCE, fd.RDB$DEFAULT_SOURCE) AS defsrc,
	rf.RDB$DESCRIPTION AS descr, fd.RDB$COMPUTED_SOURCE AS computed%s
FROM RDB$RELATION_FIELDS rf
JOIN RDB$FIELDS fd ON fd.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
LEFT JOIN RDB$CHARACTER_SETS cs ON cs.RDB$CHARACTER_SET_ID = fd.RDB$CHARACTER_SET_ID
WHERE rf.RDB$RELATION_NAME = ?
ORDER BY rf.RDB$FIELD_POSITION`
	withIdentity := f.atLeast("3.0")
	identityColumn := ", rf.RDB$IDENTITY_TYPE AS identity"
	if !withIdentity {
		identityColumn = ""
	}
	rows, err := f.queryArgs(strings.Replace(query, "%s", identityColumn, 1), table)
	if err != nil && withIdentity {
		withIdentity = false
		rows, err = f.queryArgs(strings.Replace(query, "%s", "", 1), table)
	}
	if err != nil {
		return nil, err
	}
	columns := make([]firebirdColumn, 0, len(rows))
	for _, row := range rows {
		column := firebirdColumn{
			name: firebirdText(row["NAME"]),
			field: firebirdField{
				fieldType: firebirdInt(row["FTYPE"]), subType: firebirdInt(row["SUBTYPE"]), length: firebirdInt(row["FLEN"]),
				precision: firebirdInt(row["FPREC"]), scale: firebirdInt(row["FSCALE"]), charLength: firebirdInt(row["CLEN"]),
				charset: firebirdText(row["CHARSET"]), segment: firebirdInt(row["SEGLEN"]),
			},
			notNull:    firebirdInt(row["NOTNULL"]) == 1,
			defaultSrc: firebirdRawText(row["DEFSRC"]),
			comment:    firebirdText(row["DESCR"]),
			computed:   firebirdRawText(row["COMPUTED"]),
			identity:   -1,
		}
		if withIdentity && row["IDENTITY"] != nil {
			column.identity = firebirdInt(row["IDENTITY"])
		}
		columns = append(columns, column)
	}
	return columns, nil
}

// firebirdConstraint 是主键 / 唯一 / 外键约束及其列。
type firebirdConstraint struct {
	name, kind, index string
	columns           []string
}

// constraints 读取表上的主键、唯一与外键约束（按约束名分组，列按索引段顺序）。
func (f *FirebirdDB) constraints(table string) ([]firebirdConstraint, error) {
	rows, err := f.queryArgs(`SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS cname, TRIM(rc.RDB$CONSTRAINT_TYPE) AS ctype,
	TRIM(rc.RDB$INDEX_NAME) AS iname, TRIM(s.RDB$FIELD_NAME) AS field
FROM RDB$RELATION_CONSTRAINTS rc
JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
WHERE rc.RDB$RELATION_NAME = ? AND rc.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
ORDER BY rc.RDB$CONSTRAINT_TYPE DESC, rc.RDB$CONSTRAINT_NAME, s.RDB$FIELD_POSITION`, table)
	if err != nil {
		return nil, err
	}
	var result []firebirdConstraint
	for _, row := range rows {
		name := firebirdText(row["CNAME"])
		if len(result) == 0 || result[len(result)-1].name != name {
			result = append(result, firebirdConstraint{name: name, kind: firebirdText(row["CTYPE"]), index: firebirdText(row["INAME"])})
		}
		last := &result[len(result)-1]
		last.columns = append(last.columns, firebirdText(row["FIELD"]))
	}
	return result, nil
}

func (f *FirebirdDB) GetColumns(_ string, tableName string) ([]connection.ColumnDefinition, error) {
	table := f.relationName(tableName)
	columns, err := f.loadColumns(table)
	if err != nil {
		return nil, err
	}
	constraints, err := f.constraints(table)
	if err != nil {
		return nil, err
	}
	keys := map[string]string{}
	for _, constraint := range constraints {
		for _, column := range constraint.columns {
			switch {
			case constraint.kind == "PRIMARY KEY":
				keys[column] = "PRI"
			case constraint.kind == "UNIQUE" && keys[column] == "":
				keys[column] = "UNI"
			}
		}
	}
	binaryTypes := f.atLeast("4.0")
	definitions := make([]connection.ColumnDefinition, 0, len(columns))
	for _, column := range columns {
		definition := connection.ColumnDefinition{
			Name:     column.name,
			Type:     column.field.typeName(binaryTypes),
			Nullable: "YES",
			Key:      keys[column.name],
			Comment:  column.comment,
			Charset:  column.field.charset,
		}
		if column.notNull {
			definition.Nullable = "NO"
		}
		switch {
		case column.identity >= 0:
			definition.Extra = "auto_increment"
		case column.computed != "":
			definition.Extra = "COMPUTED BY " + column.computed
		}
		if value, ok := firebirdDefaultValue(column.defaultSrc); ok {
			definition.Default = &value
			definition.HasDefault = true
		}
		definitions = append(definitions, definition)
	}
	return definitions, nil
}

func (f *FirebirdDB) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	rows, err := f.queryArgs(`SELECT TRIM(rf.RDB$RELATION_NAME) AS tname, TRIM(rf.RDB$FIELD_NAME) AS name, fd.RDB$FIELD_TYPE AS ftype,
	fd.RDB$FIELD_SUB_TYPE AS subtype, fd.RDB$FIELD_LENGTH AS flen, fd.RDB$FIELD_PRECISION AS fprec, fd.RDB$FIELD_SCALE AS fscale,
	fd.RDB$CHARACTER_LENGTH AS clen, TRIM(cs.RDB$CHARACTER_SET_NAME) AS charset, rf.RDB$DESCRIPTION AS descr
FROM RDB$RELATION_FIELDS rf
JOIN RDB$RELATIONS r ON r.RDB$RELATION_NAME = rf.RDB$RELATION_NAME
JOIN RDB$FIELDS fd ON fd.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
LEFT JOIN RDB$CHARACTER_SETS cs ON cs.RDB$CHARACTER_SET_ID = fd.RDB$CHARACTER_SET_ID
WHERE COALESCE(r.RDB$SYSTEM_FLAG, 0) = 0
ORDER BY rf.RDB$RELATION_NAME, rf.RDB$FIELD_POSITION`)
	if err != nil {
		return nil, err
	}
	binaryTypes := f.atLeast("4.0")
	result := make([]connection.ColumnDefinitionWithTable, 0, len(rows))
	for _, row := range rows {
		field := firebirdField{
			fieldType: firebirdInt(row["FTYPE"]), subType: firebirdInt(row["SUBTYPE"]), length: firebirdInt(row["FLEN"]),
			precision: firebirdInt(row["FPREC"]), scale: firebirdInt(row["FSCALE"]), charLength: firebirdInt(row["CLEN"]),
			charset: firebirdText(row["CHARSET"]),
		}
		result = append(result, connection.ColumnDefinitionWithTable{
			TableName: firebirdText(row["TNAME"]),
			Name:      firebirdText(row["NAME"]),
			Type:      field.typeName(binaryTypes),
			Comment:   firebirdText(row["DESCR"]),
		})
	}
	return result, nil
}

// firebirdIndex 是一个用户索引。
type firebirdIndex struct {
	name, constraintKind, expression string
	unique, descending               bool
	columns                          []string
}

// loadIndexes 读取表上的索引；约束自带的索引带上约束类型（主键索引在设计器里显示为 PRIMARY）。
func (f *FirebirdDB) loadIndexes(table string) ([]firebirdIndex, error) {
	rows, err := f.queryArgs(`SELECT TRIM(i.RDB$INDEX_NAME) AS iname, i.RDB$UNIQUE_FLAG AS uniq, i.RDB$INDEX_TYPE AS itype,
	i.RDB$EXPRESSION_SOURCE AS expr, TRIM(s.RDB$FIELD_NAME) AS field, TRIM(rc.RDB$CONSTRAINT_TYPE) AS ctype
FROM RDB$INDICES i
LEFT JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = i.RDB$INDEX_NAME
LEFT JOIN RDB$RELATION_CONSTRAINTS rc ON rc.RDB$INDEX_NAME = i.RDB$INDEX_NAME
WHERE i.RDB$RELATION_NAME = ? AND COALESCE(i.RDB$SYSTEM_FLAG, 0) = 0
ORDER BY i.RDB$INDEX_NAME, s.RDB$FIELD_POSITION`, table)
	if err != nil {
		return nil, err
	}
	var indexes []firebirdIndex
	for _, row := range rows {
		name := firebirdText(row["INAME"])
		if len(indexes) == 0 || indexes[len(indexes)-1].name != name {
			indexes = append(indexes, firebirdIndex{
				name:           name,
				constraintKind: firebirdText(row["CTYPE"]),
				expression:     firebirdRawText(row["EXPR"]),
				unique:         firebirdInt(row["UNIQ"]) == 1,
				descending:     firebirdInt(row["ITYPE"]) == 1,
			})
		}
		if field := firebirdText(row["FIELD"]); field != "" {
			last := &indexes[len(indexes)-1]
			last.columns = append(last.columns, field)
		}
	}
	return indexes, nil
}

func (f *FirebirdDB) GetIndexes(_ string, tableName string) ([]connection.IndexDefinition, error) {
	indexes, err := f.loadIndexes(f.relationName(tableName))
	if err != nil {
		return nil, err
	}
	var definitions []connection.IndexDefinition
	for _, index := range indexes {
		if index.constraintKind == "FOREIGN KEY" {
			continue
		}
		name := index.name
		if index.constraintKind == "PRIMARY KEY" {
			name = "PRIMARY"
		}
		indexType := "ASC"
		if index.descending {
			indexType = "DESC"
		}
		nonUnique := 1
		if index.unique {
			nonUnique = 0
		}
		columns := index.columns
		if len(columns) == 0 && index.expression != "" {
			columns = []string{"COMPUTED BY " + index.expression}
		}
		for i, column := range columns {
			definitions = append(definitions, connection.IndexDefinition{
				Name: name, ColumnName: column, NonUnique: nonUnique, SeqInIndex: i + 1, IndexType: indexType,
			})
		}
	}
	return definitions, nil
}

// firebirdForeignKey 是一个外键（列与被引用列按位置一一对应）。
type firebirdForeignKey struct {
	name, refTable, updateRule, deleteRule string
	columns, refColumns                    []string
}

func (f *FirebirdDB) loadForeignKeys(table string) ([]firebirdForeignKey, error) {
	rows, err := f.queryArgs(`SELECT TRIM(rc.RDB$CONSTRAINT_NAME) AS cname, TRIM(s.RDB$FIELD_NAME) AS field,
	TRIM(rrc.RDB$RELATION_NAME) AS reftable, TRIM(rs.RDB$FIELD_NAME) AS reffield,
	TRIM(refc.RDB$UPDATE_RULE) AS updrule, TRIM(refc.RDB$DELETE_RULE) AS delrule
FROM RDB$RELATION_CONSTRAINTS rc
JOIN RDB$REF_CONSTRAINTS refc ON refc.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
JOIN RDB$RELATION_CONSTRAINTS rrc ON rrc.RDB$CONSTRAINT_NAME = refc.RDB$CONST_NAME_UQ
JOIN RDB$INDEX_SEGMENTS s ON s.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
JOIN RDB$INDEX_SEGMENTS rs ON rs.RDB$INDEX_NAME = rrc.RDB$INDEX_NAME AND rs.RDB$FIELD_POSITION = s.RDB$FIELD_POSITION
WHERE rc.RDB$RELATION_NAME = ? AND rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY'
ORDER BY rc.RDB$CONSTRAINT_NAME, s.RDB$FIELD_POSITION`, table)
	if err != nil {
		return nil, err
	}
	var keys []firebirdForeignKey
	for _, row := range rows {
		name := firebirdText(row["CNAME"])
		if len(keys) == 0 || keys[len(keys)-1].name != name {
			keys = append(keys, firebirdForeignKey{
				name: name, refTable: firebirdText(row["REFTABLE"]),
				updateRule: firebirdText(row["UPDRULE"]), deleteRule: firebirdText(row["DELRULE"]),
			})
		}
		last := &keys[len(keys)-1]
		last.columns = append(last.columns, firebirdText(row["FIELD"]))
		last.refColumns = append(last.refColumns, firebirdText(row["REFFIELD"]))
	}
	return keys, nil
}

func (f *FirebirdDB) GetForeignKeys(_ string, tableName string) ([]connection.ForeignKeyDefinition, error) {
	keys, err := f.loadForeignKeys(f.relationName(tableName))
	if err != nil {
		return nil, err
	}
	var definitions []connection.ForeignKeyDefinition
	for _, key := range keys {
		for i, column := range key.columns {
			definitions = append(definitions, connection.ForeignKeyDefinition{
				Name: key.name, ColumnName: column, RefTableName: key.refTable, RefColumnName: key.refColumns[i], ConstraintName: key.name,
			})
		}
	}
	return definitions, nil
}

// firebirdTrigger 是一个触发器的定义。
type firebirdTrigger struct {
	name, table, source string
	triggerType         int
	position            int
	inactive            bool
}

// loadTriggers 读取用户触发器；table 为空时读取全部（含数据库级触发器）。
func (f *FirebirdDB) loadTriggers(table, name string) ([]firebirdTrigger, error) {
	query := `SELECT TRIM(RDB$TRIGGER_NAME) AS name, TRIM(RDB$RELATION_NAME) AS tname, RDB$TRIGGER_TYPE AS ttype,
	RDB$TRIGGER_SEQUENCE AS seq, RDB$TRIGGER_INACTIVE AS inactive, RDB$TRIGGER_SOURCE AS src
FROM RDB$TRIGGERS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0`
	var args []any
	if table != "" {
		query += " AND RDB$RELATION_NAME = ?"
		args = append(args, table)
	}
	if name != "" {
		query += " AND RDB$TRIGGER_NAME = ?"
		args = append(args, name)
	}
	rows, err := f.queryArgs(query+" ORDER BY RDB$TRIGGER_SEQUENCE, RDB$TRIGGER_NAME", args...)
	if err != nil {
		return nil, err
	}
	triggers := make([]firebirdTrigger, 0, len(rows))
	for _, row := range rows {
		triggers = append(triggers, firebirdTrigger{
			name: firebirdText(row["NAME"]), table: firebirdText(row["TNAME"]), source: firebirdRawText(row["SRC"]),
			triggerType: firebirdInt(row["TTYPE"]), position: firebirdInt(row["SEQ"]), inactive: firebirdInt(row["INACTIVE"]) == 1,
		})
	}
	return triggers, nil
}

func (f *FirebirdDB) GetTriggers(_ string, tableName string) ([]connection.TriggerDefinition, error) {
	triggers, err := f.loadTriggers(f.relationName(tableName), "")
	if err != nil {
		return nil, err
	}
	definitions := make([]connection.TriggerDefinition, 0, len(triggers))
	for _, trigger := range triggers {
		timing, events := firebirdTriggerTiming(trigger.triggerType)
		definitions = append(definitions, connection.TriggerDefinition{
			Name:        trigger.name,
			Timing:      timing,
			Event:       strings.Join(events, " OR "),
			Statement:   trigger.source,
			Orientation: "ROW",
		})
	}
	return definitions, nil
}
