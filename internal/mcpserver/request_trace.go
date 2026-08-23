package mcpserver

import (
	"context"
	"errors"
	"strings"

	"GoNavi-Wails/internal/requesttrace"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpRequestIDMetaKey = "gonaviRequestId"

// newMCPRequestTraceMiddleware records every MCP tool call once at the
// protocol boundary. The trace handle is carried through context so execute_sql
// can enrich the same timeline with the database dispatch and retry events.
func newMCPRequestTraceMiddleware(store *requesttrace.Store) mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if store == nil || method != "tools/call" {
				return next(ctx, method, req)
			}
			toolName := "unknown"
			if params, ok := req.GetParams().(*mcp.CallToolParamsRaw); ok && params != nil {
				if value := strings.TrimSpace(params.Name); value != "" {
					toolName = value
				}
			}
			handle := store.Start(requesttrace.Input{
				Entry:     "mcp",
				Operation: "mcp." + toolName,
			})
			traceCtx := requesttrace.WithContext(ctx, handle)
			result, err := next(traceCtx, method, req)

			status := "success"
			errorKind := ""
			errorMessage := ""
			if err != nil {
				status = "error"
				errorKind = "protocol"
				errorMessage = err.Error()
				if isMCPContextCancellation(err) {
					status = "cancelled"
					errorKind = "cancelled"
				}
			} else if toolResult, ok := result.(*mcp.CallToolResult); ok && toolResult != nil {
				attachMCPRequestID(toolResult, handle.ID())
				if toolResult.IsError {
					status = "error"
					errorKind = "tool"
					if toolErr := toolResult.GetError(); toolErr != nil {
						errorMessage = toolErr.Error()
					} else {
						errorMessage = mcpResultErrorText(toolResult)
					}
				}
			}
			responseBytes, exact := requesttrace.MeasureJSON(result, requesttrace.MaxMeasuredResponseBytes)
			handle.Complete(requesttrace.Completion{
				Status:             status,
				ErrorKind:          errorKind,
				ErrorMessage:       errorMessage,
				ResponseBytes:      responseBytes,
				ResponseBytesExact: exact,
			})
			return result, err
		}
	}
}

func attachMCPRequestID(result *mcp.CallToolResult, requestID string) {
	if result == nil || strings.TrimSpace(requestID) == "" {
		return
	}
	meta := make(map[string]any, len(result.GetMeta())+1)
	for key, value := range result.GetMeta() {
		meta[key] = value
	}
	meta[mcpRequestIDMetaKey] = requestID
	result.SetMeta(meta)
}

func mcpResultErrorText(result *mcp.CallToolResult) string {
	if result == nil {
		return ""
	}
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok && text != nil {
			return text.Text
		}
	}
	return "tool call failed"
}

func isMCPContextCancellation(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func mcpRequestID(ctx context.Context) string {
	if handle := requesttrace.FromContext(ctx); handle != nil {
		return handle.ID()
	}
	return ""
}
