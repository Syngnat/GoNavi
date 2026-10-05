package aiservice

import (
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
)

// The hosted SQL model reads text only. The agent has to know before it builds a
// request, so the built-in provider says so in the configuration that is frozen
// with every run; any other provider says nothing and keeps receiving images.
func TestBuiltinProviderDeclaresItCannotSeeImages(t *testing.T) {
	for name, cfg := range map[string]ai.ProviderConfig{
		"completed": completeBuiltinAIProvider(ai.ProviderConfig{}),
		"pinned":    pinBuiltinAIContextLimits(ai.ProviderConfig{ID: builtinAIProviderID, SupportsImages: nil}),
	} {
		if cfg.SupportsImages == nil || *cfg.SupportsImages {
			t.Errorf("%s: SupportsImages = %v, want false", name, cfg.SupportsImages)
		}
		raw, err := json.Marshal(cfg)
		if err != nil || !strings.Contains(string(raw), `"supportsImages":false`) {
			t.Errorf("%s: the declaration must be part of the frozen configuration: %s (%v)", name, raw, err)
		}
	}
}

func TestOtherProvidersDoNotDeclareAnythingAboutImages(t *testing.T) {
	raw, err := json.Marshal(ai.ProviderConfig{ID: "openai-main", Type: "openai", Model: "gpt-4o"})
	if err != nil || strings.Contains(string(raw), "supportsImages") {
		t.Fatalf("a provider without a declaration must not carry one: %s (%v)", raw, err)
	}
}

// A user cannot give the hosted model eyes by editing the stored record.
func TestStoredBuiltinRecordCannotClaimImageSupport(t *testing.T) {
	yes := true
	cfg := completeBuiltinAIProvider(ai.ProviderConfig{SupportsImages: &yes})
	if cfg.SupportsImages == nil || *cfg.SupportsImages {
		t.Fatalf("SupportsImages = %v, want false whatever was stored", cfg.SupportsImages)
	}
}
