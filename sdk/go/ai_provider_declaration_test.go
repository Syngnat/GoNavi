package plugin

import "testing"

func TestValidateAIProviderRejectsImages(t *testing.T) {
	provider := AIProvider{ID: "chat", Name: "Chat", Command: "generate", SupportsTools: true, Models: []AIModel{{ID: "model", Name: "Model", ContextWindow: 4096, MaxOutputTokens: 512}}}
	if err := ValidateAIProvider(provider); err != nil {
		t.Fatal(err)
	}
	provider.SupportsImages = true
	if err := ValidateAIProvider(provider); err == nil {
		t.Fatal("images were accepted")
	}
	provider.SupportsImages = false
	provider.Models[0].MaxOutputTokens = 9000
	provider.Models[0].ContextWindow = 1024
	if err := ValidateAIProvider(provider); err == nil {
		t.Fatal("output above the context window was accepted")
	}
}

func TestValidateAIProviderIcon(t *testing.T) {
	provider := AIProvider{ID: "chat", Name: "Chat", Command: "generate", SupportsTools: true, Icon: "icons/provider.PNG",
		Models: []AIModel{{ID: "model", Name: "Model", ContextWindow: 4096, MaxOutputTokens: 512}}}
	if err := ValidateAIProvider(provider); err != nil {
		t.Fatalf("valid icon rejected: %v", err)
	}
	for _, icon := range []string{"icons/provider.svg", "/icons/provider.png", "../provider.png", "icons\\provider.png"} {
		provider.Icon = icon
		if err := ValidateAIProvider(provider); err == nil {
			t.Fatalf("invalid icon accepted: %s", icon)
		}
	}
}
