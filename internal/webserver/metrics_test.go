package webserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWebMetricsMiddlewareAndInvokeCounters(t *testing.T) {
	metrics := newWebMetrics()
	handler := metrics.middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	metrics.recordInvoke("DBQueryMultiWithOptions", 5*time.Millisecond, false)
	metrics.recordInvoke("DBQueryMultiWithOptions", 7*time.Millisecond, true)

	server := &Server{metrics: metrics, events: newEventHub()}
	snapshot := server.metricsSnapshot()
	if snapshot.Requests != 1 {
		t.Fatalf("requests = %d, want 1", snapshot.Requests)
	}
	if snapshot.Inflight != 0 {
		t.Fatalf("inflight = %d, want 0", snapshot.Inflight)
	}
	if snapshot.Invokes != 2 || snapshot.InvokeErrors != 1 {
		t.Fatalf("invoke counters = %d/%d, want 2/1", snapshot.Invokes, snapshot.InvokeErrors)
	}
	if snapshot.InvokeByMethod["DBQueryMultiWithOptions"] != 2 {
		t.Fatalf("method counter = %d, want 2", snapshot.InvokeByMethod["DBQueryMultiWithOptions"])
	}
	if snapshot.Goroutines <= 0 {
		t.Fatal("expected a positive goroutine count")
	}
}

func TestEventHubSubscriberCount(t *testing.T) {
	hub := newEventHub()
	if got := hub.subscriberCount(); got != 0 {
		t.Fatalf("subscriber count = %d, want 0", got)
	}
	subscriber := hub.subscribe("", "")
	defer hub.unsubscribe(subscriber)
	if got := hub.subscriberCount(); got != 1 {
		t.Fatalf("subscriber count = %d, want 1", got)
	}
}

func TestWritePrometheusMetricsIncludesCountersAndLabels(t *testing.T) {
	recorder := httptest.NewRecorder()
	writePrometheusMetrics(recorder, webMetricsSnapshot{
		Requests:            3,
		Invokes:             2,
		InvokeErrors:        1,
		SSESubscribers:      4,
		AuditQueuePending:   5,
		InvokeByMethod:      map[string]int64{"DBQuery": 2},
		InvokeErrorByMethod: map[string]int64{"DBQuery": 1},
	})
	body := recorder.Body.String()
	for _, expected := range []string{
		"gonavi_web_requests_total 3",
		"gonavi_web_invokes_total 2",
		"gonavi_web_invoke_errors_total 1",
		"gonavi_web_sse_subscribers 4",
		"gonavi_web_audit_queue_pending 5",
		`gonavi_web_invoke_method_total{method="DBQuery"} 2`,
		`gonavi_web_invoke_method_errors_total{method="DBQuery"} 1`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("prometheus output missing %q:\n%s", expected, body)
		}
	}
}
