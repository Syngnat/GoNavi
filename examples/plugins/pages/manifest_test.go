package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	plugin "github.com/Syngnat/GoNavi/sdk/go"
)

func TestExamplePagesStayDeclarativeAndLeastPrivileged(t *testing.T) {
	raw, err := os.ReadFile("gonavi.plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest plugin.Manifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if err = plugin.ValidatePermissionNotes(manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Backend != nil || manifest.Window != nil {
		t.Fatal("page example must stay backend-free")
	}
	if granted := strings.Join(manifest.Permissions, " "); granted != "ui.pages ui.html-panel host.connections.read host.metadata.read" {
		t.Fatalf("permissions: %v", manifest.Permissions)
	}
	if manifest.Contributes == nil || len(manifest.Contributes.Pages) != 2 || len(manifest.Contributes.Navigation) != 2 {
		t.Fatalf("declarations: %+v", manifest.Contributes)
	}
	overview, connections := manifest.Contributes.Pages[0], manifest.Contributes.Pages[1]
	if overview.ID != "overview" || overview.Body == nil || overview.HTML != nil || overview.Body.Type != "column" {
		t.Fatalf("declarative page: %+v", overview)
	}
	if connections.ID != "connections" || connections.HTML == nil || connections.Body != nil || !strings.Contains(connections.HTML.Source, "window.gonavi.call") {
		t.Fatalf("html page: %+v", connections)
	}
	for _, entry := range manifest.Contributes.Navigation {
		if entry.Location != plugin.PageLocationTools || entry.Page == "" {
			t.Fatalf("navigation: %+v", entry)
		}
	}
	if err = plugin.ValidatePages(manifest); err != nil {
		t.Fatal(err)
	}
}

func TestExamplePagesRejectUndeclaredHTMLPermission(t *testing.T) {
	raw, err := os.ReadFile("gonavi.plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest plugin.Manifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	kept := manifest.Permissions[:0]
	for _, permission := range manifest.Permissions {
		if permission != plugin.PageCustomHTMLPermission {
			kept = append(kept, permission)
		}
	}
	manifest.Permissions = kept
	if err = plugin.ValidatePages(manifest); err == nil || !strings.Contains(err.Error(), plugin.PageCustomHTMLPermission) {
		t.Fatalf("html page without its permission: %v", err)
	}
}
