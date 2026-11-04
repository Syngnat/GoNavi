package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	plugin "github.com/Syngnat/GoNavi/sdk/go"
)

func loadExampleManifest(t *testing.T) plugin.Manifest {
	t.Helper()
	raw, err := os.ReadFile("gonavi.plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest plugin.Manifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func TestExampleSidebarDeclaresEveryEntryPoint(t *testing.T) {
	manifest := loadExampleManifest(t)
	if err := plugin.ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
	contributes := manifest.Contributes
	if contributes == nil {
		t.Fatal("missing contributions")
	}
	if len(contributes.Sidebar) != 1 || contributes.Sidebar[0].ListCommand != "list" {
		t.Fatalf("sidebar: %+v", contributes.Sidebar)
	}
	if len(contributes.Views) != 1 || contributes.Views[0].Location != plugin.ViewLocationRight {
		t.Fatalf("views: %+v", contributes.Views)
	}
	if len(contributes.Keybindings) != 1 || contributes.Keybindings[0].Target.Page != "terminal" {
		t.Fatalf("keybindings: %+v", contributes.Keybindings)
	}
	if len(contributes.Navigation) != 1 || contributes.Navigation[0].Location != plugin.PageLocationStatusbar {
		t.Fatalf("navigation: %+v", contributes.Navigation)
	}
}

func TestExampleSidebarRejectsMissingSidebarPermission(t *testing.T) {
	manifest := loadExampleManifest(t)
	kept := manifest.Permissions[:0]
	for _, permission := range manifest.Permissions {
		if permission != plugin.SidebarPermission {
			kept = append(kept, permission)
		}
	}
	manifest.Permissions = kept
	delete(manifest.PermissionNotes, plugin.SidebarPermission)
	if err := plugin.ValidateManifest(manifest); err == nil || !strings.Contains(err.Error(), plugin.SidebarPermission) {
		t.Fatalf("sidebar without its permission: %v", err)
	}
}
