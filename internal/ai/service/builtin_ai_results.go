package aiservice

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"GoNavi-Wails/internal/ai"
)

// The built-in model is a text-to-SQL model: asked for "some data", it ran the right query and then
// answered with the query again, not with what it returned. So when a turn ends right after a
// query and the answer shows no table, the desktop adds one: the first rows of the result, under a
// line in the person's language saying how many there are.

const (
	builtinAIPreviewRows    = 10
	builtinAIPreviewColumns = 8
	builtinAIPreviewCell    = 40 // runes
)

// builtinAIResultPreview is the table for the query result the request ends with, or "" when it
// does not end with one (or it has no rows).
func builtinAIResultPreview(messages []ai.Message, heading func(shown, total int) string) string {
	if len(messages) == 0 || heading == nil || messages[len(messages)-1].Role != "tool" {
		return ""
	}
	var result struct {
		Results []struct {
			Columns  []string         `json:"columns"`
			RowCount int              `json:"rowCount"`
			Rows     []map[string]any `json:"rows"`
		} `json:"results"`
	}
	decoder := json.NewDecoder(strings.NewReader(messages[len(messages)-1].Content))
	decoder.UseNumber()
	if decoder.Decode(&result) != nil || len(result.Results) == 0 {
		return ""
	}
	set := result.Results[0]
	if len(set.Columns) == 0 || len(set.Rows) == 0 {
		return ""
	}
	columns := set.Columns
	if len(columns) > builtinAIPreviewColumns {
		columns = columns[:builtinAIPreviewColumns]
	}
	shown := min(len(set.Rows), builtinAIPreviewRows)
	total := max(set.RowCount, len(set.Rows))

	var b strings.Builder
	b.WriteString(heading(shown, total))
	b.WriteString("\n\n|")
	for _, column := range columns {
		b.WriteString(" " + previewCell(column) + " |")
	}
	b.WriteString("\n|")
	for range columns {
		b.WriteString(" --- |")
	}
	for _, row := range set.Rows[:shown] {
		b.WriteString("\n|")
		for _, column := range columns {
			b.WriteString(" " + previewCell(row[column]) + " |")
		}
	}
	return b.String()
}

func previewCell(value any) string {
	var text string
	switch v := value.(type) {
	case nil:
		text = "NULL"
	case string:
		text = readableTimestamp(v)
	default:
		text = fmt.Sprint(v)
	}
	text = strings.NewReplacer("|", `\|`, "\r\n", " ", "\n", " ", "\r", " ").Replace(text)
	if utf8.RuneCountInString(text) > builtinAIPreviewCell {
		text = string([]rune(text)[:builtinAIPreviewCell]) + "…"
	}
	return text
}

// showsTable reports whether an answer already shows a markdown table.
func showsTable(text string) bool {
	return strings.Contains(text, "|---") || strings.Contains(text, "| ---") || strings.Contains(text, "|:--")
}

// timestampPattern is a date and time as Go writes it in JSON: "2026-08-31T08:00:41.460282Z".
var timestampPattern = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$`)

// readableTimestamp shows a date and time the way GoNavi's result grid does: "2026-08-31
// 08:00:41.460282", not "2026-08-31T08:00:41.460282Z". The Z is the driver's label on a value
// stored without a time zone, which is the wall-clock time as stored; any other offset is kept. A
// value at midnight with no fraction (a DATE column, such as register_date) is shown as the date.
func readableTimestamp(text string) string {
	match := timestampPattern.FindStringSubmatch(text)
	if match == nil {
		return text
	}
	date, clock, fraction, zone := match[1], match[2], match[3], match[4]
	if zone == "Z" || zone == "+00:00" || zone == "+0000" {
		zone = ""
	}
	if clock == "00:00:00" && fraction == "" && zone == "" {
		return date
	}
	return date + " " + clock + fraction + zone
}
