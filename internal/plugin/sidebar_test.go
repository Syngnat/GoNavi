package plugin

import (
	"strings"
	"testing"
)

func sidebarManifest() Manifest {
	m := basicManifest("example.sidebar")
	m.Backend = &Backend{Default: &Entry{Executable: "bin/plugin"}}
	m.Permissions = []string{SidebarPermission, PagesPermission}
	m.Contributes.Commands = []Command{{ID: "list", Title: "List"}}
	m.Contributes.Pages = []Page{{ID: "main", Title: "Main", Body: &UINode{Type: "text", Text: "x"}}}
	m.Contributes.Sidebar = []SidebarGroup{{
		ID: "ssh", Title: "SSH", ListCommand: "list",
		Open: &LaunchTarget{Type: "page", Page: "main"},
	}}
	return m
}

func TestSidebarValidationAcceptsADeclaredGroup(t *testing.T) {
	if err := ValidateManifest(sidebarManifest()); err != nil {
		t.Fatal(err)
	}
}

func TestSidebarValidationRejectsUnsafeDeclarations(t *testing.T) {
	cases := []struct {
		name   string
		modify func(*Manifest)
	}{
		{"missing permission", func(m *Manifest) { m.Permissions = []string{PagesPermission} }},
		{"empty id", func(m *Manifest) { m.Contributes.Sidebar[0].ID = "" }},
		{"duplicate id", func(m *Manifest) {
			m.Contributes.Sidebar = append(m.Contributes.Sidebar, m.Contributes.Sidebar[0])
		}},
		{"empty title", func(m *Manifest) { m.Contributes.Sidebar[0].Title = " " }},
		{"long title", func(m *Manifest) { m.Contributes.Sidebar[0].Title = strings.Repeat("x", 200) }},
		{"undeclared list command", func(m *Manifest) { m.Contributes.Sidebar[0].ListCommand = "missing" }},
		{"long empty text", func(m *Manifest) { m.Contributes.Sidebar[0].EmptyText = strings.Repeat("x", 200) }},
		{"unsafe icon", func(m *Manifest) { m.Contributes.Sidebar[0].Icon = "../secret.png" }},
		{"non raster icon", func(m *Manifest) { m.Contributes.Sidebar[0].Icon = "icons/logo.svg" }},
		{"order out of range", func(m *Manifest) { m.Contributes.Sidebar[0].Order = 1001 }},
		{"too many groups", func(m *Manifest) {
			groups := make([]SidebarGroup, 0, MaxSidebarGroups+1)
			for index := 0; index <= MaxSidebarGroups; index++ {
				groups = append(groups, SidebarGroup{ID: "g" + string(rune('a'+index)), Title: "G", ListCommand: "list"})
			}
			m.Contributes.Sidebar = groups
		}},
		{"undeclared page", func(m *Manifest) { m.Contributes.Sidebar[0].Open = &LaunchTarget{Type: "page", Page: "missing"} }},
		{"window target without window", func(m *Manifest) { m.Contributes.Sidebar[0].Open = &LaunchTarget{Type: "window"} }},
		{"window target with page", func(m *Manifest) {
			m.Permissions = append(m.Permissions, CustomPanelPermission)
			m.Window = &Window{Entry: "index.html"}
			m.Contributes.Sidebar[0].Open = &LaunchTarget{Type: "window", Page: "main"}
		}},
		{"unsupported target", func(m *Manifest) { m.Contributes.Sidebar[0].Open = &LaunchTarget{Type: "popover"} }},
		{"panel target without a view", func(m *Manifest) { m.Contributes.Sidebar[0].Open = &LaunchTarget{Type: "panel"} }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			manifest := sidebarManifest()
			test.modify(&manifest)
			if err := ValidateManifest(manifest); err == nil {
				t.Fatal("unsafe sidebar declaration was accepted")
			}
		})
	}
}

func TestSidebarWithoutGroupsNeedsNoPermission(t *testing.T) {
	manifest := basicManifest("example.none")
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
}

func TestSidebarWindowTargetAcceptsDeclaredWindow(t *testing.T) {
	manifest := sidebarManifest()
	manifest.Permissions = append(manifest.Permissions, CustomPanelPermission)
	manifest.Window = &Window{Entry: "index.html"}
	manifest.Contributes.Sidebar[0].Open = &LaunchTarget{Type: "window"}
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
}

func TestSidebarPanelTargetAcceptsDeclaredView(t *testing.T) {
	manifest := sidebarManifest()
	manifest.Contributes.Views = []View{{ID: "term", Title: "Terminal", Page: "main", Location: ViewLocationRight}}
	manifest.Contributes.Sidebar[0].Open = &LaunchTarget{Type: "panel", View: "term"}
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
}
