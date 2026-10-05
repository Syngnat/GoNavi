package cli

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sqlaudit"
)

func renderQueryResult(stdout io.Writer, stderr io.Writer, result connection.QueryResult, format string) int {
	format = strings.ToLower(strings.TrimSpace(format))
	if format == "" {
		format = "jsonl"
	}
	if format == "json" {
		return emitOutput(stdout, stderr, sanitizeQueryResult(result))
	}
	sets, err := queryResultSets(result)
	switch format {
	case "jsonl":
		// Writes and other successful non-tabular actions return metadata such
		// as affectedRows instead of result sets. They still use the stable
		// JSONL summary contract; only tabular data emits result_set/row events.
		if err != nil {
			sanitized := sanitizeQueryResult(result)
			return emitOutput(stdout, stderr, jsonlSummaryEvent{
				Type:       "summary",
				Success:    sanitized.Success,
				QueryID:    sanitized.QueryID,
				Message:    sanitized.Message,
				Messages:   sanitized.Messages,
				Data:       sanitized.Data,
				ResultSets: 0,
				Rows:       0,
			})
		}
		rows := 0
		for index, set := range sets {
			if code := emitOutput(stdout, stderr, jsonlResultSetEvent{
				Type:      "result_set",
				ResultSet: index + 1,
				Columns:   set.Columns,
				RowCount:  len(set.Rows),
			}); code != ExitSuccess {
				return code
			}
			for _, row := range set.Rows {
				if code := emitOutput(stdout, stderr, jsonlRowEvent{Type: "row", ResultSet: index + 1, Data: row}); code != ExitSuccess {
					return code
				}
				rows++
			}
		}
		sanitized := sanitizeQueryResult(result)
		return emitOutput(stdout, stderr, jsonlSummaryEvent{
			Type:       "summary",
			Success:    sanitized.Success,
			QueryID:    sanitized.QueryID,
			Message:    sanitized.Message,
			Messages:   sanitized.Messages,
			ResultSets: len(sets),
			Rows:       rows,
		})
	case "csv", "md", "markdown":
		if err != nil {
			return fail(stderr, ExitExecution, "invalid_result", err)
		}
		if len(sets) != 1 {
			return fail(stderr, ExitUsage, "unsupported_result_shape", errors.New("csv and markdown require exactly one result set"))
		}
		switch format {
		case "csv":
			writer := csv.NewWriter(stdout)
			if err := writer.Write(sets[0].Columns); err != nil {
				return fail(stderr, ExitExecution, "output_failed", err)
			}
			for _, row := range sets[0].Rows {
				record := make([]string, len(sets[0].Columns))
				for index, column := range sets[0].Columns {
					record[index] = formatOutputValue(row[column])
				}
				if err := writer.Write(record); err != nil {
					return fail(stderr, ExitExecution, "output_failed", err)
				}
			}
			writer.Flush()
			if err := writer.Error(); err != nil {
				return fail(stderr, ExitExecution, "output_failed", err)
			}
			return ExitSuccess
		case "md", "markdown":
			if _, err := fmt.Fprintf(stdout, "| %s |\n", strings.Join(sets[0].Columns, " | ")); err != nil {
				return fail(stderr, ExitExecution, "output_failed", err)
			}
			separator := make([]string, len(sets[0].Columns))
			for index := range separator {
				separator[index] = "---"
			}
			if _, err := fmt.Fprintf(stdout, "| %s |\n", strings.Join(separator, " | ")); err != nil {
				return fail(stderr, ExitExecution, "output_failed", err)
			}
			for _, row := range sets[0].Rows {
				record := make([]string, len(sets[0].Columns))
				for index, column := range sets[0].Columns {
					value := strings.ReplaceAll(formatOutputValue(row[column]), "|", "\\|")
					record[index] = strings.ReplaceAll(value, "\n", "<br>")
				}
				if _, err := fmt.Fprintf(stdout, "| %s |\n", strings.Join(record, " | ")); err != nil {
					return fail(stderr, ExitExecution, "output_failed", err)
				}
			}
			return ExitSuccess
		}
	default:
		return fail(stderr, ExitUsage, "usage", fmt.Errorf("unsupported query format %q", format))
	}
	return ExitExecution
}

func isCLIQueryFormat(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "json", "jsonl", "csv", "md", "markdown":
		return true
	default:
		return false
	}
}

func queryResultSets(result connection.QueryResult) ([]connection.ResultSetData, error) {
	if result.Data == nil {
		return []connection.ResultSetData{{Columns: result.Fields, Rows: []map[string]any{}}}, nil
	}
	if sets, ok := result.Data.([]connection.ResultSetData); ok {
		return sets, nil
	}
	if rows, ok := result.Data.([]map[string]any); ok {
		return []connection.ResultSetData{{Columns: result.Fields, Rows: rows}}, nil
	}
	return nil, fmt.Errorf("query result is not tabular")
}

func emitRequestTrace(stderr io.Writer, runtime backend, result connection.QueryResult) {
	if stderr == nil || runtime == nil || strings.TrimSpace(result.QueryID) == "" {
		return
	}
	reader, ok := runtime.(requestDiagnosticBackend)
	if !ok {
		return
	}
	diagnostic := reader.GetRequestDiagnostic(result.QueryID)
	if !diagnostic.Success || diagnostic.Data == nil {
		return
	}
	// Diagnostic capture is observability only: a local stderr write must not
	// change the outcome of the database command that just completed.
	_ = encode(stderr, map[string]any{
		"type":  "request_trace",
		"trace": diagnostic.Data,
	})
}

func sanitizeQueryResult(result connection.QueryResult) connection.QueryResult {
	result.Message = sqlaudit.RedactError(result.Message)
	if len(result.Messages) > 0 {
		messages := make([]string, 0, len(result.Messages))
		for _, message := range result.Messages {
			messages = append(messages, sqlaudit.RedactError(message))
		}
		result.Messages = messages
	}
	return result
}

func formatOutputValue(value any) string {
	if value == nil {
		return ""
	}
	switch value.(type) {
	case map[string]any, []any, []string, []byte:
		if encoded, err := json.Marshal(value); err == nil {
			return string(encoded)
		}
	}
	return fmt.Sprint(value)
}

func splitCSVList(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if normalized := strings.TrimSpace(part); normalized != "" {
			result = append(result, normalized)
		}
	}
	return result
}

func isCLIExportFormat(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "csv", "json", "md", "html", "xlsx":
		return true
	default:
		return false
	}
}

func isCLIAuditFormat(format string) bool {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "json", "csv":
		return true
	default:
		return false
	}
}

func parseTimestamp(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	if milliseconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		return milliseconds, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return 0, err
	}
	return parsed.UnixMilli(), nil
}

func resultDataBool(result connection.QueryResult, key string) bool {
	data, ok := result.Data.(map[string]any)
	if !ok {
		return false
	}
	value, _ := data[key].(bool)
	return value
}

func resultHasUnknownOutcome(result connection.QueryResult) bool {
	return resultDataBool(result, "outcomeUnknown")
}

func resultWasCancelled(result connection.QueryResult) bool {
	return resultDataBool(result, "cancelled")
}

func resultErrorKind(result connection.QueryResult) string {
	data, ok := result.Data.(map[string]any)
	if !ok {
		return ""
	}
	kind, _ := data["errorKind"].(string)
	return strings.ToLower(strings.TrimSpace(kind))
}

func failResult(ctx context.Context, stderr io.Writer, result connection.QueryResult) int {
	if resultHasUnknownOutcome(result) {
		return fail(stderr, ExitUnknownOutcome, "outcome_unknown", errors.New(result.Message))
	}
	if resultWasCancelled(result) {
		return fail(stderr, ExitCancelled, "cancelled", errors.New(result.Message))
	}
	if ctx != nil && ctx.Err() != nil {
		return fail(stderr, ExitCancelled, "cancelled", ctx.Err())
	}
	if resultErrorKind(result) == "connection" {
		return fail(stderr, ExitConnection, "connection_failed", errors.New(result.Message))
	}
	if resultErrorKind(result) == "policy" {
		return fail(stderr, ExitPolicyDenied, "policy_denied", errors.New(result.Message))
	}
	if hasCancellationToken(result.Message) {
		return fail(stderr, ExitCancelled, "cancelled", errors.New(result.Message))
	}
	if strings.Contains(strings.ToLower(result.Message), "allow-write") || strings.Contains(strings.ToLower(result.Message), "allow-mutating") || strings.Contains(strings.ToLower(result.Message), "read-only") || strings.Contains(result.Message, "只读") {
		return fail(stderr, ExitPolicyDenied, "policy_denied", errors.New(result.Message))
	}
	return fail(stderr, ExitExecution, "execution_failed", errors.New(result.Message))
}

// hasCancellationToken deliberately matches standalone cancellation words.
// Substrings such as "cancellation_reason" are ordinary database identifiers,
// not evidence that an operation was cancelled.
func hasCancellationToken(message string) bool {
	for _, token := range strings.FieldsFunc(strings.ToLower(message), func(r rune) bool {
		return !unicode.IsLetter(r)
	}) {
		switch token {
		case "cancel", "canceled", "cancelled":
			return true
		}
	}
	return false
}

func failResolveSavedConnection(stderr io.Writer, err error) int {
	var ambiguous *appcore.AmbiguousConnectionNameError
	if errors.As(err, &ambiguous) {
		return fail(stderr, ExitConnection, "connection_ambiguous", err)
	}
	return fail(stderr, ExitConnection, "connection_not_found", err)
}

func failCommandConnection(stderr io.Writer, err error) int {
	if errors.Is(err, errConnectionSourceConflict) || errors.Is(err, errConnectionSourceMissing) {
		return fail(stderr, ExitUsage, "usage", err)
	}
	var ambiguous *appcore.AmbiguousConnectionNameError
	if errors.As(err, &ambiguous) {
		return failResolveSavedConnection(stderr, err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "saved connection not found") {
		return failResolveSavedConnection(stderr, err)
	}
	return fail(stderr, ExitConnection, "connection_file_invalid", err)
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet("gonavi "+name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func visitedFlags(fs *flag.FlagSet) map[string]bool {
	result := make(map[string]bool)
	fs.Visit(func(item *flag.Flag) {
		result[item.Name] = true
	})
	return result
}

func emit(writer io.Writer, value any) int {
	if err := encode(writer, value); err != nil {
		return ExitExecution
	}
	return ExitSuccess
}

func emitOutput(stdout io.Writer, stderr io.Writer, value any) int {
	if err := encode(stdout, value); err != nil {
		return fail(stderr, ExitExecution, "output_failed", err)
	}
	return ExitSuccess
}

func encode(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func fail(writer io.Writer, exitCode int, code string, err error) int {
	message := "operation failed"
	if err != nil {
		message = sqlaudit.RedactError(err.Error())
	}
	_ = emit(writer, errorReport{OK: false, Code: code, Message: message})
	return exitCode
}

func writeRootUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, `GoNavi CLI

Usage:
	gonavi [--data-root PATH] agent <chat|run|list|show|resume|cancel|approve|deny|recover|config|snapshot>
	gonavi [--data-root PATH] list-connections
  gonavi [--data-root PATH] connection <list|add|import>
  gonavi [--data-root PATH] query (--conn ID_OR_NAME|--connection-file FILE) [--sql SQL|--sql-file FILE|SQL]
  gonavi [--data-root PATH] export (--conn ID_OR_NAME|--connection-file FILE) --output FILE [--sql SQL|--sql-file FILE|SQL]
  gonavi [--data-root PATH] batch (--conn ID_OR_NAME|--connection-file FILE) --file FILE --allow-write
  gonavi [--data-root PATH] audit export --output FILE
  gonavi [--data-root PATH] mcp <stdio|http|remote-config>
`)
}

func writeListConnectionsUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi list-connections\n")
}

func writeConnectionUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi connection <list|add|import>\n")
}

func writeConnectionAddUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi connection add --name NAME --type TYPE [--host HOST --port PORT --user USER --database DB] [--connection-params PARAMS|--connection-params-env NAME] [--password-env NAME] [--file INPUT.json]\n")
}

func writeConnectionImportUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi connection import --file CONNECTIONS.json\n")
}

func writeQueryUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi query (--conn ID_OR_NAME|--connection-file FILE) [--database DB] [--allow-write] [--request-trace] [--format jsonl|json|csv|md] (--sql SQL|--sql-file FILE|SQL)\n")
}

func writeExportUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi export (--conn ID_OR_NAME|--connection-file FILE) --output FILE [--request-trace] [--format csv|json|md|html|xlsx] (--sql SQL|--sql-file FILE|SQL)\n")
}

func writeBatchUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi batch (--conn ID_OR_NAME|--connection-file FILE) --file FILE --allow-write [--request-trace] [--transaction single|off] [--stop-on-error|--continue-on-error]\n")
}

func writeAuditUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi audit export --output FILE [--format json|csv]\n")
}

func writeMCPUsage(writer io.Writer) {
	_, _ = io.WriteString(writer, "Usage: gonavi mcp <stdio|http|remote-config>\n")
}
