package plugin

import (
	"strings"
	"testing"
)

// The contract moved into the SDK; the host keeps the previous implementation as
// validateManifestLegacy only so this test can prove the migration changed no
// verdict. A divergence here means a package the host used to accept is now
// refused, which is a compatibility break for anyone already published.
func TestValidateManifestMatchesLegacyImplementation(t *testing.T) {
	cases := []struct {
		name   string
		modify func(*Manifest)
	}{
		{"baseline", func(m *Manifest) {}},
		{"unsupported api", func(m *Manifest) { m.APIVersion = 2 }},
		{"invalid id", func(m *Manifest) { m.ID = "../escape" }},
		{"empty name", func(m *Manifest) { m.Name = "" }},
		{"missing semver patch", func(m *Manifest) { m.Version = "1.0" }},
		{"leading v version", func(m *Manifest) { m.Version = "v1.0.0" }},
		{"prerelease version", func(m *Manifest) { m.Version = "1.0.0-rc.1" }},
		{"huge description", func(m *Manifest) { m.Description = strings.Repeat("x", 16385) }},
		{"invalid min host version", func(m *Manifest) { m.MinHostVersion = "1.0" }},
		{"svg icon", func(m *Manifest) { m.Icon = "logo.svg" }},
		{"icon escaping package", func(m *Manifest) { m.Icon = "../logo.png" }},
		{"too many permissions", func(m *Manifest) {
			m.Permissions = make([]string, 65)
			for i := range m.Permissions {
				m.Permissions[i] = "p" + strings.Repeat("a", i%3) + string(rune('a'+i%26))
			}
		}},
		{"duplicate permission", func(m *Manifest) { m.Permissions = []string{"db.read", "db.read"} }},
		{"bad permission shape", func(m *Manifest) { m.Permissions = []string{"DB.READ"} }},
		{"permission note without grant", func(m *Manifest) { m.PermissionNotes = map[string]string{"db.read": "reads"} }},
		{"permission note with markup", func(m *Manifest) {
			m.Permissions = []string{"db.read"}
			m.PermissionNotes = map[string]string{"db.read": "<b>reads</b>"}
		}},
		{"self dependency", func(m *Manifest) { m.Requires = []Dependency{{ID: m.ID}} }},
		{"duplicate dependency", func(m *Manifest) {
			m.Requires = []Dependency{{ID: "other.plugin"}, {ID: "other.plugin"}}
		}},
		{"empty backend", func(m *Manifest) { m.Backend = &Backend{} }},
		{"unknown runtime", func(m *Manifest) { m.Backend = &Backend{Default: &Entry{Executable: "x", Runtime: "shell"}} }},
		{"shell path", func(m *Manifest) { m.Backend = &Backend{Default: &Entry{Executable: "../x"}} }},
		{"windows reserved executable", func(m *Manifest) { m.Backend = &Backend{Default: &Entry{Executable: "bin/CON"}} }},
		{"unsupported platform", func(m *Manifest) {
			m.Backend = &Backend{Platforms: map[string]Entry{"solaris/sparc": {Executable: "x"}}}
		}},
		{"command without backend", func(m *Manifest) {
			m.Contributes.Commands = []Command{{ID: "run", Title: "Run"}}
		}},
		{"duplicate command", func(m *Manifest) {
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "run", Title: "Run"}, {ID: "run", Title: "Again"}}
		}},
		{"bad command effect", func(m *Manifest) {
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "run", Title: "Run", Effect: "delete"}}
		}},
		{"schema not an object", func(m *Manifest) {
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "run", Title: "Run", InputSchema: []byte(`[1,2]`)}}
		}},
		{"unsafe window", func(m *Manifest) {
			m.Permissions = []string{CustomPanelPermission}
			m.Window = &Window{Entry: "C:/test"}
		}},
		{"window without permission", func(m *Manifest) { m.Window = &Window{Entry: "index.html"} }},
		{"oversized window", func(m *Manifest) {
			m.Permissions = []string{CustomPanelPermission}
			m.Window = &Window{Entry: "index.html", Width: 9000}
		}},
		{"window with permission", func(m *Manifest) {
			m.Permissions = []string{CustomPanelPermission}
			m.Window = &Window{Entry: "index.html", Title: "W", Width: 800, Height: 600}
		}},
		{"undeclared command", func(m *Manifest) {
			m.Contributes.Panels = []Panel{{ID: "main", Title: "Panel", Body: UINode{Type: "button", Command: "missing"}}}
		}},
		{"html node", func(m *Manifest) {
			m.Contributes.Panels = []Panel{{ID: "main", Title: "Panel", Body: UINode{Type: "html"}}}
		}},
		{"oversized text", func(m *Manifest) {
			m.Contributes.Panels = []Panel{{ID: "main", Title: "Panel", Body: UINode{Type: "text", Text: strings.Repeat("x", 20000)}}}
		}},
		{"html panel without permission", func(m *Manifest) {
			m.Contributes.Panels = []Panel{{ID: "main", Title: "Panel", HTML: &HTMLPanel{Source: "<p>x</p>"}}}
		}},
		{"html panel with permission", func(m *Manifest) {
			m.Permissions = []string{CustomPanelPermission}
			m.Contributes.Panels = []Panel{{ID: "main", Title: "Panel", HTML: &HTMLPanel{Source: "<p>x</p>"}}}
		}},
		{"pages without permission", func(m *Manifest) {
			m.Contributes.Pages = []Page{{ID: "p", Title: "P", Body: &UINode{Type: "text", Text: "x"}}}
		}},
		{"navigation to window without window", func(m *Manifest) {
			m.Contributes.Navigation = []Navigation{{ID: "n", Title: "N", Target: "window", Location: "tools"}}
		}},
		{"connection action without window", func(m *Manifest) {
			m.Contributes.ConnectionActions = []ConnectionAction{{ID: "open", Title: "Open", ConnectionTypes: []string{"mongodb"}, Target: LaunchTarget{Type: "window"}}}
		}},
		{"connection action invalid scope", func(m *Manifest) {
			m.Permissions = []string{CustomPanelPermission}
			m.Window = &Window{Entry: "index.html"}
			m.Contributes.ConnectionActions = []ConnectionAction{{ID: "open", Title: "Open", ConnectionTypes: []string{"mongodb"}, Scopes: []string{"schema"}, Target: LaunchTarget{Type: "window"}}}
		}},
		{"data source without permission", func(m *Manifest) {
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "q", Title: "Q", Effect: "read"}}
			m.Contributes.DataSources = []DataSource{{ID: "src", Name: "S", Dialect: "mysql", Command: "q", ReadOnly: true}}
		}},
		{"data source with permission", func(m *Manifest) {
			m.Permissions = []string{"data.sources"}
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "q", Title: "Q", Effect: "read"}}
			m.Contributes.DataSources = []DataSource{{ID: "src", Name: "S", Dialect: "mysql", Command: "q", ReadOnly: true}}
		}},
		{"read only source on write command", func(m *Manifest) {
			m.Permissions = []string{"data.sources"}
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "q", Title: "Q", Effect: "write"}}
			m.Contributes.DataSources = []DataSource{{ID: "src", Name: "S", Dialect: "mysql", Command: "q", ReadOnly: true}}
		}},
		{"bad dialect", func(m *Manifest) {
			m.Permissions = []string{"data.sources"}
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "q", Title: "Q", Effect: "read"}}
			m.Contributes.DataSources = []DataSource{{ID: "src", Name: "S", Dialect: "oracle", Command: "q", ReadOnly: true}}
		}},
		{"skill without permission", func(m *Manifest) {
			m.Contributes.Skills = []Skill{{ID: "s", Name: "S", Description: "D", Entry: "skills/s/SKILL.md"}}
		}},
		{"skill entry not SKILL.md", func(m *Manifest) {
			m.Permissions = []string{"ai.skills"}
			m.Contributes.Skills = []Skill{{ID: "s", Name: "S", Description: "D", Entry: "skills/s/README.md"}}
		}},
		{"ai provider without models", func(m *Manifest) {
			m.Permissions = []string{"ai.providers"}
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "chat", Title: "Chat"}}
			m.Contributes.AIProviders = []AIProvider{{ID: "p", Name: "P", Command: "chat"}}
		}},
		{"ai model limits inverted", func(m *Manifest) {
			m.Permissions = []string{"ai.providers"}
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "chat", Title: "Chat"}}
			m.Contributes.AIProviders = []AIProvider{{ID: "p", Name: "P", Command: "chat", Models: []AIModel{{ID: "m", Name: "M", ContextWindow: 4096, MaxOutputTokens: 8192}}}}
		}},
		{"ai base url with credentials", func(m *Manifest) {
			m.Permissions = []string{"ai.providers"}
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "chat", Title: "Chat"}}
			m.Contributes.AIProviders = []AIProvider{{ID: "p", Name: "P", Command: "chat", DefaultBaseURL: "https://user:pass@example.com",
				Models: []AIModel{{ID: "m", Name: "M", ContextWindow: 4096, MaxOutputTokens: 1024}}}}
		}},
		{"invalid utf8 html panel", func(m *Manifest) {
			m.Permissions = []string{CustomPanelPermission}
			m.Contributes.Panels = []Panel{{ID: "text", Title: "Text", HTML: &HTMLPanel{Source: "<p>\xff\xfe</p>"}}}
		}},
		{"invalid utf8 ai provider name", func(m *Manifest) {
			m.Permissions = []string{"ai.providers"}
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "chat", Title: "Chat"}}
			m.Contributes.AIProviders = []AIProvider{{ID: "p", Name: string([]byte{0xff}), Command: "chat",
				Models: []AIModel{{ID: "m", Name: "M", ContextWindow: 4096, MaxOutputTokens: 1024}}}}
		}},
		{"invalid utf8 exporter name", func(m *Manifest) {
			m.Permissions = []string{"data.export"}
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "ex", Title: "Ex"}}
			m.Contributes.Exporters = []Exporter{{ID: "e", Name: string([]byte{0xff}), Command: "ex", Extension: "csv", ContentType: "text/csv"}}
		}},
		{"invalid utf8 skill name", func(m *Manifest) {
			m.Permissions = []string{"ai.skills"}
			m.Contributes.Skills = []Skill{{ID: "s", Name: string([]byte{0xff}), Description: "D", Entry: "skills/s/SKILL.md"}}
		}},
		{"exporter without permission", func(m *Manifest) {
			m.Backend = &Backend{Default: &Entry{Executable: "bin/x"}}
			m.Contributes.Commands = []Command{{ID: "ex", Title: "Ex"}}
			m.Contributes.Exporters = []Exporter{{ID: "e", Name: "E", Command: "ex", Extension: "csv", ContentType: "text/csv"}}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			manifest := basicManifest("com.example.plugin")
			tc.modify(&manifest)
			legacy := validateManifestLegacy(manifest)
			shared := ValidateManifest(manifest)
			if (legacy == nil) != (shared == nil) {
				t.Fatalf("verdict diverged: legacy=%v shared=%v", legacy, shared)
			}
		})
	}
}

// A window-only navigation entry needs no ui.pages permission; the migration must
// not have turned that allowance into a requirement.
func TestValidateManifestKeepsWindowOnlyNavigationAllowed(t *testing.T) {
	manifest := basicManifest("com.example.plugin")
	manifest.Permissions = []string{CustomPanelPermission}
	manifest.Window = &Window{Entry: "index.html"}
	manifest.Contributes.Navigation = []Navigation{{ID: "n", Title: "N", Target: "window", Location: "tools"}}
	if err := ValidateManifest(manifest); err != nil {
		t.Fatalf("window-only navigation rejected: %v", err)
	}
}
