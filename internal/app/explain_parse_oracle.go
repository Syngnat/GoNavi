package app

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// Oracle DBMS_XPLAN.DISPLAY 表格解析。
//
// 典型输出（FORMAT=ALL）：
//
//	Plan hash value: 1234567890
//
//	--------------------------------------------------------------------------------------------------
//	| Id  | Operation         | Name   | Rows  | Bytes | Cost (%CPU)| Time     |   Predicate Information    |
//	--------------------------------------------------------------------------------------------------
//	|   0 | SELECT STATEMENT  |        | 10000 |   200K|    50   (4)| 00:00:01 |                            |
//	|*  1 |  TABLE ACCESS FULL| USERS  | 10000 |   200K|    50   (4)| 00:00:01 | filter ("AGE">18)          |
//	--------------------------------------------------------------------------------------------------
//
//	Query Block Name / Object Alias (identified by operation id):
//	-------------------------------------------------------------
//	   1 - SEL$1 / USERS@SEL$1
//
//	Column Projection Information (identified by operation id):
//	-----------------------------------------------------------
//	   1 - "ID"[NUMBER,22], "NAME"[VARCHAR2,100]
//
// 解析要点：
//   - Id 列含 "*"（带 Predicate）或空格（无 Predicate）+ 数字 + 可能空格缩进
//   - Operation 列含前导空格（表达层级深度，每 2 空格代表一层）
//   - Name 列通常是表名或索引名
//   - Rows 是估算行数（Bytes 也会给但本解析器暂不消费）
//   - Cost (%CPU) 含百分比：50 (4) 表示 cost=50 CPU 占比 4%
//   - Predicate Information（下方独立段落）按 Operation Id 列出 Predicate 文本
//   - 多个段落用空行分隔，关键段落："Plan hash value"、"Query Block Name"、"Predicate Information"、"Column Projection"

func parseOracleExplain(sourceSQL, raw string, format connection.ExplainFormat) (connection.ExplainResult, error) {
	result := connection.ExplainResult{
		DBType:    "oracle",
		SourceSQL: sourceSQL,
	}

	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return result, fmt.Errorf("Oracle DBMS_XPLAN 输出为空")
	}

	// 抽取 Predicate Information 段落（按 id 索引）
	predicates := extractOraclePredicates(trimmed)

	// 抽取主表格
	tableSection := extractOraclePlanTable(trimmed)
	if tableSection == "" {
		result.RawFormat = connection.ExplainFormatText
		result.RawPayload = raw
		result.Warnings = []string{"未识别到 DBMS_XPLAN 表格段落，可能版本不兼容"}
		return result, nil
	}

	// 解析表格行（管道符分隔的列）
	rows := extractOracleTableRows(tableSection)
	if len(rows) == 0 {
		return result, fmt.Errorf("DBMS_XPLAN 表格无有效行")
	}

	// 解析列头识别列索引
	headerCols := splitOracleTableRow(rows[0])
	colID := findOracleColumnIndex(headerCols, "Id")
	colOp := findOracleColumnIndex(headerCols, "Operation")
	colName := findOracleColumnIndex(headerCols, "Name")
	colRows := findOracleColumnIndex(headerCols, "Rows")
	colCost := findOracleColumnIndex(headerCols, "Cost")
	colTime := findOracleColumnIndex(headerCols, "Time")
	colPredicate := findOracleColumnIndex(headerCols, "Predicate")
	if colID < 0 || colOp < 0 {
		return result, fmt.Errorf("DBMS_XPLAN 表格缺少 Id 或 Operation 列")
	}

	// 按 Operation 的缩进推断父子（每 2 个前导空格代表一层）
	type pendingNode struct {
		node   connection.ExplainNode
		indent int
	}
	var stack []pendingNode // 每层保留最近一个节点

	for i := 1; i < len(rows); i++ {
		cols := splitOracleTableRow(rows[i])
		if len(cols) == 0 {
			continue
		}
		idRaw := strings.TrimSpace(safeOracleColumn(cols, colID))
		idNum := parseOracleIDNumber(idRaw)
		if idNum < 0 {
			continue
		}
		opText := strings.TrimSpace(safeOracleColumn(cols, colOp))
		indent := countLeadingSpaces(safeOracleColumn(cols, colOp))
		name := strings.TrimSpace(safeOracleColumn(cols, colName))
		rowsEst := parseExplainInt64(strings.TrimSpace(safeOracleColumn(cols, colRows)))
		cost, _ := parseOracleCost(safeOracleColumn(cols, colCost))
		timeMs := parseOracleTimeMs(safeOracleColumn(cols, colTime))

		node := connection.ExplainNode{
			OpType:     classifyOracleOperation(opText),
			OpDetail:   opText,
			Table:      name,
			EstRows:    rowsEst,
			Cost:       cost,
			DurationMs: timeMs,
		}
		// TABLE ACCESS FULL 是全表扫描
		if isOracleFullScan(opText) {
			node.Flags = append(node.Flags, connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex)
		} else if isOracleIndexAccess(opText) {
			node.Index = name
		}
		// 关联 Predicate Information：先从表格内 Predicate 列取（简短摘要）
		if colPredicate >= 0 && colPredicate < len(cols) {
			predCell := strings.TrimSpace(safeOracleColumn(cols, colPredicate))
			if predCell != "" {
				if node.Extra == nil {
					node.Extra = map[string]any{}
				}
				node.Extra["filter"] = predCell
				if strings.Contains(strings.ToLower(predCell), "filter") {
					node.Flags = append(node.Flags, connection.ExplainFlagFullScan)
				}
			}
		}
		// 独立 Predicate Information 段落更详细，覆盖表格列的简短摘要
		if pred, ok := predicates[idNum]; ok && pred != "" {
			if node.Extra == nil {
				node.Extra = map[string]any{}
			}
			node.Extra["filter"] = pred
			if strings.Contains(strings.ToLower(pred), "filter") {
				node.Flags = append(node.Flags, connection.ExplainFlagFullScan)
			}
		}

		// 推断父子：弹出栈中 indent >= 当前的节点
		for len(stack) > 0 && stack[len(stack)-1].indent >= indent {
			stack = stack[:len(stack)-1]
		}
		parentNodeID := ""
		if len(stack) > 0 {
			parentNodeID = stack[len(stack)-1].node.ID
		}
		nodeID := appendExplainChild(&result, parentNodeID, node)
		stack = append(stack, pendingNode{node: connection.ExplainNode{ID: nodeID}, indent: indent})
	}

	result.RawFormat = connection.ExplainFormatTable
	result.RawPayload = raw
	finalizeExplainStats(&result)
	return result, nil
}

// extractOraclePlanTable 提取主表格段落。
// DBMS_XPLAN 表格结构：
//
//	[空行]
//	Plan hash value: ...
//	[空行]
//	---------    ← 上边界分隔线
//	| header |
//	---------    ← 表头/数据分隔（可选）
//	| data   |
//	---------    ← 下边界分隔线
//	[空行]       ← 表格段结束（之后的 Query Block Name / Predicate Information 等段落不再计入）
//
// 实现策略：找到第一条分隔线后开始累积；跳过所有分隔线、保留表头+数据；遇到空行结束。
func extractOraclePlanTable(raw string) string {
	lines := strings.Split(raw, "\n")
	startIdx := -1
	for i, line := range lines {
		if isOracleTableSeparator(line) {
			startIdx = i
			break
		}
	}
	if startIdx < 0 {
		return ""
	}
	var builder strings.Builder
	for i := startIdx; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			break // 空行 = 表格段结束
		}
		if isOracleTableSeparator(line) {
			continue // 跳过表格内的所有分隔线（上边界/表头分隔/下边界）
		}
		builder.WriteString(line)
		builder.WriteByte('\n')
	}
	return builder.String()
}

// isOracleTableSeparator 判断是否是 DBMS_XPLAN 表格的分隔线（全是 -）。
func isOracleTableSeparator(line string) bool {
	trimmed := strings.TrimSpace(line)
	if len(trimmed) < 10 {
		return false
	}
	for _, ch := range trimmed {
		if ch != '-' {
			return false
		}
	}
	return true
}

// extractOracleTableRows 提取表格的每行内容（去掉首尾管道符，保留中间内容）。
// 返回不含分隔线的纯数据行。
func extractOracleTableRows(table string) []string {
	lines := strings.Split(strings.TrimSpace(table), "\n")
	var rows []string
	for _, line := range lines {
		trimmed := strings.TrimRight(line, "\r\n ")
		if strings.TrimSpace(trimmed) == "" {
			continue
		}
		if isOracleTableSeparator(trimmed) {
			continue
		}
		rows = append(rows, trimmed)
	}
	return rows
}

// splitOracleTableRow 按管道符 | 切分行。
// 处理：去首尾管道符 → 按 | 切分 → 不 trim（保留前导空格用于缩进判断）。
func splitOracleTableRow(line string) []string {
	// 去掉首尾的 | 和前后空白
	text := strings.TrimSpace(line)
	text = strings.TrimPrefix(text, "|")
	text = strings.TrimSuffix(text, "|")
	if text == "" {
		return nil
	}
	parts := strings.Split(text, "|")
	// 不 trim，保留前导空格（用于 Operation 缩进分析）
	return parts
}

// findOracleColumnIndex 在表头中按列名查找索引。
func findOracleColumnIndex(headerCols []string, name string) int {
	target := strings.ToLower(strings.TrimSpace(name))
	for i, col := range headerCols {
		if strings.ToLower(strings.TrimSpace(col)) == target {
			return i
		}
	}
	// 模糊匹配（"Cost (%CPU)" 可能被切成 "Cost " 和 " (%CPU)"）
	for i, col := range headerCols {
		if strings.Contains(strings.ToLower(strings.TrimSpace(col)), target) {
			return i
		}
	}
	return -1
}

// safeOracleColumn 安全取 cols[idx]（idx 越界返回空）。
func safeOracleColumn(cols []string, idx int) string {
	if idx < 0 || idx >= len(cols) {
		return ""
	}
	return cols[idx]
}

// parseOracleIDNumber 解析 "Id" 列：形如 "  0"、"* 1"、" 2"。
// 返回数字部分；前缀 "*" 表示带 Predicate，返回正值；无数字返回 -1。
func parseOracleIDNumber(s string) int {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return -1
	}
	// 去掉可能的 Predicate 标记
	trimmed = strings.TrimLeft(trimmed, "* ")
	n, err := strconv.Atoi(trimmed)
	if err != nil {
		return -1
	}
	return n
}

// parseOracleCost 解析 "Cost (%CPU)" 列，形如 "50   (4)"。
// 返回 cost 数值 + CPU 百分比（百分比暂未使用）。
func parseOracleCost(s string) (float64, int) {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return 0, 0
	}
	// 取第一个空白前的数字
	for i, ch := range trimmed {
		if ch == ' ' || ch == '\t' {
			n, _ := strconv.ParseFloat(trimmed[:i], 64)
			return n, 0
		}
	}
	n, _ := strconv.ParseFloat(trimmed, 64)
	return n, 0
}

// parseOracleTimeMs 解析 "Time" 列，形如 "00:00:01"。
// 转换为毫秒（粗略，仅用于 stats）。
func parseOracleTimeMs(s string) float64 {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return 0
	}
	parts := strings.Split(trimmed, ":")
	if len(parts) != 3 {
		return 0
	}
	h, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
	m, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
	sec, _ := strconv.Atoi(strings.TrimSpace(parts[2]))
	return float64(h*3600+m*60+sec) * 1000
}

// countLeadingSpaces 数字符串的前导空格数（用于推断 Oracle Operation 缩进层级）。
func countLeadingSpaces(s string) int {
	n := 0
	for _, ch := range s {
		if ch == ' ' {
			n++
			continue
		}
		break
	}
	return n
}

// classifyOracleOperation 把 Oracle Operation 文本归一化。
// 形如 "TABLE ACCESS FULL" → SCAN；"INDEX RANGE SCAN" → INDEX_SCAN；"HASH JOIN" → JOIN。
func classifyOracleOperation(op string) string {
	upper := strings.ToUpper(strings.TrimSpace(op))
	switch {
	case strings.Contains(upper, "TABLE ACCESS") && strings.Contains(upper, "FULL"):
		return connection.ExplainOpScan
	case strings.Contains(upper, "INDEX") && (strings.Contains(upper, "RANGE SCAN") || strings.Contains(upper, "UNIQUE SCAN") || strings.Contains(upper, "SKIP SCAN")):
		return connection.ExplainOpIndexScan
	case strings.Contains(upper, "INDEX") && strings.Contains(upper, "FAST FULL"):
		return connection.ExplainOpIndexOnly
	case strings.Contains(upper, "HASH JOIN"):
		return connection.ExplainOpJoin
	case strings.Contains(upper, "NESTED LOOPS"):
		return connection.ExplainOpJoin
	case strings.Contains(upper, "MERGE JOIN"):
		return connection.ExplainOpJoin
	case strings.Contains(upper, "SORT") && strings.Contains(upper, "ORDER BY"):
		return connection.ExplainOpSort
	case strings.Contains(upper, "SORT") && strings.Contains(upper, "GROUP BY"):
		return connection.ExplainOpAggregate
	case strings.Contains(upper, "HASH GROUP BY") || strings.Contains(upper, "AGGREGATE"):
		return connection.ExplainOpAggregate
	case strings.Contains(upper, "COUNT"):
		return connection.ExplainOpAggregate
	case strings.Contains(upper, "VIEW"):
		return connection.ExplainOpOther
	case strings.Contains(upper, "UNION"):
		return connection.ExplainOpUnion
	case strings.Contains(upper, "FILTER"):
		return connection.ExplainOpFilter
	case strings.Contains(upper, "SELECT STATEMENT"):
		return connection.ExplainOpOther
	default:
		return connection.ExplainOpOther
	}
}

// isOracleFullScan 判断是否是全表扫描。
func isOracleFullScan(op string) bool {
	return strings.Contains(strings.ToUpper(op), "TABLE ACCESS") && strings.Contains(strings.ToUpper(op), "FULL")
}

// isOracleIndexAccess 判断是否是索引访问（用于决定 Name 字段是索引名）。
func isOracleIndexAccess(op string) bool {
	upper := strings.ToUpper(op)
	if !strings.Contains(upper, "INDEX") {
		return false
	}
	return strings.Contains(upper, "SCAN") || strings.Contains(upper, "RANGE") || strings.Contains(upper, "UNIQUE")
}

// extractOraclePredicates 从原文中提取 "Predicate Information" 段落，按 id 索引。
// 返回 map[int]string，键是 Operation Id，值是对应的 Predicate 文本（多行合并）。
func extractOraclePredicates(raw string) map[int]string {
	result := map[int]string{}
	lines := strings.Split(raw, "\n")
	inSection := false
	currentID := -1
	var buffer strings.Builder

	idPattern := regexp.MustCompile(`^\s*\*?(\d+)\s*-?\s*(.*)$`)

	flush := func() {
		if currentID >= 0 {
			text := strings.TrimSpace(buffer.String())
			if text != "" {
				result[currentID] = text
			}
		}
		currentID = -1
		buffer.Reset()
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)

		if strings.HasPrefix(lower, "predicate information") {
			inSection = true
			continue
		}
		if !inSection {
			continue
		}
		// 进入段落后的空行或下一个段落标题 → 结束
		if trimmed == "" || isOracleNextSectionHeader(lower) {
			flush()
			break
		}
		// 匹配 "  1 - access("ID"=1)" 或 "  1 - filter(...)"
		match := idPattern.FindStringSubmatch(line)
		if match != nil {
			flush()
			id, _ := strconv.Atoi(match[1])
			currentID = id
			buffer.WriteString(strings.TrimSpace(match[2]))
			continue
		}
		// 多行 Predicate 续行
		if currentID >= 0 {
			buffer.WriteByte(' ')
			buffer.WriteString(trimmed)
		}
	}
	flush()
	return result
}

// isOracleNextSectionHeader 判断是否是 DBMS_XPLAN 的下一个段落标题（结束 Predicate 段）。
func isOracleNextSectionHeader(lower string) bool {
	return strings.HasPrefix(lower, "query block name") ||
		strings.HasPrefix(lower, "column projection") ||
		strings.HasPrefix(lower, "note") ||
		strings.HasPrefix(lower, "hint")
}
