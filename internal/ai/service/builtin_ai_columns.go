package aiservice

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
)

// Asked to explain or optimize a query, the built-in model first looks up every table it names,
// one tool call per table, and on the small server each call is a model turn of its own: a
// five-table query spent four of its five minutes on get_columns (seen 2026-10-06). The columns
// of the tables the person's SQL names are read here instead, with the same tool, and given to the
// model next to the table list.

const (
	// builtinAIColumnTables bounds how many tables' columns are read for one question.
	builtinAIColumnTables = 6
	// builtinAIColumnsTimeout is how long reading them may take in all. One at a time, like the
	// other lookups: each opens a connection of its own.
	builtinAIColumnsTimeout = 20 * time.Second
)

// builtinAISQLTableRef finds the table after the keywords that introduce one: FROM, JOIN, UPDATE,
// INTO, TABLE, DESCRIBE/DESC, with or without a schema and quotes. A table listed after a comma
// (FROM a, b) is not found; the model can still look that one up.
var builtinAISQLTableRef = regexp.MustCompile("(?i)\\b(?:from|join|update|into|table|describe|desc)\\s+" +
	"([`\"\\[]?[\\w$]+[`\"\\]]?(?:\\s*\\.\\s*[`\"\\[]?[\\w$]+[`\"\\]]?)?)")

// builtinAIColumn is a column as get_columns describes it.
type builtinAIColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Key  string `json:"key"`
}

// builtinAIColumnsFor returns a line per table of the target's database that the text names, with
// its columns; nil without a database to look in or when none of its tables is named.
func (s *Service) builtinAIColumnsFor(ctx context.Context, target builtinAITarget, text string) []string {
	if s == nil || target.connectionID == "" || s.agentToolCatalog == nil {
		return nil
	}
	tables := builtinAISQLTables(text, s.builtinAITables(ctx, target), target.schemaName)
	if len(tables) == 0 {
		return nil
	}
	read, cancel := context.WithTimeout(ctx, builtinAIColumnsTimeout)
	defer cancel()
	var lines []string
	for _, table := range tables {
		if read.Err() != nil {
			break
		}
		if line := builtinAIColumnsLine(table, s.builtinAIColumns(read, target, table)); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func (s *Service) builtinAIColumns(ctx context.Context, target builtinAITarget, table string) []builtinAIColumn {
	key := "columns\x00" + target.connectionID + "\x00" + target.dbName + "\x00" + table
	columns, _ := s.builtinAILookup(key, func() (any, bool) {
		var listed struct {
			Columns []builtinAIColumn `json:"columns"`
		}
		args := map[string]string{"connectionId": target.connectionID, "dbName": target.dbName, "tableName": table}
		ok := callBuiltinAITool(ctx, s.agentToolCatalog, "get_columns", args, &listed)
		return listed.Columns, ok
	}).([]builtinAIColumn)
	return columns
}

// builtinAISQLTables are the tables of the list that the text's SQL names, in the order it names
// them, at most builtinAIColumnTables. A name is matched with or without its schema; when two
// schemas hold a table of that name, the one in the current schema is taken, or else none.
func builtinAISQLTables(text string, tables []string, schema string) []string {
	if len(tables) == 0 {
		return nil
	}
	schema = strings.ToLower(strings.TrimSpace(schema))
	var found []string
	seen := map[string]bool{}
	for _, match := range builtinAISQLTableRef.FindAllStringSubmatch(text, -1) {
		name := builtinAITableRefName(match[1])
		chosen := builtinAIMatchTable(name, tables, schema)
		if chosen == "" || seen[chosen] {
			continue
		}
		seen[chosen] = true
		found = append(found, chosen)
		if len(found) == builtinAIColumnTables {
			break
		}
	}
	return found
}

// builtinAITableRefName is a table reference without its quotes and spaces, lower case.
func builtinAITableRefName(ref string) string {
	ref = strings.Map(func(r rune) rune {
		switch r {
		case '`', '"', '[', ']', ' ', '\t', '\n', '\r':
			return -1
		}
		return r
	}, ref)
	return strings.ToLower(ref)
}

// builtinAIMatchTable is the listed table a lower-case reference names, or "".
func builtinAIMatchTable(ref string, tables []string, schema string) string {
	refSchema, refName, qualified := strings.Cut(ref, ".")
	if !qualified {
		refName, refSchema = refSchema, ""
	}
	var candidates []string
	for _, table := range tables {
		lower := strings.ToLower(table)
		if lower == ref {
			return table
		}
		tableSchema, tableName, tableQualified := strings.Cut(lower, ".")
		if !tableQualified {
			tableName, tableSchema = tableSchema, ""
		}
		if tableName == refName && (refSchema == "" || refSchema == tableSchema) {
			candidates = append(candidates, table)
		}
	}
	if len(candidates) == 1 {
		return candidates[0]
	}
	for _, table := range candidates {
		if tableSchema, _, _ := strings.Cut(strings.ToLower(table), "."); schema != "" && tableSchema == schema {
			return table
		}
	}
	return ""
}

// builtinAIColumnsLine is the line the model reads about a table's columns: name and type, with
// the key the server reports (PK, UNIQUE, INDEX: an index starts with that column).
func builtinAIColumnsLine(table string, columns []builtinAIColumn) string {
	if len(columns) == 0 {
		return ""
	}
	described := make([]string, 0, len(columns))
	for _, column := range columns {
		item := strings.TrimSpace(column.Name + " " + column.Type)
		switch strings.ToUpper(strings.TrimSpace(column.Key)) {
		case "PRI":
			item += " PK"
		case "UNI":
			item += " UNIQUE"
		case "MUL":
			item += " INDEX"
		}
		described = append(described, item)
	}
	line, shown := builtinAIListLine("Columns of "+table+" (read from the database): ", described)
	if more := len(described) - shown; more > 0 {
		line += ", and more (call get_columns to see them)"
	}
	return line
}

// builtinAIQuestion is what the latest turn asks about.
type builtinAIQuestion struct {
	// text is the person's message and the SQL they selected in the editor, where the tables they
	// mean are named.
	text string
	// version is the database version the workspace reports, which the model is told.
	version string
}

func builtinAIQuestionOf(messages []ai.Message) builtinAIQuestion {
	parts := []string{latestUserText(messages)}
	var version string
	for _, message := range messages {
		if message.Role != "system" || !strings.HasPrefix(strings.TrimSpace(message.Content), `{"kind":"workspace_snapshot"`) {
			continue
		}
		var envelope struct {
			Snapshot struct {
				ActiveContext struct {
					DatabaseVersion any              `json:"databaseVersion"`
					AttachedItems   []map[string]any `json:"attachedItems"`
				} `json:"activeContext"`
			} `json:"snapshot"`
		}
		if json.Unmarshal([]byte(message.Content), &envelope) != nil {
			continue
		}
		version = promptText(envelope.Snapshot.ActiveContext.DatabaseVersion)
		for _, item := range envelope.Snapshot.ActiveContext.AttachedItems {
			if item["kind"] == "editor_selection" {
				parts = append(parts, promptText(item["content"]))
			}
		}
	}
	return builtinAIQuestion{text: strings.Join(parts, "\n"), version: version}
}
