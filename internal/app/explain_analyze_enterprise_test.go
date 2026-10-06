package app

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// Shaped after an actual plan captured from Azure SQL Edge (STATISTICS XML),
// with a parallel step, a batch-mode step and a step that never ran added.
const sqlServerActualPlanSample = `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564">
 <BatchSequence><Batch><Statements>
  <StmtSimple StatementText="SELECT ...">
   <QueryPlan DegreeOfParallelism="2">
    <QueryTimeStats ElapsedTime="42" CpuTime="40" />
    <RelOp NodeId="0" PhysicalOp="Compute Scalar" LogicalOp="Compute Scalar" EstimateRows="1" EstimatedTotalSubtreeCost="1.5">
     <ComputeScalar>
      <RelOp NodeId="1" PhysicalOp="Hash Match" LogicalOp="Inner Join" EstimateRows="20" EstimatedTotalSubtreeCost="1.4" Parallel="1">
       <RunTimeInformation>
        <RunTimeCountersPerThread Thread="1" ActualRows="6000" ActualElapsedms="30" ActualExecutions="1" ActualExecutionMode="Row" />
        <RunTimeCountersPerThread Thread="2" ActualRows="4000" ActualElapsedms="25" ActualExecutions="1" ActualExecutionMode="Row" />
       </RunTimeInformation>
       <Hash>
        <RelOp NodeId="2" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="400" EstimatedTotalSubtreeCost="0.01">
         <RunTimeInformation>
          <RunTimeCountersPerThread Thread="0" ActualRows="800" ActualElapsedms="2" ActualExecutions="2" ActualExecutionMode="Row" />
         </RunTimeInformation>
         <IndexScan Ordered="1"><Object Database="[shop]" Schema="[dbo]" Table="[customers]" Index="[idx_city]" /></IndexScan>
        </RelOp>
        <RelOp NodeId="3" PhysicalOp="Columnstore Index Scan" LogicalOp="Index Scan" EstimateRows="40000" EstimatedTotalSubtreeCost="1.2">
         <RunTimeInformation>
          <RunTimeCountersPerThread Thread="0" ActualRows="40000" ActualElapsedms="5" ActualExecutions="1" ActualExecutionMode="Batch" />
         </RunTimeInformation>
         <IndexScan><Object Database="[shop]" Schema="[dbo]" Table="[items]" Index="[cci_items]" /></IndexScan>
        </RelOp>
        <RelOp NodeId="4" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="5" EstimatedTotalSubtreeCost="0.01">
         <RunTimeInformation>
          <RunTimeCountersPerThread Thread="0" ActualRows="0" ActualExecutions="0" ActualExecutionMode="Row" />
         </RunTimeInformation>
         <IndexScan><Object Database="[shop]" Schema="[dbo]" Table="[orders]" Index="[idx_orders]" /></IndexScan>
        </RelOp>
       </Hash>
      </RelOp>
     </ComputeScalar>
    </RelOp>
   </QueryPlan>
  </StmtSimple>
 </Statements></Batch></BatchSequence>
</ShowPlanXML>`

func TestParseSQLServerActualPlanReadsCountersPerLoop(t *testing.T) {
	result, err := parseExplainRawWithText("sqlserver", "SELECT ...", sqlServerActualPlanSample, connection.ExplainFormatXML, defaultExplainBackendText)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	annotateExplainActuals(&result)
	byDetail := func(detail string) connection.ExplainNode { return findExplainNode(t, result.Nodes, detail) }

	join := byDetail("Hash Match")
	// Threads run side by side: rows add up, time is the slowest thread, and
	// a parallel step's estimate covers all threads, so threads are not loops.
	if join.ActualRows != 10000 || join.Loops != 1 || join.DurationMs != 30 {
		t.Fatalf("parallel join = %+v", join)
	}
	if !hasFlag(join.Flags, connection.ExplainFlagUccWarn) {
		t.Fatalf("20 rows expected, 10000 found: %+v", join)
	}
	seek := byDetail("Index Seek")
	if seek.Table != "customers" || seek.Index != "idx_city" || seek.Loops != 2 || seek.ActualRows != 400 || seek.DurationMs != 1 {
		t.Fatalf("table must come from the IndexScan element and counts per loop: %+v", seek)
	}
	scan := byDetail("Columnstore Index Scan")
	if scan.Table != "items" || scan.Extra["executionMode"] != "Batch" {
		t.Fatalf("batch-mode scan = %+v", scan)
	}
	var never connection.ExplainNode
	for _, node := range result.Nodes {
		if node.Table == "orders" {
			never = node
		}
	}
	if never.Loops != 0 || never.Extra["neverExecuted"] != true {
		t.Fatalf("ActualExecutions=0 means the step never ran: %+v", never)
	}
	compute := result.Nodes[0]
	if compute.Extra["neverExecuted"] == true || compute.Extra[sqlServerNoRuntimeKey] != true {
		t.Fatalf("a step without counters in an actual plan is not a step that never ran: %+v", compute)
	}
	if result.Stats.TotalDurationMs != 42 || result.HotspotBasis != explainHotspotBasisTime {
		t.Fatalf("stats=%+v basis=%q", result.Stats, result.HotspotBasis)
	}
}

func TestParseSQLServerEstimatedPlanCarriesNoRuntimeMarkers(t *testing.T) {
	estimated := strings.NewReplacer("<RunTimeInformation>", "<!--", "</RunTimeInformation>", "-->", "<QueryTimeStats", "<Ignored").Replace(sqlServerActualPlanSample)
	result, err := parseExplainRawWithText("sqlserver", "SELECT ...", estimated, connection.ExplainFormatXML, defaultExplainBackendText)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	for _, node := range result.Nodes {
		if node.Loops != 0 || node.Extra[sqlServerNoRuntimeKey] != nil {
			t.Fatalf("estimated step = %+v", node)
		}
	}
	if findExplainNode(t, result.Nodes, "Columnstore Index Scan").Table != "items" {
		t.Fatalf("estimated plans also read the table from the IndexScan element")
	}
}

// DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST') as collectExplainRaw
// hands it over, captured from Oracle 23ai Free.
const oracleActualPlanSample = "PLAN_TABLE_OUTPUT\n" +
	"SQL_ID  ddj8u1q934z42, child number 0\n" +
	"-------------------------------------\n" +
	"SELECT c.city, SUM(i.amount) AS total FROM explain_customers c JOIN\n" +
	"explain_items i ON i.customer_id = c.id WHERE c.city = 'bj' GROUP BY\n" +
	"\n" +
	"Plan hash value: 3103088185\n" +
	"\n" +
	"-------------------------------------------------------------------------------------------------------\n" +
	"| Id  | Operation            | Name              | Starts | E-Rows | A-Rows |   A-Time   | Buffers |\n" +
	"-------------------------------------------------------------------------------------------------------\n" +
	"|   0 | SELECT STATEMENT     |                   |      1 |        |      1 |00:00:01.25 |     104 |\n" +
	"|   1 |  SORT GROUP BY NOSORT|                   |      1 |      1 |      1 |00:00:01.25 |     104 |\n" +
	"|*  2 |   NESTED LOOPS       |                   |      1 |     20 |   1200K|00:00:01.20 |     104 |\n" +
	"|*  3 |    TABLE ACCESS FULL | EXPLAIN_CUSTOMERS |      1 |    400 |    400 |00:00:00.01 |       6 |\n" +
	"|   4 |    INDEX RANGE SCAN  | EXPLAIN_ITEMS_IDX |    400 |      1 |   1200K|00:00:01.10 |      98 |\n" +
	"|   5 |    TABLE ACCESS FULL | EXPLAIN_ORDERS    |      0 |     10 |      0 |00:00:00.00 |       0 |\n" +
	"-------------------------------------------------------------------------------------------------------\n" +
	"\n" +
	"Predicate Information (identified by operation id):\n" +
	"---------------------------------------------------\n" +
	"\n" +
	"   3 - filter(\"C\".\"CITY\"='bj')\n"

func TestParseOracleActualPlanFromDisplayCursor(t *testing.T) {
	result, err := parseExplainRawWithText("oracle", "SELECT ...", oracleActualPlanSample, connection.ExplainFormatTable, defaultExplainBackendText)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	annotateExplainActuals(&result)
	if len(result.Nodes) != 6 {
		t.Fatalf("the SQL_ID heading must not hide the plan table: %+v", result.Nodes)
	}
	loop := findExplainNode(t, result.Nodes, "NESTED LOOPS")
	if loop.EstRows != 20 || loop.ActualRows != 1200000 || loop.Loops != 1 || loop.DurationMs != 1200 {
		t.Fatalf("12K-style counts and hundredths of a second: %+v", loop)
	}
	probe := findExplainNode(t, result.Nodes, "INDEX RANGE SCAN")
	if probe.Loops != 400 || probe.ActualRows != 3000 || probe.DurationMs != 1100.0/400 || !hasFlag(probe.Flags, connection.ExplainFlagUccWarn) {
		t.Fatalf("A-Rows and A-Time cover all starts: %+v", probe)
	}
	orders := findExplainNode(t, result.Nodes, "TABLE ACCESS FULL")
	if orders.Table != "EXPLAIN_CUSTOMERS" || orders.Extra["filter"] == nil {
		t.Fatalf("predicates still attach to their step: %+v", orders)
	}
	if never := result.Nodes[5]; never.Loops != 0 || never.Extra["neverExecuted"] != true {
		t.Fatalf("Starts 0 means the step never ran: %+v", never)
	}
	// A-Time includes the steps below: the statement took as long as Id 0.
	if result.HotspotBasis != explainHotspotBasisTime || result.Stats.TotalDurationMs != 1250 {
		t.Fatalf("basis=%q total=%v", result.HotspotBasis, result.Stats.TotalDurationMs)
	}
}

func TestExplainAnalyzeIrreversibleConstructs(t *testing.T) {
	cases := []struct {
		dbType, query, want string
	}{
		{"sqlserver", "SELECT NEXT VALUE FOR dbo.seq", "NEXT VALUE FOR"},
		{"sqlserver", "SELECT * FROM OPENQUERY(remote, 'SELECT 1')", "OPENQUERY"},
		{"sqlserver", "SELECT 'next value for' AS label -- openrowset", ""},
		{"oracle", "SELECT seq.NEXTVAL FROM dual", "NEXTVAL"},
		{"oracle", "SELECT \"NEXTVAL\" FROM t", ""},
		{"mysql", "SELECT NEXTVAL(seq)", "NEXTVAL"},
		{"mariadb", "SELECT NEXT VALUE FOR seq", "NEXT VALUE FOR"},
		{"postgres", "SELECT nextval('seq')", ""},
	}
	for _, tc := range cases {
		if got := explainAnalyzeIrreversible(tc.dbType, tc.query); got != tc.want {
			t.Fatalf("%s %q = %q, want %q", tc.dbType, tc.query, got, tc.want)
		}
	}
	result := NewApp().DiagnoseQueryWithOptions(connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1"}, "", "SELECT NEXT VALUE FOR dbo.seq", connection.DiagnoseOptions{Analyze: true})
	if result.Success || !strings.Contains(result.Message, "NEXT VALUE FOR") {
		t.Fatalf("refused before connecting: %+v", result)
	}
}

type fakeSQLServerAnalyzeSession struct {
	fakePinnedExplainSession
	results []connection.ResultSetData
	budget  *db.RowBudget
}

func (session *fakeSQLServerAnalyzeSession) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	session.operations = append(session.operations, "multi:"+query)
	session.budget = db.RowBudgetFromContext(ctx)
	return session.results, nil
}

func TestExecuteSQLServerExplainAnalyzeReadsThePlanAfterTheRows(t *testing.T) {
	session := &fakeSQLServerAnalyzeSession{results: []connection.ResultSetData{
		{Columns: []string{"city"}, Rows: []map[string]interface{}{{"city": "bj"}}},
		{Columns: []string{"Microsoft SQL Server 2005 XML Showplan"}, Rows: []map[string]interface{}{{"Microsoft SQL Server 2005 XML Showplan": sqlServerActualPlanSample}}},
	}}
	database := &fakeAnalyzeDatabase{}
	database.analyzeSession = session
	result, statement, err := NewApp().executeExplainAnalyzeContext(context.Background(), database, connection.ConnectionConfig{}, "sqlserver", "SELECT city FROM t;")
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	want := []string{
		"exec:BEGIN TRANSACTION",
		"exec:SET STATISTICS XML ON",
		"multi:SELECT city FROM t",
		"exec:SET STATISTICS XML OFF",
		"exec:IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION",
		"close",
	}
	if strings.Join(session.operations, "\n") != strings.Join(want, "\n") {
		t.Fatalf("operations:\n got=%q\nwant=%q", session.operations, want)
	}
	if session.budget == nil || session.budget.MaxTotalRows() != sqlServerAnalyzeMaxRows {
		t.Fatalf("the rows read before the plan must be capped: %+v", session.budget)
	}
	if !strings.HasPrefix(statement, "SET STATISTICS XML ON") || !result.Analyzed || len(result.Nodes) == 0 {
		t.Fatalf("statement=%q analyzed=%t nodes=%d", statement, result.Analyzed, len(result.Nodes))
	}
}

func TestExecuteSQLServerExplainAnalyzeExplainsTooManyRows(t *testing.T) {
	session := &fakeSQLServerAnalyzeSession{}
	session.results = []connection.ResultSetData{{Columns: []string{"id"}, Rows: []map[string]interface{}{{"id": 1}}, Truncated: true}}
	database := &fakeAnalyzeDatabase{}
	database.analyzeSession = &budgetExhaustingSession{fakeSQLServerAnalyzeSession: session}
	_, _, err := NewApp().executeExplainAnalyzeContext(context.Background(), database, connection.ConnectionConfig{}, "sqlserver", "SELECT id FROM big")
	if err == nil || !strings.Contains(err.Error(), "TOP") {
		t.Fatalf("want advice to limit the rows, got %v", err)
	}
}

// budgetExhaustingSession uses up the row budget the way a large result does.
type budgetExhaustingSession struct {
	*fakeSQLServerAnalyzeSession
}

func (session *budgetExhaustingSession) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	budget := db.RowBudgetFromContext(ctx)
	for budget.CanMaterializeRow(0) {
		budget.ConsumeRow(1)
	}
	return session.fakeSQLServerAnalyzeSession.QueryMultiContext(ctx, query)
}

type fakeOracleAnalyzeSession struct {
	fakePinnedExplainSession
	streamed int
}

func (session *fakeOracleAnalyzeSession) StreamQueryContext(_ context.Context, query string, consumer db.QueryStreamConsumer) error {
	session.operations = append(session.operations, "stream:"+query)
	_ = consumer.SetColumns([]string{"city"})
	for index := 0; index < 3; index++ {
		session.streamed++
		_ = consumer.ConsumeRow(map[string]interface{}{"city": "bj"})
	}
	return nil
}

func (session *fakeOracleAnalyzeSession) QueryContext(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
	session.operations = append(session.operations, "query:"+query)
	var rows []map[string]interface{}
	for _, line := range strings.Split(strings.TrimPrefix(oracleActualPlanSample, "PLAN_TABLE_OUTPUT\n"), "\n") {
		rows = append(rows, map[string]interface{}{"PLAN_TABLE_OUTPUT": line})
	}
	return rows, []string{"PLAN_TABLE_OUTPUT"}, nil
}

func TestExecuteOracleExplainAnalyzeDrainsRowsAndDropsTheSession(t *testing.T) {
	session := &fakeOracleAnalyzeSession{}
	database := &fakeAnalyzeDatabase{}
	database.analyzeSession = session
	result, statement, err := NewApp().executeExplainAnalyzeContext(context.Background(), database, connection.ConnectionConfig{}, "oracle", "SELECT city FROM t")
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	want := []string{
		"exec:ALTER SESSION SET STATISTICS_LEVEL = ALL",
		"stream:SELECT city FROM t",
		"query:" + oracleDisplayCursorQuery,
		"exec:ROLLBACK",
		"discard",
		"close",
	}
	if strings.Join(session.operations, "\n") != strings.Join(want, "\n") {
		t.Fatalf("operations:\n got=%q\nwant=%q", session.operations, want)
	}
	if session.streamed != 3 || statement != "SELECT city FROM t" || !result.Analyzed {
		t.Fatalf("streamed=%d statement=%q analyzed=%t", session.streamed, statement, result.Analyzed)
	}
}

func TestIncludeSQLServerBatchModeChildTime(t *testing.T) {
	nodes := []connection.ExplainNode{
		{ID: "n1", DurationMs: 1, Loops: 1, Extra: map[string]any{"executionMode": "Batch"}},
		{ID: "n2", ParentID: "n1", DurationMs: 4, Loops: 1},
		{ID: "n3", ParentID: "n2", DurationMs: 3, Loops: 1, Extra: map[string]any{"executionMode": "Batch"}},
	}
	includeSQLServerBatchModeChildTime(nodes)
	// n3 has no children; n2 (row mode) already includes n3; n1 adds n2.
	if nodes[0].DurationMs != 5 || nodes[1].DurationMs != 4 || nodes[2].DurationMs != 3 {
		t.Fatalf("batch-mode times must include their children: %+v", nodes)
	}
}
