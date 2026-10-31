package plugin

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func aiProviderManifest() Manifest {
	m := basicManifest("example.ai")
	m.Permissions = []string{"ai.providers"}
	m.Backend = &Backend{Default: &Entry{Executable: "plugin", Runtime: "native"}}
	m.Contributes.Commands = []Command{{ID: "generate", Title: "Generate"}, {ID: "ordinary", Title: "Ordinary"}}
	m.Contributes.AIProviders = []AIProvider{{ID: "first", Name: "First", Command: "generate", Models: []AIModel{{ID: "model/A:1+v@x", Name: "Model", ContextWindow: 4096, MaxOutputTokens: 512}}, SupportsTools: true}}
	return m
}

func TestAIProviderDeclarationValidation(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Manifest)
	}{
		{"permission", func(m *Manifest) { m.Permissions = nil }},
		{"permission case", func(m *Manifest) { m.Permissions = []string{"AI.Providers"} }},
		{"backend", func(m *Manifest) { m.Backend = nil; m.Contributes.Commands = nil }},
		{"command", func(m *Manifest) { m.Contributes.AIProviders[0].Command = "missing" }},
		{"provider id", func(m *Manifest) { m.Contributes.AIProviders[0].ID = "First" }},
		{"duplicate provider", func(m *Manifest) {
			m.Contributes.AIProviders = append(m.Contributes.AIProviders, m.Contributes.AIProviders[0])
		}},
		{"name utf8", func(m *Manifest) { m.Contributes.AIProviders[0].Name = string([]byte{0xff}) }},
		{"icon svg", func(m *Manifest) { m.Contributes.AIProviders[0].Icon = "icons/provider.svg" }},
		{"icon absolute", func(m *Manifest) { m.Contributes.AIProviders[0].Icon = "/icons/provider.png" }},
		{"icon traversal", func(m *Manifest) { m.Contributes.AIProviders[0].Icon = "../provider.png" }},
		{"icon backslash", func(m *Manifest) { m.Contributes.AIProviders[0].Icon = "icons\\provider.png" }},
		{"icon limit", func(m *Manifest) { m.Contributes.AIProviders[0].Icon = strings.Repeat("a", 253) + ".png" }},
		{"name limit", func(m *Manifest) { m.Contributes.AIProviders[0].Name = strings.Repeat("x", 257) }},
		{"name byte limit", func(m *Manifest) { m.Contributes.AIProviders[0].Name = strings.Repeat("中", 86) }},
		{"model name byte limit", func(m *Manifest) { m.Contributes.AIProviders[0].Models[0].Name = strings.Repeat("中", 86) }},
		{"no models", func(m *Manifest) { m.Contributes.AIProviders[0].Models = nil }},
		{"model id", func(m *Manifest) { m.Contributes.AIProviders[0].Models[0].ID = "bad model" }},
		{"duplicate model", func(m *Manifest) { p := &m.Contributes.AIProviders[0]; p.Models = append(p.Models, p.Models[0]) }},
		{"context lower", func(m *Manifest) { m.Contributes.AIProviders[0].Models[0].ContextWindow = 1023 }},
		{"context upper", func(m *Manifest) { m.Contributes.AIProviders[0].Models[0].ContextWindow = 262145 }},
		{"output zero", func(m *Manifest) { m.Contributes.AIProviders[0].Models[0].MaxOutputTokens = 0 }},
		{"output upper", func(m *Manifest) { m.Contributes.AIProviders[0].Models[0].MaxOutputTokens = 65537 }},
		{"output exceeds context", func(m *Manifest) { m.Contributes.AIProviders[0].Models[0].MaxOutputTokens = 4097 }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			m := aiProviderManifest()
			test.change(&m)
			if ValidateManifest(m) == nil {
				t.Fatal("invalid declaration accepted")
			}
		})
	}
	m := aiProviderManifest()
	p := &m.Contributes.AIProviders[0]
	p.SupportsImages = true
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("explicit image capability rejected: %v", err)
	}
	m = aiProviderManifest()
	m.Contributes.AIProviders[0].Icon = "icons/provider.PNG"
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("valid raster icon rejected: %v", err)
	}
	m = aiProviderManifest()
	p = &m.Contributes.AIProviders[0]
	p.SupportsTools = false
	p.Models = append(p.Models, AIModel{ID: "MODEL/A:1+v@x", Name: "Case distinct", ContextWindow: 262144, MaxOutputTokens: 65536})
	for len(p.Models) < 32 {
		p.Models = append(p.Models, AIModel{ID: fmt.Sprintf("model-%d", len(p.Models)), Name: "Model", ContextWindow: 1024, MaxOutputTokens: 1})
	}
	for len(m.Contributes.AIProviders) < 8 {
		other := m.Contributes.AIProviders[0]
		other.ID = "provider" + string(rune('a'+len(m.Contributes.AIProviders)))
		m.Contributes.AIProviders = append(m.Contributes.AIProviders, other)
	}
	m.Contributes.AIProviders[0].Name = strings.Repeat("中", 85)
	m.Contributes.AIProviders[0].Models[0].Name = strings.Repeat("中", 85)
	if err := ValidateManifest(m); err != nil {
		t.Fatal(err)
	}
	m.Contributes.AIProviders = append(m.Contributes.AIProviders, AIProvider{ID: "extra"})
	if ValidateManifest(m) == nil {
		t.Fatal("provider count limit bypassed")
	}
	m = aiProviderManifest()
	p = &m.Contributes.AIProviders[0]
	for len(p.Models) < 33 {
		p.Models = append(p.Models, AIModel{ID: fmt.Sprintf("model-%d", len(p.Models)), Name: "Model", ContextWindow: 1024, MaxOutputTokens: 1})
	}
	if ValidateManifest(m) == nil {
		t.Fatal("model count limit bypassed")
	}
}

func TestAIProviderStrictJSON(t *testing.T) {
	raw, err := json.Marshal(aiProviderManifest().Contributes.AIProviders[0])
	if err != nil {
		t.Fatal(err)
	}
	valid := string(raw)
	cases := []string{`null`, `[]`,
		strings.Replace(valid, `"supportsTools":true,`, "", 1),
		strings.Replace(valid, `"supportsImages":false`, `"supportsImages":null`, 1),
		strings.Replace(valid, `"supportsImages":false`, `"SupportsImages":false`, 1),
		strings.Replace(valid, `"supportsImages":false`, `"supportsImages":false,"\u0073upportsImages":false`, 1),
		strings.Replace(valid, `"supportsImages":false`, `"supportsImages":false,"extra":0`, 1),
		strings.Replace(valid, `"contextWindow":4096`, `"contextWindow":null`, 1),
		strings.Replace(valid, `"contextWindow":4096`, `"contextWindow":4096.1`, 1),
		strings.Replace(valid, `"contextWindow":4096`, `"contextWindow":4096,"ContextWindow":4096`, 1),
	}
	for _, value := range cases {
		var provider AIProvider
		if json.Unmarshal([]byte(value), &provider) == nil {
			t.Fatal("ambiguous provider JSON accepted")
		}
	}
	var provider AIProvider
	if err = json.Unmarshal([]byte(strings.Replace(valid, "supportsTools", `supports\u0054ools`, 1)), &provider); err != nil {
		t.Fatal("unambiguous escaped key rejected", err)
	}
	var images AIProvider
	if err = json.Unmarshal([]byte(strings.Replace(valid, `"supportsImages":false`, `"supportsImages":true`, 1)), &images); err != nil || !images.SupportsImages {
		t.Fatal("explicit image capability rejected", err)
	}
	before := provider.Name
	if err = json.Unmarshal([]byte(cases[2]), &provider); err == nil || provider.Name != before {
		t.Fatal("failed decoding changed receiver")
	}
}

func TestAIProviderIdentityNeverNormalizes(t *testing.T) {
	m := aiProviderManifest()
	valid := AIProviderType(m.ID, m.Contributes.AIProviders[0])
	id, provider, ok := ParseAIProviderType(valid)
	if !ok || id != m.ID || provider != "first" {
		t.Fatal("identity roundtrip failed")
	}
	for _, value := range []string{"plugin", " Plugin ", "PLUGIN:example.ai:first", " plugin:example.ai:first", "plugin :example.ai:first", "plugin\t:example.ai:first", "plugin:example.ai:first:mysql", "plugin:example.ai:first "} {
		if _, _, ok := ParseAIProviderType(value); ok {
			t.Fatalf("malformed identity accepted: %q", value)
		}
		if !IsAIProviderNamespace(value) {
			t.Fatalf("malformed namespace escaped protection: %q", value)
		}
	}
	if IsAIProviderNamespace("custom") || AIProviderType("example.ai", AIProvider{ID: "First"}) != "" {
		t.Fatal("identity validation changed")
	}
}

func FuzzParseAIProviderType(f *testing.F) {
	for _, seed := range []string{"plugin:example.ai:first", "plugin", " PLUGIN:bad:id", "plugin:example.ai:first:extra"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, value string) {
		id, provider, ok := ParseAIProviderType(value)
		if ok {
			if AIProviderType(id, AIProvider{ID: provider}) != value {
				t.Fatal("parser normalized identity")
			}
		} else if id != "" || provider != "" {
			t.Fatal("invalid parse returned identity")
		}
	})
}
