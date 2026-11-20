package scriptengine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == WorkerModeArg {
		err := RunWorker(context.Background(), os.Stdin, os.Stdout)
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type fakeScriptHost struct {
	mu      sync.Mutex
	methods []string
	rows    []map[string]any
}

func (h *fakeScriptHost) Handle(ctx context.Context, request HostRequest) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.methods = append(h.methods, request.Method)
	h.mu.Unlock()
	switch request.Method {
	case "db.query":
		return hostQueryResult{
			Columns:  []string{"id", "name"},
			Rows:     h.rows,
			RowCount: len(h.rows),
		}, nil
	case "db.execute":
		return hostExecuteResult{AffectedRows: 2}, nil
	case "tx.begin":
		return hostTransactionResult{TransactionID: "tx-1"}, nil
	case "tx.execute":
		return hostExecuteResult{AffectedRows: 1}, nil
	case "tx.commit", "tx.rollback":
		return map[string]any{"ok": true}, nil
	default:
		return nil, fmt.Errorf("unexpected host method %s", request.Method)
	}
}

func (h *fakeScriptHost) recordedMethods() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.methods...)
}

func TestRunnerExecutesHostQueryAndEmitsEvents(t *testing.T) {
	host := &fakeScriptHost{rows: []map[string]any{{"id": 1, "name": "Ada"}}}
	var events []Event
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		RunID: "run-1",
		Script: `
			gonavi.log("start");
			gonavi.progress({current: 1, total: 2});
			const result = gonavi.db.query("prod", {
				database: "orders",
				sql: "SELECT id, name FROM users WHERE id IN (:ids)",
				params: { ids: [1, 2] }
			});
			gonavi.output("users", result.rows);
		`,
		Connections: []ConnectionSpec{{Alias: "prod", Type: "mysql", ReadOnly: true}},
		Limits:      NormalizeLimits(Limits{}, time.Minute),
	}, host, func(event Event) error {
		events = append(events, event)
		return nil
	})
	if !result.Success {
		t.Fatalf("run failed: %+v", result)
	}
	if got := host.recordedMethods(); len(got) != 1 || got[0] != "db.query" {
		t.Fatalf("host methods = %v, want [db.query]", got)
	}
	if !hasScriptEvent(events, "log", "start") {
		t.Fatalf("log event missing: %+v", events)
	}
	if !hasScriptEvent(events, "progress", "") {
		t.Fatalf("progress event missing: %+v", events)
	}
	output := findScriptEvent(events, "output")
	if output == nil || output.Name != "users" {
		t.Fatalf("output event missing: %+v", events)
	}
	var payload struct {
		Name string           `json:"name"`
		Rows []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(output.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Rows) != 1 || payload.Rows[0]["name"] != "Ada" {
		t.Fatalf("output rows = %+v", payload.Rows)
	}
}

func TestRunnerTransactionCommitsAndRollsBack(t *testing.T) {
	host := &fakeScriptHost{}
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `
			gonavi.db.transaction("prod", {database: "orders"}, function (tx) {
				tx.execute("UPDATE users SET status = :status", {params: {status: "done"}});
			});
			try {
				gonavi.db.transaction("prod", {}, function (tx) {
					tx.execute("DELETE FROM users WHERE id = :id", {params: {id: 7}});
					throw new Error("boom");
				});
			} catch (error) {
				gonavi.log("caught");
			}
		`,
	}, host, nil)
	if !result.Success {
		t.Fatalf("run failed: %+v", result)
	}
	methods := host.recordedMethods()
	want := []string{"tx.begin", "tx.execute", "tx.commit", "tx.begin", "tx.execute", "tx.rollback"}
	if strings.Join(methods, ",") != strings.Join(want, ",") {
		t.Fatalf("host methods = %v, want %v", methods, want)
	}
}

func TestRunnerReportsUncaughtScriptError(t *testing.T) {
	host := &fakeScriptHost{}
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `throw new Error("script exploded");`,
	}, host, nil)
	if result.Success {
		t.Fatalf("expected failure, got %+v", result)
	}
	if !strings.Contains(result.Message, "script exploded") {
		t.Fatalf("message = %q", result.Message)
	}
}

func TestRunnerDoesNotExposeHostProcessGlobals(t *testing.T) {
	host := &fakeScriptHost{}
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `
			const forbidden = ["require", "process", "fetch", "XMLHttpRequest", "setTimeout", "setInterval"];
			for (const name of forbidden) {
				if (typeof globalThis[name] !== "undefined") {
					throw new Error("unexpected global: " + name);
				}
			}
			if (typeof gonavi.db.query !== "function" || typeof gonavi.files.open !== "function") {
				throw new Error("gonavi host API is missing");
			}
		`,
	}, host, nil)
	if !result.Success {
		t.Fatalf("run failed: %+v", result)
	}
}

func TestRunnerCancelsInfiniteScript(t *testing.T) {
	host := &fakeScriptHost{}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	runner := Runner{Executable: os.Args[0], KillGrace: 500 * time.Millisecond}
	started := time.Now()
	result := runner.Run(ctx, RunRequest{
		Script: `while (true) {}`,
	}, host, nil)
	if !result.TimedOut {
		t.Fatalf("expected timeout, got %+v", result)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("cancellation took too long: %s", elapsed)
	}
}

func TestNormalizeLimitsClampsUnsafeValues(t *testing.T) {
	limits := NormalizeLimits(Limits{
		MaxDBCalls:       -1,
		MaxOutputRows:    -1,
		DefaultBatch:     999999,
		MaxBatch:         999999,
		DefaultINList:    0,
		MaxINList:        999999,
		DefaultQueryRows: -5,
		MaxQueryRows:     999999,
	}, time.Minute)
	if limits.MaxDBCalls != DefaultMaxDBCalls {
		t.Fatalf("default max calls = %d", limits.MaxDBCalls)
	}
	if limits.MaxOutputRows != DefaultOutputRows {
		t.Fatalf("default output rows = %d", limits.MaxOutputRows)
	}
	if limits.DefaultBatch != MaxBatchSize || limits.MaxBatch != MaxBatchSize {
		t.Fatalf("batch limits = %d/%d", limits.DefaultBatch, limits.MaxBatch)
	}
	if limits.MaxQueryRows != MaxQueryRows {
		t.Fatalf("max query rows = %d", limits.MaxQueryRows)
	}
	if limits.MemoryLimitBytes != DefaultMemoryLimit {
		t.Fatalf("default memory limit = %d", limits.MemoryLimitBytes)
	}
	limits = NormalizeLimits(Limits{MemoryLimitBytes: MaxMemoryLimit * 2}, time.Minute)
	if limits.MemoryLimitBytes != MaxMemoryLimit {
		t.Fatalf("clamped memory limit = %d", limits.MemoryLimitBytes)
	}
	limits = NormalizeLimits(Limits{
		MaxDBCalls:    50_000,
		MaxOutputRows: 100_000,
	}, time.Minute)
	if limits.MaxDBCalls != 50_000 || limits.MaxOutputRows != 100_000 {
		t.Fatalf("supported custom limits = %d/%d", limits.MaxDBCalls, limits.MaxOutputRows)
	}
	limits = NormalizeLimits(Limits{
		MaxDBCalls:    MaxDBCalls + 1,
		MaxOutputRows: MaxOutputRows + 1,
	}, time.Minute)
	if limits.MaxDBCalls != MaxDBCalls || limits.MaxOutputRows != MaxOutputRows {
		t.Fatalf("hard limit clamps = %d/%d", limits.MaxDBCalls, limits.MaxOutputRows)
	}
}

func TestRunnerUsesConfiguredOutputRowLimit(t *testing.T) {
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `gonavi.output("rows", [{id: 1}, {id: 2}, {id: 3}]);`,
		Limits: NormalizeLimits(Limits{MaxOutputRows: 2}, time.Minute),
	}, &fakeScriptHost{}, nil)
	if result.Success || !strings.Contains(result.Message, "exceeds 2 rows") {
		t.Fatalf("result = %+v", result)
	}
}

func hasScriptEvent(events []Event, eventType string, message string) bool {
	for _, event := range events {
		if event.Type != eventType {
			continue
		}
		if message == "" || strings.Contains(event.Message, message) {
			return true
		}
	}
	return false
}

func findScriptEvent(events []Event, eventType string) *Event {
	for index := range events {
		if events[index].Type == eventType {
			return &events[index]
		}
	}
	return nil
}

func TestProtocolFrameRoundTrip(t *testing.T) {
	frame := workerInbound{
		Type: frameTypeRun,
		Request: &RunRequest{
			RunID:  "r",
			Script: "1 + 1",
			Limits: NormalizeLimits(Limits{}, time.Minute),
		},
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	var decoded workerInbound
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Request == nil || decoded.Request.RunID != "r" {
		t.Fatalf("decoded request = %+v", decoded.Request)
	}
}

func TestHostResponseErrorPropagates(t *testing.T) {
	host := &errorHost{err: errors.New("denied by policy")}
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `gonavi.db.query("prod", {sql: "SELECT 1"});`,
	}, host, nil)
	if result.Success || !strings.Contains(result.Message, "denied by policy") {
		t.Fatalf("result = %+v", result)
	}
}

type errorHost struct {
	err error
}

func (h *errorHost) Handle(context.Context, HostRequest) (any, error) {
	return nil, h.err
}

func TestEventPayloadRowsKeepStableOrder(t *testing.T) {
	rows := []map[string]any{{"b": 2, "a": 1}}
	encoded, err := json.Marshal(hostQueryResult{Rows: rows})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	items, ok := decoded["rows"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("decoded rows = %#v", decoded["rows"])
	}
	keys := make([]string, 0, 2)
	for key := range items[0].(map[string]any) {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "a,b" {
		t.Fatalf("keys = %v", keys)
	}
}

func TestRunnerRejectsPrimitiveOutputRows(t *testing.T) {
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `gonavi.output("bad", [1, 2]);`,
	}, &fakeScriptHost{}, nil)
	if result.Success || !strings.Contains(result.Message, "must be an object") {
		t.Fatalf("result = %+v", result)
	}
}

func TestRunnerRejectsCyclicOutputRows(t *testing.T) {
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `const row = {}; row.self = row; gonavi.output("bad", [row]);`,
	}, &fakeScriptHost{}, nil)
	if result.Success || !strings.Contains(strings.ToLower(result.Message), "cycle") {
		t.Fatalf("result = %+v", result)
	}
}

func TestRunnerRejectsOversizedOutputName(t *testing.T) {
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `gonavi.output("x".repeat(300), []);`,
	}, &fakeScriptHost{}, nil)
	if result.Success || !strings.Contains(result.Message, "output name exceeds") {
		t.Fatalf("result = %+v", result)
	}
}

func TestRunnerRejectsOversizedProgressPayload(t *testing.T) {
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `gonavi.progress({payload: "x".repeat(70000)});`,
	}, &fakeScriptHost{}, nil)
	if result.Success || !strings.Contains(result.Message, "payload exceeds") {
		t.Fatalf("result = %+v", result)
	}
}

func TestRunnerRejectsNonObjectProgressPayload(t *testing.T) {
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `gonavi.progress([1, 2, 3]);`,
	}, &fakeScriptHost{}, nil)
	if result.Success || !strings.Contains(result.Message, "requires an object") {
		t.Fatalf("result = %+v", result)
	}
}

func TestRunnerCapsLogEventMessage(t *testing.T) {
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	var events []Event
	result := runner.Run(context.Background(), RunRequest{
		Script: `gonavi.log("x".repeat(20000));`,
	}, &fakeScriptHost{}, func(event Event) error {
		events = append(events, event)
		return nil
	})
	if !result.Success {
		t.Fatalf("run failed: %+v", result)
	}
	logEvent := findScriptEvent(events, "log")
	if logEvent == nil || len(logEvent.Message) > MaxLogMessageBytes {
		t.Fatalf("log event = %+v", logEvent)
	}
}

func TestRunnerFailsWhenObserverRejectsEvent(t *testing.T) {
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `gonavi.log("reject me");`,
	}, &fakeScriptHost{}, func(Event) error {
		return errors.New("observer rejected payload")
	})
	if result.Success || !strings.Contains(result.Message, "observer rejected payload") {
		t.Fatalf("result = %+v", result)
	}
}

func TestRunnerCapsErrorMessage(t *testing.T) {
	runner := Runner{Executable: os.Args[0], KillGrace: time.Second}
	result := runner.Run(context.Background(), RunRequest{
		Script: `throw new Error("x".repeat(20000));`,
	}, &fakeScriptHost{}, nil)
	if result.Success || len(result.Message) > MaxErrorMessageBytes {
		t.Fatalf("result message length = %d: %+v", len(result.Message), result)
	}
}
