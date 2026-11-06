package plugin

import (
	"strings"
	"testing"
)

func viewsTestManifest() Manifest {
	manifest := pageManifest(PagesPermission)
	manifest.Backend = &Backend{Default: &Entry{Executable: "bin/plugin"}}
	manifest.Contributes.Pages = []Page{textPage("terminal", "Terminal")}
	manifest.Contributes.Views = []View{{
		ID: "term", Title: "Terminal", Page: "terminal", Location: ViewLocationRight,
	}}
	return manifest
}

func TestValidateManifestAcceptsADockedView(t *testing.T) {
	if err := ValidateManifest(viewsTestManifest()); err != nil {
		t.Fatal(err)
	}
}

func TestValidateManifestRejectsUnsafeViews(t *testing.T) {
	cases := []struct {
		name   string
		modify func(*Manifest)
	}{
		{"missing pages permission", func(m *Manifest) { m.Permissions = nil }},
		{"undeclared page", func(m *Manifest) { m.Contributes.Views[0].Page = "missing" }},
		{"unsupported location", func(m *Manifest) { m.Contributes.Views[0].Location = "left" }},
		{"duplicate id", func(m *Manifest) { m.Contributes.Views = append(m.Contributes.Views, m.Contributes.Views[0]) }},
		{"long title", func(m *Manifest) { m.Contributes.Views[0].Title = strings.Repeat("x", 200) }},
		{"unsafe icon", func(m *Manifest) { m.Contributes.Views[0].Icon = "../secret.png" }},
		{"order out of range", func(m *Manifest) { m.Contributes.Views[0].Order = 1001 }},
		{"too many views", func(m *Manifest) {
			views := make([]View, 0, maxManifestViews+1)
			for index := 0; index <= maxManifestViews; index++ {
				views = append(views, View{ID: "v" + string(rune('a'+index)), Title: "V", Page: "terminal", Location: ViewLocationRight})
			}
			m.Contributes.Views = views
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			manifest := viewsTestManifest()
			test.modify(&manifest)
			if err := ValidateManifest(manifest); err == nil {
				t.Fatal("unsafe view declaration was accepted")
			}
		})
	}
}

func TestValidateManifestAcceptsAPanelSidebarTarget(t *testing.T) {
	manifest := viewsTestManifest()
	manifest.Permissions = []string{PagesPermission, SidebarPermission}
	manifest.Contributes.Commands = []Command{{ID: "list", Title: "List"}}
	manifest.Backend = &Backend{Default: &Entry{Executable: "bin/plugin"}}
	manifest.Contributes.Sidebar = []SidebarGroup{{
		ID: "ssh", Title: "SSH", ListCommand: "list",
		Open: &LaunchTarget{Type: "panel", View: "term"},
	}}
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Contributes.Sidebar[0].Open.View = "missing"
	if err := ValidateManifest(manifest); err == nil {
		t.Fatal("sidebar accepted an undeclared view")
	}
}

func TestValidateManifestAcceptsABottomView(t *testing.T) {
	manifest := viewsTestManifest()
	manifest.Contributes.Views[0].Location = ViewLocationBottom
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
}
