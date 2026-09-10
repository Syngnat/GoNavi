package connection

import "time"

// SQL 诊断工作台数据结构。
//
// 设计要点：
//   - 节点用扁平数组 + ParentID 表达父子（不用嵌套树），便于前端 react-flow 渲染和按 ID 检索
//   - 跨方言归一化：不论 MySQL/PG/Oracle 输出，统一映射到 ExplainNode.OpType + Flags
//   - 原文保留（RawPayload）用于调试和前端展开查看
//   - 与 ResultSetData 同包，便于 Wails 绑定自动生成 TS 类型

// ExplainFormat 标识 EXPLAIN 原始输出的格式，决定解析器路径。
type ExplainFormat string

const (
	ExplainFormatJSON  ExplainFormat = "json"  // MySQL 8.0 FORMAT=JSON / PG FORMAT JSON / ClickHouse JSON
	ExplainFormatTable ExplainFormat = "table" // MySQL 5.7 表格 / SQLite EQP / Oracle DBMS_XPLAN
	ExplainFormatXML   ExplainFormat = "xml"   // SQLServer SHOWPLAN_XML
	ExplainFormatText  ExplainFormat = "text"  // 兜底，无法归类时
)

// 节点操作类型（归一化后跨方言通用）。
const (
	ExplainOpScan        = "SCAN"        // 全表扫描 / 顺序扫描
	ExplainOpIndexScan   = "INDEX_SCAN"  // 索引扫描（ref/eq_ref/range）
	ExplainOpIndexOnly   = "INDEX_ONLY"  // Using index 覆盖索引
	ExplainOpJoin        = "JOIN"        // 任意 JOIN 类型（Nested Loop / Hash / Merge）
	ExplainOpAggregate   = "AGGREGATE"   // GROUP BY / DISTINCT / 聚合函数
	ExplainOpSort        = "SORT"        // filesort / ORDER BY
	ExplainOpLimit       = "LIMIT"       // LIMIT 截断
	ExplainOpFilter      = "FILTER"      // WHERE/HAVING 过滤
	ExplainOpSubquery    = "SUBQUERY"    // 子查询
	ExplainOpUnion       = "UNION"       // UNION 合并
	ExplainOpWindow      = "WINDOW"      // 窗口函数
	ExplainOpMaterialize = "MATERIALIZE" // 物化临时表
	ExplainOpInsert      = "INSERT"      // INSERT 操作（EXPLAIN INSERT）
	ExplainOpUpdate      = "UPDATE"
	ExplainOpDelete      = "DELETE"
	ExplainOpOther       = "OTHER" // 无法归类
)

// 节点警告标志（用于规则匹配和前端高亮）。
const (
	ExplainFlagFullScan     = "FULL_SCAN"      // 全表扫描
	ExplainFlagFilesort     = "FILESORT"       // 额外排序
	ExplainFlagTempTable    = "TEMP_TABLE"     // 使用临时表
	ExplainFlagNoIndex      = "NO_INDEX"       // 未命中索引
	ExplainFlagHighCost     = "HIGH_COST"      // 成本显著高于其他节点
	ExplainFlagLowBufferHit = "LOW_BUFFER_HIT" // 缓冲命中率低（PG BUFFERS）
	ExplainFlagUccWarn      = "UNCERTAIN_ROWS" // 估算行数不确定（rows=0 或巨大偏差）
)

// 索引建议严重度。
const (
	SeverityCritical = "critical" // 严重影响性能（如大表全表扫描）
	SeverityWarning  = "warning"  // 有改进空间
	SeverityInfo     = "info"     // 优化建议
)

// ExplainNode 表示执行计划中的一个节点（归一化后跨方言通用）。
type ExplainNode struct {
	ID         string         `json:"id"`
	ParentID   string         `json:"parentId,omitempty"`
	OpType     string         `json:"opType"`
	OpDetail   string         `json:"opDetail,omitempty"`   // 原始操作符文本，如 "Hash Join" / "Using where"
	Table      string         `json:"table,omitempty"`      // 涉及的表名
	Index      string         `json:"index,omitempty"`      // 使用的索引名
	EstRows    int64          `json:"estRows,omitempty"`    // 估算扫描行数
	ActualRows int64          `json:"actualRows,omitempty"` // 实际返回行数（需 ANALYZE）
	Loops      int64          `json:"loops,omitempty"`      // 循环执行次数
	Cost       float64        `json:"cost,omitempty"`       // 估算成本
	DurationMs float64        `json:"durationMs,omitempty"` // 实际耗时毫秒（需 ANALYZE）
	BufferHit  float64        `json:"bufferHit,omitempty"`  // 缓冲命中率 0-1
	Flags      []string       `json:"flags,omitempty"`      // 警告标志
	Extra      map[string]any `json:"extra,omitempty"`      // 方言特定字段，前端按需展示
}

// ExplainEdge 表示执行计划节点间的父子关系，前端 react-flow 用于绘制连线。
type ExplainEdge struct {
	From  string `json:"from"`            // 父节点 ID
	To    string `json:"to"`              // 子节点 ID
	Label string `json:"label,omitempty"` // 边的标注（如 JOIN 类型 "INNER"/"LEFT"）
}

// ExplainStats 是整个执行计划的聚合统计。
type ExplainStats struct {
	TotalCost       float64 `json:"totalCost,omitempty"`
	TotalDurationMs float64 `json:"totalDurationMs,omitempty"`
	RowsRead        int64   `json:"rowsRead,omitempty"`      // 所有 SCAN 节点估算行数之和
	BufferHitRate   float64 `json:"bufferHitRate,omitempty"` // 平均缓冲命中率
	HasFullScan     bool    `json:"hasFullScan"`
	HasFilesort     bool    `json:"hasFilesort"`
	HasTempTable    bool    `json:"hasTempTable"`
	MaxEstRows      int64   `json:"maxEstRows,omitempty"` // 单节点最大估算行数（用于规则匹配）
}

// ExplainResult 是一次 EXPLAIN 解析后的归一化结果。
type ExplainResult struct {
	DBType     string        `json:"dbType"`
	SourceSQL  string        `json:"sourceSql"`
	Nodes      []ExplainNode `json:"nodes"`
	Edges      []ExplainEdge `json:"edges,omitempty"`
	Stats      ExplainStats  `json:"stats"`
	Warnings   []string      `json:"warnings,omitempty"` // 解析/降级过程中的提示
	RawFormat  ExplainFormat `json:"rawFormat"`
	RawPayload string        `json:"rawPayload,omitempty"` // 原始 EXPLAIN 输出，前端调试用
}

// IndexSuggestion 是规则引擎针对某个节点产生的索引建议。
type IndexSuggestion struct {
	Severity       string `json:"severity"`                 // critical/warning/info
	Rule           string `json:"rule"`                     // 规则 ID，如 "full_scan_on_large_table"
	Reason         string `json:"reason"`                   // 人类可读的触发原因
	SuggestedIndex string `json:"suggestedIndex,omitempty"` // 建议的 CREATE INDEX 语句（如有）
	AffectedNodeID string `json:"affectedNodeId,omitempty"` // 关联的 ExplainNode.ID
	AffectedTable  string `json:"affectedTable,omitempty"`
	EstRows        int64  `json:"estRows,omitempty"` // 触发节点的估算行数，便于排序
}

// DiagnoseReport 是 DiagnoseQuery 的最终返回值，前端诊断面板消费此结构。
type DiagnoseReport struct {
	Plan        ExplainResult     `json:"plan"`
	Suggestions []IndexSuggestion `json:"suggestions"`
}

// QueryExecutionRecord 是慢 SQL 历史的一条记录（PR5 慢 SQL 摘要用，提前定义便于 PR1 数据流贯通）。
type QueryExecutionRecord struct {
	ID             string  `json:"id"`
	ConnectionFP   string  `json:"connectionFp"` // 连接指纹，复用 saved_query_fingerprint
	SQLFingerprint string  `json:"sqlFp"`        // SQL 文本指纹（归一化后 sha256 取前 16）
	SQLPreview     string  `json:"sqlPreview"`   // 截断后的 SQL 预览（前 200 字符）
	SQLText        string  `json:"sqlText,omitempty"`
	SQLTruncated   bool    `json:"sqlTruncated,omitempty"`
	Diagnosable    bool    `json:"diagnosable"`
	StatementCount int     `json:"statementCount,omitempty"`
	DBType         string  `json:"dbType"`
	DurationMs     int64   `json:"durationMs"`
	ExecutionCount int64   `json:"executionCount,omitempty"`
	AvgDurationMs  float64 `json:"avgDurationMs,omitempty"`
	MaxDurationMs  int64   `json:"maxDurationMs,omitempty"`
	RowsRead       int64   `json:"rowsRead,omitempty"`
	RowsReturned   int64   `json:"rowsReturned,omitempty"`
	PlanHash       string  `json:"planHash,omitempty"` // 同一 SQL 不同计划的区分（PR5 实现）
	// Wails 会把 time.Time 当结构体查找并打印 "Not found: time.Time"，
	// 必须标 ts_type。JSON 编码仍是 RFC3339。
	ExecutedAt time.Time `json:"executedAt" ts_type:"string"`
}
