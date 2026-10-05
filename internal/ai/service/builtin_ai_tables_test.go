package aiservice

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
)

// kingbaseLabTables is what get_tables returns for the KingBase lab database: the person's tables
// in dbms_job, and the system schemas KingBase lists alongside them.
var kingbaseLabTables = []string{
	"dbms_job.lab_customers", "dbms_job.lab_employees", "dbms_job.lab_order_items", "dbms_job.lab_orders", "dbms_job.lab_products",
	"sys_hm.check_param", "sys_hm.check_type", "sysmac.sysmac_label",
}

// savedConnections is what get_connections returns on the machine where the problems were seen.
var savedConnections = []map[string]any{
	{"id": "1775889710138", "name": "本地", "type": "mysql"},
	{"id": "1780629068100", "name": "DuckDB", "type": "duckdb"},
	{"id": "1787492158693", "name": "PostGreSQL", "type": "postgres"},
	{"id": "1789133301866", "name": "KingBase", "type": "kingbase"},
}

func TestTheTablesLineListsTheCurrentSchema(t *testing.T) {
	got := builtinAITablesLine("Tables in this database", kingbaseLabTables, "dbms_job")
	want := "Tables in this database (use these exact names): dbms_job.lab_customers, dbms_job.lab_employees, dbms_job.lab_order_items, dbms_job.lab_orders, dbms_job.lab_products. 3 more in other schemas (call get_tables to see them)"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if all := builtinAITablesLine("Tables", kingbaseLabTables, ""); !strings.Contains(all, "sysmac.sysmac_label") || strings.Contains(all, "more") {
		t.Fatalf("without a schema every table is listed: %s", all)
	}
	if other := builtinAITablesLine("Tables", kingbaseLabTables, "public"); !strings.Contains(other, "dbms_job.lab_orders") {
		t.Fatalf("a schema with no tables of its own lists them all: %s", other)
	}
	if builtinAITablesLine("Tables", nil, "dbms_job") != "" {
		t.Fatal("no tables, no line")
	}
}

func TestALongTableListIsCutAndCounted(t *testing.T) {
	var names []string
	for i := 0; i < 400; i++ {
		names = append(names, "orders_archive_"+strings.Repeat("x", 10)+string(rune('a'+i%26)))
	}
	got := builtinAITablesLine("Tables", names, "")
	if len(got) > builtinAILineMaxBytes+80 || !strings.Contains(got, " more (call get_tables to see them)") {
		t.Fatalf("%d bytes: %s", len(got), got)
	}
}

// fakeLookupCatalog answers the read-only tools the desktop uses to tell the model real names.
type fakeLookupCatalog struct {
	mu    sync.Mutex
	calls []string
	fail  bool
	// labs are the databases holding the lab tables; by default the one on the KingBase server.
	labs map[string]bool
}

func (c *fakeLookupCatalog) List(context.Context) ([]runharness.ToolDescriptor, error) {
	return nil, nil
}

func (c *fakeLookupCatalog) Resolve(_ context.Context, name string) (runharness.ToolDescriptor, runharness.ToolExecutor, error) {
	return runharness.ToolDescriptor{Name: name}, c, nil
}

func (c *fakeLookupCatalog) Execute(_ context.Context, request runharness.ToolExecutionRequest) (runharness.ToolExecutionResult, error) {
	c.mu.Lock()
	c.calls = append(c.calls, request.ToolName+" "+string(request.Arguments))
	c.mu.Unlock()
	if c.fail {
		return runharness.ToolExecutionResult{Status: "failed"}, context.DeadlineExceeded
	}
	var args map[string]string
	_ = json.Unmarshal(request.Arguments, &args)
	switch request.ToolName {
	case "get_connections":
		return runharness.ToolExecutionResult{Status: "completed", Value: map[string]any{"connections": savedConnections}}, nil
	case "get_databases":
		return runharness.ToolExecutionResult{Status: "completed", Value: map[string]any{"databases": []string{"test", "kingbase", "security", "gonavi_kingbase_lab"}}}, nil
	case "get_tables":
		labs := c.labs
		if labs == nil {
			labs = map[string]bool{"gonavi_kingbase_lab": true}
		}
		if !labs[args["dbName"]] { // KingBase's other databases hold only system tables
			return runharness.ToolExecutionResult{Status: "completed", Value: map[string]any{"tables": []string{"sys_hm.check_param", "sysmac.sysmac_label"}}}, nil
		}
		return runharness.ToolExecutionResult{Status: "completed", Value: map[string]any{"tables": kingbaseLabTables}}, nil
	}
	return runharness.ToolExecutionResult{Status: "failed"}, runharness.ErrToolNotFound
}

func (c *fakeLookupCatalog) seen() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.calls...)
}

func TestTheTablesOfTheSelectedDatabaseAreReadOnceAndKept(t *testing.T) {
	catalog := &fakeLookupCatalog{}
	s := &Service{agentToolCatalog: catalog}
	target := builtinAITarget{connectionID: "1789133301866", dbName: "gonavi_kingbase_lab", schemaName: "dbms_job"}

	got, lines := s.builtinAIContextFor(context.Background(), target, "随便找点数据给我看看")
	_, _ = s.builtinAIContextFor(context.Background(), target, "再来一点")
	if got.connectionID != "1789133301866" || !got.known["1775889710138"] {
		t.Fatalf("the target keeps its connection and learns the saved ones: %+v", got)
	}
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "Tables in this database (use these exact names): dbms_job.lab_customers") {
		t.Fatalf("lines: %q", lines)
	}
	calls := catalog.seen()
	if len(calls) != 2 || calls[1] != `get_tables {"connectionId":"1789133301866","dbName":"gonavi_kingbase_lab"}` {
		t.Fatalf("each list is read once and kept: %v", calls)
	}
}

// Regression (2026-10-03): with no connection selected, "连接kingbase随便找点数据给我" made the model
// write "your_connection_id" and "your_table_name", then (told only the default database's system
// tables) invent t_user. It is now told the saved connections; the one the message names becomes
// the target, and so does the only database on it that holds tables of its own.
func TestAConnectionNamedInTheMessageBecomesTheTarget(t *testing.T) {
	s := &Service{agentToolCatalog: &fakeLookupCatalog{}}
	got, lines := s.builtinAIContextFor(context.Background(), builtinAITarget{}, "连接kingbase随便找点数据给我")
	if got.connectionID != "1789133301866" || got.dbName != "gonavi_kingbase_lab" {
		t.Fatalf("target: %+v", got)
	}
	text := strings.Join(lines, "\n")
	for _, want := range []string{
		"No connection is selected. Saved connections: 本地 (mysql, id 1775889710138), DuckDB (duckdb, id 1780629068100), PostGreSQL (postgres, id 1787492158693), KingBase (kingbase, id 1789133301866)",
		"The user means the connection KingBase (kingbase). Connection id (for tools): 1789133301866. Databases: test, kingbase, security, gonavi_kingbase_lab",
		"Database gonavi_kingbase_lab holds tables of its own; use it (dbName gonavi_kingbase_lab).",
		"Tables in gonavi_kingbase_lab (use these exact names): dbms_job.lab_customers, dbms_job.lab_employees, dbms_job.lab_order_items, dbms_job.lab_orders, dbms_job.lab_products",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
	if strings.Contains(text, "sysmac") {
		t.Errorf("system tables are left out:\n%s", text)
	}
	// The model's call on that connection then runs in that database.
	completed := got.complete([]ai.ToolCall{toolCall("execute_sql", `{"connectionId":"1789133301866","sql":"SELECT * FROM dbms_job.lab_orders LIMIT 10"}`)})
	if !strings.Contains(completed[0].Function.Arguments, `"dbName":"gonavi_kingbase_lab"`) {
		t.Fatalf("call: %s", completed[0].Function.Arguments)
	}
}

// Regression (2026-10-03): looking into all four KingBase databases at once, the SSH server refused
// three of the four tunnels. They are looked into one at a time, the likeliest first, until one
// holds tables of its own.
func TestTheDatabasesAreLookedIntoOneAtATimeLikeliestFirst(t *testing.T) {
	catalog := &fakeLookupCatalog{labs: map[string]bool{"test": true, "gonavi_kingbase_lab": true}}
	s := &Service{agentToolCatalog: catalog}
	got, _ := s.builtinAIContextFor(context.Background(), builtinAITarget{}, "kingbase 里有什么数据")
	if got.dbName != "gonavi_kingbase_lab" {
		t.Fatalf("the person's own database comes before the ones KingBase is installed with: %+v", got)
	}
	var tables []string
	for _, call := range catalog.seen() {
		if strings.HasPrefix(call, "get_tables ") {
			tables = append(tables, call)
		}
	}
	if len(tables) != 1 {
		t.Fatalf("the look stops at the first database with tables: %v", tables)
	}

	// A database the person has a tab open on is looked into first.
	opened := &Service{agentToolCatalog: &fakeLookupCatalog{labs: map[string]bool{"test": true, "gonavi_kingbase_lab": true}}}
	got, _ = opened.builtinAIContextFor(context.Background(), builtinAITarget{opened: map[string][]string{"1789133301866": {"test"}}}, "kingbase 里有什么数据")
	if got.dbName != "test" {
		t.Fatalf("an open tab's database first: %+v", got)
	}
}

func TestTheScanOrder(t *testing.T) {
	got := builtinAIScanOrder([]string{"test", "kingbase", "security", "mysql", "lab", "sales"}, []string{"sales", "gone"})
	if strings.Join(got, ",") != "sales,lab,test,kingbase,security" {
		t.Fatalf("got %v", got)
	}
}

func TestTheTargetKnowsTheDatabasesWithOpenTabs(t *testing.T) {
	encoded, _ := json.Marshal(map[string]any{"kind": "workspace_snapshot", "snapshot": map[string]any{
		"activeContext": map[string]any{},
		"tabs":          []any{map[string]any{"id": "t1", "connectionId": "kb", "database": "lab"}, map[string]any{"id": "t2", "kind": "settings"}},
	}})
	got := builtinAITargetOf([]ai.Message{{Role: "system", Content: string(encoded)}})
	if len(got.opened["kb"]) != 1 || got.opened["kb"][0] != "lab" {
		t.Fatalf("got %+v", got)
	}
}

// Regression (2026-10-03): when no database could be shown to hold tables of its own, the model was
// offered the default database's system tables, picked sysmac.sysmac_column_label and was refused.
func TestWithNoTablesOfItsOwnTheModelIsToldToLookNotOfferedSystemTables(t *testing.T) {
	s := &Service{agentToolCatalog: &fakeLookupCatalog{labs: map[string]bool{}}}
	got, lines := s.builtinAIContextFor(context.Background(), builtinAITarget{}, "连接kingbase随便找点数据给我")
	text := strings.Join(lines, "\n")
	if got.dbName != "" || strings.Contains(text, "sysmac") || !strings.Contains(text, "To see the tables, call get_tables with one of these databases as dbName.") {
		t.Fatalf("target %+v:\n%s", got, text)
	}
}

func TestSystemTablesAndDatabasesAreLeftOut(t *testing.T) {
	if got := builtinAIOwnTables(kingbaseLabTables); len(got) != 5 || got[0] != "dbms_job.lab_customers" {
		t.Fatalf("own: %v", got)
	}
	if got := builtinAIUserTables([]string{"sys_hm.check_param"}); len(got) != 1 {
		t.Fatalf("a database with only system tables still lists them: %v", got)
	}
	if got := builtinAIOwnTables([]string{"orders", "pg_temp.x", "information_schema.tables", "public.users"}); strings.Join(got, ",") != "orders,public.users" {
		t.Fatalf("got %v", got)
	}
	for _, name := range []string{"mysql", "information_schema", "performance_schema", "sys", "template1"} {
		if !builtinAISystemDatabase(name) {
			t.Errorf("%s is the server's own", name)
		}
	}
	if builtinAISystemDatabase("missav_bot") {
		t.Error("a person's database is not the server's")
	}
}

func TestAMessageThatNamesNoSingleConnectionOnlyListsThem(t *testing.T) {
	s := &Service{agentToolCatalog: &fakeLookupCatalog{}}
	for _, question := range []string{"随便找点数据给我", "compare mysql and kingbase"} {
		got, lines := s.builtinAIContextFor(context.Background(), builtinAITarget{}, question)
		if got.connectionID != "" || len(lines) != 1 || !strings.HasPrefix(lines[0], "No connection is selected. Saved connections: ") {
			t.Errorf("%q: target %+v lines %q", question, got, lines)
		}
	}
}

func TestMentionsMatchANameFirstThenAType(t *testing.T) {
	connections := []builtinAIConnection{{ID: "1", Name: "本地", Type: "mysql"}, {ID: "2", Name: "订单库", Type: "mysql"}, {ID: "3", Name: "KingBase", Type: "kingbase"}}
	for question, want := range map[string]string{"看看订单库": "2", "KINGBASE 里有啥": "3", "kingbase 和 本地 对比": "", "mysql 里的数据": ""} {
		got, ok := mentionedBuiltinAIConnection(connections, question)
		if (want == "") == ok || got.ID != want {
			t.Errorf("%q: got %+v ok=%v, want %q", question, got, ok, want)
		}
	}
}

func TestLookupsThatFailAreLeftOut(t *testing.T) {
	failing := &Service{agentToolCatalog: &fakeLookupCatalog{fail: true}}
	if got, lines := failing.builtinAIContextFor(context.Background(), builtinAITarget{}, "kingbase"); got.connectionID != "" || len(lines) != 0 {
		t.Fatalf("target %+v lines %q", got, lines)
	}
	if got, lines := (&Service{}).builtinAIContextFor(context.Background(), builtinAITarget{connectionID: "kb"}, "q"); got.connectionID != "kb" || len(lines) != 0 {
		t.Fatalf("no tool catalog: %+v %q", got, lines)
	}
}

func TestTheModelSeesTheRealNamesNextToTheDatabase(t *testing.T) {
	inner := &recordingProvider{stream: []ai.StreamChunk{{Content: "ok", Done: true}}}
	s := &Service{agentToolCatalog: &fakeLookupCatalog{}}
	wrapped := builtinAIPromptProvider{Provider: inner, lookup: s.builtinAIContextFor}
	request := ai.ChatRequest{Messages: []ai.Message{
		workspaceMessage(t, map[string]any{"connectionId": "1789133301866", "dbName": "gonavi_kingbase_lab", "schemaName": "dbms_job"}),
		{Role: "user", Content: "随便找点数据给我看看"},
	}}
	if err := wrapped.ChatStream(context.Background(), request, func(ai.StreamChunk) {}); err != nil {
		t.Fatal(err)
	}
	content := inner.request.Messages[len(inner.request.Messages)-1].Content
	want := "Database: gonavi_kingbase_lab. Connection id (for tools): 1789133301866. Schema: dbms_job\n\nTables in this database (use these exact names): dbms_job.lab_customers"
	if !strings.Contains(content, want) {
		t.Fatalf("the tables must follow the database line:\n%s", content)
	}
}

func TestWithNoWorkspaceTheLinesStillReachTheModel(t *testing.T) {
	got := presentBuiltinAIContextWithLines([]ai.Message{{Role: "user", Content: "连接kingbase"}}, []string{"No connection is selected. Saved connections: KingBase (kingbase, id 1)"})
	if len(got) != 1 || got[0].Content != "### Context\nNo connection is selected. Saved connections: KingBase (kingbase, id 1)\n\n### Request\n连接kingbase" {
		t.Fatalf("got %+v", got)
	}
}
