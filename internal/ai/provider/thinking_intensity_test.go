package provider

import (
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestNormalizeThinkingIntensityKeepsProviderNativeLevels(t *testing.T) {
	cases := map[string]ai.ThinkingIntensity{
		"":        "",
		"auto":    "",
		"off":     ai.ThinkingIntensityOff,
		"none":    ai.ThinkingIntensity("none"),
		"minimal": ai.ThinkingIntensity("minimal"),
		"low":     ai.ThinkingIntensityLow,
		"MEDIUM":  ai.ThinkingIntensityMedium,
		"high":    ai.ThinkingIntensityHigh,
		"xhigh":   ai.ThinkingIntensity("xhigh"),
		"max":     ai.ThinkingIntensity("max"),
	}
	for input, want := range cases {
		if got := NormalizeThinkingIntensity(input); got != want {
			t.Fatalf("NormalizeThinkingIntensity(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestResolveThinkingProfile(t *testing.T) {
	if got := ResolveThinkingProfile("openai", "", "https://api.openai.com/v1", "gpt-5.2"); got != ThinkingProfileOpenAI {
		t.Fatalf("expected openai profile, got %q", got)
	}
	if got := ResolveThinkingProfile("custom", "anthropic", "https://api.deepseek.com", "deepseek-chat"); got != ThinkingProfileDeepSeek {
		t.Fatalf("expected deepseek profile, got %q", got)
	}
	if got := ResolveThinkingProfile("anthropic", "", "https://api.anthropic.com", "claude-opus-4"); got != ThinkingProfileAnthropic {
		t.Fatalf("expected anthropic profile, got %q", got)
	}
	if got := ResolveThinkingProfile("gemini", "", "https://generativelanguage.googleapis.com", "gemini-3-flash"); got != ThinkingProfileGemini {
		t.Fatalf("expected gemini profile, got %q", got)
	}
	for _, model := range []string{"glm-4-plus", "z-ai/glm-5.3-free"} {
		if got := ResolveThinkingProfile("openai", "openai-responses", "https://api.example.com/v1", model); got != ThinkingProfileOpenAI {
			t.Fatalf("expected OpenAI profile for Responses-routed %q, got %q", model, got)
		}
	}
}

func TestOpenAIAndAnthropicEffortMapping(t *testing.T) {
	if openAIReasoningEffort(ai.ThinkingIntensity("xhigh")) != "xhigh" {
		t.Fatal("expected openai xhigh")
	}
	if openAIReasoningEffort(ai.ThinkingIntensity("none")) != "none" {
		t.Fatal("expected openai none")
	}
	if anthropicOutputEffort(ai.ThinkingIntensity("max")) != "max" {
		t.Fatal("expected anthropic max effort")
	}
	if anthropicOutputEffort(ai.ThinkingIntensity("xhigh")) != "xhigh" {
		t.Fatal("expected anthropic xhigh effort")
	}
}

func TestClampThinkingIntensityAcrossProfiles(t *testing.T) {
	if got := clampThinkingIntensityToProfile("xhigh", ThinkingProfileDeepSeek); got != ai.ThinkingIntensityHigh {
		t.Fatalf("deepseek should clamp xhigh to high, got %q", got)
	}
	if got := clampThinkingIntensityToProfile("off", ThinkingProfileOpenAI); got != ai.ThinkingIntensity("none") {
		t.Fatalf("openai should map off to none, got %q", got)
	}
	if got := clampThinkingIntensityToProfile("max", ThinkingProfileOpenAI); got != ai.ThinkingIntensity("xhigh") {
		t.Fatalf("openai should map max to xhigh, got %q", got)
	}
}
