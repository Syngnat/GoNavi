package aiservice

import (
	"encoding/json"
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/safety"
)

// The built-in AI runs a 3B model on a small server, so it gets a short list of read-only tools:
// enough to see what is in the user's database and look at some rows, few enough that the model
// picks the right one and the definitions cost little prompt-reading time. Everything else in
// GoNavi's tool catalog stays with the large models. The Gateway only recognizes calls to tools
// offered in the request, so the model cannot reach the others either.
var builtinAIToolNames = map[string]bool{
	"get_server_version": true,
	"get_databases":      true,
	"get_tables":         true,
	"get_columns":        true,
	"get_table_ddl":      true,
	"execute_sql":        true,
}

const builtinAIExecuteSQLDescription = "Run one read-only query (SELECT, SHOW, DESCRIBE or EXPLAIN) on a saved connection and return the rows. Add LIMIT to queries that may return many rows. Statements that change data or schema are refused."

// builtinAITools keeps the curated tools, in the catalog's order, and offers execute_sql as the
// read-only query it is for this model.
func builtinAITools(tools []ai.Tool) []ai.Tool {
	var kept []ai.Tool
	for _, tool := range tools {
		name := strings.TrimSpace(tool.Function.Name)
		if !builtinAIToolNames[name] {
			continue
		}
		if name == "execute_sql" {
			tool.Function.Description = builtinAIExecuteSQLDescription
			tool.Function.Parameters = map[string]any{
				"type":                 "object",
				"additionalProperties": false,
				"required":             []string{"connectionId", "sql"},
				"properties": map[string]any{
					"connectionId": map[string]any{"type": "string", "description": "saved connection ID"},
					"dbName":       map[string]any{"type": "string", "description": "optional database or schema"},
					"sql":          map[string]any{"type": "string", "description": "one read-only SQL statement"},
				},
			}
		}
		kept = append(kept, tool)
	}
	return kept
}

// guardBuiltinAIToolCalls lets through the calls the built-in AI may make. A query that is not
// read-only is not run: the person gets the SQL to look at instead, with a note that says why.
// (The tool's own checks and the approval step stay in place for everything that passes.)
func guardBuiltinAIToolCalls(calls []ai.ToolCall, content string, notice string) ([]ai.ToolCall, string) {
	var allowed []ai.ToolCall
	var blocked []string
	for _, call := range calls {
		name := strings.TrimSpace(call.Function.Name)
		if !builtinAIToolNames[name] {
			continue
		}
		if name == "execute_sql" {
			var args struct {
				SQL string `json:"sql"`
			}
			_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
			if sql := strings.TrimSpace(args.SQL); sql == "" || safety.ClassifySQL(sql) != ai.SQLOpQuery {
				blocked = append(blocked, sql)
				continue
			}
		}
		allowed = append(allowed, call)
	}
	if len(blocked) == 0 {
		return allowed, content
	}
	var text strings.Builder
	if strings.TrimSpace(content) != "" {
		text.WriteString(strings.TrimRight(content, "\n"))
		text.WriteString("\n\n")
	}
	text.WriteString(notice)
	for _, sql := range blocked {
		if sql != "" {
			text.WriteString("\n\n```sql\n" + sql + "\n```")
		}
	}
	return allowed, text.String()
}

// builtinAITarget is the connection and database the person is working in, as the turn's
// workspace names them.
type builtinAITarget struct {
	connectionID string
	dbName       string
	schemaName   string
	// known are the saved connections' ids, when they could be read: a call naming any other
	// connection (the small model writes "your_connection_id") is put on the target instead.
	known map[string]bool
	// opened are the databases the person has tabs open on, by connection id.
	opened map[string][]string
}

// builtinAITargetOf reads the target from the workspace message, before it is presented as text.
func builtinAITargetOf(messages []ai.Message) builtinAITarget {
	for _, message := range messages {
		if message.Role != "system" || !strings.HasPrefix(strings.TrimSpace(message.Content), `{"kind":"workspace_snapshot"`) {
			continue
		}
		var envelope struct {
			Snapshot struct {
				ActiveContext map[string]any `json:"activeContext"`
				Tabs          []struct {
					ConnectionID string `json:"connectionId"`
					Database     string `json:"database"`
				} `json:"tabs"`
			} `json:"snapshot"`
		}
		if json.Unmarshal([]byte(message.Content), &envelope) == nil {
			active := envelope.Snapshot.ActiveContext
			target := builtinAITarget{connectionID: promptText(active["connectionId"]), dbName: promptText(active["dbName"]), schemaName: promptText(active["schemaName"])}
			for _, tab := range envelope.Snapshot.Tabs {
				if tab.ConnectionID == "" || tab.Database == "" {
					continue
				}
				if target.opened == nil {
					target.opened = map[string][]string{}
				}
				target.opened[tab.ConnectionID] = append(target.opened[tab.ConnectionID], tab.Database)
			}
			return target
		}
	}
	return builtinAITarget{}
}

// builtinAIToolsWithoutDatabase are the curated tools that take no database.
var builtinAIToolsWithoutDatabase = map[string]bool{"get_server_version": true, "get_databases": true}

// complete fills in what the small model leaves out of a call: the connection, when it names
// none or one that does not exist, and the database, when the call is on the person's connection
// and names none. Without the database a MySQL connection with no default answers "no tables",
// and the model reports that the database is empty. A call that names another saved connection
// or another database is left as is.
func (t builtinAITarget) complete(calls []ai.ToolCall) []ai.ToolCall {
	if t.connectionID == "" || len(calls) == 0 {
		return calls
	}
	completed := make([]ai.ToolCall, len(calls))
	for i, call := range calls {
		completed[i] = call
		name := strings.TrimSpace(call.Function.Name)
		if !builtinAIToolNames[name] {
			continue
		}
		args := map[string]any{}
		if raw := strings.TrimSpace(call.Function.Arguments); raw != "" {
			decoder := json.NewDecoder(strings.NewReader(raw))
			decoder.UseNumber()
			if decoder.Decode(&args) != nil || args == nil {
				continue
			}
		}
		changed := false
		switch id := args["connectionId"].(type) {
		case json.Number: // the model wrote the id without quotes; the tools take it as text
			args["connectionId"], changed = id.String(), true
		case string:
			if strings.TrimSpace(id) == "" {
				args["connectionId"], changed = t.connectionID, true
			}
		case nil:
			args["connectionId"], changed = t.connectionID, true
		}
		if id, _ := args["connectionId"].(string); len(t.known) > 0 && !t.known[id] {
			args["connectionId"], changed = t.connectionID, true
		}
		if id, _ := args["connectionId"].(string); id == t.connectionID && t.dbName != "" && !builtinAIToolsWithoutDatabase[name] {
			if db, _ := args["dbName"].(string); strings.TrimSpace(db) == "" {
				args["dbName"], changed = t.dbName, true
			}
		}
		if changed {
			if encoded, err := json.Marshal(args); err == nil {
				completed[i].Function.Arguments = string(encoded)
			}
		}
	}
	return completed
}

// builtinAIStreamGuard holds a streamed answer's tool calls until it ends: the provider reports
// the calls as they build up, and only the complete ones can be judged. They are then completed
// and passed on, or (for a refused query) replaced by the note.
type builtinAIStreamGuard struct {
	callback func(ai.StreamChunk)
	notice   string
	target   builtinAITarget
	calls    []ai.ToolCall
	released bool
	// preview is added before the end of an answer that makes no call and shows no table.
	preview string
	tail    string // the end of the answer so far, enough to see a table start
	table   bool
}

func newBuiltinAIStreamGuard(callback func(ai.StreamChunk), notice string, target builtinAITarget) *builtinAIStreamGuard {
	return &builtinAIStreamGuard{callback: callback, notice: notice, target: target}
}

func (g *builtinAIStreamGuard) push(chunk ai.StreamChunk) {
	if len(chunk.ToolCalls) > 0 {
		g.calls = append([]ai.ToolCall(nil), chunk.ToolCalls...)
		chunk.ToolCalls = nil
		if chunk.Content == "" && chunk.ReasoningContent == "" && chunk.Thinking == "" && !chunk.Done && chunk.Error == "" && chunk.Usage == nil {
			return
		}
	}
	if chunk.Content != "" && !g.table {
		g.tail += chunk.Content
		g.table = showsTable(g.tail)
		if len(g.tail) > 64 {
			g.tail = g.tail[len(g.tail)-64:]
		}
	}
	if chunk.Done || chunk.Error != "" {
		g.release()
	}
	if chunk.Done && chunk.Error == "" && g.preview != "" && len(g.calls) == 0 && !g.table {
		g.callback(ai.StreamChunk{Content: "\n\n" + g.preview})
		g.preview = ""
	}
	g.callback(chunk)
}

// finish releases what is still held if the provider stopped without a final chunk.
func (g *builtinAIStreamGuard) finish() { g.release() }

func (g *builtinAIStreamGuard) release() {
	if g.released || len(g.calls) == 0 {
		return
	}
	g.released = true
	allowed, text := guardBuiltinAIToolCalls(g.target.complete(g.calls), "", g.notice)
	if text != "" {
		g.callback(ai.StreamChunk{Content: text})
	}
	if len(allowed) > 0 {
		g.callback(ai.StreamChunk{ToolCalls: allowed})
	}
}

// builtinAIToolRows is how many rows of each result set the small model reads; the person sees
// them all. A hundred rows of eight columns took the model on the slow node most of a minute to
// read, and it then answered "got the data" without showing any.
const builtinAIToolRows = 20

// compactBuiltinAIToolResult is a query result as the small model reads it: the first rows of each
// result set, with how many it holds in all, and without the bookkeeping fields. Anything that is
// not such a result is left as it was.
func compactBuiltinAIToolResult(content string) string {
	var result map[string]any
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.UseNumber()
	if decoder.Decode(&result) != nil {
		return content
	}
	sets, ok := result["results"].([]any)
	if !ok {
		return content
	}
	for _, raw := range sets {
		set, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		rows, ok := set["rows"].([]any)
		if !ok {
			continue
		}
		if len(rows) > builtinAIToolRows {
			rows = rows[:builtinAIToolRows]
			set["rows"] = rows
			set["shownRows"] = builtinAIToolRows
		}
		// Dates as people write them (and as the person sees them), in fewer tokens.
		for _, raw := range rows {
			if row, ok := raw.(map[string]any); ok {
				for column, value := range row {
					if text, ok := value.(string); ok {
						row[column] = readableTimestamp(text)
					}
				}
			}
		}
	}
	for _, key := range []string{"queryId", "requestId", "statements", "statementCount"} {
		delete(result, key)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return content
	}
	return string(encoded)
}
