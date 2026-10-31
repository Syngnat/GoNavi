package plugin

import (
	"encoding/json"
	"strings"
	"testing"
)

// The top-level icon is the installed-plugin logo the host reads without starting the
// plugin. ParseManifest must accept it so `plugin check` and author tests do not report
// it as an unknown field, and it must round-trip as a plain package-relative path.
func TestParseManifestAcceptsTopLevelIcon(t *testing.T) {
	const raw = `{"schemaVersion":1,"apiVersion":1,"id":"example.host","name":"Host","version":"1.0.0","permissions":[],"icon":"icons/logo.png"}`
	manifest, err := ParseManifest([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Icon != "icons/logo.png" {
		t.Fatalf("unexpected icon: %q", manifest.Icon)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"icon":"icons/logo.png"`) {
		t.Fatalf("icon did not round-trip: %s", encoded)
	}
}

func TestParseManifestOmitsAbsentIcon(t *testing.T) {
	manifest, err := ParseManifest([]byte(`{"schemaVersion":1,"apiVersion":1,"id":"example.host","name":"Host","version":"1.0.0","permissions":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"icon"`) {
		t.Fatalf("omitted icon must stay absent: %s", encoded)
	}
}
