package ai

import (
	"reflect"
	"testing"
)

// unknownContextProfile 是识别不出模型时的通用档位。
func unknownContextProfile() ModelContextProfile {
	return ModelContextProfile{DefaultWindow: UnknownModelContextWindow, Options: []int{
		128_000, 200_000, UnknownModelContextWindow, 500_000, 1_000_000, 2_000_000,
	}}
}

func TestResolveModelContextProfile(t *testing.T) {
	tests := []struct {
		name  string
		model string
		want  ModelContextProfile
	}{
		{"gpt-5 family is adjustable", "gpt-5.6-sol", ModelContextProfile{DefaultWindow: 1_000_000, Options: []int{500_000, 1_000_000}}},
		{"gpt-4o fixed", "gpt-4o-mini", ModelContextProfile{DefaultWindow: 128_000, Options: []int{128_000}}},
		{"gpt-4.1 has 1M", "gpt-4.1", ModelContextProfile{DefaultWindow: 1_000_000, Options: []int{1_000_000}}},
		{"o-series by prefix", "o3-mini", ModelContextProfile{DefaultWindow: 200_000, Options: []int{200_000}}},
		{"o-series ignores substrings", "kimi-k2-o1x", unknownContextProfile()},
		{"claude sonnet 4 adjustable", "claude-sonnet-4-5", ModelContextProfile{DefaultWindow: 200_000, Options: []int{200_000, 1_000_000}}},
		{"claude older fixed", "claude-3-5-haiku", ModelContextProfile{DefaultWindow: 200_000, Options: []int{200_000}}},
		{"gemini 1.5 pro 2M", "gemini-1.5-pro-002", ModelContextProfile{DefaultWindow: 2_000_000, Options: []int{2_000_000}}},
		{"gemini 1M", "gemini-2.5-pro", ModelContextProfile{DefaultWindow: 1_000_000, Options: []int{1_000_000}}},
		{"deepseek v4", "deepseek-v4-pro", ModelContextProfile{DefaultWindow: 1_000_000, Options: []int{1_000_000}}},
		{"deepseek generic", "deepseek-chat", ModelContextProfile{DefaultWindow: 128_000, Options: []int{128_000}}},
		{"provider prefix is tolerated", "openrouter/o3-mini", ModelContextProfile{DefaultWindow: 200_000, Options: []int{200_000}}},
		{"case insensitive", "  GPT-5  ", ModelContextProfile{DefaultWindow: 1_000_000, Options: []int{500_000, 1_000_000}}},
		{"unknown", "my-private-model", unknownContextProfile()},
		{"empty", "", unknownContextProfile()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ResolveModelContextProfile(test.model); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("ResolveModelContextProfile(%q) = %+v, want %+v", test.model, got, test.want)
			}
		})
	}
}

func TestResolveModelContextProfileReturnsIndependentOptions(t *testing.T) {
	first := ResolveModelContextProfile("gpt-5")
	first.Options[0] = 1
	if second := ResolveModelContextProfile("gpt-5"); second.Options[0] != 500_000 {
		t.Fatalf("rule table was mutated through a returned profile: %+v", second)
	}
}

func TestModelContextProfileNormalizeWindow(t *testing.T) {
	profile := ResolveModelContextProfile("gpt-5")
	tests := []struct {
		name string
		in   int
		want int
	}{
		{"selectable smaller tier is kept", 500_000, 500_000},
		{"default tier means follow the model", 1_000_000, 0},
		{"unknown tier is dropped", 300_000, 0},
		{"zero stays zero", 0, 0},
		{"negative is dropped", -5, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := profile.NormalizeWindow(test.in); got != test.want {
				t.Fatalf("NormalizeWindow(%d) = %d, want %d", test.in, got, test.want)
			}
		})
	}
	fixed := ResolveModelContextProfile("gpt-4o")
	if got := fixed.NormalizeWindow(500_000); got != 0 {
		t.Fatalf("a tier outside the model's options must be dropped, got %d", got)
	}
}
