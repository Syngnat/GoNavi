package aiservice

import (
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
)

// The window a preview measures against is the one a run for the same input would freeze.
func TestPreviewUsesTheWindowAndOutputCapARunWouldFreeze(t *testing.T) {
	service, _ := newInitializedAgentHarnessService(t)
	service.providers = []ai.ProviderConfig{{
		ID: "provider-a", Type: "openai", Name: "Provider", APIKey: "key",
		BaseURL: "http://127.0.0.1:1/v1", Model: "gpt-5", ContextWindow: 500_000, MaxTokens: 4_000,
	}}
	service.activeProvider = "provider-a"

	preview, err := service.AIPreviewAgentContext(runharness.AgentInputRequest{Content: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if preview.WindowTokens != 500_000 || preview.ReservedOutputTokens != 4_000 || preview.UserBytes == 0 {
		t.Fatalf("preview = %+v", preview)
	}
	// Another model does not inherit the chosen tier; the model's own window applies (and a run does not trim).
	other, err := service.AIPreviewAgentContext(runharness.AgentInputRequest{Content: "hello", Model: "gpt-4o"})
	if err != nil || other.WindowTokens != 0 {
		t.Fatalf("other model: %+v %v", other, err)
	}
	// What a run would refuse, a preview refuses too.
	if _, err := service.AIPreviewAgentContext(runharness.AgentInputRequest{Content: "hello", Provider: "nobody"}); err == nil {
		t.Fatal("an unknown provider cannot be previewed")
	}
}
