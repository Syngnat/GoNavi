package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
)

// fakeAgentRuntime keeps the adapter tests independent from SQLite and from
// provider wiring. The real harness contract is exercised in
// internal/ai/runharness; these tests focus on CLI argument and lifecycle
// semantics at the boundary.
type fakeAgentRuntime struct {
	mu sync.Mutex

	submitRequests      []runharness.AgentInputRequest
	submitContexts      []context.Context
	submitReceipts      []runharness.AgentInputReceipt
	submitErr           error
	controlRequests     []runharness.RunControlRequest
	controlContexts     []context.Context
	controlSnapshot     runharness.RunSnapshot
	controlErr          error
	readResults         []runharness.RunReadResult
	advanceReadResults  bool
	readErr             error
	readBlock           <-chan struct{}
	readSessionRequests []runharness.SessionReadRequest
	readSessionContexts []context.Context
	readSessionResults  []runharness.SessionProjection
	readSessionErr      error
	snapshots           []runharness.WorkspaceSnapshot
	snapshotContexts    []context.Context
	snapshotErr         error
	closeCalls          int
}

type recordingAgentLedgerKeyringStore struct {
	items   map[string][]byte
	getRefs []string
	putRefs []string
}

func (s *recordingAgentLedgerKeyringStore) Put(ref string, value []byte) error {
	s.putRefs = append(s.putRefs, ref)
	if s.items == nil {
		s.items = make(map[string][]byte)
	}
	s.items[ref] = append([]byte(nil), value...)
	return nil
}

func (s *recordingAgentLedgerKeyringStore) Get(ref string) ([]byte, error) {
	s.getRefs = append(s.getRefs, ref)
	value, ok := s.items[ref]
	if !ok {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), value...), nil
}

func (s *recordingAgentLedgerKeyringStore) Delete(ref string) error {
	delete(s.items, ref)
	return nil
}

func (s *recordingAgentLedgerKeyringStore) HealthCheck() error { return nil }

func (f *fakeAgentRuntime) SubmitInput(ctx context.Context, request runharness.AgentInputRequest) (runharness.AgentInputReceipt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.submitRequests = append(f.submitRequests, request)
	f.submitContexts = append(f.submitContexts, ctx)
	if f.submitErr != nil {
		return runharness.AgentInputReceipt{}, f.submitErr
	}
	if len(f.submitReceipts) == 0 {
		return runharness.AgentInputReceipt{RequestID: request.RequestID, SessionID: request.SessionID, RunID: "run-1", State: runharness.RunStateRunningModel}, nil
	}
	index := len(f.submitRequests) - 1
	if index >= len(f.submitReceipts) {
		index = len(f.submitReceipts) - 1
	}
	return f.submitReceipts[index], nil
}

func (f *fakeAgentRuntime) ControlRun(ctx context.Context, request runharness.RunControlRequest) (runharness.RunSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.controlRequests = append(f.controlRequests, request)
	f.controlContexts = append(f.controlContexts, ctx)
	if f.controlErr != nil {
		return runharness.RunSnapshot{}, f.controlErr
	}
	return f.controlSnapshot, nil
}

func (f *fakeAgentRuntime) ReadRun(ctx context.Context, _ runharness.RunReadRequest) (runharness.RunReadResult, error) {
	if f.readBlock != nil {
		select {
		case <-f.readBlock:
		case <-ctx.Done():
			return runharness.RunReadResult{}, ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readErr != nil {
		return runharness.RunReadResult{}, f.readErr
	}
	if len(f.readResults) == 0 {
		return runharness.RunReadResult{Run: runharness.RunSnapshot{ID: "run-1", State: runharness.RunStateCompleted}}, nil
	}
	result := f.readResults[0]
	if f.advanceReadResults && len(f.readResults) > 1 {
		f.readResults = f.readResults[1:]
	}
	return result, nil
}

func (f *fakeAgentRuntime) ListSessions(context.Context, runharness.SessionListRequest) (runharness.SessionListResult, error) {
	return runharness.SessionListResult{}, nil
}

func (f *fakeAgentRuntime) ReadSession(ctx context.Context, request runharness.SessionReadRequest) (runharness.SessionProjection, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.readSessionRequests = append(f.readSessionRequests, request)
	f.readSessionContexts = append(f.readSessionContexts, ctx)
	if f.readSessionErr != nil {
		return runharness.SessionProjection{}, f.readSessionErr
	}
	if len(f.readSessionResults) == 0 {
		return runharness.SessionProjection{ID: request.SessionID, Revision: 1}, nil
	}
	index := len(f.readSessionRequests) - 1
	if index >= len(f.readSessionResults) {
		index = len(f.readSessionResults) - 1
	}
	return f.readSessionResults[index], nil
}

func (f *fakeAgentRuntime) MutateSession(context.Context, runharness.SessionMutationRequest) (runharness.SessionProjection, error) {
	return runharness.SessionProjection{}, nil
}

func (f *fakeAgentRuntime) PutWorkspaceSnapshot(ctx context.Context, snapshot runharness.WorkspaceSnapshot) (runharness.SnapshotAck, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snapshotContexts = append(f.snapshotContexts, ctx)
	if f.snapshotErr != nil {
		return runharness.SnapshotAck{}, f.snapshotErr
	}
	f.snapshots = append(f.snapshots, snapshot)
	return runharness.SnapshotAck{SourceID: snapshot.SourceID, SourceInstanceID: snapshot.SourceInstanceID, Revision: snapshot.Revision, ContentHash: snapshot.ContentHash, Accepted: true}, nil
}

func (f *fakeAgentRuntime) Close() error {
	f.mu.Lock()
	f.closeCalls++
	f.mu.Unlock()
	return nil
}

var _ AgentHarnessRuntime = (*fakeAgentRuntime)(nil)

func TestCloseAgentRuntimeResourcesUsesLifecycleShutdownOrder(t *testing.T) {
	type lifecycleKey struct{}
	parent, parentCancel := context.WithCancel(context.WithValue(context.Background(), lifecycleKey{}, "cli-owner"))
	parentCancel()

	harnessErr := errors.New("harness close")
	backendErr := errors.New("backend close")
	ledgerErr := errors.New("ledger close")
	var calls []string
	type shutdownContextObservation struct {
		err   error
		owner any
	}
	var shutdownContexts []shutdownContextObservation
	err := closeAgentRuntimeResources(parent, agentRuntimeResources{
		closeHarness: func() error {
			calls = append(calls, "harness")
			return harnessErr
		},
		shutdownMCP: func(ctx context.Context) {
			calls = append(calls, "mcp")
			shutdownContexts = append(shutdownContexts, shutdownContextObservation{err: ctx.Err(), owner: ctx.Value(lifecycleKey{})})
		},
		closeBackend: func(ctx context.Context) error {
			calls = append(calls, "backend")
			shutdownContexts = append(shutdownContexts, shutdownContextObservation{err: ctx.Err(), owner: ctx.Value(lifecycleKey{})})
			return backendErr
		},
		closeLedger: func() error {
			calls = append(calls, "ledger")
			return ledgerErr
		},
	})
	if got, want := strings.Join(calls, ","), "harness,mcp,backend,ledger"; got != want {
		t.Fatalf("shutdown order = %q, want %q", got, want)
	}
	if !errors.Is(err, harnessErr) || !errors.Is(err, backendErr) || !errors.Is(err, ledgerErr) {
		t.Fatalf("cleanup error = %v, want all resource errors", err)
	}
	if len(shutdownContexts) != 2 {
		t.Fatalf("shutdown contexts = %d, want 2", len(shutdownContexts))
	}
	for _, observation := range shutdownContexts {
		if observation.err != nil {
			t.Fatalf("shutdown context inherited parent cancellation: %v", observation.err)
		}
		if got := observation.owner; got != "cli-owner" {
			t.Fatalf("shutdown context owner value = %v, want cli-owner", got)
		}
	}
}

func TestDefaultAgentHarnessFactoryRequiresLifecycleContext(t *testing.T) {
	runtime, err := defaultAgentHarnessFactory(nil, AgentHarnessOptions{})
	if runtime != nil || !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("factory result = (%T, %v), want root-context error", runtime, err)
	}
}

func TestCLIAgentToolCatalogIncludesWorkspaceInspection(t *testing.T) {
	catalog := newCLIAgentToolCatalog(nil, nil)
	for _, name := range []string{"execute_sql", "inspect_active_tab"} {
		descriptor, executor, err := catalog.Resolve(context.Background(), name)
		if err != nil || executor == nil {
			t.Fatalf("Resolve(%q) = %#v, %v", name, descriptor, err)
		}
		if name == "inspect_active_tab" && descriptor.Effect != runharness.ToolEffectReadOnly {
			t.Fatalf("workspace tool effect = %q, want read_only", descriptor.Effect)
		}
	}
}

func TestAgentLedgerOptionsUseDesktopDataRootKeyFile(t *testing.T) {
	dataRoot := t.TempDir()
	store := &recordingAgentLedgerKeyringStore{}
	options, err := agentLedgerOptions(dataRoot, "", store)
	if err != nil {
		t.Fatalf("agentLedgerOptions: %v", err)
	}

	ledger, err := runharness.Open(filepath.Join(dataRoot, "agent_runs.sqlite"), options...)
	if err != nil {
		t.Fatalf("open ledger with CLI options: %v", err)
	}
	if err := ledger.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}

	want, err := aiservice.AgentLedgerKeyFilePath(dataRoot)
	if err != nil {
		t.Fatalf("desktop key file path: %v", err)
	}
	if info, err := os.Stat(want); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
		t.Fatalf("local key file = %v, %v; want 0600 file", info, err)
	}
	if len(store.getRefs) != 0 || len(store.putRefs) != 0 {
		t.Fatalf("CLI agent ledger accessed keyring: gets=%v puts=%v", store.getRefs, store.putRefs)
	}
}

func TestAgentLifecycleHelpersRejectNilContext(t *testing.T) {
	if _, _, err := agentCommandContext(nil, time.Second); !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("command context error = %v, want root-context error", err)
	}
	if renewal := startAgentWorkspaceSnapshotRenewal(nil, &fakeAgentRuntime{}, agentWorkspaceSnapshotBinding{}); renewal != nil {
		t.Fatalf("nil lifecycle renewal = %#v, want nil", renewal)
	}
	if _, _, err := nextAgentChatLine(nil, bufio.NewScanner(strings.NewReader("hello\n"))); !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("chat input error = %v, want root-context error", err)
	}
	resolver := newCLIProviderResolver(t.TempDir())
	if _, err := resolver(nil, runharness.ModelTurnRequest{}); !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("provider resolver error = %v, want root-context error", err)
	}
	handler := newCLIAgentApprovalHandler()
	if _, err := handler.Request(nil, runharness.ApprovalRequest{}); !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("approval error = %v, want root-context error", err)
	}
}

func TestOpenAgentHarnessRejectsNilLifecycleBeforeFactory(t *testing.T) {
	called := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		called = true
		return nil, errors.New("factory must not run without a lifecycle")
	}
	t.Cleanup(func() { newAgentHarness = previous })

	if runtime, _, err := openAgentHarnessWithRuntime(nil, agentCommonFlags{}, runharness.RunPolicy{}, false); runtime != nil || !errors.Is(err, runharness.ErrRootContextRequired) {
		t.Fatalf("openAgentHarnessWithRuntime(nil) = (%T, %v), want root-context error", runtime, err)
	}
	if called {
		t.Fatal("agent factory was called with a nil lifecycle context")
	}
}

func TestCLIProviderResolverUsesBoundConfigAfterSettingsChange(t *testing.T) {
	root := t.TempDir()
	store := aiservice.NewProviderConfigStore(root, nil)
	base := ai.ProviderConfig{
		ID:        "provider-a",
		Type:      "custom",
		APIFormat: "openai",
		Name:      "Provider A",
		APIKey:    "key-v1",
		BaseURL:   "https://old.example/v1",
		Model:     "model-v1",
		Headers:   map[string]string{"X-Revision": "one"},
	}
	if err := store.Save(aiservice.ProviderConfigStoreSnapshot{
		Providers:      []ai.ProviderConfig{base},
		ActiveProvider: base.ID,
	}); err != nil {
		t.Fatalf("save initial provider config: %v", err)
	}

	var captured []ai.ProviderConfig
	previousFactory := newCLIProviderInstance
	newCLIProviderInstance = func(config ai.ProviderConfig) (provider.Provider, error) {
		captured = append(captured, cloneCLIProviderConfig(config))
		return nil, nil
	}
	t.Cleanup(func() { newCLIProviderInstance = previousFactory })

	resolver := newCLIProviderResolverState(root)
	temperature := 0.35
	maxTokens := 2048
	input := runharness.AgentInputRequest{
		RequestID: "run-freeze-1", Content: "hello", Model: "turn-model", Thinking: "high",
		Temperature: &temperature, MaxTokens: &maxTokens,
	}
	if err := resolver.bindInput(&input); err != nil {
		t.Fatalf("bind input: %v", err)
	}
	if input.Provider != base.ID || !input.HasProviderBinding() {
		t.Fatalf("bound input = %#v, want provider %q with binding", input, base.ID)
	}
	binding, ok := input.ProviderBindingForHost()
	if !ok {
		t.Fatal("bound input has no host provider binding")
	}

	updated := base
	updated.APIKey = "key-v2"
	updated.BaseURL = "https://new.example/v1"
	updated.Model = "model-v2"
	updated.Headers = map[string]string{"X-Revision": "two"}
	if err := store.Save(aiservice.ProviderConfigStoreSnapshot{
		Providers:      []ai.ProviderConfig{updated},
		ActiveProvider: updated.ID,
	}); err != nil {
		t.Fatalf("save updated provider config: %v", err)
	}
	request := runharness.ModelTurnRequest{RunID: "run-freeze-1", Provider: input.Provider, ProviderBinding: &binding}
	if _, err := resolver.resolve(context.Background(), request); err != nil {
		t.Fatalf("resolve provider after config edit: %v", err)
	}
	if _, err := resolver.resolve(context.Background(), request); err != nil {
		t.Fatalf("resolve provider for a later model attempt: %v", err)
	}
	if len(captured) != 2 {
		t.Fatalf("provider factory calls = %d, want 2", len(captured))
	}
	first, second := captured[0], captured[1]
	for _, config := range []ai.ProviderConfig{first, second} {
		if config.BaseURL != base.BaseURL || config.APIKey != base.APIKey || config.Headers["X-Revision"] != "one" {
			t.Fatalf("resolver used mutable provider config: %#v", config)
		}
		if config.Model != input.Model || config.ThinkingIntensity != input.Thinking || config.Temperature != temperature || config.MaxTokens != maxTokens {
			t.Fatalf("turn overrides were not frozen: %#v", config)
		}
	}
}

func TestCLIProviderResolverBindsCurrentActiveProviderID(t *testing.T) {
	root := t.TempDir()
	store := aiservice.NewProviderConfigStore(root, nil)
	providerA := ai.ProviderConfig{ID: "provider-a", Type: "custom", APIFormat: "openai", Name: "Provider A", BaseURL: "https://a.example/v1"}
	providerB := ai.ProviderConfig{ID: "provider-b", Type: "custom", APIFormat: "openai", Name: "Provider B", BaseURL: "https://b.example/v1"}
	if err := store.Save(aiservice.ProviderConfigStoreSnapshot{Providers: []ai.ProviderConfig{providerA, providerB}, ActiveProvider: providerA.ID}); err != nil {
		t.Fatalf("save initial provider config: %v", err)
	}
	resolver := newCLIProviderResolverState(root)
	first := runharness.AgentInputRequest{RequestID: "provider-a", Content: "hello"}
	if err := resolver.bindInput(&first); err != nil {
		t.Fatalf("bind input with first active provider: %v", err)
	}
	if first.Provider != providerA.ID || !first.HasProviderBinding() {
		t.Fatalf("first binding = %#v, want provider %q", first, providerA.ID)
	}
	if err := store.Save(aiservice.ProviderConfigStoreSnapshot{Providers: []ai.ProviderConfig{providerA, providerB}, ActiveProvider: providerB.ID}); err != nil {
		t.Fatalf("save updated provider config: %v", err)
	}
	second := runharness.AgentInputRequest{RequestID: "provider-b", Content: "hello"}
	if err := resolver.bindInput(&second); err != nil {
		t.Fatalf("bind input with updated active provider: %v", err)
	}
	if second.Provider != providerB.ID || !second.HasProviderBinding() {
		t.Fatalf("second binding = %#v, want provider %q", second, providerB.ID)
	}
}

func TestCLIProviderResolverRejectsUnboundModelTurn(t *testing.T) {
	resolver := newCLIProviderResolverState(t.TempDir())
	_, err := resolver.resolve(context.Background(), runharness.ModelTurnRequest{RunID: "unbound", Provider: "provider-a"})
	if !errors.Is(err, runharness.ErrProviderBindingUnbound) {
		t.Fatalf("resolve unbound model turn error = %v, want %v", err, runharness.ErrProviderBindingUnbound)
	}
}

func TestLedgerHarnessRuntimeCloseIsIdempotentWithoutProviderSnapshotCache(t *testing.T) {
	resolver := newCLIProviderResolverState(t.TempDir())
	runtime := &ledgerHarnessRuntime{providerResolver: resolver}
	if err := runtime.Close(); err != nil {
		t.Fatalf("runtime close: %v", err)
	}
	if err := runtime.Close(); err != nil {
		t.Fatalf("second runtime close: %v", err)
	}
}

type agentFactoryCapture struct {
	Options AgentHarnessOptions
	Context context.Context
}

func installFakeAgentRuntime(t *testing.T, runtime *fakeAgentRuntime) *agentFactoryCapture {
	t.Helper()
	previousFactory := newAgentHarness
	previousRoot, hadRoot := os.LookupEnv("GONAVI_DATA_ROOT")
	root := t.TempDir()
	if err := os.Setenv("GONAVI_DATA_ROOT", root); err != nil {
		t.Fatal(err)
	}
	capture := &agentFactoryCapture{}
	newAgentHarness = func(ctx context.Context, got AgentHarnessOptions) (AgentHarnessRuntime, error) {
		capture.Context = ctx
		capture.Options = got
		return runtime, nil
	}
	t.Cleanup(func() {
		newAgentHarness = previousFactory
		if hadRoot {
			_ = os.Setenv("GONAVI_DATA_ROOT", previousRoot)
		} else {
			_ = os.Unsetenv("GONAVI_DATA_ROOT")
		}
	})
	return capture
}

func mustJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}
