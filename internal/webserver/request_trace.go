package webserver

import (
	"encoding/json"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/requesttrace"
)

func shouldTraceWebInvoke(request invokeRequest) bool {
	method := strings.TrimSpace(request.Method)
	if method == "GetRequestDiagnostics" || method == "GetRequestDiagnostic" {
		return false
	}
	return !isDatabaseQueryInvoke(request)
}

// Database query methods create their own trace inside App so the actual
// query ID, deadline, cancellation and driver retry signals live in one record
// rather than being split between an HTTP wrapper and a database wrapper.
func isDatabaseQueryInvoke(request invokeRequest) bool {
	namespace := strings.ToLower(strings.TrimSpace(request.Namespace))
	receiver := strings.ToLower(strings.TrimSpace(request.Receiver))
	if namespace != "app" || (receiver != "" && receiver != "app") {
		return false
	}
	switch strings.TrimSpace(request.Method) {
	case "DBQuery", "DBQueryWithCancel", "DBQueryMulti":
		return true
	default:
		return false
	}
}

func webInvokeTraceInput(request invokeRequest) requesttrace.Input {
	config := webInvokeConnectionConfig(request)
	return requesttrace.Input{
		Entry:          "web",
		Operation:      "web." + strings.TrimSpace(request.Method),
		DataSourceType: strings.ToLower(strings.TrimSpace(config.Type)),
		DriverMode:     webRequestTraceDriverMode(config),
	}
}

func webInvokeConnectionConfig(request invokeRequest) connection.ConnectionConfig {
	if len(request.Args) == 0 {
		return connection.ConnectionConfig{}
	}
	var config connection.ConnectionConfig
	if err := json.Unmarshal(request.Args[0], &config); err != nil {
		return connection.ConnectionConfig{}
	}
	return config
}

func webRequestTraceDriverMode(config connection.ConnectionConfig) string {
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

func webInvokeResultRequestID(result any) string {
	switch value := result.(type) {
	case connection.QueryResult:
		return strings.TrimSpace(value.QueryID)
	case *connection.QueryResult:
		if value != nil {
			return strings.TrimSpace(value.QueryID)
		}
	}
	return ""
}

func completeWebInvokeTrace(handle *requesttrace.Handle, response invokeResponse) {
	if handle == nil {
		return
	}
	responseBytes, exact := requesttrace.MeasureJSON(response, requesttrace.MaxMeasuredResponseBytes)
	status := "success"
	if strings.TrimSpace(response.Error) != "" {
		status = "error"
	}
	handle.Complete(requesttrace.Completion{
		Status:             status,
		ErrorKind:          "rpc",
		ErrorMessage:       response.Error,
		ResponseBytes:      responseBytes,
		ResponseBytesExact: exact,
	})
}
