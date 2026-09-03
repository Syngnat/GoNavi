package aiservice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/uievents"
)

type agentHarnessTestSecretStore struct {
	mu           sync.Mutex
	items        map[string][]byte
	gets         []string
	puts         []string
	healthChecks int
}

func newAgentHarnessTestSecretStore() *agentHarnessTestSecretStore {
	return &agentHarnessTestSecretStore{items: make(map[string][]byte)}
}

func (s *agentHarnessTestSecretStore) Put(ref string, value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.puts = append(s.puts, ref)
	s.items[ref] = append([]byte(nil), value...)
	return nil
}

func (s *agentHarnessTestSecretStore) Get(ref string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gets = append(s.gets, ref)
	value, ok := s.items[ref]
	if !ok {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), value...), nil
}

func (s *agentHarnessTestSecretStore) Delete(ref string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.items, ref)
	return nil
}

func (s *agentHarnessTestSecretStore) HealthCheck() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.healthChecks++
	return nil
}

func (s *agentHarnessTestSecretStore) accessCounts() (gets, puts, healthChecks int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.gets), len(s.puts), s.healthChecks
}

var _ secretstore.SecretStore = (*agentHarnessTestSecretStore)(nil)

type agentHarnessTestEmitter struct {
	mu     sync.Mutex
	events []runharness.RunEvent
}

func (e *agentHarnessTestEmitter) Emit(name string, args ...any) {
	if name != runharness.EventName || len(args) != 1 {
		return
	}
	event, ok := args[0].(runharness.RunEvent)
	if !ok {
		return
	}
	e.mu.Lock()
	e.events = append(e.events, event)
	e.mu.Unlock()
}

func (e *agentHarnessTestEmitter) count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.events)
}

// ledgerObservingMCPHTTPProcess proves the shutdown order without relying on
// SQLite implementation details: Stop must run while the detached Ledger is
// still live, and the test checks it is closed only after Shutdown returns.
type ledgerObservingMCPHTTPProcess struct {
	*fakeMCPHTTPProcess
	ledger                    *runharness.Ledger
	ledgerAvailableDuringStop bool
}

func (p *ledgerObservingMCPHTTPProcess) Stop(ctx context.Context) error {
	_, err := p.ledger.ListSessions(context.Background(), runharness.SessionListRequest{Limit: 1})
	p.ledgerAvailableDuringStop = err == nil
	return p.fakeMCPHTTPProcess.Stop(ctx)
}

func newInitializedAgentHarnessService(t *testing.T) (*Service, *agentHarnessTestEmitter) {
	t.Helper()
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = t.TempDir()
	emitter := &agentHarnessTestEmitter{}
	ctx := uievents.WithEmitter(context.Background(), emitter)
	service.agentContext = ctx
	if err := service.initializeAgentHarness(ctx); err != nil {
		t.Fatalf("initializeAgentHarness: %v", err)
	}
	t.Cleanup(service.Shutdown)
	return service, emitter
}

func TestServiceRunPolicyRoundTripAndNormalization(t *testing.T) {
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = t.TempDir()
	initial, err := service.AIGetRunPolicy()
	if err != nil {
		t.Fatalf("AIGetRunPolicy: %v", err)
	}
	if initial.Revision != 1 {
		t.Fatalf("initial policy revision = %d, want 1", initial.Revision)
	}
	policy := runharness.RunPolicy{SoftToolRoundLimit: 2, MaxToolRounds: 4}
	saved, err := service.AISaveRunPolicy(runharness.RunPolicyMutationRequest{
		ExpectedRevision: initial.Revision,
		Policy:           policy,
	})
	if err != nil {
		t.Fatalf("AISaveRunPolicy: %v", err)
	}
	if saved.Revision != initial.Revision+1 || saved.Policy.DefaultDispatchMode != runharness.DispatchQueue || saved.Policy.MaxToolRounds != 4 || saved.Policy.MaxToolResultBytes == 0 {
		t.Fatalf("saved policy was not normalized: %+v", saved)
	}
	loaded, err := service.AIGetRunPolicy()
	if err != nil {
		t.Fatalf("AIGetRunPolicy: %v", err)
	}
	if loaded != saved {
		t.Fatalf("loaded policy %+v differs from saved %+v", loaded, saved)
	}
	data, err := os.ReadFile(filepath.Join(service.configDir, agentRunPolicyFileName))
	if err != nil {
		t.Fatalf("read policy file: %v", err)
	}
	var envelope runharness.RunPolicySnapshot
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatalf("decode policy file: %v", err)
	}
	if envelope != saved {
		t.Fatalf("unexpected policy envelope: %+v", envelope)
	}
	_, err = service.AISaveRunPolicy(runharness.RunPolicyMutationRequest{
		ExpectedRevision: initial.Revision,
		Policy:           runharness.DefaultRunPolicy(),
	})
	if !errors.Is(err, runharness.ErrRevisionConflict) || !strings.Contains(err.Error(), "revision_conflict") {
		t.Fatalf("stale policy save error = %v, want revision_conflict", err)
	}
	if err := service.shutdownAgentHarness(); err != nil {
		t.Fatalf("shutdown helper: %v", err)
	}
}

func TestServiceAgentWailsMethodsUseSharedLedger(t *testing.T) {
	service, emitter := newInitializedAgentHarnessService(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n"))
	}))
	t.Cleanup(server.Close)
	service.mu.Lock()
	service.providers = []ai.ProviderConfig{{
		ID: "service-test-provider", Type: "openai", APIFormat: "openai",
		BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "test-model",
	}}
	service.activeProvider = "service-test-provider"
	service.mu.Unlock()

	snapshot := runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceCLI,
		SourceID:         "test-source",
		SourceInstanceID: "instance-1",
		Revision:         1,
		CapturedAt:       time.Now(),
	}
	ack, err := service.AIUpdateWorkspaceSnapshot(snapshot)
	if err != nil {
		t.Fatalf("AIUpdateWorkspaceSnapshot: %v", err)
	}
	if !ack.Accepted || ack.Revision != 1 || ack.ContentHash == "" {
		t.Fatalf("unexpected snapshot ack: %+v", ack)
	}

	receipt, err := service.AISubmitAgentInput(runharness.AgentInputRequest{
		RequestID: "service-request-1",
		Content:   "hello",
	})
	if err != nil {
		t.Fatalf("AISubmitAgentInput: %v", err)
	}
	if receipt.SessionID == "" || receipt.RunID == "" {
		t.Fatalf("input receipt missing IDs: %+v", receipt)
	}

	list, err := service.AIListAgentSessions(runharness.SessionListRequest{Limit: 10})
	if err != nil {
		t.Fatalf("AIListAgentSessions: %v", err)
	}
	if list.Total != 1 || len(list.Sessions) != 1 || list.Sessions[0].ID != receipt.SessionID {
		t.Fatalf("unexpected session list: %+v", list)
	}

	var read runharness.RunReadResult
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		read, err = service.AIReadAgentRun(runharness.RunReadRequest{RunID: receipt.RunID})
		if err != nil {
			t.Fatalf("AIReadAgentRun: %v", err)
		}
		if len(read.Events) > 0 || read.Run.State.Terminal() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if read.Run.ID != receipt.RunID || len(read.Events) == 0 {
		t.Fatalf("run read did not include persisted events: %+v", read)
	}
	if emitter.count() == 0 {
		t.Fatal("expected persisted run events to be emitted through uievents")
	}
}

func TestServiceWorkspaceSnapshotDefersLedgerUntilAgentUse(t *testing.T) {
	store := newAgentHarnessTestSecretStore()
	service := NewServiceWithSecretStore(store)
	service.configDir = t.TempDir()
	service.agentContext = context.Background()
	t.Cleanup(service.Shutdown)

	snapshot := runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceDesktop,
		SourceID:         "desktop",
		SourceInstanceID: "startup-instance",
		Revision:         1,
		CapturedAt:       time.Now(),
	}
	ack, err := service.AIUpdateWorkspaceSnapshot(snapshot)
	if err != nil {
		t.Fatalf("AIUpdateWorkspaceSnapshot: %v", err)
	}
	if !ack.Accepted || ack.ContentHash == "" {
		t.Fatalf("unexpected deferred snapshot ack: %+v", ack)
	}
	gets, puts, _ := store.accessCounts()
	if gets != 0 || puts != 0 {
		t.Fatalf("snapshot publication touched keyring: gets=%d puts=%d", gets, puts)
	}
	if _, statErr := os.Stat(filepath.Join(service.configDir, "agent_runs.sqlite")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("snapshot publication created agent ledger: %v", statErr)
	}
	if status := service.AIGetAgentLedgerStatus(); status.State != runharness.LedgerStatusUnavailable {
		t.Fatalf("ledger status after snapshot = %+v, want unavailable", status)
	}
	conflicting := snapshot
	conflicting.ActiveContext = map[string]any{"changed": true}
	if _, err := service.AIUpdateWorkspaceSnapshot(conflicting); !errors.Is(err, runharness.ErrSnapshotConflict) {
		t.Fatalf("same-revision snapshot error = %v, want ErrSnapshotConflict", err)
	}

	if _, err := service.AIReadAgentSession(runharness.SessionReadRequest{SessionID: "not-created"}); !errors.Is(err, runharness.ErrNotFound) {
		t.Fatalf("first Agent API error = %v, want ErrNotFound", err)
	}
	gets, puts, _ = store.accessCounts()
	if gets != 0 || puts != 0 {
		t.Fatalf("first Agent API accessed SecretStore: gets=%d puts=%d", gets, puts)
	}
	if _, statErr := os.Stat(filepath.Join(service.configDir, agentLedgerKeyFileName)); statErr != nil {
		t.Fatalf("first Agent API did not create local ledger key: %v", statErr)
	}
	if status := service.AIGetAgentLedgerStatus(); status.State != runharness.LedgerStatusReady {
		t.Fatalf("ledger status after Agent API = %+v, want ready", status)
	}
}

func TestServiceInitializationFlushesPendingWorkspaceSnapshotsBeforeExposure(t *testing.T) {
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = t.TempDir()
	service.agentContext = context.Background()
	t.Cleanup(service.Shutdown)

	pending := runharness.WorkspaceSnapshot{
		SourceKind:       runharness.WorkspaceDesktop,
		SourceID:         "desktop",
		SourceInstanceID: "startup-instance",
		Revision:         6,
		CapturedAt:       time.Now(),
	}
	if _, err := service.AIUpdateWorkspaceSnapshot(pending); err != nil {
		t.Fatalf("cache startup workspace snapshot: %v", err)
	}
	if err := service.initializeAgentHarness(service.agentContext); err != nil {
		t.Fatalf("initializeAgentHarness: %v", err)
	}

	newer := pending
	newer.Revision = 7
	newer.CapturedAt = time.Now()
	if _, err := service.AIUpdateWorkspaceSnapshot(newer); err != nil {
		t.Fatalf("persist snapshot after initialization: %v", err)
	}
	if _, err := service.AIReadAgentSession(runharness.SessionReadRequest{SessionID: "not-created"}); !errors.Is(err, runharness.ErrNotFound) {
		t.Fatalf("Agent API after workspace update = %v, want ErrNotFound without a snapshot conflict", err)
	}

	service.agentMu.RLock()
	ledger := service.agentLedger
	pendingCount := len(service.agentPendingWorkspaceSnapshots)
	service.agentMu.RUnlock()
	if ledger == nil {
		t.Fatal("expected initialized ledger")
	}
	if pendingCount != 0 {
		t.Fatalf("pending snapshots after initialization = %d, want 0", pendingCount)
	}
	stored, err := ledger.LatestWorkspaceSnapshot(context.Background(), newer.SourceID, newer.SourceInstanceID)
	if err != nil {
		t.Fatalf("read persisted workspace snapshot: %v", err)
	}
	if stored.Revision != newer.Revision {
		t.Fatalf("workspace snapshot revision = %d, want %d", stored.Revision, newer.Revision)
	}
}

func TestServiceSubmitRejectsUnconfiguredProviderBeforePersistingRun(t *testing.T) {
	service, _ := newInitializedAgentHarnessService(t)

	_, err := service.AISubmitAgentInput(runharness.AgentInputRequest{
		RequestID: "unconfigured-provider-request",
		Content:   "hello",
	})
	if err == nil || !strings.Contains(err.Error(), "Provider is not configured") {
		t.Fatalf("AISubmitAgentInput error = %v, want an unconfigured-provider error", err)
	}

	sessions, err := service.AIListAgentSessions(runharness.SessionListRequest{Limit: 10})
	if err != nil {
		t.Fatalf("AIListAgentSessions: %v", err)
	}
	if sessions.Total != 0 || len(sessions.Sessions) != 0 {
		t.Fatalf("unconfigured provider created durable sessions: %+v", sessions)
	}
}

func TestServiceAgentAPIsInitializeLedgerLazily(t *testing.T) {
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = t.TempDir()
	service.agentContext = context.Background()
	t.Cleanup(service.Shutdown)

	if service.agentHarnessInitialized {
		t.Fatal("agent harness initialized before an Agent API call")
	}
	if _, err := service.AIListAgentSessions(runharness.SessionListRequest{Limit: 1}); err != nil {
		t.Fatalf("AIListAgentSessions: %v", err)
	}
	if !service.agentHarnessInitialized || service.agentHarness == nil || service.agentLedger == nil {
		t.Fatal("Agent API call did not initialize the ledger")
	}
}

func TestServiceAgentHarnessUsesLocalKeyFileWithoutSecretStore(t *testing.T) {
	store := newAgentHarnessTestSecretStore()
	service := NewServiceWithSecretStore(store)
	service.configDir = t.TempDir()
	service.agentContext = context.Background()
	t.Cleanup(service.Shutdown)

	if err := service.initializeAgentHarness(service.agentContext); err != nil {
		t.Fatalf("initialize agent harness: %v", err)
	}
	gets, puts, healthChecks := store.accessCounts()
	if gets != 0 || puts != 0 || healthChecks != 0 {
		t.Fatalf("agent harness accessed SecretStore: gets=%d puts=%d healthChecks=%d", gets, puts, healthChecks)
	}
	keyInfo, err := os.Stat(filepath.Join(service.configDir, "agent_runs.key"))
	if err != nil {
		t.Fatalf("stat local ledger key: %v", err)
	}
	if runtime.GOOS != "windows" && keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("local ledger key permissions = %o, want 0600", keyInfo.Mode().Perm())
	}
}

func TestServiceAgentHarnessArchivesLegacyKeyringLedgerWithoutAccessingSecretStore(t *testing.T) {
	configDir := t.TempDir()
	ledgerPath := filepath.Join(configDir, "agent_runs.sqlite")
	legacyKey := make([]byte, 32)
	for index := range legacyKey {
		legacyKey[index] = byte(index + 1)
	}
	legacyLedger, err := runharness.Open(ledgerPath, runharness.WithKey(legacyKey))
	if err != nil {
		t.Fatalf("create legacy ledger: %v", err)
	}
	if err := legacyLedger.Close(); err != nil {
		t.Fatalf("close legacy ledger: %v", err)
	}

	store := newAgentHarnessTestSecretStore()
	keyRef, err := agentLedgerKeyRef(configDir)
	if err != nil {
		t.Fatalf("resolve legacy key ref: %v", err)
	}
	store.items[keyRef] = append([]byte(nil), legacyKey...)
	service := NewServiceWithSecretStore(store)
	service.configDir = configDir
	service.agentContext = context.Background()
	t.Cleanup(service.Shutdown)

	if err := service.initializeAgentHarness(service.agentContext); err != nil {
		t.Fatalf("initialize agent harness after keyring removal: %v", err)
	}
	gets, puts, healthChecks := store.accessCounts()
	if gets != 0 || puts != 0 || healthChecks != 0 {
		t.Fatalf("legacy archive accessed SecretStore: gets=%d puts=%d healthChecks=%d", gets, puts, healthChecks)
	}

	entries, err := os.ReadDir(configDir)
	if err != nil {
		t.Fatalf("read config directory: %v", err)
	}
	var archivedLedgerPath string
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), ".agent_runs.keyring-backup-") {
			archivedLedgerPath = filepath.Join(configDir, entry.Name(), "agent_runs.sqlite")
			break
		}
	}
	if archivedLedgerPath == "" {
		t.Fatal("legacy keyring ledger was not archived")
	}
	archivedLedger, err := runharness.Open(archivedLedgerPath, runharness.WithKey(legacyKey))
	if err != nil {
		t.Fatalf("archived legacy ledger is not recoverable with its original key: %v", err)
	}
	if err := archivedLedger.Close(); err != nil {
		t.Fatalf("close archived legacy ledger: %v", err)
	}
}

func TestServiceStartupDoesNotOpenAgentLedger(t *testing.T) {
	dataRoot := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", dataRoot)
	store := newAgentHarnessTestSecretStore()
	service := NewServiceWithSecretStore(store)
	t.Cleanup(service.Shutdown)

	service.startup(context.Background())
	if service.agentHarnessInitialized || service.agentHarness != nil || service.agentLedger != nil {
		t.Fatal("service startup initialized the Agent ledger")
	}
	gets, puts, healthChecks := store.accessCounts()
	if gets != 0 || puts != 0 || healthChecks != 0 {
		t.Fatalf("service startup accessed SecretStore: gets=%d puts=%d healthChecks=%d", gets, puts, healthChecks)
	}
}

func TestServiceAgentLedgerStatusDoesNotProbeSecretStore(t *testing.T) {
	store := newAgentHarnessTestSecretStore()
	service := NewServiceWithSecretStore(store)
	if status := service.AIGetAgentLedgerStatus(); status.State != runharness.LedgerStatusUnavailable {
		t.Fatalf("uninitialized ledger status = %+v", status)
	}
	gets, puts, healthChecks := store.accessCounts()
	if gets != 0 || puts != 0 || healthChecks != 0 {
		t.Fatalf("ledger status accessed SecretStore: gets=%d puts=%d healthChecks=%d", gets, puts, healthChecks)
	}
}

func TestServiceSubmitBindsActiveProviderToDurableRun(t *testing.T) {
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = t.TempDir()
	base := ai.ProviderConfig{
		ID: "provider-a", Type: "custom", APIFormat: "openai", Name: "Frozen Provider",
		APIKey: "key-v1", BaseURL: "http://127.0.0.1:1/v1", Model: "provider-model",
		Headers: map[string]string{"Authorization": "Bearer header-v1", "X-Revision": "one"},
	}
	service.providers = []ai.ProviderConfig{base}
	service.activeProvider = "provider-a"
	service.agentContext = context.Background()
	if err := service.initializeAgentHarness(service.agentContext); err != nil {
		t.Fatalf("initializeAgentHarness: %v", err)
	}
	t.Cleanup(service.Shutdown)

	temperature := 0.42
	maxTokens := 4096
	receipt, err := service.AISubmitAgentInput(runharness.AgentInputRequest{
		RequestID:   "provider-binding-request",
		Content:     "hello",
		Model:       "request-model",
		Thinking:    "high",
		Temperature: &temperature,
		MaxTokens:   &maxTokens,
	})
	if err != nil {
		t.Fatalf("AISubmitAgentInput: %v", err)
	}
	read, err := service.AIReadAgentRun(runharness.RunReadRequest{RunID: receipt.RunID})
	if err != nil {
		t.Fatalf("AIReadAgentRun: %v", err)
	}
	if read.Run.Provider != "provider-a" {
		t.Fatalf("durable run provider = %q, want provider-a", read.Run.Provider)
	}
	binding, err := service.agentLedger.GetProviderBinding(context.Background(), receipt.RunID)
	if err != nil {
		t.Fatalf("get durable provider binding: %v", err)
	}
	var frozen ai.ProviderConfig
	if err := json.Unmarshal(binding.Config, &frozen); err != nil {
		t.Fatalf("decode durable provider binding: %v", err)
	}
	if frozen.APIKey != base.APIKey || frozen.Headers["Authorization"] != base.Headers["Authorization"] || frozen.Headers["X-Revision"] != "one" {
		t.Fatalf("durable binding did not retain resolved secrets and headers: %#v", frozen)
	}
	if frozen.Model != "request-model" || frozen.ThinkingIntensity != "high" || frozen.Temperature != temperature || frozen.MaxTokens != maxTokens {
		t.Fatalf("durable binding did not retain request overrides: %#v", frozen)
	}

	changed := base
	changed.Name = "Changed Provider"
	changed.APIKey = "key-v2"
	changed.BaseURL = "http://127.0.0.1:2/v1"
	changed.Headers = map[string]string{"Authorization": "Bearer header-v2", "X-Revision": "two"}
	service.mu.Lock()
	service.providers[0] = changed
	service.mu.Unlock()
	resolved, err := service.resolveAgentProvider(context.Background(), runharness.ModelTurnRequest{
		RunID: receipt.RunID, Provider: binding.ProviderID, ProviderBinding: &binding,
	})
	if err != nil {
		t.Fatalf("resolve frozen provider after settings edit: %v", err)
	}
	if resolved.Name() != base.Name {
		t.Fatalf("resolved provider name = %q, want frozen %q", resolved.Name(), base.Name)
	}
}

func TestServiceAgentWailsMethodsRequireLifecycleContext(t *testing.T) {
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = t.TempDir()

	_, err := service.AISubmitAgentInput(runharness.AgentInputRequest{
		RequestID: "missing-lifecycle",
		Content:   "hello",
	})
	if !errors.Is(err, ErrAgentLifecycleUnavailable) {
		t.Fatalf("AISubmitAgentInput error = %v, want ErrAgentLifecycleUnavailable", err)
	}
	if _, statErr := os.Stat(filepath.Join(service.configDir, "agent_runs.sqlite")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("agent ledger was created without lifecycle context: %v", statErr)
	}
}

func TestServiceAgentLedgerStatusIsNonSensitive(t *testing.T) {
	readyService, _ := newInitializedAgentHarnessService(t)
	if status := readyService.AIGetAgentLedgerStatus(); status.State != runharness.LedgerStatusReady || status.Message != "" {
		t.Fatalf("ready ledger status = %+v", status)
	}

	localOnlyService := NewServiceWithSecretStore(secretstore.NewUnavailableStore("test keyring unavailable"))
	localOnlyService.configDir = t.TempDir()
	localOnlyService.agentContext = context.Background()
	if err := localOnlyService.initializeAgentHarness(localOnlyService.agentContext); err != nil {
		t.Fatalf("initializeAgentHarness should not require an unavailable keyring: %v", err)
	}
	t.Cleanup(localOnlyService.Shutdown)
	if status := localOnlyService.AIGetAgentLedgerStatus(); status.State != runharness.LedgerStatusReady || status.Message != "" {
		t.Fatalf("local-only ledger status = %+v", status)
	}

	unavailableService := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	if status := unavailableService.AIGetAgentLedgerStatus(); status.State != runharness.LedgerStatusUnavailable || status.Message != "" {
		t.Fatalf("unavailable ledger status = %+v", status)
	}
}

func TestServiceExposesOnlyAgentRunHarnessChatBoundary(t *testing.T) {
	serviceType := reflect.TypeOf((*Service)(nil))

	for _, method := range []string{
		"AISubmitAgentInput",
		"AIControlAgentRun",
		"AIReadAgentRun",
		"AIListAgentSessions",
		"AIReadAgentSession",
		"AIMutateAgentSession",
		"AIUpdateWorkspaceSnapshot",
		"AIGetAgentLedgerStatus",
		"AIGetRunPolicy",
		"AISaveRunPolicy",
	} {
		if _, ok := serviceType.MethodByName(method); !ok {
			t.Fatalf("new agent harness method %s is not exposed", method)
		}
	}

	for _, method := range []string{
		"AIChatSend",
		"AIChatSendWithOptions",
		"AIChatSendInSession",
		"AIChatStream",
		"AIChatStreamWithOptions",
		"AIChatCancel",
		"AIChatCancelAndWait",
		"AIChatCancelAllAndWait",
		"AIGetSessions",
		"AILoadSession",
		"AISaveSession",
		"AIDeleteSession",
		"ShutdownWithContext",
	} {
		if _, ok := serviceType.MethodByName(method); ok {
			t.Fatalf("legacy AI chat method %s must not be exposed", method)
		}
	}
}

func TestServiceShutdownWithContextClosesLedgerAfterMCP(t *testing.T) {
	originalStarter := startMCPHTTPProcess
	originalHealth := waitMCPHTTPHealth
	t.Cleanup(func() {
		startMCPHTTPProcess = originalStarter
		waitMCPHTTPHealth = originalHealth
	})

	service, _ := newInitializedAgentHarnessService(t)
	service.agentMu.RLock()
	ledger := service.agentLedger
	service.agentMu.RUnlock()
	if ledger == nil {
		t.Fatal("expected initialized agent ledger")
	}

	process := &ledgerObservingMCPHTTPProcess{
		fakeMCPHTTPProcess: newFakeMCPHTTPProcess(),
		ledger:             ledger,
	}
	startMCPHTTPProcess = func(_ context.Context, _ mcpHTTPProcessStartOptions, _ mcpHTTPTextLookup) (mcpHTTPProcess, error) {
		return process, nil
	}
	waitMCPHTTPHealth = func(_ context.Context, _ string, _ mcpHTTPTextLookup) error {
		return nil
	}
	if _, err := service.AIStartMCPHTTPServer(ai.MCPHTTPServerOptions{Addr: "127.0.0.1:0", Path: "/mcp"}); err != nil {
		t.Fatalf("AIStartMCPHTTPServer: %v", err)
	}

	ShutdownWithContext(service, context.Background())
	if !process.ledgerAvailableDuringStop {
		t.Fatal("MCP stopped after the agent ledger was closed")
	}
	if _, err := ledger.ListSessions(context.Background(), runharness.SessionListRequest{}); !errors.Is(err, runharness.ErrClosed) {
		t.Fatalf("ledger error after shutdown = %v, want ErrClosed", err)
	}
	if _, err := service.AIListAgentSessions(runharness.SessionListRequest{}); !errors.Is(err, runharness.ErrHarnessClosed) {
		t.Fatalf("agent call after shutdown = %v, want ErrHarnessClosed", err)
	}
}

func TestServiceAgentPolicyRejectsInvalidValues(t *testing.T) {
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = t.TempDir()
	_, err := service.AISaveRunPolicy(runharness.RunPolicyMutationRequest{
		ExpectedRevision: 1,
		Policy:           runharness.RunPolicy{SoftToolRoundLimit: -1},
	})
	if err == nil {
		t.Fatal("AISaveRunPolicy accepted a negative limit")
	}
	if errors.Is(err, runharness.ErrHarnessClosed) {
		t.Fatal("policy validation should not report a closed harness")
	}
}

func TestServiceAgentPolicyRejectsShutdownWithoutChangingFile(t *testing.T) {
	service, _ := newInitializedAgentHarnessService(t)
	initial, err := service.AIGetRunPolicy()
	if err != nil {
		t.Fatalf("AIGetRunPolicy: %v", err)
	}
	ShutdownWithContext(service, context.Background())

	_, err = service.AISaveRunPolicy(runharness.RunPolicyMutationRequest{
		ExpectedRevision: initial.Revision,
		Policy:           runharness.RunPolicy{SoftToolRoundLimit: 2, MaxToolRounds: 4},
	})
	if !errors.Is(err, runharness.ErrHarnessClosed) {
		t.Fatalf("shutdown policy save error = %v, want ErrHarnessClosed", err)
	}
	loaded, err := service.AIGetRunPolicy()
	if err != nil {
		t.Fatalf("AIGetRunPolicy after rejected save: %v", err)
	}
	if loaded != initial {
		t.Fatalf("shutdown policy save changed durable policy: before=%+v after=%+v", initial, loaded)
	}
}

func TestServiceAgentPolicyLiveUpdateFailureRollsBackDurableFile(t *testing.T) {
	service, _ := newInitializedAgentHarnessService(t)
	initial, err := service.AIGetRunPolicy()
	if err != nil {
		t.Fatalf("AIGetRunPolicy: %v", err)
	}
	service.agentMu.RLock()
	harness := service.agentHarness
	service.agentMu.RUnlock()
	if harness == nil {
		t.Fatal("expected initialized harness")
	}
	// Simulate a close that races after the service has acquired its pointer but
	// before the live runtime setter. AISaveRunPolicy must restore the file when
	// SetRuntimeConfig rejects the update. Deliberately close the Harness
	// directly so the Service has not yet detached its pointer.
	if err := harness.Close(); err != nil {
		t.Fatalf("close harness: %v", err)
	}
	_, err = service.AISaveRunPolicy(runharness.RunPolicyMutationRequest{
		ExpectedRevision: initial.Revision,
		Policy:           runharness.RunPolicy{SoftToolRoundLimit: 2, MaxToolRounds: 4},
	})
	if !errors.Is(err, runharness.ErrHarnessClosed) {
		t.Fatalf("live policy update error = %v, want ErrHarnessClosed", err)
	}
	loaded, err := service.AIGetRunPolicy()
	if err != nil {
		t.Fatalf("AIGetRunPolicy after rollback: %v", err)
	}
	if loaded != initial {
		t.Fatalf("failed live update changed durable policy: before=%+v after=%+v", initial, loaded)
	}
}

func TestServiceAgentPolicyWriteWaitsForCrossProcessLock(t *testing.T) {
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = t.TempDir()
	policyPath := service.agentPolicyPath()
	if err := os.MkdirAll(filepath.Dir(policyPath), 0o700); err != nil {
		t.Fatalf("create policy directory: %v", err)
	}
	lock, err := appdata.AcquireFileLock(policyPath + ".lock")
	if err != nil {
		t.Fatalf("acquire policy lock: %v", err)
	}

	finished := make(chan error, 1)
	go func() {
		_, saveErr := service.AISaveRunPolicy(runharness.RunPolicyMutationRequest{
			ExpectedRevision: 1,
			Policy:           runharness.RunPolicy{SoftToolRoundLimit: 2, MaxToolRounds: 4},
		})
		finished <- saveErr
	}()
	select {
	case saveErr := <-finished:
		t.Fatalf("policy save acquired cross-process lock before release: %v", saveErr)
	case <-time.After(50 * time.Millisecond):
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("release policy lock: %v", err)
	}
	select {
	case saveErr := <-finished:
		if saveErr != nil {
			t.Fatalf("policy save after lock release: %v", saveErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("policy save did not acquire cross-process lock after release")
	}
}

func TestServiceAgentPolicyConcurrentServicesUseRevisionCAS(t *testing.T) {
	configDir := t.TempDir()
	first := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	second := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	first.configDir = configDir
	second.configDir = configDir

	start := make(chan struct{})
	type result struct {
		policy runharness.RunPolicySnapshot
		err    error
	}
	results := make(chan result, 2)
	for _, service := range []*Service{first, second} {
		service := service
		go func() {
			<-start
			policy, saveErr := service.AISaveRunPolicy(runharness.RunPolicyMutationRequest{
				ExpectedRevision: 1,
				Policy:           runharness.RunPolicy{SoftToolRoundLimit: 2, MaxToolRounds: 4},
			})
			results <- result{policy: policy, err: saveErr}
		}()
	}
	close(start)
	left := <-results
	right := <-results

	successes := 0
	conflicts := 0
	for _, item := range []result{left, right} {
		if item.err == nil {
			successes++
			if item.policy.Revision != 2 {
				t.Fatalf("successful policy revision = %d, want 2", item.policy.Revision)
			}
			continue
		}
		if errors.Is(item.err, runharness.ErrRevisionConflict) && strings.Contains(item.err.Error(), "revision_conflict") {
			conflicts++
			continue
		}
		t.Fatalf("unexpected concurrent policy save error: %v", item.err)
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent policy results: successes=%d conflicts=%d", successes, conflicts)
	}
}

func TestResolveAgentImagePromptsUsesCurrentLanguage(t *testing.T) {
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.AISetLanguage("zh-CN")
	prompts, err := service.resolveAgentImagePrompts(context.Background(), runharness.ModelTurnRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if prompts.FallbackPrompt != "请描述和分析这张图片。" {
		t.Fatalf("fallback prompt = %q", prompts.FallbackPrompt)
	}
	if prompts.OmittedNotice != "[图片已省略：当前模型或上游接口不支持图片输入。请切换到支持视觉的模型后重新发送图片。]" {
		t.Fatalf("omitted notice = %q", prompts.OmittedNotice)
	}
}

func TestLoadServiceRunPolicyRejectsMalformedWrapper(t *testing.T) {
	path := filepath.Join(t.TempDir(), agentRunPolicyFileName)
	if err := os.WriteFile(path, []byte(`{"policy":"broken","maxToolRounds":4}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadServiceRunPolicy(path); err == nil {
		t.Fatal("loadServiceRunPolicy accepted a malformed policy wrapper")
	}
}

func TestLoadServiceRunPolicyRejectsNullDocument(t *testing.T) {
	path := filepath.Join(t.TempDir(), agentRunPolicyFileName)
	if err := os.WriteFile(path, []byte(`null`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadServiceRunPolicy(path); err == nil {
		t.Fatal("loadServiceRunPolicy accepted a null document")
	}
}
