package aiservice

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestTheTablesTheSQLNamesAreFoundInTheList(t *testing.T) {
	cases := []struct {
		name   string
		text   string
		schema string
		want   []string
	}{
		{
			name: "joins, quotes and a schema, in the order named",
			text: "请解释：\n```sql\nSELECT * FROM lab_orders o JOIN `lab_customers` c ON c.id = o.customer_id\nLEFT JOIN dbms_job.\"lab_products\" p ON 1=1 ORDER BY o.id DESC LIMIT 10\n```",
			want: []string{"dbms_job.lab_orders", "dbms_job.lab_customers", "dbms_job.lab_products"},
		},
		{
			name: "each table once, unknown names and keywords left out",
			text: "SELECT 1 FROM lab_orders WHERE NOT EXISTS (SELECT 1 FROM missing_table m JOIN LAB_ORDERS x ON 1=1) ORDER BY 1 DESC",
			want: []string{"dbms_job.lab_orders"},
		},
		{
			name: "update, insert and describe",
			text: "UPDATE lab_products SET x = 1; INSERT INTO lab_employees VALUES (1); DESCRIBE lab_order_items",
			want: []string{"dbms_job.lab_products", "dbms_job.lab_employees", "dbms_job.lab_order_items"},
		},
		{
			name: "no SQL, no tables",
			text: "随便找点数据给我看看",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := builtinAISQLTables(tc.text, kingbaseLabTables, tc.schema)
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestATableNameInTwoSchemasIsTakenFromTheCurrentOneOrNotAtAll(t *testing.T) {
	tables := []string{"sales.orders", "archive.orders", "public.users"}
	if got := builtinAISQLTables("SELECT * FROM orders", tables, "archive"); len(got) != 1 || got[0] != "archive.orders" {
		t.Fatalf("the current schema's table: %v", got)
	}
	if got := builtinAISQLTables("SELECT * FROM orders", tables, ""); len(got) != 0 {
		t.Fatalf("no way to tell which one: %v", got)
	}
	if got := builtinAISQLTables("SELECT * FROM sales.orders JOIN users", tables, ""); strings.Join(got, ",") != "sales.orders,public.users" {
		t.Fatalf("a qualified name picks its own; a unique one needs no schema: %v", got)
	}
}

func TestAtMostSixTablesAreRead(t *testing.T) {
	var tables []string
	var sql strings.Builder
	sql.WriteString("SELECT 1 FROM t0")
	for i := 0; i < 9; i++ {
		name := "t" + string(rune('0'+i))
		tables = append(tables, name)
		if i > 0 {
			sql.WriteString(" JOIN " + name + " ON 1=1")
		}
	}
	if got := builtinAISQLTables(sql.String(), tables, ""); len(got) != builtinAIColumnTables {
		t.Fatalf("got %d tables: %v", len(got), got)
	}
}

func TestTheColumnsLineNamesTypesAndKeys(t *testing.T) {
	got := builtinAIColumnsLine("orders", []builtinAIColumn{
		{Name: "id", Type: "bigint", Key: "PRI"},
		{Name: "code", Type: "varchar(32)", Key: "UNI"},
		{Name: "customer_id", Type: "bigint", Key: "MUL"},
		{Name: "note", Type: "text"},
	})
	want := "Columns of orders (read from the database): id bigint PK, code varchar(32) UNIQUE, customer_id bigint INDEX, note text"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if builtinAIColumnsLine("orders", nil) != "" {
		t.Fatal("no columns, no line")
	}
	var wide []builtinAIColumn
	for i := 0; i < 200; i++ {
		wide = append(wide, builtinAIColumn{Name: "column_with_a_long_name_" + strings.Repeat("x", i%7), Type: "varchar(255)"})
	}
	if long := builtinAIColumnsLine("wide", wide); len(long) > builtinAILineMaxBytes+80 || !strings.HasSuffix(long, ", and more (call get_columns to see them)") {
		t.Fatalf("%d bytes: %s", len(long), long)
	}
}

// Regression (2026-10-06): asked to optimize a five-table query, the built-in model called
// get_columns once per table, each a model turn of its own, and spent four of five minutes on
// them. The columns of the tables the SQL names are now read up front, once, and kept.
func TestTheColumnsOfTheTablesTheSQLNamesAreReadOnceAndKept(t *testing.T) {
	catalog := &fakeLookupCatalog{}
	s := &Service{agentToolCatalog: catalog}
	target := builtinAITarget{connectionID: "1789133301866", dbName: "gonavi_kingbase_lab", schemaName: "dbms_job"}
	text := "请分析性能：SELECT * FROM lab_orders o JOIN lab_customers c ON c.id = o.customer_id"

	lines := s.builtinAIColumnsFor(context.Background(), target, text)
	_ = s.builtinAIColumnsFor(context.Background(), target, text)
	want := []string{
		"Columns of dbms_job.lab_orders (read from the database): id bigint PK, customer_id bigint INDEX, created_at timestamp",
		"Columns of dbms_job.lab_customers (read from the database): id bigint PK, customer_id bigint INDEX, created_at timestamp",
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("lines:\n%s", strings.Join(lines, "\n"))
	}
	calls := catalog.seen()
	wantCalls := []string{
		`get_tables {"connectionId":"1789133301866","dbName":"gonavi_kingbase_lab"}`,
		`get_columns {"connectionId":"1789133301866","dbName":"gonavi_kingbase_lab","tableName":"dbms_job.lab_orders"}`,
		`get_columns {"connectionId":"1789133301866","dbName":"gonavi_kingbase_lab","tableName":"dbms_job.lab_customers"}`,
	}
	if strings.Join(calls, "\n") != strings.Join(wantCalls, "\n") {
		t.Fatalf("each list is read once, one at a time:\n%s", strings.Join(calls, "\n"))
	}
}

func TestNoColumnsAreReadWithoutADatabaseOrATableNamed(t *testing.T) {
	catalog := &fakeLookupCatalog{}
	s := &Service{agentToolCatalog: catalog}
	if lines := s.builtinAIColumnsFor(context.Background(), builtinAITarget{}, "SELECT * FROM lab_orders"); lines != nil || len(catalog.seen()) != 0 {
		t.Fatalf("no connection: %q %v", lines, catalog.seen())
	}
	target := builtinAITarget{connectionID: "1789133301866", dbName: "gonavi_kingbase_lab"}
	if lines := s.builtinAIColumnsFor(context.Background(), target, "随便找点数据给我看看"); lines != nil {
		t.Fatalf("no table named: %q", lines)
	}
	failing := &Service{agentToolCatalog: &fakeLookupCatalog{fail: true}}
	if lines := failing.builtinAIColumnsFor(context.Background(), target, "SELECT * FROM lab_orders"); lines != nil {
		t.Fatalf("lookups that fail are left out: %q", lines)
	}
}

func TestTheQuestionHasTheSelectedSQLAndTheVersion(t *testing.T) {
	messages := []ai.Message{
		workspaceMessage(t, map[string]any{"connectionId": "c1", "databaseVersion": "5.7.26-log", "attachedItems": []any{
			map[string]any{"kind": "editor_selection", "content": "SELECT * FROM lab_products"},
			map[string]any{"kind": "table_schema", "ddl": "CREATE TABLE lab_orders (id int)"},
		}}),
		{Role: "user", Content: "解释一下选中的 SQL"},
	}
	got := builtinAIQuestionOf(messages)
	if !strings.Contains(got.text, "解释一下选中的 SQL") || !strings.Contains(got.text, "FROM lab_products") || strings.Contains(got.text, "CREATE TABLE") {
		t.Fatalf("text %q", got.text)
	}
	if got.version != "5.7.26-log" {
		t.Fatalf("version %q", got.version)
	}
	if bare := builtinAIQuestionOf([]ai.Message{{Role: "user", Content: "hi"}}); bare.text != "hi" || bare.version != "" {
		t.Fatalf("no workspace: %+v", bare)
	}
}

func TestToolsThatWouldOnlyRepeatTheContextAreLeftOut(t *testing.T) {
	var curated []ai.Tool
	for _, name := range []string{"get_server_version", "get_databases", "get_tables", "get_columns", "get_table_ddl", "execute_sql"} {
		curated = append(curated, catalogTool(name))
	}
	cases := []struct {
		name  string
		known builtinAIKnown
		want  string
	}{
		{"nothing known", builtinAIKnown{}, "get_server_version,get_databases,get_tables,get_columns,get_table_ddl,execute_sql"},
		{"the version", builtinAIKnown{version: true}, "get_databases,get_tables,get_columns,get_table_ddl,execute_sql"},
		{"the tables of the SQL", builtinAIKnown{tables: true}, "execute_sql"},
		{"both", builtinAIKnown{version: true, tables: true}, "execute_sql"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := toolNames(builtinAITurnTools(curated, tc.known)); got != tc.want {
				t.Fatalf("got %s", got)
			}
		})
	}
}

// Regression (2026-10-06): asked to optimize a query whose tables' columns it had been given, the
// hosted model still read the version, the table list and every table's columns and definition.
func TestWithTheTablesOfTheSQLInTheContextOnlyQueriesAreOffered(t *testing.T) {
	s := &Service{agentToolCatalog: &fakeLookupCatalog{}}
	var tools []ai.Tool
	for _, name := range []string{"get_server_version", "get_databases", "get_tables", "get_columns", "get_table_ddl", "execute_sql"} {
		tools = append(tools, catalogTool(name))
	}
	ask := func(question string) string {
		inner := &recordingProvider{stream: []ai.StreamChunk{{Content: "ok", Done: true}}}
		wrapped := builtinAIPromptProvider{Provider: inner, lookup: s.builtinAIContextFor, columns: s.builtinAIColumnsFor}
		request := ai.ChatRequest{Tools: tools, Messages: []ai.Message{
			workspaceMessage(t, map[string]any{"connectionId": "1789133301866", "dbName": "gonavi_kingbase_lab", "schemaName": "dbms_job", "databaseVersion": "KingbaseES V8"}),
			{Role: "user", Content: question},
		}}
		if err := wrapped.ChatStream(context.Background(), request, func(ai.StreamChunk) {}); err != nil {
			t.Fatal(err)
		}
		return toolNames(inner.request.Tools)
	}
	if got := ask("请分析以下 SQL 的性能：\n```sql\nSELECT * FROM lab_orders JOIN lab_customers USING (id)\n```"); got != "execute_sql" {
		t.Fatalf("SQL on known tables: %s", got)
	}
	if got := ask("统计最近 30 天每个客户的订单数"); got != "get_databases,get_tables,get_columns,get_table_ddl,execute_sql" {
		t.Fatalf("a question without SQL keeps the lookups, but not the version it was told: %s", got)
	}
}

func toolNames(tools []ai.Tool) string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Function.Name)
	}
	return strings.Join(names, ",")
}

func TestTheModelSeesTheColumnsAfterTheTables(t *testing.T) {
	inner := &recordingProvider{stream: []ai.StreamChunk{{Content: "ok", Done: true}}}
	s := &Service{agentToolCatalog: &fakeLookupCatalog{}}
	wrapped := builtinAIPromptProvider{Provider: inner, lookup: s.builtinAIContextFor, columns: s.builtinAIColumnsFor}
	request := ai.ChatRequest{Messages: []ai.Message{
		workspaceMessage(t, map[string]any{"connectionId": "1789133301866", "dbName": "gonavi_kingbase_lab", "schemaName": "dbms_job"}),
		{Role: "user", Content: "请解释以下 SQL 语句的执行逻辑：\n```sql\nSELECT * FROM lab_orders\n```"},
	}}
	if err := wrapped.ChatStream(context.Background(), request, func(ai.StreamChunk) {}); err != nil {
		t.Fatal(err)
	}
	content := inner.request.Messages[len(inner.request.Messages)-1].Content
	tables := strings.Index(content, "Tables in this database (use these exact names)")
	columns := strings.Index(content, "Columns of dbms_job.lab_orders (read from the database): id bigint PK")
	question := strings.Index(content, "### Request")
	if tables < 0 || columns < tables || question < columns {
		t.Fatalf("the columns must follow the tables, before the question:\n%s", content)
	}
}
