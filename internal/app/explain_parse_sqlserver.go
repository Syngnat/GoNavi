package app

import (
	"encoding/xml"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// SQL Server SHOWPLAN_XML 解析。
//
// 典型 XML 结构（简化）：
//
//	<ShowPlanXML Version="1.5" ...>
//	  <BatchSequence>
//	    <Batch>
//	      <Statements>
//	        <StmtSimple StatementText="SELECT * FROM users" ...>
//	          <QueryPlan ...>
//	            <RelOp NodeId="0" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Scan"
//	                   EstimateRows="1000" EstimateIO="0.1" EstimateCPU="0.001" EstimatedTotalSubtreeCost="0.2"
//	          	       Parallel="0" EstimateRebinds="0">
//	              <Object Database="[db]" Schema="[dbo]" Table="[users]" Index="[PK_users]" />
//	              <RunTimeInformation>
//	                <RunTimeCountersPerThread ... ActualRows="1000" ActualElapsedms="5" ActualScans="1" />
//	              </RunTimeInformation>
//	              <IndexScan Ordered="0" ...>
//	                <Object .../>
//	                <Predicate>
//	                  <ScalarOperator ScalarString="[age]>(18)">
//	                    ...
//	          </ScalarOperator>
//	                </Predicate>
//	              </IndexScan>
//	            </RelOp>
//	          </QueryPlan>
//	        </StmtSimple>
//	      </Statements>
//	    </Batch>
//	  </BatchSequence>
//	</ShowPlanXML>
//
// 解析要点：
//   - RelOp 是核心节点（递归嵌套），每个含 PhysicalOp + LogicalOp + EstimateRows + EstimatedTotalSubtreeCost
//   - 嵌套在 RelOp 内的同级 RelOp（在 IndexScan/NestedLoops/Hash 等子元素下）是子节点
//   - PhysicalOp 直接对应执行算子（Clustered Index Scan / Index Seek / Hash Match / Sort / ...）
//   - Object 子元素含 Table/Index 信息
//   - Predicate 的 ScalarOperator ScalarString 含过滤条件（供规则引擎提取列名）
//   - RunTimeCountersPerThread 含 ActualRows（对应 ANALYZE 信息）

// sqlServerShowPlanXML 是 SHOWPLAN_XML 顶层文档的 Go 结构（部分字段，未识别的留 raw）。
type sqlServerShowPlanXML struct {
	XMLName  xml.Name                `xml:"ShowPlanXML"`
	Batches  []sqlServerXMLBatch     `xml:"BatchSequence>Batch"`
}

type sqlServerXMLBatch struct {
	Statements []sqlServerXMLStmtSimple `xml:"Statements>StmtSimple"`
}

type sqlServerXMLStmtSimple struct {
	StatementText string             `xml:"StatementText,attr"`
	QueryPlan     *sqlServerXMLPlan  `xml:"QueryPlan"`
}

type sqlServerXMLPlan struct {
	RelOps []sqlServerXMLRelOp `xml:"RelOp"`
	// QueryTimeStats 只在实际执行计划（STATISTICS XML）中出现，单位毫秒。
	QueryTimeStats *struct {
		ElapsedTime float64 `xml:"ElapsedTime,attr"`
	} `xml:"QueryTimeStats"`
}

// sqlServerXMLRelOp 是 SHOWPLAN_XML 的核心节点；嵌套子 RelOp 通过多种容器元素持有。
// 为简化解析：先把所有层级的 RelOp 平铺出来（按 NodeId 排序），再按 NodeId 父子推断。
type sqlServerXMLRelOp struct {
	NodeID                  int                       `xml:"NodeId,attr"`
	PhysicalOp              string                    `xml:"PhysicalOp,attr"`
	LogicalOp               string                    `xml:"LogicalOp,attr"`
	EstimateRows            float64                   `xml:"EstimateRows,attr"`
	EstimateIO              float64                   `xml:"EstimateIO,attr"`
	EstimateCPU             float64                   `xml:"EstimateCPU,attr"`
	EstimatedTotalSubtreeCost float64                 `xml:"EstimatedTotalSubtreeCost,attr"`
	EstimateRebinds         float64                   `xml:"EstimateRebinds,attr"`
	Parallel                int                       `xml:"Parallel,attr"`
	// 子节点容器（不同 PhysicalOp 对应不同容器名，这里全收）
	Objects     []sqlServerXMLObject        `xml:"Object"`
	IndexScan   *sqlServerXMLContainer      `xml:"IndexScan"`
	NestedLoops *sqlServerXMLContainer      `xml:"NestedLoops"`
	Hash        *sqlServerXMLContainer      `xml:"Hash"`
	Merge       *sqlServerXMLContainer      `xml:"Merge"`
	Concat      *sqlServerXMLContainer      `xml:"Concat"`
	Sort        *sqlServerXMLContainer      `xml:"Sort"`
	Filter      *sqlServerXMLContainer      `xml:"Filter"`
	ComputeScalar *sqlServerXMLContainer    `xml:"ComputeScalar"`
	Top         *sqlServerXMLContainer      `xml:"Top"`
	GenericRelOps []sqlServerXMLContainer   `xml:",any"` // 兜底：未识别容器
	Predicate   *sqlServerXMLPredicate      `xml:"Predicate"`
	RunTimeInfo *sqlServerXMLRunTimeInfo    `xml:"RunTimeInformation"`
}

type sqlServerXMLObject struct {
	Database string `xml:"Database,attr"`
	Schema   string `xml:"Schema,attr"`
	Table    string `xml:"Table,attr"`
	Index    string `xml:"Index,attr"`
}

type sqlServerXMLContainer struct {
	Objects   []sqlServerXMLObject `xml:"Object"`
	RelOps    []sqlServerXMLRelOp  `xml:"RelOp"`
	Predicate *sqlServerXMLPredicate `xml:"Predicate"`
}

type sqlServerXMLPredicate struct {
	ScalarString string `xml:"ScalarOperator>ScalarString"`
}

type sqlServerXMLRunTimeInfo struct {
	RunTimeCounters []sqlServerXMLRunTimeCounter `xml:"RunTimeCountersPerThread"`
}

type sqlServerXMLRunTimeCounter struct {
	ActualRows          int64   `xml:"ActualRows,attr"`
	ActualElapsedMs     float64 `xml:"ActualElapsedms,attr"`
	ActualScans         int64   `xml:"ActualScans,attr"`
	ActualExecutions    *int64  `xml:"ActualExecutions,attr"`
	ActualExecutionMode string  `xml:"ActualExecutionMode,attr"`
}

func parseSQLServerExplain(sourceSQL, raw string, format connection.ExplainFormat) (connection.ExplainResult, error) {
	result := connection.ExplainResult{
		DBType:    "sqlserver",
		SourceSQL: sourceSQL,
	}

	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return result, fmt.Errorf("SHOWPLAN_XML 输出为空")
	}

	// SQL Server 输出的 XML 含 `<?xml encoding="utf-16"?>` 声明，Go encoding/xml 不支持 utf-16
	// 直接报 "encoding declared but not supported"。从 <ShowPlanXML> 标签开始截取即可规避。
	showPlanStart := strings.Index(trimmed, "<ShowPlanXML")
	if showPlanStart < 0 {
		showPlanStart = 0
	}
	body := trimmed[showPlanStart:]

	// SHOWPLAN_XML 携带默认命名空间 xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"，
	// Go encoding/xml 严格按 namespace 匹配，导致子元素无法识别。
	// 该 namespace URL 是固定的（微软规范），直接 strip 掉即可让 struct 按 local name 匹配。
	cleaned := stripSQLServerDefaultNamespace(body)

	var doc sqlServerShowPlanXML
	if err := xml.Unmarshal([]byte(cleaned), &doc); err != nil {
		result.RawFormat = connection.ExplainFormatText
		result.RawPayload = raw
		result.Warnings = []string{fmt.Sprintf("SHOWPLAN_XML 解析失败：%v", err)}
		return result, nil
	}

	// 平铺 RelOp + 记录 NodeId 到内部 ID 的映射
	nodeByOpID := map[int]string{}
	for _, batch := range doc.Batches {
		for _, stmt := range batch.Statements {
			if stmt.QueryPlan == nil {
				continue
			}
			for _, relOp := range stmt.QueryPlan.RelOps {
				parseSQLServerRelOp(&relOp, "", &result, nodeByOpID)
			}
			if stats := stmt.QueryPlan.QueryTimeStats; stats != nil {
				result.Stats.TotalDurationMs += stats.ElapsedTime
			}
		}
	}
	includeSQLServerBatchModeChildTime(result.Nodes)
	markSQLServerStepsWithoutRuntime(result.Nodes)

	if len(result.Nodes) == 0 {
		result.Warnings = append(result.Warnings, "SHOWPLANXML 解析未提取到任何 RelOp 节点")
	}

	result.RawFormat = connection.ExplainFormatXML
	result.RawPayload = raw
	measuredTotal := result.Stats.TotalDurationMs
	finalizeExplainStats(&result)
	if measuredTotal == 0 && result.Stats.TotalDurationMs > 0 {
		// No QueryTimeStats (older servers): step times include their children.
		result.Stats.TotalDurationMs = explainMeasuredWallMs(result.Nodes)
	}
	return result, nil
}

// stripSQLServerDefaultNamespace 去掉 SHOWPLAN_XML 的默认命名空间属性。
// 该 namespace URL 是 SQL Server 固定规范值，从 SQL Server 2005 起未变化。
func stripSQLServerDefaultNamespace(xmlText string) string {
	const ns = ` xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"`
	return strings.ReplaceAll(xmlText, ns, "")
}

// parseSQLServerRelOp 递归解析 RelOp 节点及其所有子 RelOp（在多种容器元素中）。
func parseSQLServerRelOp(rel *sqlServerXMLRelOp, parentID string, result *connection.ExplainResult, nodeByOpID map[int]string) {
	if rel == nil {
		return
	}

	node := connection.ExplainNode{
		OpType:   classifySQLServerPhysicalOp(rel.PhysicalOp, rel.LogicalOp),
		OpDetail: rel.PhysicalOp,
		EstRows:  int64(rel.EstimateRows),
		Cost:     rel.EstimatedTotalSubtreeCost,
	}

	// 取第一个 Object 作为表/索引来源；扫描与查找类算子把 Object 放在 IndexScan 等子元素里
	if obj, ok := firstSQLServerObject(rel); ok {
		node.Table = stripSQLServerBrackets(obj.Table)
		node.Index = stripSQLServerBrackets(obj.Index)
	}

	// Predicate
	if rel.Predicate != nil && rel.Predicate.ScalarString != "" {
		if node.Extra == nil {
			node.Extra = map[string]any{}
		}
		node.Extra["filter"] = rel.Predicate.ScalarString
	}

	if rel.RunTimeInfo != nil {
		applySQLServerRunTimeCounters(&node, rel.RunTimeInfo.RunTimeCounters, rel.Parallel == 1)
	} else {
		// Only meaningful in an actual plan; see markSQLServerStepsWithoutRuntime.
		setExplainExtra(&node, sqlServerNoRuntimeKey, true)
	}

	// 物理算子归类
	switch node.OpType {
	case connection.ExplainOpScan:
		node.Flags = append(node.Flags, connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex)
	case connection.ExplainOpSort:
		node.Flags = append(node.Flags, connection.ExplainFlagFilesort)
	case connection.ExplainOpAggregate, connection.ExplainOpMaterialize:
		node.Flags = append(node.Flags, connection.ExplainFlagTempTable)
	}

	// 关联 LogicalOp 优化提示
	if strings.Contains(strings.ToLower(rel.LogicalOp), "aggregate") {
		node.Flags = appendExplainFlag(node.Flags, connection.ExplainFlagTempTable)
	}

	nodeID := appendExplainChild(result, parentID, node)
	nodeByOpID[rel.NodeID] = nodeID

	// 递归所有可能的容器
	containers := []*sqlServerXMLContainer{
		rel.IndexScan, rel.NestedLoops, rel.Hash, rel.Merge,
		rel.Concat, rel.Sort, rel.Filter, rel.ComputeScalar, rel.Top,
	}
	for _, c := range containers {
		if c == nil {
			continue
		}
		for i := range c.RelOps {
			parseSQLServerRelOp(&c.RelOps[i], nodeID, result, nodeByOpID)
		}
	}
	// GenericRelOps 是 ,any 兜底容器，按需递归
	for i := range rel.GenericRelOps {
		for j := range rel.GenericRelOps[i].RelOps {
			parseSQLServerRelOp(&rel.GenericRelOps[i].RelOps[j], nodeID, result, nodeByOpID)
		}
	}
}

// classifySQLServerPhysicalOp 把 SQLServer PhysicalOp/LogicalOp 归一化到通用 OpType。
// 参考官方文档：Clustered Index Scan / Index Seek / RID Lookup / Key Lookup / Hash Match / Nested Loops /
// Merge Join / Sort / Stream Aggregate / Filter / Compute Scalar / Top / Spool / Table-valued function。
func classifySQLServerPhysicalOp(physical, logical string) string {
	p := strings.ToLower(strings.TrimSpace(physical))
	l := strings.ToLower(strings.TrimSpace(logical))
	switch {
	case strings.Contains(p, "index scan"), strings.Contains(p, "clustered index scan"), strings.Contains(p, "table scan"):
		return connection.ExplainOpScan
	case strings.Contains(p, "index seek"), strings.Contains(p, "clustered index seek"):
		return connection.ExplainOpIndexScan
	case strings.Contains(p, "key lookup"), strings.Contains(p, "rid lookup"):
		return connection.ExplainOpIndexScan
	case strings.Contains(p, "hash match"), strings.Contains(p, "nested loops"), strings.Contains(p, "merge join"):
		return connection.ExplainOpJoin
	case strings.Contains(p, "sort"):
		return connection.ExplainOpSort
	case strings.Contains(l, "aggregate"), strings.Contains(p, "stream aggregate"), strings.Contains(p, "hash match") && strings.Contains(l, "aggregate"):
		return connection.ExplainOpAggregate
	case strings.Contains(p, "filter"):
		return connection.ExplainOpFilter
	case strings.Contains(p, "top"):
		return connection.ExplainOpLimit
	case strings.Contains(p, "spool"):
		return connection.ExplainOpMaterialize
	case strings.Contains(p, "compute scalar"):
		return connection.ExplainOpOther
	default:
		return connection.ExplainOpOther
	}
}

// stripSQLServerBrackets 去掉 SQLServer 标识符的方括号：[users] → users。
func stripSQLServerBrackets(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	return s
}

// applySQLServerRunTimeCounters turns the per-thread counters of an actual
// plan into the per-loop figures every dialect reports. Rows add up across
// threads; threads run side by side, so the step took as long as its slowest
// thread. ActualRows and ActualElapsedms cover all executions, while
// EstimateRows is per execution of the whole step: a parallel step runs once
// per thread for one loop, so its loops are the most any thread executed.
func applySQLServerRunTimeCounters(node *connection.ExplainNode, counters []sqlServerXMLRunTimeCounter, parallel bool) {
	if len(counters) == 0 {
		return
	}
	var rows, executions int64
	var elapsedMs float64
	mode := ""
	reported := false
	for _, counter := range counters {
		rows += counter.ActualRows
		if counter.ActualExecutions != nil {
			reported = true
			if !parallel {
				executions += *counter.ActualExecutions
			} else if *counter.ActualExecutions > executions {
				executions = *counter.ActualExecutions
			}
		}
		if counter.ActualElapsedMs > elapsedMs {
			elapsedMs = counter.ActualElapsedMs
		}
		if counter.ActualExecutionMode != "" {
			mode = counter.ActualExecutionMode
		}
	}
	if !reported {
		// Older servers omit ActualExecutions; the step ran at least once.
		executions = 1
	}
	if executions <= 0 {
		// ActualExecutions="0": the executor never started this step.
		return
	}
	node.Loops = executions
	node.ActualRows = int64(float64(rows)/float64(executions) + 0.5)
	node.DurationMs = elapsedMs / float64(executions)
	if strings.EqualFold(mode, "Batch") {
		setExplainExtra(node, "executionMode", "Batch")
	}
}

// includeSQLServerBatchModeChildTime makes batch-mode times include the steps
// below them, as row-mode times already do: a batch-mode operator reports only
// its own time. Children follow their parent in the list, so walking it
// backwards sees every child's final time first.
func includeSQLServerBatchModeChildTime(nodes []connection.ExplainNode) {
	index := make(map[string]int, len(nodes))
	for position, node := range nodes {
		index[node.ID] = position
	}
	childTotals := make([]float64, len(nodes))
	for position := len(nodes) - 1; position >= 0; position-- {
		node := &nodes[position]
		if node.Extra["executionMode"] == "Batch" && childTotals[position] > 0 {
			loops := node.Loops
			if loops < 1 {
				loops = 1
			}
			node.DurationMs = (explainNodeTotalMs(*node) + childTotals[position]) / float64(loops)
		}
		if parent, ok := index[node.ParentID]; ok && node.ParentID != "" {
			childTotals[parent] += explainNodeTotalMs(*node)
		}
	}
}

// sqlServerNoRuntimeKey marks a step an actual plan carries no runtime counters
// for (Compute Scalar is usually evaluated inside its consumer).
const sqlServerNoRuntimeKey = "runtimeNotReported"

// markSQLServerStepsWithoutRuntime keeps the marker only in actual plans, where
// it stops a counter-less step from reading as "never executed"; an estimated
// plan has no counters anywhere and needs no marker.
func markSQLServerStepsWithoutRuntime(nodes []connection.ExplainNode) {
	actual := false
	for _, node := range nodes {
		if node.Extra[sqlServerNoRuntimeKey] == nil {
			actual = true
			break
		}
	}
	if actual {
		return
	}
	for index := range nodes {
		delete(nodes[index].Extra, sqlServerNoRuntimeKey)
		if len(nodes[index].Extra) == 0 {
			nodes[index].Extra = nil
		}
	}
}

// firstSQLServerObject finds the table a step reads: on the RelOp itself or in
// the operator element below it (<IndexScan><Object .../></IndexScan>).
func firstSQLServerObject(rel *sqlServerXMLRelOp) (sqlServerXMLObject, bool) {
	if len(rel.Objects) > 0 {
		return rel.Objects[0], true
	}
	containers := []*sqlServerXMLContainer{
		rel.IndexScan, rel.NestedLoops, rel.Hash, rel.Merge,
		rel.Concat, rel.Sort, rel.Filter, rel.ComputeScalar, rel.Top,
	}
	for index := range rel.GenericRelOps {
		containers = append(containers, &rel.GenericRelOps[index])
	}
	for _, container := range containers {
		if container != nil && len(container.Objects) > 0 {
			return container.Objects[0], true
		}
	}
	return sqlServerXMLObject{}, false
}
