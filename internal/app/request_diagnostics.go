package app

import (
	"context"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/requesttrace"
)

// GetRequestDiagnostics exposes only process-local, already-redacted trace
// summaries. The store intentionally has no disk persistence so diagnostics
// never become a second long-lived request log.
func (a *App) GetRequestDiagnostics(filter requesttrace.Filter) connection.QueryResult {
	return connection.QueryResult{
		Success: true,
		Data:    a.requestDiagnostics().List(filter),
	}
}

func (a *App) GetRequestDiagnostic(requestID string) connection.QueryResult {
	trace, found := a.requestDiagnostics().Get(requestID)
	if !found {
		return connection.QueryResult{Success: false, Message: "request diagnostic was not found or has expired"}
	}
	return connection.QueryResult{Success: true, Data: trace}
}

// RequestTraceStoreForEntryPoint gives internal entry points such as the Web
// and MCP servers access to the shared recorder without turning the store
// itself into a desktop RPC method.
func RequestTraceStoreForEntryPoint(a *App) *requesttrace.Store {
	if a == nil {
		return nil
	}
	return a.requestDiagnostics()
}

func (a *App) requestDiagnostics() *requesttrace.Store {
	if a == nil {
		return requesttrace.NewStore(1)
	}
	a.requestTraceMu.Lock()
	defer a.requestTraceMu.Unlock()
	if a.requestTraceStore == nil {
		a.requestTraceStore = requesttrace.NewStore(requesttrace.DefaultCapacity)
	}
	return a.requestTraceStore
}

func (a *App) beginRequestTrace(
	ctx context.Context,
	input requesttrace.Input,
) (context.Context, *requesttrace.Handle, bool) {
	if existing := requesttrace.FromContext(ctx); existing != nil {
		existing.SetRequestMetadata(input.DataSourceType, input.DriverMode, input.Deadline)
		return ctx, existing, false
	}
	handle := a.requestDiagnostics().Start(input)
	return requesttrace.WithContext(ctx, handle), handle, true
}

func requestTraceIDFromContext(ctx context.Context) string {
	if handle := requesttrace.FromContext(ctx); handle != nil {
		return handle.ID()
	}
	return ""
}

func (a *App) beginQueryRequestTrace(
	ctx context.Context,
	config connection.ConnectionConfig,
	queryID string,
	source string,
	operation string,
) (context.Context, *requesttrace.Handle, bool) {
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := time.Time{}
	if config.QueryTimeout > 0 {
		deadline = time.Now().Add(time.Duration(config.QueryTimeout) * time.Second)
	}
	return a.beginRequestTrace(ctx, requesttrace.Input{
		RequestID:      queryID,
		Entry:          requestTraceEntry(a, source),
		Operation:      operation,
		DataSourceType: strings.ToLower(strings.TrimSpace(config.Type)),
		DriverMode:     requestTraceDriverMode(config),
		Deadline:       deadline,
	})
}

func (a *App) completeQueryRequestTrace(handle *requesttrace.Handle, result connection.QueryResult) {
	a.recordQueryRequestTraceOutcome(handle, result, true)
}

func (a *App) recordQueryRequestTraceOutcome(handle *requesttrace.Handle, result connection.QueryResult, complete bool) {
	if handle == nil {
		return
	}
	responseBytes, exact := requesttrace.MeasureJSON(result, requesttrace.MaxMeasuredResponseBytes)
	completion := requesttrace.Completion{
		Status:             requestTraceStatus(result),
		ErrorKind:          requestTraceErrorKind(result),
		ErrorMessage:       result.Message,
		ResponseBytes:      responseBytes,
		ResponseBytesExact: exact,
		Pagination:         requestTracePagination(result),
	}
	if complete {
		handle.Complete(completion)
		return
	}
	handle.RecordOperationOutcome(completion)
}

func requestTraceEntry(a *App, source string) string {
	if a != nil && a.webRuntime {
		return "web"
	}
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "cli":
		return "cli"
	case "mcp":
		return "mcp"
	default:
		return "desktop"
	}
}

func requestTraceDriverMode(config connection.ConnectionConfig) string {
	if strings.TrimSpace(config.Driver) != "" {
		return "custom-driver"
	}
	if config.UseSSH {
		return "builtin-over-ssh"
	}
	if config.UseHTTPTunnel {
		return "builtin-over-http-tunnel"
	}
	if config.UseProxy {
		return "builtin-over-proxy"
	}
	return "builtin"
}

func requestTraceStatus(result connection.QueryResult) string {
	if result.Success {
		return "success"
	}
	if requestTraceResultCancelled(result) {
		return "cancelled"
	}
	return "error"
}

func requestTraceErrorKind(result connection.QueryResult) string {
	if result.Success {
		return ""
	}
	if requestTraceResultCancelled(result) {
		return "cancelled"
	}
	if data, ok := result.Data.(map[string]any); ok {
		if kind, ok := data["errorKind"].(string); ok && strings.TrimSpace(kind) != "" {
			return strings.ToLower(strings.TrimSpace(kind))
		}
		if unknown, _ := data["outcomeUnknown"].(bool); unknown {
			return "outcome_unknown"
		}
	}
	return "execution"
}

func requestTraceResultCancelled(result connection.QueryResult) bool {
	if data, ok := result.Data.(map[string]any); ok {
		if cancelled, _ := data["cancelled"].(bool); cancelled {
			return true
		}
	}
	message := strings.ToLower(strings.TrimSpace(result.Message))
	return strings.Contains(message, "context canceled") ||
		strings.Contains(message, "context cancelled") ||
		strings.Contains(message, "deadline exceeded") ||
		strings.Contains(message, "query cancelled") ||
		strings.Contains(message, "query canceled")
}

func requestTracePagination(result connection.QueryResult) requesttrace.Pagination {
	pagination := requesttrace.Pagination{Mode: "result_set"}
	switch data := result.Data.(type) {
	case []connection.ResultSetData:
		pagination.ResultSetCount = len(data)
		for _, resultSet := range data {
			pagination.ReturnedRows += int64(len(resultSet.Rows))
		}
	case []map[string]interface{}:
		pagination.ResultSetCount = 1
		pagination.ReturnedRows = int64(len(data))
	case map[string]any:
		if truncated, _ := data["truncated"].(bool); truncated {
			pagination.Truncated = true
		}
		if rows, found := requestTraceInt64(data["rows"]); found {
			pagination.ResultSetCount = 1
			pagination.ReturnedRows = rows
		}
	}
	return pagination
}

func requestTraceInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case int64:
		return typed, true
	case uint:
		return int64(typed), true
	case uint32:
		return int64(typed), true
	case uint64:
		if typed <= uint64(^uint64(0)>>1) {
			return int64(typed), true
		}
	case float64:
		return int64(typed), true
	}
	return 0, false
}
