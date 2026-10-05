package sync

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func groupIndexDefinitions(indexes []connection.IndexDefinition) []groupedIndex {
	if len(indexes) == 0 {
		return nil
	}
	groupMap := make(map[string][]connection.IndexDefinition)
	order := make([]string, 0)
	for _, idx := range indexes {
		name := strings.TrimSpace(idx.Name)
		if name == "" {
			continue
		}
		if _, ok := groupMap[name]; !ok {
			order = append(order, name)
		}
		groupMap[name] = append(groupMap[name], idx)
	}
	grouped := make([]groupedIndex, 0, len(groupMap))
	for _, name := range order {
		rows := groupMap[name]
		sort.SliceStable(rows, func(i, j int) bool {
			return rows[i].SeqInIndex < rows[j].SeqInIndex
		})
		gi := groupedIndex{Name: name, Unique: true, IndexType: "BTREE"}
		for _, row := range rows {
			if row.NonUnique != 0 {
				gi.Unique = false
			}
			if strings.TrimSpace(row.IndexType) != "" {
				gi.IndexType = row.IndexType
			}
			col := strings.TrimSpace(row.ColumnName)
			if col != "" {
				gi.Columns = append(gi.Columns, IndexMigrationColumn{
					Name:         col,
					PrefixLength: row.SubPart,
				})
			}
		}
		grouped = append(grouped, gi)
	}
	return grouped
}

func sameColumnNameList(a []IndexMigrationColumn, b []string) bool {
	if len(a) == 0 || len(a) != len(b) {
		return false
	}
	for i := range a {
		if !strings.EqualFold(strings.TrimSpace(a[i].Name), strings.TrimSpace(b[i])) {
			return false
		}
	}
	return true
}

func hasIndexPrefix(columns []IndexMigrationColumn) bool {
	for _, column := range columns {
		if column.PrefixLength > 0 {
			return true
		}
	}
	return false
}

func buildQuotedIndexColumns(targetType string, columns []IndexMigrationColumn, preservePrefix bool) []string {
	quoted := make([]string, 0, len(columns))
	for _, column := range columns {
		name := strings.TrimSpace(column.Name)
		if name == "" {
			continue
		}
		value := quoteIdentByType(targetType, name)
		if preservePrefix && column.PrefixLength > 0 {
			value += fmt.Sprintf("(%d)", column.PrefixLength)
		}
		quoted = append(quoted, value)
	}
	return quoted
}

func buildCreateIndexSQL(targetType, targetQueryTable string, idx groupedIndex, preservePrefix bool) string {
	prefix := "CREATE INDEX"
	if idx.Unique {
		prefix = "CREATE UNIQUE INDEX"
	}
	return fmt.Sprintf("%s %s ON %s (%s)",
		prefix,
		quoteIdentByType(targetType, idx.Name),
		quoteQualifiedIdentByType(targetType, targetQueryTable),
		strings.Join(buildQuotedIndexColumns(targetType, idx.Columns, preservePrefix), ", "),
	)
}

func buildIndexRemediationStatements(targetType, targetQueryTable string, idx groupedIndex) []string {
	kind := strings.ToLower(strings.TrimSpace(idx.IndexType))
	if isMySQLRowStoreType(targetType) {
		if kind == "fulltext" {
			return []string{fmt.Sprintf("CREATE FULLTEXT INDEX %s ON %s (%s)",
				quoteIdentByType(targetType, idx.Name),
				quoteQualifiedIdentByType(targetType, targetQueryTable),
				strings.Join(buildQuotedIndexColumns(targetType, idx.Columns, true), ", "),
			)}
		}
		if hasIndexPrefix(idx.Columns) {
			return []string{buildCreateIndexSQL(targetType, targetQueryTable, idx, true)}
		}
		return nil
	}
	if kind == "fulltext" && isPGLikeSameFamilyDDLType(targetType) {
		parts := make([]string, 0, len(idx.Columns))
		for _, column := range idx.Columns {
			parts = append(parts, fmt.Sprintf("coalesce(CAST(%s AS text), '')", quoteIdentByType(targetType, column.Name)))
		}
		return []string{fmt.Sprintf("CREATE INDEX %s ON %s USING GIN (to_tsvector('simple', %s))",
			quoteIdentByType(targetType, idx.Name),
			quoteQualifiedIdentByType(targetType, targetQueryTable),
			strings.Join(parts, " || ' ' || "),
		)}
	}
	if hasIndexPrefix(idx.Columns) && isPGLikeSameFamilyDDLType(targetType) {
		columns := make([]string, 0, len(idx.Columns))
		for _, column := range idx.Columns {
			value := quoteIdentByType(targetType, column.Name)
			if column.PrefixLength > 0 {
				value = fmt.Sprintf("left(CAST(%s AS text), %d)", value, column.PrefixLength)
			}
			columns = append(columns, value)
		}
		prefix := "CREATE INDEX"
		if idx.Unique {
			prefix = "CREATE UNIQUE INDEX"
		}
		return []string{fmt.Sprintf("%s %s ON %s (%s)",
			prefix,
			quoteIdentByType(targetType, idx.Name),
			quoteQualifiedIdentByType(targetType, targetQueryTable),
			strings.Join(columns, ", "),
		)}
	}
	return nil
}

// indexHitsUnindexableColumn 判断索引是否落在目标方言不可索引的大对象列上，
// 返回首个命中的列名。columnTypes 为空时不做判断（调用方未提供列类型信息）。
func indexHitsUnindexableColumn(targetType string, idx groupedIndex, columnTypes map[string]string) (string, bool) {
	if len(columnTypes) == 0 || targetAllowsLOBKeyColumn(targetType) {
		return "", false
	}
	for _, col := range idx.Columns {
		plannedType, ok := columnTypes[strings.ToLower(strings.TrimSpace(col.Name))]
		if !ok {
			continue
		}
		if isUnindexableTargetColumnType(plannedType) {
			return col.Name, true
		}
	}
	return "", false
}

// isUnindexableTargetColumnType 判定已生成的目标列定义是否是不可索引的大对象类型。
// 入参是目标方言的列定义文本（如 "CLOB NOT NULL"、"NVARCHAR(MAX)"、"text"）。
func isUnindexableTargetColumnType(plannedType string) bool {
	upper := strings.ToUpper(plannedType)
	for _, lob := range []string{"CLOB", "BLOB", "NVARCHAR(MAX)", "VARCHAR(MAX)", "VARBINARY(MAX)", "LONGTEXT", "MEDIUMTEXT", "TINYTEXT", "IMAGE", "NTEXT"} {
		if strings.Contains(upper, lob) {
			return true
		}
	}
	// 裸 TEXT / JSON 需精确匹配词首，避免把 VARCHAR/NVARCHAR 之类误判成 LOB。
	//
	// JSON 必须算在内：MySQL 的 JSON 列不能直接建索引（报 "JSON column
	// cannot be used in key specification"，只能建函数索引），而 json 既不含
	// LOB 关键字也不带声明长度，长度上限那条规则同样漏掉它。
	for _, field := range strings.FieldsFunc(upper, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '(' || r == ')' || r == ','
	}) {
		if field == "TEXT" || field == "JSON" {
			return true
		}
	}
	return false
}

// buildMySQLSourceIndexPlan 生成目标端建索引语句。
//
// plannedColumnTypes 可选：传入"列名 -> 已生成的目标列类型"映射后，函数会跳过
// 落在不可索引类型（LOB）上的索引。这一步不可省：源端列元数据只标记主键
// （PG 的 information_schema 不回填普通索引列的 Key），键列收紧因此漏掉这些列，
// 目标端会建出 CLOB / NVARCHAR(MAX)，而建索引发生在数据导入之后 —— 报错时
// 数据已经写进去了，任务处于半完成状态。宁可跳过索引并告知用户。
// stripPrimaryKeyImplicitIndexes 去掉与主键列集合完全一致且唯一的索引。
//
// 建表语句已含 PRIMARY KEY 约束，主键的隐含索引无需在目标端重建：Oracle/达梦
// 的主键约束在数据字典中就是一个唯一索引（索引名=约束名），SQL Server 的
// 主键是唯一聚集/非聚集索引，照建一次会得到一个与主键同列的冗余唯一索引。
// MySQL 的主键索引名恒为 PRIMARY，由 buildMySQLSourceIndexPlan 自行跳过，
// 对其调用本函数是无操作。显式 UNIQUE 索引（含 UNIQUE 约束隐含的）不受
// 影响：建表不迁移 UNIQUE 约束，唯一索引必须照建。
//
// 带前缀长度的唯一索引（如 UNIQUE KEY(code(10)) 与 PRIMARY KEY(code) 同列）
// 不得剥离：前缀索引约束的是前 N 字符的唯一性，与整列唯一语义不同，照建
// 才能保住该约束。
func stripPrimaryKeyImplicitIndexes(indexes []connection.IndexDefinition, sourceCols []connection.ColumnDefinition) []connection.IndexDefinition {
	pkColumns := make([]string, 0, 2)
	for _, col := range sourceCols {
		switch strings.ToUpper(strings.TrimSpace(col.Key)) {
		case "PRI", "PK":
			name := strings.ToLower(strings.TrimSpace(col.Name))
			if name != "" {
				pkColumns = append(pkColumns, name)
			}
		}
	}
	if len(pkColumns) == 0 || len(indexes) == 0 {
		return indexes
	}

	type indexColumn struct {
		name string
		seq  int
	}
	type indexShape struct {
		unique    bool
		hasPrefix bool
		columns   []indexColumn
	}
	shapes := make(map[string]*indexShape)
	for _, idx := range indexes {
		name := strings.TrimSpace(idx.Name)
		if name == "" {
			continue
		}
		shape, ok := shapes[name]
		if !ok {
			shape = &indexShape{}
			shapes[name] = shape
		}
		if idx.NonUnique == 0 {
			shape.unique = true
		}
		if idx.SubPart > 0 {
			shape.hasPrefix = true
		}
		if col := strings.ToLower(strings.TrimSpace(idx.ColumnName)); col != "" {
			shape.columns = append(shape.columns, indexColumn{name: col, seq: idx.SeqInIndex})
		}
	}
	for _, shape := range shapes {
		sort.SliceStable(shape.columns, func(i, j int) bool {
			return shape.columns[i].seq < shape.columns[j].seq
		})
	}

	drop := make(map[string]bool, 1)
	for name, shape := range shapes {
		if !shape.unique || shape.hasPrefix || len(shape.columns) != len(pkColumns) {
			continue
		}
		matches := true
		for index, col := range shape.columns {
			if col.name != pkColumns[index] {
				matches = false
				break
			}
		}
		if matches {
			drop[name] = true
		}
	}
	if len(drop) == 0 {
		return indexes
	}

	kept := make([]connection.IndexDefinition, 0, len(indexes))
	for _, idx := range indexes {
		if !drop[strings.TrimSpace(idx.Name)] {
			kept = append(kept, idx)
		}
	}
	return kept
}

// isBTreeEquivalentIndexType 判定源索引类型是否可按普通 B 树索引自动迁移。
//
// 各方言对"普通索引"的叫法不同：MySQL 系叫 BTREE，Oracle/达梦 的数据字典叫
// NORMAL，SQL Server 叫 CLUSTERED/NONCLUSTERED（无独立 BTREE 概念）。这些
// 在目标端都能用普通 CREATE [UNIQUE] INDEX 等价表达。BITMAP、函数索引、
// GIN/GIST 等特化类型没有跨方言等价物，仍走"不支持"分支人工评审。
func isBTreeEquivalentIndexType(indexType string) bool {
	switch strings.ToLower(strings.TrimSpace(indexType)) {
	case "", "btree", "normal", "clustered", "nonclustered":
		return true
	default:
		return false
	}
}

func buildMySQLSourceIndexPlan(targetType, targetQueryTable string, indexes []connection.IndexDefinition, plannedColumnTypes ...map[string]string) ([]string, []string, []UnmigratedIndex, int, int) {
	var columnTypes map[string]string
	if len(plannedColumnTypes) > 0 {
		columnTypes = plannedColumnTypes[0]
	}
	grouped := groupIndexDefinitions(indexes)
	postSQL := make([]string, 0, len(grouped))
	unsupported := make([]string, 0)
	unmigrated := make([]UnmigratedIndex, 0)
	created := 0
	skipped := 0
	for _, idx := range grouped {
		name := strings.TrimSpace(idx.Name)
		if name == "" || strings.EqualFold(name, "primary") {
			continue
		}
		if lobColumn, ok := indexHitsUnindexableColumn(targetType, idx, columnTypes); ok {
			reason := fmt.Sprintf("索引 %s 的列 %s 在目标 %s 为大对象类型，不支持建索引，已跳过",
				name, lobColumn, strings.TrimSpace(targetType))
			unsupported = append(unsupported, reason)
			unmigrated = append(unmigrated, UnmigratedIndex{
				Name:                  name,
				Columns:               append([]IndexMigrationColumn(nil), idx.Columns...),
				Unique:                idx.Unique,
				IndexType:             idx.IndexType,
				ReasonCode:            "lob_column_not_indexable",
				Reason:                reason,
				RemediationStatements: buildIndexRemediationStatements(targetType, targetQueryTable, idx),
			})
			skipped++
			continue
		}
		if len(idx.Columns) == 0 {
			reason := fmt.Sprintf("索引 %s 缺少列定义，已跳过", name)
			unsupported = append(unsupported, reason)
			unmigrated = append(unmigrated, UnmigratedIndex{
				Name:       name,
				Columns:    []IndexMigrationColumn{},
				Unique:     idx.Unique,
				IndexType:  idx.IndexType,
				ReasonCode: "missing_columns",
				Reason:     reason,
			})
			skipped++
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(idx.IndexType))
		if isBTreeEquivalentIndexType(kind) && !hasIndexPrefix(idx.Columns) {
			postSQL = append(postSQL, buildCreateIndexSQL(targetType, targetQueryTable, idx, false))
			created++
			continue
		}

		reasonCode := "unsupported_index_type"
		reason := fmt.Sprintf("索引 %s 类型=%s，当前暂不支持等价自动迁移", name, idx.IndexType)
		if hasIndexPrefix(idx.Columns) {
			reasonCode = "prefix_index_requires_review"
			reason = fmt.Sprintf("索引 %s 使用前缀长度，当前目标方言暂不支持等价自动迁移", name)
		} else if kind == "fulltext" {
			reasonCode = "fulltext_requires_review"
		}
		unsupported = append(unsupported, reason)
		unmigrated = append(unmigrated, UnmigratedIndex{
			Name:                  name,
			Columns:               append([]IndexMigrationColumn(nil), idx.Columns...),
			Unique:                idx.Unique,
			IndexType:             idx.IndexType,
			ReasonCode:            reasonCode,
			Reason:                reason,
			RemediationStatements: buildIndexRemediationStatements(targetType, targetQueryTable, idx),
		})
		skipped++
	}
	return postSQL, dedupeStrings(unsupported), unmigrated, created, skipped
}

func intFromAny(v interface{}) int {
	switch typed := v.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		i, _ := strconv.Atoi(strings.TrimSpace(typed))
		return i
	default:
		return 0
	}
}

func isPGLikeSource(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb":
		return true
	default:
		return false
	}
}

func isPGLikeSameFamilyDDLType(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return true
	default:
		return false
	}
}
