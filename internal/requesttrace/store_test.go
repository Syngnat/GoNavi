package requesttrace

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestStorePreservesOrderedRedactedTrace(t *testing.T) {
	store := NewStore(2)
	handle := store.Start(Input{
		RequestID:      "request-1",
		Entry:          "cli",
		Operation:      "query",
		DataSourceType: "postgres",
		DriverMode:     "builtin",
		Deadline:       time.UnixMilli(2_000),
	})
	handle.AddEvent("driver.dispatched", map[string]string{"target": "postgres://user:secret@example.test/db"})
	handle.MarkRetry("network password=secret")
	handle.AddEvent("query.details", map[string]string{"sql": "SELECT * FROM private_table", "target": "postgres://user:secret@example.test/db"})
	handle.MarkCancellation(true)
	handle.Complete(Completion{
		Status:             "cancelled",
		ResponseBytes:      123,
		ResponseBytesExact: true,
		Pagination:         Pagination{Mode: "result_set", ResultSetCount: 1, ReturnedRows: 2},
	})

	trace, found := store.Get("request-1")
	if !found {
		t.Fatal("expected trace")
	}
	if trace.Cancellation.Outcome != "observed" {
		t.Fatalf("cancellation outcome = %q, want observed", trace.Cancellation.Outcome)
	}
	if trace.RetryCount != 1 || len(trace.Events) != 6 {
		t.Fatalf("unexpected timeline: retries=%d events=%d", trace.RetryCount, len(trace.Events))
	}
	if got := trace.Events[1].Details["target"]; got != "[redacted]" {
		t.Fatalf("trace retained URI target: %q", got)
	}
	if got := trace.Events[2].Details["reason"]; strings.Contains(got, "secret") || !strings.Contains(got, "***") {
		t.Fatalf("trace leaked assignment secret: %q", got)
	}
	if _, found := trace.Events[3].Details["sql"]; found {
		t.Fatalf("trace retained SQL event detail: %#v", trace.Events[3].Details)
	}
	if got := trace.Events[3].Details["target"]; got != "[redacted]" {
		t.Fatalf("trace retained connection target: %q", got)
	}
}

func TestNestedOperationFailureIsPreservedByOuterCompletion(t *testing.T) {
	store := NewStore(1)
	handle := store.Start(Input{RequestID: "nested"})
	handle.RecordOperationOutcome(Completion{
		Status:       "error",
		ErrorKind:    "connection",
		ErrorMessage: "postgres://alice:secret@example.test/app failed after SELECT private_value",
		Pagination:   Pagination{Mode: "result_set", ResultSetCount: 1, ReturnedRows: 3},
	})
	handle.Complete(Completion{Status: "success", ResponseBytes: 42, ResponseBytesExact: true})

	trace, found := store.Get("nested")
	if !found {
		t.Fatal("expected nested trace")
	}
	if trace.Status != "error" || trace.Error == nil || trace.Error.Kind != "connection" {
		t.Fatalf("outer completion lost nested failure: %#v", trace)
	}
	if trace.Error.Message != "database connection failed" {
		t.Fatalf("unexpected retained error message: %q", trace.Error.Message)
	}
	if trace.Pagination.ResultSetCount != 1 || trace.Pagination.ReturnedRows != 3 {
		t.Fatalf("outer completion lost pagination: %#v", trace.Pagination)
	}
}

func TestCancellationOutcomeShowsWhenDriverDidNotObserveIt(t *testing.T) {
	store := NewStore(1)
	handle := store.Start(Input{RequestID: "unobserved-cancel"})
	handle.MarkCancellation(true)
	handle.Complete(Completion{Status: "success"})

	trace, found := store.Get("unobserved-cancel")
	if !found || trace.Cancellation.Outcome != "not_observed" {
		t.Fatalf("cancellation outcome = %#v, want not_observed", trace.Cancellation)
	}
}

func TestStoreBoundedAndContextPropagation(t *testing.T) {
	store := NewStore(1)
	first := store.Start(Input{RequestID: "first"})
	if FromContext(WithContext(context.Background(), first)) != first {
		t.Fatal("trace handle was not retained in context")
	}
	store.Start(Input{RequestID: "second"})
	if _, found := store.Get("first"); found {
		t.Fatal("oldest trace should be evicted")
	}
	page := store.List(Filter{Limit: 999})
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].RequestID != "second" {
		t.Fatalf("unexpected page: %#v", page)
	}
}

func TestMeasureJSONCapsLargeResponse(t *testing.T) {
	bytes, exact := MeasureJSON(map[string]string{"payload": strings.Repeat("x", 256)}, 64)
	if exact || bytes != 64 {
		t.Fatalf("measurement = (%d, %v), want (64, false)", bytes, exact)
	}
}
