package plugin

import (
	"encoding/json"
	"strings"
	"testing"
)

// A zero UINode must not be serialized: an HTML-only panel would otherwise carry
// body:{"type":""} next to html, and hosts that require exactly one body reject it.
func TestHTMLOnlyPanelOmitsZeroBody(t *testing.T) {
	htmlOnly, err := json.Marshal(Panel{ID: "overview", Title: "Overview", HTML: &HTMLPanel{Source: "<h1>hi</h1>"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(htmlOnly), `"body"`) {
		t.Fatalf("zero declarative body leaked into JSON: %s", htmlOnly)
	}
	if !strings.Contains(string(htmlOnly), `"html"`) {
		t.Fatalf("html panel lost its payload: %s", htmlOnly)
	}

	declarative, err := json.Marshal(Panel{ID: "status", Title: "Status", Body: UINode{Type: "text", Text: "ready"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(declarative), `"body":{"type":"text"`) {
		t.Fatalf("declarative body was dropped: %s", declarative)
	}

	manifest := Manifest{
		SchemaVersion: 1, APIVersion: 1, ID: "com.example.dashboard", Name: "Dashboard", Version: "1.0.0",
		Permissions: []string{CustomPanelPermission},
		Contributes: Contributions{Panels: []Panel{{ID: "overview", Title: "Overview", HTML: &HTMLPanel{Source: "<p>x</p>"}}}},
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Manifest
	if err = json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if err = ValidateManifest(decoded); err != nil {
		t.Fatalf("html-only manifest rejected after round trip: %v", err)
	}
}
