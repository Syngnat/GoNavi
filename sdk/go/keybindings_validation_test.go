package plugin

import (
	"strings"
	"testing"
)

func keybindingsTestManifest() Manifest {
	manifest := pageManifest(PagesPermission)
	manifest.Backend = &Backend{Default: &Entry{Executable: "bin/plugin"}}
	manifest.Contributes.Pages = []Page{textPage("terminal", "Terminal")}
	manifest.Contributes.Keybindings = []Keybinding{{
		ID: "open", Title: "Open terminal", Keys: "CmdOrCtrl+Shift+T",
		Target: LaunchTarget{Type: "page", Page: "terminal"},
	}}
	return manifest
}

func TestValidateManifestAcceptsAPageKeybinding(t *testing.T) {
	if err := ValidateManifest(keybindingsTestManifest()); err != nil {
		t.Fatal(err)
	}
}

func TestValidateManifestRejectsUnsafeKeybindings(t *testing.T) {
	cases := []struct {
		name   string
		modify func(*Manifest)
	}{
		{"unknown modifier", func(m *Manifest) { m.Contributes.Keybindings[0].Keys = "Hyper+T" }},
		{"no main key", func(m *Manifest) { m.Contributes.Keybindings[0].Keys = "Ctrl+" }},
		{"duplicate keys", func(m *Manifest) {
			second := m.Contributes.Keybindings[0]
			second.ID = "open-2"
			m.Contributes.Keybindings = append(m.Contributes.Keybindings, second)
		}},
		{"duplicate id", func(m *Manifest) {
			m.Contributes.Keybindings = append(m.Contributes.Keybindings, m.Contributes.Keybindings[0])
		}},
		{"missing page permission", func(m *Manifest) { m.Permissions = nil }},
		{"undeclared page", func(m *Manifest) { m.Contributes.Keybindings[0].Target.Page = "missing" }},
		{"window without manifest window", func(m *Manifest) {
			m.Contributes.Keybindings[0].Target = LaunchTarget{Type: "window"}
		}},
		{"unsupported target", func(m *Manifest) { m.Contributes.Keybindings[0].Target = LaunchTarget{Type: "panel"} }},
		{"too many keybindings", func(m *Manifest) {
			bindings := make([]Keybinding, 0, maxManifestKeybindings+1)
			for index := 0; index <= maxManifestKeybindings; index++ {
				bindings = append(bindings, Keybinding{
					ID: "b" + string(rune('a'+index)), Title: "B",
					Keys:   "Ctrl+" + strings.ToUpper(string(rune('a'+index))),
					Target: LaunchTarget{Type: "page", Page: "terminal"},
				})
			}
			m.Contributes.Keybindings = bindings
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			manifest := keybindingsTestManifest()
			test.modify(&manifest)
			if err := ValidateManifest(manifest); err == nil {
				t.Fatal("unsafe keybinding was accepted")
			}
		})
	}
}

func TestValidateManifestAcceptsAWindowKeybinding(t *testing.T) {
	manifest := keybindingsTestManifest()
	manifest.Permissions = append(manifest.Permissions, PageCustomHTMLPermission)
	manifest.Window = &Window{Entry: "index.html"}
	manifest.Contributes.Keybindings[0].Target = LaunchTarget{Type: "window"}
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
}
