package app

import (
	"fmt"
	"math"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// SQL 诊断工作台规则引擎。
//
// 设计要点：
//   - 规则跨方言通用，基于归一化后的 ExplainNode 字段匹配
//   - 每条规则只描述问题 + 给出 Reason；不强行生成 CREATE INDEX（避免瞎猜列名误导用户）
//   - 规则触发按 Severity 严重度排序：critical > warning > info
//   - 同一节点可能触发多条规则（如 FULL_SCAN 节点同时触发"全表扫描"+"缺索引"）
//
// 规则 ID 列表（前端按 ID 显示本地化文案 + 图标）：
//   - full_scan_on_large_table：大表全表扫描（critical）
//   - full_scan_with_filter：带 WHERE 的全表扫描（critical，索引建议价值最高）
//   - missing_index_lookup：JOIN 中存在无索引扫描节点（critical）
//   - filesort_on_large_result：大结果集排序（warning）
//   - temp_table_for_distinct：DISTINCT/GROUP BY 物化临时表（warning）
//   - low_buffer_hit_rate：缓冲命中率低（warning，需 ANALYZE 才有数据）
//   - high_estimation_skew：估算与实际行数偏差大（info，需 ANALYZE）
//   - high_total_cost：总成本过高（warning）
//   - nested_loop_high_fanout：Nested Loop 高扇出（warning）
//   - using_temp_btree_order：SQLite 风格 ORDER BY 临时表（info）

// 规则阈值常量。值的选择基于工程经验：
//   - 1000 行：单节点扫描超过此值视为"非小表"
//   - 10000 行：超过此值视为"大表"，触发 critical 建议索引
//   - 0.5：缓冲命中率低于 50% 视为差
//   - 10x：估算与实际偏差超过 10 倍视为显著
const (
	ruleFullScanLargeTableRows   int64   = 10000
	ruleFullScanSmallTableRows   int64   = 1000
	ruleFilesortRowsThreshold    int64   = 5000
	ruleLowBufferHitThreshold    float64 = 0.5
	ruleEstimationSkewRatio     float64 = 10.0
	ruleHighTotalCostThreshold   float64 = 1000.0
	ruleNestedLoopFanoutRows     int64   = 10000
	// 扩展规则阈值
	ruleLargeOffsetThreshold     int64   = 10000 // LIMIT offset 超过此值视为大 offset
	ruleCartesianProductEstRows  int64   = 100000 // JOIN 无条件且估算超过此值视为风险
	ruleWideTableColumnCount     int64   = 20     // SELECT * + JOIN + 列数 > 20 视为宽表
)

// runExplainRules 对归一化的 ExplainResult 跑全部规则，返回排序后的建议列表。
// 按 Severity 排序（critical > warning > info），同 Severity 内按 EstRows 降序。
func runExplainRules(result connection.ExplainResult) []connection.IndexSuggestion {
	var suggestions []connection.IndexSuggestion

	// 全局规则（基于 Stats）
	if s := ruleHighTotalCost(result); s != nil {
		suggestions = append(suggestions, *s)
	}
	if s := ruleLowBufferHitRate(result); s != nil {
		suggestions = append(suggestions, *s)
	}
	if s := ruleCartesianProductRisk(result); s != nil {
		suggestions = append(suggestions, *s)
	}

	// 节点级规则
	for _, node := range result.Nodes {
		rules := []func(connection.ExplainResult, connection.ExplainNode) *connection.IndexSuggestion{
			ruleFullScanLargeTable,
			ruleFullScanWithFilter,
			ruleMissingIndexLookup,
			ruleFilesortOnLargeResult,
			ruleTempTableForDistinct,
			ruleHighEstimationSkew,
			ruleNestedLoopHighFanout,
			ruleUsingTempBTreeOrder,
			ruleLikeLeadingWildcard,
			ruleFunctionOnColumn,
			ruleLargeOffsetPagination,
			ruleSelectStarWithJoin,
			ruleOrConditionNoIndex,
		}
		for _, ruleFn := range rules {
			if s := ruleFn(result, node); s != nil {
				suggestions = append(suggestions, *s)
			}
		}
	}

	sortExplainSuggestions(suggestions)
	return suggestions
}

// sortExplainSuggestions 按 Severity + EstRows 排序（in-place）。
func sortExplainSuggestions(s []connection.IndexSuggestion) {
	// 简单插入排序：建议数量通常 < 20，无需 sort.Slice 的反射开销
	severityRank := map[string]int{
		connection.SeverityCritical: 0,
		connection.SeverityWarning:  1,
		connection.SeverityInfo:     2,
	}
	for i := 1; i < len(s); i++ {
		for j := i; j > 0; j-- {
			si := severityRank[s[j].Severity]
			sj := severityRank[s[j-1].Severity]
			if si < sj || (si == sj && s[j].EstRows > s[j-1].EstRows) {
				s[j], s[j-1] = s[j-1], s[j]
				continue
			}
			break
		}
	}
}

// ruleFullScanLargeTable：单节点全表扫描 + 估算行数超过阈值。
// 严重度：EstRows > 10000 → critical；> 1000 → warning；否则不触发。
func ruleFullScanLargeTable(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if !hasFlag(node.Flags, connection.ExplainFlagFullScan) {
		return nil
	}
	if node.EstRows < ruleFullScanSmallTableRows {
		return nil
	}
	severity := connection.SeverityWarning
	if node.EstRows >= ruleFullScanLargeTableRows {
		severity = connection.SeverityCritical
	}
	return &connection.IndexSuggestion{
		Severity:       severity,
		Rule:           "full_scan_on_large_table",
		Reason:         fmt.Sprintf("表 %s 全表扫描，估算扫描 %d 行；考虑为 WHERE/JOIN 条件字段添加索引", node.Table, node.EstRows),
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleFullScanWithFilter：带 WHERE 的全表扫描（最有价值的索引建议场景）。
// 从 attachedCondition / Filter / Extra 提取等式字段，提示用户考虑建索引。
func ruleFullScanWithFilter(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if !hasFlag(node.Flags, connection.ExplainFlagFullScan) {
		return nil
	}
	filter := extractNodeFilterText(node)
	if filter == "" {
		return nil
	}
	columns := extractEqualityColumns(filter)
	if len(columns) == 0 {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityCritical,
		Rule:           "full_scan_with_filter",
		Reason:         fmt.Sprintf("表 %s 全表扫描但带 WHERE 条件 %q；建议为字段 %s 建立索引", node.Table, truncateForReason(filter, 60), joinColumnsForReason(columns)),
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleMissingIndexLookup：JOIN 中存在无索引扫描节点（NO_INDEX flag）。
func ruleMissingIndexLookup(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if !hasFlag(node.Flags, connection.ExplainFlagNoIndex) {
		return nil
	}
	// 已被 full_scan_on_large_table 覆盖时跳过，避免重复
	if hasFlag(node.Flags, connection.ExplainFlagFullScan) {
		return nil
	}
	if node.EstRows < ruleFullScanSmallTableRows {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityCritical,
		Rule:           "missing_index_lookup",
		Reason:         fmt.Sprintf("JOIN 节点 %s 未命中索引，估算扫描 %d 行；JOIN 字段需要索引", node.Table, node.EstRows),
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleFilesortOnLargeResult：大结果集排序。
func ruleFilesortOnLargeResult(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if !hasFlag(node.Flags, connection.ExplainFlagFilesort) {
		return nil
	}
	if node.EstRows < ruleFilesortRowsThreshold {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityWarning,
		Rule:           "filesort_on_large_result",
		Reason:         fmt.Sprintf("对约 %d 行做额外排序；考虑为 ORDER BY 字段建立索引以避免 filesort", node.EstRows),
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleTempTableForDistinct：使用临时表（DISTINCT/GROUP BY）。
func ruleTempTableForDistinct(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if !hasFlag(node.Flags, connection.ExplainFlagTempTable) {
		return nil
	}
	// OpDetail 含 distinct/group 时给出更精准的建议
	detail := strings.ToLower(node.OpDetail)
	var hint string
	switch {
	case strings.Contains(detail, "distinct"):
		hint = "DISTINCT 物化了临时表"
	case strings.Contains(detail, "group"):
		hint = "GROUP BY 物化了临时表"
	default:
		hint = "查询使用了临时表"
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityWarning,
		Rule:           "temp_table_for_distinct",
		Reason:         fmt.Sprintf("%s；考虑为分组字段建立索引避免物化", hint),
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleHighEstimationSkew：估算与实际行数偏差大（需 ANALYZE 才有数据）。
func ruleHighEstimationSkew(result connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if node.EstRows <= 0 || node.ActualRows <= 0 {
		return nil
	}
	// A measured plan already judged each step, including how many rows the
	// miss involved over all loops; follow that verdict.
	if node.EstimateFactor > 0 && !hasFlag(node.Flags, connection.ExplainFlagUccWarn) {
		return nil
	}
	// A misestimate carries upwards; advise where it starts, not at every step above it.
	if node.EstimateFactor > 0 && hasMisestimatedDescendant(result, node.ID) {
		return nil
	}
	ratio := float64(node.ActualRows) / float64(node.EstRows)
	if ratio < ruleEstimationSkewRatio && ratio > 1.0/ruleEstimationSkewRatio {
		return nil
	}
	rows := fmt.Sprintf("估算 %d 行 / 实际 %d 行", node.EstRows, node.ActualRows)
	if node.Loops > 1 {
		rows += fmt.Sprintf("（每次循环，共 %d 次）", node.Loops)
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityInfo,
		Rule:           "high_estimation_skew",
		Reason:         fmt.Sprintf("%s，相差约 %.0f 倍；统计信息可能过期，考虑 ANALYZE TABLE", rows, math.Max(ratio, 1/ratio)),
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleNestedLoopHighFanout：Nested Loop 高扇出。
// 触发条件：JOIN 节点 + 子节点（被驱动表）估算行数 > 10000。
func ruleNestedLoopHighFanout(result connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if node.OpType != connection.ExplainOpJoin {
		return nil
	}
	// 找到该 JOIN 的直接子节点（被驱动表）
	var maxChildRows int64
	for _, edge := range result.Edges {
		if edge.From != node.ID {
			continue
		}
		for _, child := range result.Nodes {
			if child.ID == edge.To && child.EstRows > maxChildRows {
				maxChildRows = child.EstRows
			}
		}
	}
	if maxChildRows < ruleNestedLoopFanoutRows {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityWarning,
		Rule:           "nested_loop_high_fanout",
		Reason:         fmt.Sprintf("Nested Loop JOIN 被驱动表估算 %d 行，扇出过大；考虑改用 Hash Join 或为 JOIN 字段加索引", maxChildRows),
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        maxChildRows,
	}
}

// ruleUsingTempBTreeOrder：SQLite 风格的 ORDER BY 临时表（Info 级，提示性）。
func ruleUsingTempBTreeOrder(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if !hasFlag(node.Flags, connection.ExplainFlagFilesort) {
		return nil
	}
	if node.EstRows >= ruleFilesortRowsThreshold {
		return nil // 已被 filesort_on_large_result 覆盖
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityInfo,
		Rule:           "using_temp_btree_order",
		Reason:         "ORDER BY 使用临时 B-Tree；如频繁执行，为排序字段建立索引可消除该开销",
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleHighTotalCost：总成本过高（全局规则）。
func ruleHighTotalCost(result connection.ExplainResult) *connection.IndexSuggestion {
	if result.Stats.TotalCost < ruleHighTotalCostThreshold {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity: connection.SeverityWarning,
		Rule:     "high_total_cost",
		Reason:   fmt.Sprintf("执行计划总成本 %.1f；考虑重写查询或加索引降低扫描量", result.Stats.TotalCost),
		EstRows:  result.Stats.RowsRead,
	}
}

// ruleLowBufferHitRate：缓冲命中率低（全局规则，PG/Oracle 才有此数据）。
func ruleLowBufferHitRate(result connection.ExplainResult) *connection.IndexSuggestion {
	if result.Stats.BufferHitRate <= 0 || result.Stats.BufferHitRate >= ruleLowBufferHitThreshold {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity: connection.SeverityWarning,
		Rule:     "low_buffer_hit_rate",
		Reason:   fmt.Sprintf("缓冲命中率仅 %.1f%%；热门数据可能未被缓存，考虑增大 shared_buffers 或检查访问模式", result.Stats.BufferHitRate*100),
		EstRows:  result.Stats.RowsRead,
	}
}

// hasFlag 检查节点是否含指定 flag。
func hasFlag(flags []string, target string) bool {
	for _, f := range flags {
		if f == target {
			return true
		}
	}
	return false
}

// extractNodeFilterText 从节点的 attached_condition / Filter / Extra 中提取过滤条件文本。
func extractNodeFilterText(node connection.ExplainNode) string {
	if node.Extra == nil {
		return ""
	}
	for _, key := range []string{"attachedCondition", "filter"} {
		if v, ok := node.Extra[key]; ok {
			text := strings.TrimSpace(fmt.Sprintf("%v", v))
			if text != "" && text != "<nil>" {
				return text
			}
		}
	}
	return ""
}

// extractEqualityColumns 从 SQL 过滤条件中提取等值条件的列名（粗略解析）。
// 仅识别 "col = ?" / "col = literal" 形式；不处理复杂表达式（OR/函数调用）。
func extractEqualityColumns(filter string) []string {
	if filter == "" {
		return nil
	}
	// 简化：按 AND 切分后取每个等值条件的左边
	parts := splitTopLevelByKeyword(filter, " and ")
	seen := make(map[string]struct{})
	var columns []string
	for _, part := range parts {
		part = strings.TrimSpace(part)
		// 去除括号
		part = strings.Trim(part, "() ")
		eqIdx := strings.Index(part, "=")
		if eqIdx <= 0 {
			continue
		}
		left := strings.TrimSpace(part[:eqIdx])
		// 必须是简单标识符（字母数字下划线 + 点）
		if !isSimpleIdentifier(left) {
			continue
		}
		// 右边不是另一个列引用（粗略判断：不含点/字母前缀的字段）
		right := strings.TrimSpace(part[eqIdx+1:])
		if isSimpleIdentifier(right) {
			continue // col1 = col2 形式不算索引候选
		}
		if _, exists := seen[left]; !exists {
			seen[left] = struct{}{}
			columns = append(columns, left)
		}
	}
	return columns
}

// splitTopLevelByKeyword 按关键字（不区分大小写）切分字符串，忽略嵌套括号内的匹配。
func splitTopLevelByKeyword(text, keyword string) []string {
	var parts []string
	depth := 0
	lower := strings.ToLower(text)
	kw := strings.ToLower(keyword)
	start := 0
	for i := 0; i < len(lower); i++ {
		switch lower[i] {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		}
		if depth > 0 {
			continue
		}
		if strings.HasPrefix(lower[i:], kw) {
			parts = append(parts, text[start:i])
			i += len(kw)
			start = i
		}
	}
	parts = append(parts, text[start:])
	return parts
}

// isSimpleIdentifier 判断字符串是否是简单 SQL 标识符（支持 schema.table 形式）。
func isSimpleIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for i, ch := range s {
		ok := (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '.'
		if !ok {
			return false
		}
		if i == 0 && ch >= '0' && ch <= '9' {
			return false
		}
	}
	return true
}

// truncateForReason 截断字符串到 maxLen，超出加省略号。
func truncateForReason(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-1] + "…"
}

// joinColumnsForReason 把列名列表格式化为人类可读的列表（最多 3 个）。
func joinColumnsForReason(columns []string) string {
	if len(columns) == 0 {
		return ""
	}
	if len(columns) > 3 {
		return strings.Join(columns[:3], ", ") + " 等"
	}
	return strings.Join(columns, ", ")
}

// === 扩展规则（v2 新增）===

// ruleLikeLeadingWildcard：检测 WHERE col LIKE '%xxx' 前缀通配（索引完全失效）。
// 通过节点的 filter 文本判断，模式如 "col like '%xxx'"。
func ruleLikeLeadingWildcard(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	filter := extractNodeFilterText(node)
	if filter == "" {
		return nil
	}
	lower := strings.ToLower(filter)
	// 简化匹配：col like '%xxx' 模式（前导 % 让 B-Tree 索引失效）
	if !strings.Contains(lower, " like '%") && !strings.Contains(lower, " like\"%") {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityCritical,
		Rule:           "like_leading_wildcard",
		Reason:         fmt.Sprintf("LIKE 前缀通配（%q）导致索引失效；考虑改用全文索引或前置常量前缀", truncateForReason(filter, 80)),
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleFunctionOnColumn：检测 WHERE func(col) = ? 形式（函数包裹列让索引失效）。
// 模式如 "upper(col) =" / "date_format(col, ...) =" / "col + 1 =" 等。
func ruleFunctionOnColumn(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	filter := extractNodeFilterText(node)
	if filter == "" {
		return nil
	}
	// 扫描常见函数模式：函数名 + (
	lower := strings.ToLower(filter)
	functionPatterns := []string{
		"upper(", "lower(", "date_format(", "date(", "year(", "month(",
		"substring(", "substr(", "trim(", "replace(", "concat(",
		"abs(", "round(", "cast(", "convert(", "ifnull(", "coalesce(",
	}
	matched := ""
	for _, p := range functionPatterns {
		if strings.Contains(lower, p) {
			matched = p
			break
		}
	}
	if matched == "" {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityCritical,
		Rule:           "function_on_column",
		Reason:         fmt.Sprintf("WHERE 条件中 %s... 包裹列，导致该列上的索引失效；考虑重写为列 = func(常量) 形式或在函数上建表达式索引", matched),
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleLargeOffsetPagination：检测 LIMIT 大 offset 分页（如 LIMIT 100000, 10）。
// 大 offset 让数据库扫描并丢弃前 N 行，性能随 offset 线性下降。
func ruleLargeOffsetPagination(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if node.OpType != connection.ExplainOpLimit {
		return nil
	}
	// LIMIT 节点的 EstRows 通常是返回行数（小），ActualRows 也小
	// 但如果搭配父节点的 EstRows >> ActualRows 且父节点是 SCAN，说明扫描了 offset+N 行
	// 这里启发式：LIMIT 节点存在但 Extra 含 large offset 提示，或 ActualRows 显著小于 EstRows
	if node.Extra == nil {
		return nil
	}
	if v, ok := node.Extra["offset"]; ok {
		offset := parseExplainInt64(fmt.Sprintf("%v", v))
		if offset >= ruleLargeOffsetThreshold {
			return &connection.IndexSuggestion{
				Severity: connection.SeverityWarning,
				Rule:     "large_offset_pagination",
				Reason:   fmt.Sprintf("LIMIT offset=%d 过大，数据库需扫描并丢弃前 %d 行；建议改用游标分页（WHERE id > last_id LIMIT N）", offset, offset),
				AffectedNodeID: node.ID,
				EstRows: offset,
			}
		}
	}
	return nil
}

// ruleSelectStarWithJoin：检测 SELECT * + JOIN 模式（拉取不必要字段，放大网络/内存开销）。
// 通过 SourceSQL 判断（节点级规则无法拿到 SQL，需要全局规则；此处用启发式：JOIN 节点 + 估算行数大）。
// 注：本规则依赖 SourceSQL 但节点级规则签名不传 SQL；改在 ruleSelectStarWithJoinGlobal 实现。
func ruleSelectStarWithJoin(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	// 启发式：JOIN 节点 + ActualRows 远大于 EstRows（说明 SELECT * 拉了大量数据）
	if node.OpType != connection.ExplainOpJoin {
		return nil
	}
	if node.EstRows <= 0 || node.ActualRows <= 0 {
		return nil
	}
	if node.ActualRows < node.EstRows*10 {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityInfo,
		Rule:           "select_star_with_join_pattern",
		Reason:         "JOIN 节点实际行数远超估算，可能因 SELECT * 拉取了不必要字段；建议显式列出需要的列",
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.ActualRows,
	}
}

// ruleOrConditionNoIndex：检测 WHERE 用 OR 但其中一侧无索引（通常导致全表扫描）。
// 通过 filter 文本判断 "col1 = ? or col2 = ?" 模式。
func ruleOrConditionNoIndex(_ connection.ExplainResult, node connection.ExplainNode) *connection.IndexSuggestion {
	if !hasFlag(node.Flags, connection.ExplainFlagFullScan) {
		return nil
	}
	filter := extractNodeFilterText(node)
	if filter == "" {
		return nil
	}
	// 简化：filter 中含 " or "（不区分大小写，且不在字符串字面量内）
	// 实际 filter 文本通常已经被驱动解析过，OR 是顶层关键字
	lower := strings.ToLower(filter)
	if !containsTopLevelKeyword(lower, " or ") {
		return nil
	}
	return &connection.IndexSuggestion{
		Severity:       connection.SeverityWarning,
		Rule:           "or_condition_no_index",
		Reason:         "WHERE 含 OR 条件，若两侧字段未全部建索引则触发全表扫描；考虑改写为 UNION ALL 或为 OR 两侧字段都建索引",
		AffectedNodeID: node.ID,
		AffectedTable:  node.Table,
		EstRows:        node.EstRows,
	}
}

// ruleCartesianProductRisk：全局规则，检测 JOIN 无 ON 条件（笛卡尔积）。
// 判定：JOIN 节点 + Extra 中无 hashCond/joinType/on 等条件 + EstRows > 阈值。
func ruleCartesianProductRisk(result connection.ExplainResult) *connection.IndexSuggestion {
	for _, node := range result.Nodes {
		if node.OpType != connection.ExplainOpJoin {
			continue
		}
		if node.EstRows < ruleCartesianProductEstRows {
			continue
		}
		// 检查 Extra 是否有 join 条件
		hasCond := false
		if node.Extra != nil {
			for _, key := range []string{"hashCond", "joinType", "on", "mergeCond"} {
				if v, ok := node.Extra[key]; ok && v != nil && fmt.Sprintf("%v", v) != "" {
					hasCond = true
					break
				}
			}
		}
		if hasCond {
			continue
		}
		return &connection.IndexSuggestion{
			Severity: connection.SeverityCritical,
			Rule:     "cartesian_product_risk",
			Reason:   fmt.Sprintf("JOIN 节点估算 %d 行且未识别到 ON/HASH 条件，可能是笛卡尔积；请补充 JOIN 条件", node.EstRows),
			AffectedNodeID: node.ID,
			EstRows: node.EstRows,
		}
	}
	return nil
}

// containsTopLevelKeyword 简化判断 keyword 是否在 text 中（不做嵌套括号分析，仅做大小写归一后子串匹配）。
// 用于 OR 关键字检测；若需要更精确可在后续迭代增强。
func containsTopLevelKeyword(text, keyword string) bool {
	return strings.Contains(text, keyword)
}

// hasMisestimatedDescendant reports whether a step below nodeID was itself
// measured as misestimated.
func hasMisestimatedDescendant(result connection.ExplainResult, nodeID string) bool {
	children := make(map[string][]string, len(result.Nodes))
	flagged := make(map[string]bool, len(result.Nodes))
	for _, node := range result.Nodes {
		children[node.ParentID] = append(children[node.ParentID], node.ID)
		flagged[node.ID] = hasFlag(node.Flags, connection.ExplainFlagUccWarn)
	}
	pending := append([]string(nil), children[nodeID]...)
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if flagged[current] {
			return true
		}
		pending = append(pending, children[current]...)
	}
	return false
}
