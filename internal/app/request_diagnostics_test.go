package app

import (
	"testing"

	"GoNavi-Wails/internal/requesttrace"
)

func TestGetRequestDiagnosticsReturnsOnlyBoundedRedactedTracePage(t *testing.T) {
	application := NewApp()
	handle := RequestTraceStoreForEntryPoint(application).Start(requesttrace.Input{
		RequestID:      "diagnostics-1",
		Entry:          "desktop",
		Operation:      "database.query",
		DataSourceType: "postgres",
	})
	handle.AddEvent("driver.dispatched", map[string]string{"sql": "SELECT * FROM secret_table"})
	handle.Complete(requesttrace.Completion{Status: "success"})

	result := application.GetRequestDiagnostics(requesttrace.Filter{Entry: "desktop", Limit: 10})
	if !result.Success {
		t.Fatalf("GetRequestDiagnostics failed: %s", result.Message)
	}
	page, ok := result.Data.(requesttrace.Page)
	if !ok || page.Total != 1 || len(page.Items) != 1 {
		t.Fatalf("unexpected diagnostics page: %#v", result.Data)
	}
	if _, found := page.Items[0].Events[1].Details["sql"]; found {
		t.Fatalf("diagnostics RPC exposed SQL: %#v", page.Items[0])
	}

	missing := application.GetRequestDiagnostic("missing-request")
	if missing.Success {
		t.Fatalf("missing diagnostic should not be reported as success: %#v", missing)
	}
}
