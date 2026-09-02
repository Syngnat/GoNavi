package runharness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestProviderBindingRoundTripIsEncryptedAndDetached(t *testing.T) {
	ledger := testLedger(t)
	const secret = "provider-api-key-must-not-be-plaintext"
	binding, err := NewProviderBinding(" provider-a ", map[string]any{
		"id": "provider-a", "apiKey": secret, "headers": map[string]string{"X-Secret": "header-secret"},
	})
	if err != nil {
		t.Fatalf("new provider binding: %v", err)
	}
	run, err := ledger.CreateRun(context.Background(), CreateRunRequest{
		SessionID: "provider-binding-session", RequestID: "provider-binding-request",
		Policy: DefaultRunPolicy(), Provider: " provider-a ", ProviderBinding: &binding,
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if run.Provider != "provider-a" {
		t.Fatalf("run provider = %q, want canonical provider-a", run.Provider)
	}
	if snapshotJSON, err := json.Marshal(run); err != nil {
		t.Fatalf("marshal run snapshot: %v", err)
	} else if bytes.Contains(snapshotJSON, []byte(secret)) {
		t.Fatalf("run snapshot leaked provider secret: %s", snapshotJSON)
	}

	var raw []byte
	if err := ledger.db.QueryRow(`SELECT provider_binding FROM runs WHERE id=?`, run.ID).Scan(&raw); err != nil {
		t.Fatalf("read raw provider binding: %v", err)
	}
	if bytes.Contains(raw, []byte(secret)) || bytes.Contains(raw, []byte("header-secret")) {
		t.Fatalf("encrypted provider binding contains plaintext secret: %q", raw)
	}

	got, err := ledger.GetProviderBinding(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("get provider binding: %v", err)
	}
	if got.ProviderID != "provider-a" || !bytes.Contains(got.Config, []byte(secret)) {
		t.Fatalf("provider binding = %#v, want resolved provider config", got)
	}
	got.Config[0] = '['
	again, err := ledger.GetProviderBinding(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("get provider binding after mutation: %v", err)
	}
	if again.Config[0] == '[' {
		t.Fatal("ledger returned mutable provider binding storage")
	}
}

func TestAgentInputProviderBindingIsHostOnlyAndDetached(t *testing.T) {
	const secret = "host-only-provider-secret"
	binding, err := NewProviderBinding("provider-a", map[string]string{"id": "provider-a", "apiKey": secret})
	if err != nil {
		t.Fatalf("new provider binding: %v", err)
	}
	input := AgentInputRequest{RequestID: "host-only-binding", Content: "hello"}
	if err := input.SetProviderBinding(binding); err != nil {
		t.Fatalf("set provider binding: %v", err)
	}
	if input.Provider != binding.ProviderID || !input.HasProviderBinding() {
		t.Fatalf("input binding state = %#v, want bound provider %q", input, binding.ProviderID)
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("marshal agent input: %v", err)
	}
	if bytes.Contains(encoded, []byte(secret)) || bytes.Contains(encoded, []byte("providerBinding")) {
		t.Fatalf("agent input JSON leaked provider binding: %s", encoded)
	}
	copy, ok := input.ProviderBindingForHost()
	if !ok || !bytes.Contains(copy.Config, []byte(secret)) {
		t.Fatalf("host binding = %#v, want detached secret-bearing copy", copy)
	}
	copy.Config[0] = '['
	again, ok := input.ProviderBindingForHost()
	if !ok || again.Config[0] == '[' {
		t.Fatal("host provider binding was not detached")
	}
}

func TestProviderBindingFailsClosedForMissingOrMismatchedProvider(t *testing.T) {
	ledger := testLedger(t)
	binding, err := NewProviderBinding("provider-a", map[string]string{"id": "provider-a"})
	if err != nil {
		t.Fatalf("new provider binding: %v", err)
	}

	for _, test := range []struct {
		name    string
		request CreateRunRequest
		want    error
	}{
		{
			name:    "provider without binding",
			request: CreateRunRequest{SessionID: "provider-unbound", RequestID: "provider-unbound", Policy: DefaultRunPolicy(), Provider: "provider-a"},
			want:    ErrProviderBindingUnbound,
		},
		{
			name:    "binding without provider",
			request: CreateRunRequest{SessionID: "binding-unbound", RequestID: "binding-unbound", Policy: DefaultRunPolicy(), ProviderBinding: &binding},
			want:    ErrProviderBindingUnbound,
		},
		{
			name:    "mismatched provider",
			request: CreateRunRequest{SessionID: "provider-mismatch", RequestID: "provider-mismatch", Policy: DefaultRunPolicy(), Provider: "provider-b", ProviderBinding: &binding},
			want:    ErrProviderBindingCorrupt,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := ledger.CreateRun(context.Background(), test.request)
			if !errors.Is(err, test.want) {
				t.Fatalf("create run error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestProviderBindingRejectsBlankIndexedProvider(t *testing.T) {
	ledger := testLedger(t)
	binding, err := NewProviderBinding("provider-a", map[string]string{"id": "provider-a"})
	if err != nil {
		t.Fatalf("new provider binding: %v", err)
	}
	run, err := ledger.CreateRun(context.Background(), CreateRunRequest{
		SessionID: "provider-index-tamper", RequestID: "provider-index-tamper", Policy: DefaultRunPolicy(),
		Provider: "provider-a", ProviderBinding: &binding,
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if _, err := ledger.db.Exec(`UPDATE runs SET provider='' WHERE id=?`, run.ID); err != nil {
		t.Fatalf("tamper indexed provider: %v", err)
	}
	if _, err := ledger.GetProviderBinding(context.Background(), run.ID); !errors.Is(err, ErrProviderBindingCorrupt) {
		t.Fatalf("blank indexed provider error = %v, want %v", err, ErrProviderBindingCorrupt)
	}
}

type providerBindingCaptureModel struct {
	requests chan ModelTurnRequest
}

func (m *providerBindingCaptureModel) Execute(_ context.Context, request ModelTurnRequest, _ ModelDeltaSink) (ModelTurnResult, error) {
	copy := request
	copy.ProviderBinding = cloneProviderBinding(request.ProviderBinding)
	m.requests <- copy
	return ModelTurnResult{Completed: true}, nil
}

func TestHarnessPassesStoredProviderBindingToModel(t *testing.T) {
	model := &providerBindingCaptureModel{requests: make(chan ModelTurnRequest, 1)}
	harness, _ := newContractHarness(t, model, nil, nil)
	binding, err := NewProviderBinding("provider-a", map[string]string{"id": "provider-a", "apiKey": "secret"})
	if err != nil {
		t.Fatalf("new provider binding: %v", err)
	}
	input := AgentInputRequest{RequestID: "provider-model-request", Content: "hello"}
	if err := input.SetProviderBinding(binding); err != nil {
		t.Fatalf("set provider binding: %v", err)
	}
	receipt, err := harness.SubmitInput(context.Background(), input)
	if err != nil {
		t.Fatalf("submit input: %v", err)
	}
	select {
	case request := <-model.requests:
		if request.ProviderBinding == nil || request.ProviderBinding.ProviderID != binding.ProviderID || !bytes.Contains(request.ProviderBinding.Config, []byte("secret")) {
			t.Fatalf("model provider binding = %#v, want stored binding", request.ProviderBinding)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("model was not called")
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if snapshotJSON, err := json.Marshal(read.Run); err != nil {
		t.Fatalf("marshal run projection: %v", err)
	} else if bytes.Contains(snapshotJSON, []byte("secret")) {
		t.Fatalf("run projection leaked provider binding: %s", snapshotJSON)
	}
}
