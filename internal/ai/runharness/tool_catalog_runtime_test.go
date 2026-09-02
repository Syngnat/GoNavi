package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// mutableRuntimeCatalog models a host catalog that can be hot-reloaded while
// a run is in flight. The harness must read List only at submission time and
// must fence Resolve against the immutable binding captured for that run.
type mutableRuntimeCatalog struct {
	mu           sync.Mutex
	descriptor   ToolDescriptor
	executor     ToolExecutor
	revision     int64
	listCalls    int
	resolveCalls int
}

func (c *mutableRuntimeCatalog) List(context.Context) ([]ToolDescriptor, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.listCalls++
	return cloneToolDescriptors([]ToolDescriptor{c.descriptor}), nil
}

func (c *mutableRuntimeCatalog) Resolve(_ context.Context, name string) (ToolDescriptor, ToolExecutor, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.resolveCalls++
	if strings.TrimSpace(name) != c.descriptor.Name {
		return ToolDescriptor{}, nil, ErrToolNotFound
	}
	return c.descriptor, c.executor, nil
}

func (c *mutableRuntimeCatalog) Revision(context.Context) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.revision, nil
}

func (c *mutableRuntimeCatalog) setDescriptor(descriptor ToolDescriptor) {
	c.mu.Lock()
	c.descriptor = descriptor
	if c.revision == 0 {
		c.revision = 1
	}
	c.revision++
	c.mu.Unlock()
}

func (c *mutableRuntimeCatalog) calls() (list, resolve int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.listCalls, c.resolveCalls
}

type runtimeCatalogModel struct {
	mu             sync.Mutex
	requests       []ModelTurnRequest
	tool           ToolIntent
	afterFirstCall func()
}

func (m *runtimeCatalogModel) Execute(_ context.Context, request ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
	m.mu.Lock()
	request.Tools = cloneToolDescriptors(request.Tools)
	m.requests = append(m.requests, request)
	call := len(m.requests)
	m.mu.Unlock()
	if call == 1 {
		if m.afterFirstCall != nil {
			m.afterFirstCall()
		}
		return ModelTurnResult{ToolCalls: []ToolIntent{m.tool}, Completed: true}, nil
	}
	return ModelTurnResult{Text: "done", Completed: true}, nil
}

func (m *runtimeCatalogModel) requestsSnapshot() []ModelTurnRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]ModelTurnRequest, len(m.requests))
	for index, request := range m.requests {
		request.Tools = cloneToolDescriptors(request.Tools)
		result[index] = request
	}
	return result
}

type mutatingRuntimeExecutor struct {
	inner  ToolExecutor
	mutate func()
}

func (e mutatingRuntimeExecutor) Execute(ctx context.Context, request ToolExecutionRequest) (ToolExecutionResult, error) {
	result, err := e.inner.Execute(ctx, request)
	if e.mutate != nil {
		e.mutate()
	}
	return result, err
}

func runtimeCatalogDescriptor(description string) ToolDescriptor {
	return ToolDescriptor{
		Name:        "read_rows",
		Description: description,
		Effect:      ToolEffectReadOnly,
		InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`),
	}
}

func TestRunUsesFrozenToolCatalogAcrossHotReload(t *testing.T) {
	initial := runtimeCatalogDescriptor("version one")
	catalog := &mutableRuntimeCatalog{descriptor: initial}
	baseExecutor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed", Value: map[string]any{"rows": 1}}}
	catalog.executor = mutatingRuntimeExecutor{
		inner: baseExecutor,
		mutate: func() {
			catalog.setDescriptor(runtimeCatalogDescriptor("version two"))
		},
	}
	model := &runtimeCatalogModel{tool: ToolIntent{
		CallID: "catalog-call", ToolName: initial.Name, Effect: ToolEffectReadOnly,
		Arguments: json.RawMessage(`{}`),
	}}
	harness, _ := newContractHarness(t, model, catalog, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "frozen-catalog-request", Content: "read rows",
	})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s, want %s", read.Run.State, RunStateCompleted)
	}

	requests := model.requestsSnapshot()
	if len(requests) != 2 {
		t.Fatalf("model calls = %d, want 2", len(requests))
	}
	for index, request := range requests {
		if len(request.Tools) != 1 || request.Tools[0].Description != initial.Description {
			t.Fatalf("model request %d tools = %#v, want frozen descriptor %#v", index+1, request.Tools, initial)
		}
	}
	listCalls, resolveCalls := catalog.calls()
	if listCalls != 1 {
		t.Fatalf("catalog List calls = %d, want 1", listCalls)
	}
	if resolveCalls < 1 {
		t.Fatalf("catalog Resolve calls = %d, want at least 1", resolveCalls)
	}
}

func TestRunFencesLiveToolDescriptorDrift(t *testing.T) {
	initial := runtimeCatalogDescriptor("version one")
	catalog := &mutableRuntimeCatalog{descriptor: initial}
	executor := &contractToolExecutor{result: ToolExecutionResult{Status: "completed"}}
	catalog.executor = executor
	model := &runtimeCatalogModel{
		tool: ToolIntent{
			CallID: "drift-call", ToolName: initial.Name, Effect: ToolEffectReadOnly,
			Arguments: json.RawMessage(`{}`),
		},
		afterFirstCall: func() {
			catalog.setDescriptor(runtimeCatalogDescriptor("version two"))
		},
	}
	harness, _ := newContractHarness(t, model, catalog, nil)

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID: "drift-catalog-request", Content: "read rows",
	})
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("run state = %s, want %s", read.Run.State, RunStateCompleted)
	}
	if _, ok := executor.lastRequest(); ok {
		t.Fatal("executor ran after the live descriptor drifted")
	}

	var sawCatalogError bool
	for _, event := range read.Events {
		if event.Kind != EventRunError {
			continue
		}
		var failure RunErrorEvent
		if err := json.Unmarshal(event.Payload, &failure); err != nil {
			t.Fatalf("decode run error: %v", err)
		}
		if failure.Code == "tool_contract_mismatch" && strings.Contains(failure.Message, "descriptor mismatch") {
			sawCatalogError = true
		}
	}
	if !sawCatalogError {
		t.Fatal("missing tool_contract_mismatch descriptor mismatch event")
	}
	listCalls, resolveCalls := catalog.calls()
	if listCalls != 1 {
		t.Fatalf("catalog List calls = %d, want 1", listCalls)
	}
	if resolveCalls < 1 {
		t.Fatalf("catalog Resolve calls = %d, want at least 1", resolveCalls)
	}
}

func TestToolCatalogBindingRoundTripAndDefensiveClone(t *testing.T) {
	ledger, err := Open(filepath.Join(t.TempDir(), "agent_runs.sqlite"), WithKey([]byte("01234567890123456789012345678901")))
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	defer ledger.Close()

	descriptor := runtimeCatalogDescriptor("immutable")
	descriptor.Capabilities = []string{" editor ", "workspace", "editor"}
	binding, err := NewToolCatalogBinding([]ToolDescriptor{descriptor}, 7)
	if err != nil {
		t.Fatalf("new binding: %v", err)
	}
	run, err := ledger.CreateRun(context.Background(), CreateRunRequest{
		SessionID: "catalog-binding-session", RequestID: "catalog-binding-request",
		Policy: DefaultRunPolicy(), ToolCatalogBinding: &binding,
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	got, err := ledger.GetToolCatalogBinding(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("get binding: %v", err)
	}
	if got.Hash != binding.Hash || got.Revision != binding.Revision {
		t.Fatalf("binding identity = (%q,%d), want (%q,%d)", got.Hash, got.Revision, binding.Hash, binding.Revision)
	}
	if len(got.Descriptors) != 1 || got.Descriptors[0].Capabilities[0] != "editor" {
		t.Fatalf("canonical capabilities = %#v", got.Descriptors)
	}
	got.Descriptors[0].Capabilities[0] = "mutated"
	got.Descriptors[0].InputSchema[0] = '['
	again, err := ledger.GetToolCatalogBinding(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("get binding after mutation: %v", err)
	}
	if again.Descriptors[0].Capabilities[0] == "mutated" || again.Descriptors[0].InputSchema[0] == '[' {
		t.Fatal("ledger returned mutable descriptor storage")
	}
}

func TestToolCatalogBindingRejectsInvalidRevision(t *testing.T) {
	descriptor := runtimeCatalogDescriptor("revision")
	for _, revision := range []int64{-1, 0} {
		if _, err := NewToolCatalogBinding([]ToolDescriptor{descriptor}, revision); err == nil {
			t.Fatalf("revision %d unexpectedly accepted", revision)
		}
	}
}

func TestToolCatalogBindingRejectsIndexedMetadataTampering(t *testing.T) {
	ctx := context.Background()

	t.Run("hash", func(t *testing.T) {
		ledger := testLedger(t)
		binding, err := NewToolCatalogBinding([]ToolDescriptor{runtimeCatalogDescriptor("bound")}, 3)
		if err != nil {
			t.Fatal(err)
		}
		run, err := ledger.CreateRun(ctx, CreateRunRequest{SessionID: "catalog-tamper-hash", RequestID: "catalog-tamper-hash", Policy: DefaultRunPolicy(), ToolCatalogBinding: &binding})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ledger.db.Exec(`UPDATE runs SET tool_catalog_hash=? WHERE id=?`, fmt.Sprintf("%064d", 1), run.ID); err != nil {
			t.Fatal(err)
		}
		_, err = ledger.GetToolCatalogBinding(ctx, run.ID)
		if !errors.Is(err, ErrToolCatalogBindingCorrupt) {
			t.Fatalf("hash tamper error = %v", err)
		}
	})

	t.Run("revision", func(t *testing.T) {
		ledger := testLedger(t)
		binding, err := NewToolCatalogBinding([]ToolDescriptor{runtimeCatalogDescriptor("bound")}, 3)
		if err != nil {
			t.Fatal(err)
		}
		run, err := ledger.CreateRun(ctx, CreateRunRequest{SessionID: "catalog-tamper-revision", RequestID: "catalog-tamper-revision", Policy: DefaultRunPolicy(), ToolCatalogBinding: &binding})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ledger.db.Exec(`UPDATE runs SET tool_catalog_revision=? WHERE id=?`, 4, run.ID); err != nil {
			t.Fatal(err)
		}
		_, err = ledger.GetToolCatalogBinding(ctx, run.ID)
		if !errors.Is(err, ErrToolCatalogBindingCorrupt) {
			t.Fatalf("revision tamper error = %v", err)
		}
	})

	t.Run("missing-encrypted-payload", func(t *testing.T) {
		ledger := testLedger(t)
		binding, err := NewToolCatalogBinding([]ToolDescriptor{runtimeCatalogDescriptor("bound")}, 3)
		if err != nil {
			t.Fatal(err)
		}
		run, err := ledger.CreateRun(ctx, CreateRunRequest{SessionID: "catalog-tamper-payload", RequestID: "catalog-tamper-payload", Policy: DefaultRunPolicy(), ToolCatalogBinding: &binding})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ledger.db.Exec(`UPDATE runs SET tool_catalog_binding=NULL WHERE id=?`, run.ID); err != nil {
			t.Fatal(err)
		}
		_, err = ledger.GetToolCatalogBinding(ctx, run.ID)
		if !errors.Is(err, ErrToolCatalogBindingCorrupt) {
			t.Fatalf("missing payload error = %v", err)
		}
	})
}
