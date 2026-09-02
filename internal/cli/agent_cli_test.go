package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/appdata"
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
}

func (s *recordingAgentLedgerKeyringStore) Put(ref string, value []byte) error {
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

func TestAgentLedgerOptionsUseDesktopDataRootKeyringReference(t *testing.T) {
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

	want, err := aiservice.AgentLedgerKeyRef(dataRoot)
	if err != nil {
		t.Fatalf("desktop key reference: %v", err)
	}
	if len(store.getRefs) != 1 || store.getRefs[0] != want {
		t.Fatalf("keyring references = %v, want [%q]", store.getRefs, want)
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

func TestRunAgentHelpDoesNotStartHarness(t *testing.T) {
	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("factory must not run for help")
	}
	t.Cleanup(func() { newAgentHarness = previous })

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{"--help"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("help exit = %d, stderr=%s", code, stderr.String())
	}
	if started {
		t.Fatal("agent harness started while showing help")
	}
}

func TestRunAgentRejectsMultiplePromptSourcesBeforeHarness(t *testing.T) {
	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("factory must not run for invalid prompt")
	}
	t.Cleanup(func() { newAgentHarness = previous })

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{"--prompt", "one", "two"}, &stdout, &stderr)
	if code != ExitUsage || started || !strings.Contains(stderr.String(), `"code":"usage"`) {
		t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
	}
}

func TestRunAgentForwardsInputOverridesAndContext(t *testing.T) {
	runtime := &fakeAgentRuntime{submitReceipts: []runharness.AgentInputReceipt{{
		RequestID: "req-1", SessionID: "session-1", RunID: "run-1", Disposition: "started", State: runharness.RunStateQueued,
	}}}
	capture := installFakeAgentRuntime(t, runtime)

	snapshotPath := filepath.Join(t.TempDir(), "workspace.json")
	snapshot := runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceCLI,
		SourceID:         "cli-source",
		SourceInstanceID: "instance-1",
		Revision:         4,
		CLIContext:       &runharness.CLIWorkspaceContext{CWD: "/tmp/project"},
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snapshotPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--session", "session-1", "--request-id", "req-1", "--expected-revision", "9",
		"--prompt", "inspect", "--provider", "custom", "--model", "glm-4", "--thinking", "high",
		"--temperature", "0.35", "--max-tokens", "2048", "--dispatch", "queue",
		"--context-file", snapshotPath, "--policy", "max-tool-rounds=20,default-tool-timeout=2s", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 1 {
		t.Fatalf("submit requests = %#v", runtime.submitRequests)
	}
	request := runtime.submitRequests[0]
	if request.RequestID != "req-1" || request.SessionID != "session-1" || request.Content != "inspect" || request.ContextSourceID != "cli-source" || request.ContextSourceInstanceID != "instance-1" || request.ExpectedRevision != 9 {
		t.Fatalf("request = %#v", request)
	}
	if request.Provider != "custom" || request.Model != "glm-4" || request.Thinking != "high" || request.DispatchMode != runharness.DispatchQueue {
		t.Fatalf("provider/model overrides = %#v", request)
	}
	if request.Temperature == nil || *request.Temperature != 0.35 || request.MaxTokens == nil || *request.MaxTokens != 2048 {
		t.Fatalf("numeric overrides = %#v", request)
	}
	if len(runtime.snapshots) != 1 || runtime.snapshots[0].SourceID != "cli-source" || runtime.snapshots[0].SourceInstanceID != "instance-1" || runtime.snapshots[0].ContentHash == "" {
		t.Fatalf("snapshots = %#v", runtime.snapshots)
	}
	if capture.Options.Policy.MaxToolRounds != 20 || capture.Options.Policy.DefaultToolTimeout != 2*time.Second {
		t.Fatalf("policy = %#v", capture.Options.Policy)
	}
	if capture.Options.Policy.DefaultDispatchMode != runharness.DispatchQueue {
		t.Fatalf("policy dispatch = %q", capture.Options.Policy.DefaultDispatchMode)
	}
	if !capture.Options.StartWorkers {
		t.Fatal("agent run must start harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("--no-wait closed the runtime %d times", runtime.closeCalls)
	}
	var receipt runharness.AgentInputReceipt
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &receipt); err != nil {
		t.Fatalf("JSON receipt: %v; output=%s", err, stdout.String())
	}
	if receipt.RunID != "run-1" {
		t.Fatalf("receipt = %#v", receipt)
	}
}

func TestRunAgentReadsExistingSessionRevisionForQueue(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "req-existing", SessionID: "existing-session", RunID: "run-existing",
			Disposition: "queued", State: runharness.RunStateQueued,
		}},
		readSessionResults: []runharness.SessionProjection{{ID: "existing-session", Revision: 23}},
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--session", "existing-session", "--request-id", "req-existing", "--prompt", "continue", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.readSessionRequests) != 1 || runtime.readSessionRequests[0].SessionID != "existing-session" {
		t.Fatalf("session reads=%#v, want one existing-session read", runtime.readSessionRequests)
	}
	if len(runtime.submitRequests) != 1 || runtime.submitRequests[0].ExpectedRevision != 23 {
		t.Fatalf("submit requests=%#v, want revision 23", runtime.submitRequests)
	}
}

func TestRunAgentStopsBeforeSubmittingWhenExistingSessionRevisionReadFails(t *testing.T) {
	runtime := &fakeAgentRuntime{readSessionErr: errors.New("ledger unavailable")}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--session", "existing-session", "--prompt", "continue", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitExecution {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "read session revision") {
		t.Fatalf("stderr=%q, want session revision read failure", stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.readSessionRequests) != 1 || len(runtime.submitRequests) != 0 {
		t.Fatalf("session reads=%#v submits=%#v, want read and no submit", runtime.readSessionRequests, runtime.submitRequests)
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("revision read failure closed runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentSteerDoesNotReadExistingSessionRevision(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "req-steer", SessionID: "existing-session", RunID: "run-steer",
			Disposition: "started", State: runharness.RunStateQueued,
		}},
		readSessionErr: errors.New("must not read session revision for steer"),
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--session", "existing-session", "--request-id", "req-steer", "--prompt", "redirect", "--dispatch", "steer", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.readSessionRequests) != 0 {
		t.Fatalf("session reads=%#v, want none for steer", runtime.readSessionRequests)
	}
	if len(runtime.submitRequests) != 1 || runtime.submitRequests[0].ExpectedRevision != 0 {
		t.Fatalf("submit requests=%#v, want steer revision unchanged", runtime.submitRequests)
	}
}

func TestRunAgentBuildsCLISnapshotWhenContextFileIsOmitted(t *testing.T) {
	runtime := &fakeAgentRuntime{submitReceipts: []runharness.AgentInputReceipt{{
		RequestID: "req-native", SessionID: "session-native", RunID: "run-native", Disposition: "started", State: runharness.RunStateCompleted,
	}}}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{
		"--request-id", "req-native", "--prompt", "inspect", "--no-wait", "--json",
	}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.snapshots) != 1 {
		t.Fatalf("snapshots = %#v", runtime.snapshots)
	}
	snapshot := runtime.snapshots[0]
	if snapshot.SourceKind != runharness.WorkspaceCLI || snapshot.SourceID == "" || snapshot.SourceInstanceID == "" || snapshot.ContentHash == "" {
		t.Fatalf("native snapshot = %#v", snapshot)
	}
	if !strings.HasPrefix(snapshot.SourceID, "cli-") {
		t.Fatalf("native source ID = %q, want hashed cli prefix", snapshot.SourceID)
	}
	if snapshot.CLIContext == nil || snapshot.CLIContext.CWD == "" || snapshot.CLIContext.Command != "gonavi agent run" {
		t.Fatalf("native CLI context = %#v", snapshot.CLIContext)
	}
	if len(runtime.submitRequests) != 1 {
		t.Fatalf("submit requests = %#v", runtime.submitRequests)
	}
	request := runtime.submitRequests[0]
	if request.ContextSourceID != snapshot.SourceID || request.ContextSourceInstanceID != snapshot.SourceInstanceID {
		t.Fatalf("input source binding = %#v, snapshot = %#v", request, snapshot)
	}
}

func TestRunAgentRejectsNonCLISnapshotContextFile(t *testing.T) {
	runtime := &fakeAgentRuntime{}
	installFakeAgentRuntime(t, runtime)

	path := filepath.Join(t.TempDir(), "desktop-workspace.json")
	data, err := json.Marshal(runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceDesktop,
		SourceID:         "desktop-source",
		SourceInstanceID: "desktop-instance",
		Revision:         1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{
		"--prompt", "inspect", "--context-file", path,
	}, &stdout, &stderr); code != ExitUsage {
		t.Fatalf("exit = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "context_invalid") || !strings.Contains(stderr.String(), "sourceKind") {
		t.Fatalf("error = %q", stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 0 || len(runtime.snapshots) != 0 {
		t.Fatalf("non-CLI snapshot reached harness: requests=%#v snapshots=%#v", runtime.submitRequests, runtime.snapshots)
	}
}

func TestRunAgentSnapshotRejectsNonCLISnapshotBeforeHarness(t *testing.T) {
	path := filepath.Join(t.TempDir(), "desktop-workspace.json")
	data, err := json.Marshal(runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceDesktop,
		SourceID:         "desktop-source",
		SourceInstanceID: "desktop-instance",
		Revision:         1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("harness must not start for a desktop snapshot")
	}
	t.Cleanup(func() { newAgentHarness = previous })

	var stdout, stderr bytes.Buffer
	if code := runAgentSnapshot(context.Background(), []string{"--file", path}, &stdout, &stderr); code != ExitUsage {
		t.Fatalf("exit = %d, stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if started {
		t.Fatal("desktop snapshot opened the harness")
	}
	if !strings.Contains(stderr.String(), "snapshot_invalid") || !strings.Contains(stderr.String(), "sourceKind") {
		t.Fatalf("error = %q", stderr.String())
	}
}

func TestAgentWorkspaceSnapshotRenewalRepublishesSameBinding(t *testing.T) {
	runtime := &fakeAgentRuntime{}
	snapshot, err := newAgentCLIWorkspaceSnapshot("renew-source", "gonavi agent run")
	if err != nil {
		t.Fatal(err)
	}
	binding := agentWorkspaceSnapshotBinding{
		SourceID:         snapshot.SourceID,
		SourceInstanceID: snapshot.SourceInstanceID,
		Snapshot:         snapshot,
	}
	if err := binding.Publish(context.Background(), runtime); err != nil {
		t.Fatal(err)
	}

	previous := agentWorkspaceSnapshotRenewInterval
	agentWorkspaceSnapshotRenewInterval = time.Millisecond
	t.Cleanup(func() { agentWorkspaceSnapshotRenewInterval = previous })
	renewal := startAgentWorkspaceSnapshotRenewal(context.Background(), runtime, binding)
	t.Cleanup(renewal.Close)

	deadline := time.Now().Add(time.Second)
	for {
		runtime.mu.Lock()
		count := len(runtime.snapshots)
		runtime.mu.Unlock()
		if count >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("snapshot renewal did not publish again; snapshots=%#v", runtime.snapshots)
		}
		time.Sleep(time.Millisecond)
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	for _, renewed := range runtime.snapshots[1:] {
		if renewed.SourceID != snapshot.SourceID || renewed.SourceInstanceID != snapshot.SourceInstanceID || renewed.Revision != snapshot.Revision || renewed.ContentHash != snapshot.ContentHash {
			t.Fatalf("renewed snapshot changed identity/content: %#v, want %#v", renewed, snapshot)
		}
	}
}

func TestRunAgentJSONEmitsOnlyStableRunProjection(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readResults:    []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateCompleted}, NextSequence: 1}},
	}
	installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{"--prompt", "hello", "--json", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	var result runharness.RunReadResult
	decoder := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	if err := decoder.Decode(&result); err != nil {
		t.Fatalf("decode result: %v; output=%s", err, stdout.String())
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		t.Fatalf("expected one JSON result, extra=%#v err=%v output=%s", extra, err, stdout.String())
	}
	if result.Run.State != runharness.RunStateCompleted {
		t.Fatalf("result = %#v", result)
	}
}

func TestRunAgentWaitsPastInitialQueuedState(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "queued-wait", SessionID: "queued-session", RunID: "queued-run", State: runharness.RunStateQueued,
		}},
		readResults: []runharness.RunReadResult{
			{Run: runharness.RunSnapshot{ID: "queued-run", State: runharness.RunStateQueued}},
			{Run: runharness.RunSnapshot{ID: "queued-run", State: runharness.RunStateCompleted}, NextSequence: 1},
		},
		advanceReadResults: true,
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{"--prompt", "hello", "--json", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	var result runharness.RunReadResult
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &result); err != nil {
		t.Fatalf("decode result: %v; output=%s", err, stdout.String())
	}
	if result.Run.State != runharness.RunStateCompleted {
		t.Fatalf("result state = %s, want completed", result.Run.State)
	}
}

func TestRunAgentJSONLContainsOnlyTypedRunEvents(t *testing.T) {
	events := []runharness.RunEvent{
		{
			SchemaVersion: 1, RunID: "run-jsonl", SessionID: "session-jsonl", Sequence: 1,
			Kind: runharness.EventInput, ResultingState: runharness.RunStateRunningModel,
			Payload: mustJSON(runharness.InputEvent{RequestID: "request-jsonl"}),
		},
		{
			SchemaVersion: 1, RunID: "run-jsonl", SessionID: "session-jsonl", Sequence: 2,
			Kind: runharness.EventTerminal, ResultingState: runharness.RunStateCompleted,
			Payload: mustJSON(runharness.TerminalEvent{Reason: "completed"}),
		},
	}
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "request-jsonl", SessionID: "session-jsonl", RunID: "run-jsonl",
			Disposition: "started", State: runharness.RunStateRunningModel,
		}},
		readResults: []runharness.RunReadResult{{
			Run:    runharness.RunSnapshot{ID: "run-jsonl", State: runharness.RunStateCompleted},
			Events: events,
		}},
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{
		"--prompt", "hello", "--jsonl", "--poll", "1ms",
	}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	got := decodeAgentJSONLEvents(t, stdout.Bytes())
	if len(got) != len(events) {
		t.Fatalf("JSONL event count=%d, want %d; output=%q", len(got), len(events), stdout.String())
	}
	for index, event := range got {
		if event.RunID != "run-jsonl" || event.Sequence != events[index].Sequence || event.Kind != events[index].Kind {
			t.Fatalf("event[%d]=%+v, want %+v", index, event, events[index])
		}
	}
	if strings.Contains(stdout.String(), `"disposition"`) {
		t.Fatalf("JSONL output leaked AgentInputReceipt: %q", stdout.String())
	}
}

func TestRunAgentChatJSONLContainsOnlyTypedRunEvents(t *testing.T) {
	events := []runharness.RunEvent{
		{
			SchemaVersion: 1, RunID: "chat-jsonl", SessionID: "chat-session", Sequence: 1,
			Kind: runharness.EventModelCompleted, ResultingState: runharness.RunStateCompleted,
			Payload: mustJSON(runharness.ModelCompletedEvent{Text: "done"}),
		},
	}
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "chat-request", SessionID: "chat-session", RunID: "chat-jsonl",
			Disposition: "started", State: runharness.RunStateRunningModel,
		}},
		readResults: []runharness.RunReadResult{{
			Run:    runharness.RunSnapshot{ID: "chat-jsonl", State: runharness.RunStateCompleted},
			Events: events,
		}},
	}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{
		"--prompt", "hello", "--jsonl", "--poll", "1ms",
	}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	got := decodeAgentJSONLEvents(t, stdout.Bytes())
	if len(got) != 1 || got[0].RunID != "chat-jsonl" || got[0].Kind != runharness.EventModelCompleted {
		t.Fatalf("JSONL events=%+v, output=%q", got, stdout.String())
	}
	if strings.Contains(stdout.String(), `"disposition"`) {
		t.Fatalf("JSONL output leaked AgentInputReceipt: %q", stdout.String())
	}
}

func TestRunAgentNoWaitJSONLDoesNotEmitReceipt(t *testing.T) {
	runtime := &fakeAgentRuntime{submitReceipts: []runharness.AgentInputReceipt{{
		RequestID: "no-wait", SessionID: "session-no-wait", RunID: "run-no-wait",
		Disposition: "queued", State: runharness.RunStateQueued,
	}}}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{
		"--prompt", "hello", "--jsonl", "--no-wait",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("--no-wait --jsonl emitted non-event output: %q", stdout.String())
	}
}

func TestAgentControlCommandsForwardTypedControlRequests(t *testing.T) {
	cases := []struct {
		name         string
		invoke       func(*fakeAgentRuntime, *bytes.Buffer, *bytes.Buffer) int
		wantAction   runharness.RunControlAction
		wantApproval string
		wantCall     string
		wantArgsHash string
	}{
		{
			name: "cancel",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "cancel", []string{
					"run-1", "--request-id", "req-cancel", "--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlCancel,
		},
		{
			name: "resume",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "resume", []string{
					"run-1", "--request-id", "req-resume", "--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlResume,
		},
		{
			name: "approve",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentApproval(context.Background(), "approve", []string{
					"run-1", "--approval-id", "approval-1", "--call-id", "call-1",
					"--args-hash", "hash-approve", "--request-id", "req-approve", "--expected-revision", "7", "--no-wait", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlApprove, wantApproval: "approval-1", wantCall: "call-1", wantArgsHash: "hash-approve",
		},
		{
			name: "deny",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentApproval(context.Background(), "deny", []string{
					"run-1", "--approval-id", "approval-2", "--call-id", "call-2",
					"--args-hash", "hash-deny", "--request-id", "req-deny", "--expected-revision", "7", "--no-wait", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlDeny, wantApproval: "approval-2", wantCall: "call-2", wantArgsHash: "hash-deny",
		},
		{
			name: "recover retry",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{
					"run-1", "--action", "retry", "--call-id", "call-retry",
					"--request-id", "req-retry", "--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlRecover, wantCall: "call-retry",
		},
		{
			name: "recover abort",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{
					"run-1", "--action", "abort", "--request-id", "req-abort",
					"--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlAbortRecovery,
		},
		{
			name: "recover mark completed",
			invoke: func(_ *fakeAgentRuntime, stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{
					"run-1", "--action", "mark-completed", "--call-id", "call-complete",
					"--request-id", "req-complete", "--expected-revision", "7", "--json",
				}, stdout, stderr)
			},
			wantAction: runharness.ControlMarkCompleted, wantCall: "call-complete",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runtime := &fakeAgentRuntime{controlSnapshot: runharness.RunSnapshot{ID: "run-1", State: runharness.RunStateRunningModel}}
			capture := installFakeAgentRuntime(t, runtime)
			var stdout, stderr bytes.Buffer
			if code := tc.invoke(runtime, &stdout, &stderr); code != ExitActionRequired {
				t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
			}
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			if len(runtime.controlRequests) != 1 {
				t.Fatalf("control requests=%#v", runtime.controlRequests)
			}
			request := runtime.controlRequests[0]
			if request.Action != tc.wantAction || request.RunID != "run-1" || request.ExpectedRevision != 7 {
				t.Fatalf("request=%+v, want action=%s run=run-1 revision=7", request, tc.wantAction)
			}
			if request.RequestID == "" {
				t.Fatalf("request has no idempotency key: %+v", request)
			}
			if request.ApprovalID != tc.wantApproval || request.CallID != tc.wantCall || request.ArgsHash != tc.wantArgsHash {
				t.Fatalf("approval/call/args-hash fields=%q/%q/%q, want %q/%q/%q", request.ApprovalID, request.CallID, request.ArgsHash, tc.wantApproval, tc.wantCall, tc.wantArgsHash)
			}
			if capture.Options.StartWorkers {
				t.Fatal("control command started unrelated harness workers")
			}
		})
	}
}

func TestRunAgentApprovalRequiresCompleteBindingBeforeStartingHarness(t *testing.T) {
	cases := []struct {
		name      string
		action    string
		args      []string
		wantError string
	}{
		{
			name: "missing call ID", action: "approve",
			args:      []string{"run-1", "--approval-id", "approval-1", "--args-hash", "hash-1", "--expected-revision", "1", "--json"},
			wantError: "--call-id",
		},
		{
			name: "missing args hash", action: "deny",
			args:      []string{"run-1", "--approval-id", "approval-1", "--call-id", "call-1", "--expected-revision", "1", "--json"},
			wantError: "--args-hash",
		},
		{
			name: "zero revision", action: "approve",
			args:      []string{"run-1", "--approval-id", "approval-1", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "0", "--json"},
			wantError: "positive --expected-revision",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			started := false
			previous := newAgentHarness
			newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
				started = true
				return nil, errors.New("harness must not start for incomplete approval")
			}
			t.Cleanup(func() { newAgentHarness = previous })
			var stdout, stderr bytes.Buffer
			code := runAgentApproval(context.Background(), tc.action, tc.args, &stdout, &stderr)
			if code != ExitUsage || started || !strings.Contains(stderr.String(), tc.wantError) {
				t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunAgentControlCommandsRequirePositiveRevisionBeforeStartingHarness(t *testing.T) {
	cases := []struct {
		name string
		call func(*bytes.Buffer, *bytes.Buffer) int
	}{
		{
			name: "cancel",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "cancel", []string{"run-1", "--expected-revision", "0", "--json"}, stdout, stderr)
			},
		},
		{
			name: "resume",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "resume", []string{"run-1", "--expected-revision", "0", "--json"}, stdout, stderr)
			},
		},
		{
			name: "recover",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{"run-1", "--action", "retry", "--expected-revision", "0", "--json"}, stdout, stderr)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			started := false
			previous := newAgentHarness
			newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
				started = true
				return nil, errors.New("harness must not start for zero revision")
			}
			t.Cleanup(func() { newAgentHarness = previous })
			var stdout, stderr bytes.Buffer
			if code := tc.call(&stdout, &stderr); code != ExitUsage || started || !strings.Contains(stderr.String(), "positive --expected-revision") {
				t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
			}
		})
	}
}

func TestExitCodeForRunStateCoversEveryState(t *testing.T) {
	cases := []struct {
		state runharness.RunState
		want  int
	}{
		{runharness.RunStateQueued, ExitActionRequired},
		{runharness.RunStateRunningModel, ExitActionRequired},
		{runharness.RunStateAwaitingApproval, ExitActionRequired},
		{runharness.RunStateRunningTool, ExitActionRequired},
		{runharness.RunStateAwaitingWorkspace, ExitActionRequired},
		{runharness.RunStateInterrupted, ExitActionRequired},
		{runharness.RunStateRecoveryRequired, ExitUnknownOutcome},
		{runharness.RunStateCanceling, ExitActionRequired},
		{runharness.RunStateCompleted, ExitSuccess},
		{runharness.RunStateFailed, ExitExecution},
		{runharness.RunStateCanceled, ExitCancelled},
		{runharness.RunStateExhausted, ExitExecution},
	}
	for _, tc := range cases {
		t.Run(string(tc.state), func(t *testing.T) {
			if got := exitCodeForRunState(tc.state); got != tc.want {
				t.Fatalf("exitCodeForRunState(%s)=%d, want %d", tc.state, got, tc.want)
			}
		})
	}
}

func decodeAgentJSONLEvents(t *testing.T, data []byte) []runharness.RunEvent {
	t.Helper()
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil
	}
	lines := bytes.Split(trimmed, []byte{'\n'})
	events := make([]runharness.RunEvent, 0, len(lines))
	for index, line := range lines {
		var event runharness.RunEvent
		if err := json.Unmarshal(line, &event); err != nil {
			t.Fatalf("decode JSONL line %d: %v; line=%q", index, err, line)
		}
		events = append(events, event)
	}
	return events
}

func TestRunAgentChatReusesCreatedSessionAcrossLines(t *testing.T) {
	runtime := &fakeAgentRuntime{submitReceipts: []runharness.AgentInputReceipt{
		{RequestID: "one", SessionID: "created-session", RunID: "run-1", State: runharness.RunStateCompleted},
		{RequestID: "two", SessionID: "created-session", RunID: "run-2", State: runharness.RunStateCompleted},
	}, readSessionResults: []runharness.SessionProjection{{ID: "created-session", Revision: 17}}}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(strings.NewReader("one\ntwo\n"))
	defer restoreInput()
	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 2 {
		t.Fatalf("requests = %#v", runtime.submitRequests)
	}
	if runtime.submitRequests[0].SessionID != "" || runtime.submitRequests[1].SessionID != "created-session" {
		t.Fatalf("session propagation = %#v", runtime.submitRequests)
	}
	if runtime.submitRequests[0].ExpectedRevision != 0 || runtime.submitRequests[1].ExpectedRevision != 17 {
		t.Fatalf("expected revisions = %#v", runtime.submitRequests)
	}
	if len(runtime.readSessionRequests) != 1 || runtime.readSessionRequests[0].SessionID != "created-session" {
		t.Fatalf("session reads = %#v", runtime.readSessionRequests)
	}
}

func TestRunAgentChatStopsBeforeSubmittingWhenSessionRevisionReadFails(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{
			RequestID: "one", SessionID: "created-session", RunID: "run-1", State: runharness.RunStateCompleted,
		}},
		readSessionErr: errors.New("ledger unavailable"),
	}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(strings.NewReader("one\ntwo\n"))
	defer restoreInput()

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitExecution {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "read session revision") {
		t.Fatalf("stderr=%q, want session revision read failure", stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 1 {
		t.Fatalf("submit requests = %#v, want only first input", runtime.submitRequests)
	}
	if len(runtime.readSessionRequests) != 1 || runtime.readSessionRequests[0].SessionID != "created-session" {
		t.Fatalf("session reads = %#v", runtime.readSessionRequests)
	}
}

func TestRunAgentChatSteerDoesNotUseSessionRevisionAsRunRevision(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{
			{RequestID: "one", SessionID: "created-session", RunID: "run-1", State: runharness.RunStateCompleted},
			{RequestID: "two", SessionID: "created-session", RunID: "run-2", State: runharness.RunStateCompleted},
		},
		readSessionErr: errors.New("must not read session revision for steer"),
	}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(strings.NewReader("one\ntwo\n"))
	defer restoreInput()

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--dispatch", "steer", "--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.submitRequests) != 2 || runtime.submitRequests[1].ExpectedRevision != 0 {
		t.Fatalf("steer requests = %#v", runtime.submitRequests)
	}
	if len(runtime.readSessionRequests) != 0 {
		t.Fatalf("steer read session projection = %#v", runtime.readSessionRequests)
	}
}

type agentCLIErrorReader struct{ err error }

func (r agentCLIErrorReader) Read([]byte) (int, error) { return 0, r.err }

func TestRunAgentChatEOFDetachesDurableRuntime(t *testing.T) {
	runtime := &fakeAgentRuntime{}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(strings.NewReader(""))
	defer restoreInput()

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("EOF closed durable runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentChatScannerErrorDetachesDurableRuntime(t *testing.T) {
	scanErr := errors.New("stdin read failed")
	runtime := &fakeAgentRuntime{}
	installFakeAgentRuntime(t, runtime)
	restoreInput := SetAgentCLIInput(agentCLIErrorReader{err: scanErr})
	defer restoreInput()

	var stdout, stderr bytes.Buffer
	if code := runAgentChat(context.Background(), []string{"--jsonl", "--poll", "1ms"}, &stdout, &stderr); code != ExitExecution {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "input_failed") {
		t.Fatalf("stderr=%q, want input_failed", stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("scanner error closed durable runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentSubmitErrorDetachesDurableRuntime(t *testing.T) {
	submitErr := errors.New("submit response lost")
	runtime := &fakeAgentRuntime{submitErr: submitErr}
	installFakeAgentRuntime(t, runtime)

	var stdout, stderr bytes.Buffer
	if code := runAgentRun(context.Background(), []string{"--prompt", "hello", "--json"}, &stdout, &stderr); code != ExitExecution {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("ambiguous submit error closed durable runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentControlErrorsDetachDurableRuntime(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*bytes.Buffer, *bytes.Buffer) int
	}{
		{
			name: "control",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentControl(context.Background(), "resume", []string{"run-1", "--expected-revision", "1", "--json"}, stdout, stderr)
			},
		},
		{
			name: "approval",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentApproval(context.Background(), "approve", []string{"run-1", "--approval-id", "a", "--call-id", "c", "--args-hash", "hash-1", "--expected-revision", "1", "--json"}, stdout, stderr)
			},
		},
		{
			name: "recovery",
			call: func(stdout, stderr *bytes.Buffer) int {
				return runAgentRecover(context.Background(), []string{"run-1", "--action", "retry", "--expected-revision", "1", "--json"}, stdout, stderr)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtime := &fakeAgentRuntime{controlErr: errors.New("control response lost")}
			installFakeAgentRuntime(t, runtime)
			var stdout, stderr bytes.Buffer
			if code := tc.call(&stdout, &stderr); code != ExitExecution {
				t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
			}
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			if runtime.closeCalls != 0 {
				t.Fatalf("control error closed durable runtime %d times", runtime.closeCalls)
			}
		})
	}
}

func TestRunAgentWaitTimeoutDoesNotCancelRun(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readResults:    []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel}}},
	}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{"--prompt", "slow", "--timeout", "5ms", "--poll", "100ms", "--json"}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if _, hasDeadline := capture.Context.Deadline(); hasDeadline {
		t.Fatal("harness factory received command timeout context")
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 0 {
		t.Fatalf("timeout unexpectedly sent controls = %#v", runtime.controlRequests)
	}
	if len(runtime.submitContexts) != 1 {
		t.Fatalf("submit contexts = %d, want 1", len(runtime.submitContexts))
	}
	if _, hasDeadline := runtime.submitContexts[0].Deadline(); hasDeadline {
		t.Fatal("harness SubmitInput received command timeout context")
	}
	if !capture.Options.StartWorkers {
		t.Fatal("agent run must start harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("timeout closed the active runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentApprovalTimeoutDoesNotCancelDurableDecision(t *testing.T) {
	runtime := &fakeAgentRuntime{
		controlSnapshot: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel},
		readResults: []runharness.RunReadResult{{
			Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel},
		}},
	}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentApproval(context.Background(), "approve", []string{
		"r", "--approval-id", "a", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "1", "--timeout", "5ms", "--poll", "100ms", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlContexts) != 1 {
		t.Fatalf("control contexts = %d, want 1", len(runtime.controlContexts))
	}
	if _, hasDeadline := runtime.controlContexts[0].Deadline(); hasDeadline {
		t.Fatal("harness ControlRun received command timeout context")
	}
	if capture.Options.StartWorkers {
		t.Fatal("approval command must not start unrelated harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("approval timeout closed the active runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentApprovalNoWaitDoesNotCloseActiveRuntime(t *testing.T) {
	runtime := &fakeAgentRuntime{controlSnapshot: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel}}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentApproval(context.Background(), "approve", []string{
		"r", "--approval-id", "a", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "1", "--no-wait", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if capture.Options.StartWorkers {
		t.Fatal("approval command must not start unrelated harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("approval --no-wait closed the active runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentTimeoutBeforeFirstProjectionDoesNotCloseRun(t *testing.T) {
	blocked := make(chan struct{})
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readBlock:      blocked,
	}
	installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentRun(context.Background(), []string{"--prompt", "slow", "--timeout", "5ms", "--poll", "1ms", "--json"}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("timeout before first projection closed the active runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentChatRecoveryRequiredDoesNotCloseRuntime(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readResults:    []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRecoveryRequired}}},
	}
	installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentChat(context.Background(), []string{"--prompt", "continue", "--json", "--poll", "1ms"}, &stdout, &stderr)
	if code != ExitUnknownOutcome {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.closeCalls != 0 {
		t.Fatalf("recovery-required chat closed the runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentCancellationPersistsControlCommand(t *testing.T) {
	runtime := &fakeAgentRuntime{
		submitReceipts: []runharness.AgentInputReceipt{{RequestID: "req", SessionID: "s", RunID: "r", State: runharness.RunStateRunningModel}},
		readResults:    []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateRunningModel, Revision: 7}}},
	}
	installFakeAgentRuntime(t, runtime)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var stdout, stderr bytes.Buffer
	code := runAgentRun(ctx, []string{"--prompt", "cancel", "--json"}, &stdout, &stderr)
	if code != ExitCancelled {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 1 || runtime.controlRequests[0].Action != runharness.ControlCancel || runtime.controlRequests[0].RunID != "r" {
		t.Fatalf("controls = %#v", runtime.controlRequests)
	}
	if runtime.controlRequests[0].RequestID == "" {
		t.Fatal("cancel control has no idempotency key")
	}
	if runtime.controlRequests[0].ExpectedRevision != 7 {
		t.Fatalf("cancel expected revision = %d, want 7", runtime.controlRequests[0].ExpectedRevision)
	}
}

func TestCancelAgentRunDoesNotMutateWhenCurrentRunCannotBeRead(t *testing.T) {
	runtime := &fakeAgentRuntime{readErr: errors.New("ledger unavailable")}
	terminal, state := cancelAgentRun(context.Background(), runtime, "run-1")
	if terminal || state != "" {
		t.Fatalf("result = terminal:%t state:%q", terminal, state)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 0 {
		t.Fatalf("controls = %#v, want none after failed read", runtime.controlRequests)
	}
}

func TestCancelAgentRunDoesNotMutateAnAlreadyTerminalRun(t *testing.T) {
	runtime := &fakeAgentRuntime{readResults: []runharness.RunReadResult{{
		Run: runharness.RunSnapshot{ID: "run-1", State: runharness.RunStateCompleted, Revision: 4},
	}}}
	terminal, state := cancelAgentRun(context.Background(), runtime, "run-1")
	if !terminal || state != runharness.RunStateCompleted {
		t.Fatalf("result = terminal:%t state:%q", terminal, state)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 0 {
		t.Fatalf("controls = %#v, want none for terminal run", runtime.controlRequests)
	}
}

func TestCancelAgentRunSurfacesRevisionConflictInsteadOfClaimingCanceled(t *testing.T) {
	runtime := &fakeAgentRuntime{
		controlErr: runharness.ErrRevisionConflict,
		readResults: []runharness.RunReadResult{{
			Run: runharness.RunSnapshot{ID: "run-1", State: runharness.RunStateRunningModel, Revision: 4},
		}},
	}
	terminal, state, err := cancelAgentRunWithError(context.Background(), runtime, "run-1")
	if terminal || state != "" {
		t.Fatalf("result = terminal:%t state:%q", terminal, state)
	}
	if !errors.Is(err, runharness.ErrRevisionConflict) {
		t.Fatalf("error = %v, want revision conflict", err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 2 {
		t.Fatalf("control requests = %d, want one refresh retry", len(runtime.controlRequests))
	}
	if runtime.controlRequests[0].ExpectedRevision != 4 || runtime.controlRequests[1].ExpectedRevision != 4 {
		t.Fatalf("control revisions = %#v", runtime.controlRequests)
	}
}

func TestRunAgentControlGeneratesRequestIDWhenOmitted(t *testing.T) {
	runtime := &fakeAgentRuntime{controlSnapshot: runharness.RunSnapshot{ID: "r", State: runharness.RunStateInterrupted}}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	if code := runAgentControl(context.Background(), "resume", []string{"r", "--expected-revision", "1", "--json"}, &stdout, &stderr); code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 1 {
		t.Fatalf("controls = %#v", runtime.controlRequests)
	}
	control := runtime.controlRequests[0]
	if control.Action != runharness.ControlResume || control.RunID != "r" || control.RequestID == "" {
		t.Fatalf("control = %#v", control)
	}
	if capture.Options.StartWorkers {
		t.Fatal("resume command must not start unrelated harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("non-terminal resume closed the runtime %d times", runtime.closeCalls)
	}
}

func TestRunAgentRecoverRequiresExplicitAction(t *testing.T) {
	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("factory must not run without a recovery action")
	}
	t.Cleanup(func() { newAgentHarness = previous })
	var stdout, stderr bytes.Buffer
	code := runAgentRecover(context.Background(), []string{"run-1"}, &stdout, &stderr)
	if code != ExitUsage || started || !strings.Contains(stderr.String(), `"code":"usage"`) {
		t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
	}
}

func TestRunAgentRecoverForwardsUnknownToolCallID(t *testing.T) {
	runtime := &fakeAgentRuntime{controlSnapshot: runharness.RunSnapshot{ID: "run-1", State: runharness.RunStateRunningModel}}
	capture := installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentRecover(context.Background(), []string{
		"run-1", "--action", "mark-completed", "--call-id", "call-7", "--expected-revision", "1", "--json",
	}, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 1 || runtime.controlRequests[0].CallID != "call-7" || runtime.controlRequests[0].Action != runharness.ControlMarkCompleted {
		t.Fatalf("control requests = %#v", runtime.controlRequests)
	}
	if capture.Options.StartWorkers {
		t.Fatal("recovery command must not start unrelated harness workers")
	}
	if runtime.closeCalls != 0 {
		t.Fatalf("non-terminal recovery closed the runtime %d times", runtime.closeCalls)
	}
}

func TestReadOnlyAgentCommandsDoNotStartWorkers(t *testing.T) {
	t.Run("list", func(t *testing.T) {
		runtime := &fakeAgentRuntime{}
		capture := installFakeAgentRuntime(t, runtime)
		var stdout, stderr bytes.Buffer
		if code := runAgentList(context.Background(), []string{"--json"}, &stdout, &stderr); code != ExitSuccess {
			t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		if capture.Options.StartWorkers {
			t.Fatal("list command started workers")
		}
		if runtime.closeCalls != 1 {
			t.Fatalf("list close calls=%d, want 1", runtime.closeCalls)
		}
	})

	t.Run("show", func(t *testing.T) {
		runtime := &fakeAgentRuntime{readResults: []runharness.RunReadResult{{Run: runharness.RunSnapshot{ID: "r", State: runharness.RunStateCompleted}}}}
		capture := installFakeAgentRuntime(t, runtime)
		var stdout, stderr bytes.Buffer
		if code := runAgentShow(context.Background(), []string{"r", "--json"}, &stdout, &stderr); code != ExitSuccess {
			t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		if capture.Options.StartWorkers {
			t.Fatal("show command started workers")
		}
		if runtime.closeCalls != 1 {
			t.Fatalf("show close calls=%d, want 1", runtime.closeCalls)
		}
	})

	t.Run("snapshot", func(t *testing.T) {
		runtime := &fakeAgentRuntime{}
		capture := installFakeAgentRuntime(t, runtime)
		path := filepath.Join(t.TempDir(), "workspace.json")
		data, err := json.Marshal(runharness.WorkspaceSnapshot{
			SourceKind:       runharness.WorkspaceCLI,
			SourceID:         "cli-source",
			SourceInstanceID: "instance",
			Revision:         1,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		var stdout, stderr bytes.Buffer
		if code := runAgentSnapshot(context.Background(), []string{"--file", path, "--json"}, &stdout, &stderr); code != ExitSuccess {
			t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
		if capture.Options.StartWorkers {
			t.Fatal("snapshot command started workers")
		}
		if runtime.closeCalls != 1 {
			t.Fatalf("snapshot close calls=%d, want 1", runtime.closeCalls)
		}
	})
}

func TestLoadAgentPolicyAcceptsBarePolicyObject(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	data := []byte(`{"maxToolRounds":4,"softToolRoundLimit":2,"defaultDispatchMode":"queue"}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("loadAgentPolicy: %v", err)
	}
	if snapshot.Revision != 1 || snapshot.SchemaVersion != runharness.CurrentSchemaVersion {
		t.Fatalf("bare policy snapshot = %+v, want initial revisioned snapshot", snapshot)
	}
	if snapshot.Policy.MaxToolRounds != 4 || snapshot.Policy.SoftToolRoundLimit != 2 || snapshot.Policy.DefaultDispatchMode != runharness.DispatchQueue {
		t.Fatalf("bare policy was ignored: %+v", snapshot.Policy)
	}
}

func TestLoadAgentPolicyDecodesRuntimeWrapper(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	want := runharness.DefaultRunPolicySnapshot()
	want.Revision = 7
	want.Runtime = runharness.RunRuntimeConfig{
		ControlPollInterval:            375 * time.Millisecond,
		WorkspaceSnapshotRenewInterval: 2 * time.Second,
		WorkspaceSnapshotLeaseDuration: 9 * time.Second,
		PolicyWatchInterval:            runharness.DefaultRunPolicyWatchInterval,
	}
	if err := saveAgentPolicy(path, want); err != nil {
		t.Fatalf("saveAgentPolicy: %v", err)
	}

	got, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("loadAgentPolicy: %v", err)
	}
	if got != want {
		t.Fatalf("loaded snapshot = %+v, want %+v", got, want)
	}
}

func TestRunAgentConfigSetWritesRuntimeOverrides(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{
		"set", "--file", path, "--revision", "1",
		"--set", "control-poll-interval=375ms,workspaceSnapshotRenewInterval=2s,workspace-snapshot-lease-duration=9s,policy-watch-interval=750ms",
	}, &stdout, &stderr)
	if code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var got runharness.RunPolicySnapshot
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("decode config set output: %v; output=%q", err, stdout.String())
	}
	wantRuntime := runharness.RunRuntimeConfig{
		ControlPollInterval:            375 * time.Millisecond,
		WorkspaceSnapshotRenewInterval: 2 * time.Second,
		WorkspaceSnapshotLeaseDuration: 9 * time.Second,
		PolicyWatchInterval:            750 * time.Millisecond,
	}
	if got.Runtime != wantRuntime {
		t.Fatalf("runtime = %+v, want %+v", got.Runtime, wantRuntime)
	}
	stored, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("load stored policy: %v", err)
	}
	if stored.Runtime != wantRuntime || stored.Revision != 2 {
		t.Fatalf("stored snapshot = %+v", stored)
	}
}

func TestRunAgentConfigSetRejectsRenewIntervalAtLease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{
		"set", "--file", path, "--revision", "1",
		"--set", "workspace-snapshot-renew-interval=15s",
	}, &stdout, &stderr)
	if code != ExitUsage || !strings.Contains(stderr.String(), "shorter than lease") {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	loaded, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("load policy after rejected mutation: %v", err)
	}
	defaults := runharness.DefaultRunPolicySnapshot()
	if loaded != defaults {
		t.Fatalf("rejected mutation changed policy: got %+v want %+v", loaded, defaults)
	}
}

func TestAgentPollIntervalUsesRuntimeUnlessExplicitFlag(t *testing.T) {
	runtime := runharness.RunRuntimeConfig{
		ControlPollInterval:            875 * time.Millisecond,
		WorkspaceSnapshotRenewInterval: 2 * time.Second,
		WorkspaceSnapshotLeaseDuration: 9 * time.Second,
	}
	withoutFlag := newFlagSet("agent test")
	poll := withoutFlag.Duration("poll", 0, "poll")
	if err := parseAgentFlags(withoutFlag, nil); err != nil {
		t.Fatal(err)
	}
	if got := agentPollInterval(withoutFlag, *poll, runtime); got != runtime.ControlPollInterval {
		t.Fatalf("configured poll = %s, want %s", got, runtime.ControlPollInterval)
	}

	withFlag := newFlagSet("agent test")
	explicit := withFlag.Duration("poll", 0, "poll")
	if err := parseAgentFlags(withFlag, []string{"--poll", "17ms"}); err != nil {
		t.Fatal(err)
	}
	if got := agentPollInterval(withFlag, *explicit, runtime); got != 17*time.Millisecond {
		t.Fatalf("explicit poll = %s, want 17ms", got)
	}
}

func TestLoadAgentPolicyRejectsMalformedWrapper(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"policy":"broken","maxToolRounds":4}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAgentPolicy(path); err == nil {
		t.Fatal("loadAgentPolicy accepted a malformed policy wrapper")
	}
}

func TestLoadAgentPolicyRejectsNullDocument(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`null`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAgentPolicy(path); err == nil {
		t.Fatal("loadAgentPolicy accepted a null document")
	}
}

func TestRunAgentConfigShowEmitsRunPolicySnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	want := runharness.DefaultRunPolicySnapshot()
	want.Revision = 4
	want.Policy.MaxToolRounds = 20
	if err := saveAgentPolicy(path, want); err != nil {
		t.Fatalf("saveAgentPolicy: %v", err)
	}

	var stdout, stderr bytes.Buffer
	if code := runAgentConfig(context.Background(), []string{"show", "--file", path}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var got runharness.RunPolicySnapshot
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("decode config show output: %v; output=%q", err, stdout.String())
	}
	if got != want {
		t.Fatalf("config show = %+v, want %+v", got, want)
	}
}

func TestRunAgentConfigSetRequiresExpectedRevision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{"set", "--file", path, "--set", "max-tool-rounds=4"}, &stdout, &stderr)
	if code != ExitActionRequired || !strings.Contains(stderr.String(), `"code":"revision_conflict"`) {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config set without revision wrote policy: %v", err)
	}
}

func TestRunAgentConfigSetWritesNextSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{"set", "--file", path, "--revision", "1", "--set", "soft-tool-round-limit=2,max-tool-rounds=4"}, &stdout, &stderr)
	if code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var emitted runharness.RunPolicySnapshot
	if err := json.Unmarshal(stdout.Bytes(), &emitted); err != nil {
		t.Fatalf("decode config set output: %v; output=%q", err, stdout.String())
	}
	if emitted.Revision != 2 || emitted.Policy.SoftToolRoundLimit != 2 || emitted.Policy.MaxToolRounds != 4 {
		t.Fatalf("config set snapshot = %+v", emitted)
	}
	stored, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("loadAgentPolicy: %v", err)
	}
	if stored != emitted {
		t.Fatalf("stored policy = %+v, want emitted %+v", stored, emitted)
	}
}

func TestRunAgentConfigSetRejectsStaleRevision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	seed := runharness.DefaultRunPolicySnapshot()
	seed.Revision = 2
	if err := saveAgentPolicy(path, seed); err != nil {
		t.Fatalf("saveAgentPolicy: %v", err)
	}

	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{"set", "--file", path, "--expected-revision", "1", "--set", "max-tool-rounds=4"}, &stdout, &stderr)
	if code != ExitActionRequired || !strings.Contains(stderr.String(), `"code":"revision_conflict"`) {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	loaded, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("loadAgentPolicy: %v", err)
	}
	if loaded != seed {
		t.Fatalf("stale config set changed policy: got %+v want %+v", loaded, seed)
	}
}

func TestMutateAgentPolicyConcurrentCAS(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	start := make(chan struct{})
	type result struct {
		snapshot runharness.RunPolicySnapshot
		err      error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			<-start
			snapshot, err := mutateAgentPolicy(path, 1, "soft-tool-round-limit=2,max-tool-rounds=4")
			results <- result{snapshot: snapshot, err: err}
		}()
	}
	close(start)
	left, right := <-results, <-results

	successes, conflicts := 0, 0
	for _, item := range []result{left, right} {
		if item.err == nil {
			successes++
			if item.snapshot.Revision != 2 {
				t.Fatalf("successful mutation revision=%d, want 2", item.snapshot.Revision)
			}
			continue
		}
		if errors.Is(item.err, runharness.ErrRevisionConflict) && strings.Contains(item.err.Error(), "revision_conflict") {
			conflicts++
			continue
		}
		t.Fatalf("unexpected concurrent mutation error: %v", item.err)
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent mutations: successes=%d conflicts=%d", successes, conflicts)
	}
}

func TestMutateAgentPolicyWaitsForExternalLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create policy directory: %v", err)
	}
	lock, err := appdata.AcquireFileLock(path + ".lock")
	if err != nil {
		t.Fatalf("acquire policy lock: %v", err)
	}

	finished := make(chan error, 1)
	go func() {
		_, mutateErr := mutateAgentPolicy(path, 1, "soft-tool-round-limit=2,max-tool-rounds=4")
		finished <- mutateErr
	}()
	select {
	case mutateErr := <-finished:
		t.Fatalf("policy mutation acquired external lock before release: %v", mutateErr)
	case <-time.After(50 * time.Millisecond):
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("release policy lock: %v", err)
	}
	select {
	case mutateErr := <-finished:
		if mutateErr != nil {
			t.Fatalf("policy mutation after lock release: %v", mutateErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("policy mutation did not acquire external lock after release")
	}
}

func TestRunAgentApprovalRejectsNegativeRevision(t *testing.T) {
	started := false
	previous := newAgentHarness
	newAgentHarness = func(context.Context, AgentHarnessOptions) (AgentHarnessRuntime, error) {
		started = true
		return nil, errors.New("factory must not run for invalid revision")
	}
	t.Cleanup(func() { newAgentHarness = previous })
	var stdout, stderr bytes.Buffer
	code := runAgentApproval(context.Background(), "approve", []string{"r", "--approval-id", "a", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "-1"}, &stdout, &stderr)
	if code != ExitUsage || started || !strings.Contains(stderr.String(), `"code":"usage"`) {
		t.Fatalf("exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
	}
}

func TestCLIAgentApprovalNonTTYReturnsPendingWithoutReadingTTY(t *testing.T) {
	opened := false
	var output bytes.Buffer
	handler := &cliAgentApprovalHandler{
		stdin: func() io.Reader { return strings.NewReader("piped input") },
		tty:   readerIsTTY,
		openTTY: func() (io.ReadWriteCloser, error) {
			opened = true
			return nil, errors.New("must not open tty for piped input")
		},
		stderr: &output,
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	decision, err := handler.Request(ctx, runharness.ApprovalRequest{
		ApprovalID: "approval-1", RunID: "run-1", CallID: "call-1", ToolName: "execute_sql",
	})
	if !errors.Is(err, runharness.ErrApprovalPending) {
		t.Fatalf("error = %v, want ErrApprovalPending", err)
	}
	if opened || decision != (runharness.ApprovalDecision{}) {
		t.Fatalf("non-TTY approval = %#v opened=%t", decision, opened)
	}
}

func TestCLIAgentApprovalNonTTYPropagatesCancellation(t *testing.T) {
	handler := &cliAgentApprovalHandler{
		stdin: func() io.Reader { return strings.NewReader("piped input") },
		tty:   readerIsTTY,
		openTTY: func() (io.ReadWriteCloser, error) {
			t.Fatalf("must not open tty after cancellation")
			return nil, nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	decision, err := handler.Request(ctx, runharness.ApprovalRequest{ApprovalID: "approval-1"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if decision != (runharness.ApprovalDecision{}) {
		t.Fatalf("decision = %#v", decision)
	}
}

func TestRunAgentApprovalWaitsForWorkerAndReturnsTerminalResult(t *testing.T) {
	runtime := &fakeAgentRuntime{
		controlSnapshot: runharness.RunSnapshot{ID: "run-approval", State: runharness.RunStateAwaitingApproval},
		readResults: []runharness.RunReadResult{{
			Run: runharness.RunSnapshot{ID: "run-approval", State: runharness.RunStateCompleted},
			Events: []runharness.RunEvent{{
				RunID: "run-approval", Sequence: 1, Kind: runharness.EventTerminal,
				ResultingState: runharness.RunStateCompleted,
			}},
		}},
	}
	installFakeAgentRuntime(t, runtime)
	var stdout, stderr bytes.Buffer
	code := runAgentApproval(context.Background(), "approve", []string{
		"run-approval", "--approval-id", "approval-1", "--call-id", "call-1", "--args-hash", "hash-1", "--expected-revision", "1", "--json", "--poll", "1ms",
	}, &stdout, &stderr)
	if code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var result runharness.RunReadResult
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &result); err != nil {
		t.Fatalf("decode terminal result: %v; output=%q", err, stdout.String())
	}
	if result.Run.State != runharness.RunStateCompleted {
		t.Fatalf("result = %#v", result.Run)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if len(runtime.controlRequests) != 1 || runtime.controlRequests[0].Action != runharness.ControlApprove {
		t.Fatalf("control requests = %#v", runtime.controlRequests)
	}
	if runtime.closeCalls != 1 {
		t.Fatalf("close calls = %d", runtime.closeCalls)
	}
}

func TestWaitForAgentRunJSONLReportsApprovalIdentifiersOnce(t *testing.T) {
	runtime := &fakeAgentRuntime{
		readResults: []runharness.RunReadResult{{
			Run: runharness.RunSnapshot{ID: "run-approval", State: runharness.RunStateAwaitingApproval},
			Events: []runharness.RunEvent{{
				RunID: "run-approval", Sequence: 1, Kind: runharness.EventApproval,
				ResultingState: runharness.RunStateAwaitingApproval,
				Payload:        mustJSON(runharness.ApprovalEvent{ApprovalID: "approval-1", CallID: "call-1", ArgsHash: "hash-1", Decision: "pending"}),
			}},
		}},
	}
	var stdout, stderr bytes.Buffer
	code := waitForAgentRun(context.Background(), runtime, "run-approval", agentOutputJSONL, time.Millisecond, &stdout, &stderr)
	if code != ExitActionRequired {
		t.Fatalf("exit = %d", code)
	}
	if got := strings.Count(stderr.String(), "approvalId=approval-1"); got != 1 || !strings.Contains(stderr.String(), "argsHash=hash-1") {
		t.Fatalf("approval notice count = %d, stderr=%q", got, stderr.String())
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("JSONL lines = %d, output=%q", len(lines), stdout.String())
	}
	var event runharness.RunEvent
	if err := json.Unmarshal([]byte(lines[0]), &event); err != nil || event.Kind != runharness.EventApproval {
		t.Fatalf("JSONL event = %#v err=%v", event, err)
	}
	var payload runharness.ApprovalEvent
	if err := json.Unmarshal(event.Payload, &payload); err != nil || payload.ArgsHash != "hash-1" {
		t.Fatalf("JSONL approval payload = %#v err=%v", payload, err)
	}
	if strings.Contains(stdout.String(), "approval required") {
		t.Fatalf("JSONL stdout contains human approval notice: %q", stdout.String())
	}
}

func TestWriteAgentEventApprovalDisplaysOnlyBoundIdentifiers(t *testing.T) {
	event := runharness.RunEvent{
		Sequence:       9,
		Kind:           runharness.EventApproval,
		ResultingState: runharness.RunStateAwaitingApproval,
		Payload: mustJSON(map[string]any{
			"approvalId": "approval-1",
			"callId":     "call-1",
			"argsHash":   "hash-1",
			"decision":   "pending",
			"arguments":  map[string]any{"sql": "SELECT secret_value"},
			"text":       "SELECT secret_value",
		}),
	}
	var output bytes.Buffer
	writeAgentEvent(&output, event)
	got := output.String()
	if !strings.Contains(got, "approval=approval-1 call=call-1 args-hash=hash-1 decision=pending") {
		t.Fatalf("approval event output=%q", got)
	}
	if strings.Contains(got, "secret_value") {
		t.Fatalf("approval event exposed tool arguments: %q", got)
	}
}

func TestFailAgentErrorMapsFollowUpStatesToActionRequired(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code string
	}{
		{name: "recovery", err: runharness.ErrRecoveryUnavailable, code: "recovery_unavailable"},
		{name: "snapshot expired", err: runharness.ErrSnapshotExpired, code: "snapshot_expired"},
		{name: "snapshot conflict", err: runharness.ErrSnapshotConflict, code: "snapshot_conflict"},
		{name: "workspace unavailable", err: runharness.ErrWorkspaceUnavailable, code: "workspace_unavailable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var stderr bytes.Buffer
			if got := failAgentError(&stderr, tc.err); got != ExitActionRequired {
				t.Fatalf("exit=%d stderr=%q", got, stderr.String())
			}
			if !strings.Contains(stderr.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("missing code %q in stderr=%q", tc.code, stderr.String())
			}
		})
	}
}

func mustJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}
