package app

import (
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// SQLite EXPLAIN QUERY PLAN 解析。
//
// SQLite EQP 输出是 4 列表格：
//
//	id | parent | notused | detail
//	2  | 0      | 0       | SCAN TABLE t
//	3  | 0      | 0       | SEARCH TABLE t USING INDEX idx_x (col=?)
//	7  | 0      | 0       | USE TEMP B-TREE FOR ORDER BY
//	21 | 0      | 0       | COMPOUND QUERY
//	22 | 0      | 0       | USE TEMP B-TREE FOR LAST DISTINCT
//
// id 字段语义：
//   - 同一 id 多行：同一节点的多个细节行（如"SCAN" + "USE TEMP B-TREE"）
//   - 不同 id：不同节点；parent 字段指向父节点 id
//
// detail 文本模式：
//   - "SCAN TABLE <name>" 或 "SCAN <name>"：全表扫描
//   - "SEARCH TABLE <name> USING INDEX <idx> (<cols>)"：索引扫描
//   - "SEARCH TABLE <name> USING PRIMARY KEY (<cols>)"：主键扫描
//   - "USE TEMP B-TREE FOR ORDER BY"：filesort
//   - "USE TEMP B-TREE FOR DISTINCT"：临时表
//   - "COMPOUND QUERY"：UNION/INTERSECT 等
//   - "CORRELATED SCALAR SUBQUERY"：子查询
//   - "CO-ROUTINE <name>"：协程

func parseSQLiteExplain(sourceSQL, raw string, format connection.ExplainFormat) (connection.ExplainResult, error) {
	result := connection.ExplainResult{
		DBType:    "sqlite",
		SourceSQL: sourceSQL,
	}

	header, rows := parseExplainTSVRows(raw)
	if len(header) == 0 || len(rows) == 0 {
		return result, fmt.Errorf("SQLite EQP 输出无有效行")
	}

	colID := lookupTSVColumn(header, "id")
	colParent := lookupTSVColumn(header, "parent")
	colDetail := lookupTSVColumn(header, "detail")
	if colID < 0 || colDetail < 0 {
		return result, fmt.Errorf("SQLite EQP 输出缺少 id 或 detail 列")
	}

	// 同一 id 多行：合并 detail 后作为单节点
	// 不同 id 的父子通过 parent 关联
	type eqpEntry struct {
		ID       string
		ParentID string
		Details  []string
		NodeID   string // 归一化后的 ExplainNode.ID
	}
	entries := make(map[string]*eqpEntry)
	var order []string // 保持 id 出现顺序

	for _, row := range rows {
		var id, parent, detail string
		if colID < len(row) {
			id = strings.TrimSpace(row[colID])
		}
		if colParent >= 0 && colParent < len(row) {
			parent = strings.TrimSpace(row[colParent])
		}
		if colDetail < len(row) {
			detail = strings.TrimSpace(row[colDetail])
		}
		if id == "" {
			continue
		}

		entry, exists := entries[id]
		if !exists {
			entry = &eqpEntry{ID: id, ParentID: parent}
			entries[id] = entry
			order = append(order, id)
		}
		if detail != "" {
			entry.Details = append(entry.Details, detail)
		}
	}

	// 按 id 出现顺序生成节点（SQLite 保证父先于子）
	for _, id := range order {
		entry := entries[id]
		node := buildSQLiteNodeFromDetails(entry.Details)
		parentNodeID := ""
		if entry.ParentID != "" && entry.ParentID != "0" {
			if parent, ok := entries[entry.ParentID]; ok && parent.NodeID != "" {
				parentNodeID = parent.NodeID
			}
		}
		entry.NodeID = appendExplainChild(&result, parentNodeID, node)
	}

	result.RawFormat = connection.ExplainFormatTable
	result.RawPayload = raw
	finalizeExplainStats(&result)
	return result, nil
}

// buildSQLiteNodeFromDetails 把 SQLite EQP 的多个 detail 行合并为单节点。
// 第一行通常是主操作（SCAN/SEARCH），后续行是附加标志（USE TEMP B-TREE 等）。
//
// 注意：SQLite 在某些场景下 "USE TEMP B-TREE ..." 会作为独立 id 出现（不是 SCAN 的附加行），
// 此时主操作本身就是 USE TEMP B-TREE，需要识别为附加 flag 节点（OpType 保持 OTHER）。
func buildSQLiteNodeFromDetails(details []string) connection.ExplainNode {
	node := connection.ExplainNode{OpType: connection.ExplainOpOther}
	if len(details) == 0 {
		return node
	}

	// 主操作从第一行解析
	primary := details[0]
	node.OpDetail = primary
	lower := strings.ToLower(primary)

	switch {
	case strings.HasPrefix(lower, "scan"):
		node.OpType = connection.ExplainOpScan
		node.Table = extractSQLiteTableName(primary)
		node.Flags = append(node.Flags, connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex)
	case strings.HasPrefix(lower, "search"):
		node.OpType = classifySQLiteSearchOp(primary)
		node.Table = extractSQLiteTableName(primary)
		node.Index = extractSQLiteIndexName(primary)
	case strings.HasPrefix(lower, "compound"):
		node.OpType = connection.ExplainOpUnion
	case strings.HasPrefix(lower, "correlated"), strings.HasPrefix(lower, "scalar subquery"):
		node.OpType = connection.ExplainOpSubquery
	case strings.HasPrefix(lower, "co-routine"):
		node.OpType = connection.ExplainOpOther
	case strings.HasPrefix(lower, "use temp b-tree"):
		// 独立 id 形式的附加 flag 节点：直接打 flag，OpType 保持 OTHER
		if strings.Contains(lower, "order by") {
			node.Flags = append(node.Flags, connection.ExplainFlagFilesort)
		} else {
			node.Flags = append(node.Flags, connection.ExplainFlagTempTable)
		}
	}

	// 后续行是附加 flag（仅当主行不是 USE TEMP B-TREE 时才处理，避免重复）
	if !strings.HasPrefix(lower, "use temp b-tree") {
		for _, d := range details[1:] {
			dl := strings.ToLower(d)
			switch {
			case strings.Contains(dl, "temp b-tree"):
				if strings.Contains(dl, "order by") {
					node.Flags = append(node.Flags, connection.ExplainFlagFilesort)
				} else {
					node.Flags = append(node.Flags, connection.ExplainFlagTempTable)
				}
			case strings.Contains(dl, "subquery"):
				node.Flags = append(node.Flags, "SUBQUERY")
			}
			if node.Extra == nil {
				node.Extra = map[string]any{}
			}
			node.Extra["extra"] = d
		}
	}
	return node
}

// classifySQLiteSearchOp 区分 SQLite SEARCH 的索引类型。
// USING INDEX → INDEX_SCAN；USING PRIMARY KEY → INDEX_SCAN；USING ROWID → SCAN（伪索引扫描）。
func classifySQLiteSearchOp(detail string) string {
	lower := strings.ToLower(detail)
	if strings.Contains(lower, "using covering index") {
		return connection.ExplainOpIndexOnly
	}
	if strings.Contains(lower, "using index") || strings.Contains(lower, "using primary key") {
		return connection.ExplainOpIndexScan
	}
	if strings.Contains(lower, "using rowid") {
		// ROWID 扫描本质还是按物理位置顺序访问
		return connection.ExplainOpScan
	}
	return connection.ExplainOpIndexScan
}

// extractSQLiteTableName 从 detail 文本中提取表名。
// 形如 "SCAN TABLE users" → "users"；"SEARCH TABLE users USING INDEX idx_x (id)" → "users"。
func extractSQLiteTableName(detail string) string {
	upper := strings.ToUpper(detail)
	for _, marker := range []string{"TABLE ", "VIEW "} {
		idx := strings.Index(upper, marker)
		if idx < 0 {
			continue
		}
		rest := detail[idx+len(marker):]
		// 截到下一个空格或 USING 之前
		for i, ch := range rest {
			if ch == ' ' || ch == '\t' {
				return strings.TrimSpace(rest[:i])
			}
		}
		return strings.TrimSpace(rest)
	}
	return ""
}

// extractSQLiteIndexName 从 detail 中提取使用的索引名。
// 形如 "USING INDEX idx_x (id)" → "idx_x"；"USING PRIMARY KEY" → "PRIMARY"。
func extractSQLiteIndexName(detail string) string {
	upper := strings.ToUpper(detail)
	for _, marker := range []string{"USING INDEX ", "USING PRIMARY KEY", "USING COVERING INDEX "} {
		idx := strings.Index(upper, marker)
		if idx < 0 {
			continue
		}
		rest := detail[idx+len(marker):]
		if marker == "USING PRIMARY KEY" {
			return "PRIMARY"
		}
		// 截到下一个空格或左括号
		for i, ch := range rest {
			if ch == ' ' || ch == '\t' || ch == '(' {
				if i == 0 {
					return ""
				}
				name := strings.TrimSpace(rest[:i])
				if _, err := strconv.Atoi(name); err == nil {
					continue
				}
				return name
			}
		}
		return strings.TrimSpace(rest)
	}
	return ""
}
