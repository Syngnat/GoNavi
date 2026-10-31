package plugin

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func basicManifest(id string) Manifest {
	return Manifest{SchemaVersion: 1, APIVersion: 1, ID: id, Name: "Fixture", Version: "1.0.0", Permissions: []string{}}
}
func TestManifestValidation(t *testing.T) {
	cases := []struct {
		name   string
		modify func(*Manifest)
	}{
		{"unsupported api", func(m *Manifest) { m.APIVersion = 2 }},
		{"invalid id", func(m *Manifest) { m.ID = "../escape" }},
		{"missing semver patch", func(m *Manifest) { m.Version = "1.0" }},
		{"unknown runtime", func(m *Manifest) { m.Backend = &Backend{Default: &Entry{Executable: "x", Runtime: "shell"}} }},
		{"shell path", func(m *Manifest) { m.Backend = &Backend{Default: &Entry{Executable: "../x"}} }},
		{"duplicate permission", func(m *Manifest) { m.Permissions = []string{"db.read", "db.read"} }},
		{"self dependency", func(m *Manifest) { m.Requires = []Dependency{{ID: m.ID}} }},
		{"unsafe window", func(m *Manifest) { m.Window = &Window{Entry: "C:/test"} }},
		{"undeclared command", func(m *Manifest) {
			m.Contributes.Panels = []Panel{{ID: "main", Title: "Panel", Body: UINode{Type: "button", Command: "missing"}}}
		}},
		{"html node", func(m *Manifest) {
			m.Contributes.Panels = []Panel{{ID: "main", Title: "Panel", Body: UINode{Type: "html"}}}
		}},
		{"oversized text", func(m *Manifest) {
			m.Contributes.Panels = []Panel{{ID: "main", Title: "Panel", Body: UINode{Type: "text", Text: strings.Repeat("x", 20000)}}}
		}},
		{"connection action without window", func(m *Manifest) {
			m.Contributes.ConnectionActions = []ConnectionAction{{ID: "open", Title: "Open", ConnectionTypes: []string{"mongodb"}, Target: LaunchTarget{Type: "window"}}}
		}},
		{"connection action invalid type", func(m *Manifest) {
			m.Window = &Window{Entry: "index.html"}
			m.Contributes.ConnectionActions = []ConnectionAction{{ID: "open", Title: "Open", ConnectionTypes: []string{"Mongo DB!"}, Target: LaunchTarget{Type: "window"}}}
		}},
		{"connection action invalid scope", func(m *Manifest) {
			m.Window = &Window{Entry: "index.html"}
			m.Contributes.ConnectionActions = []ConnectionAction{{ID: "open", Title: "Open", ConnectionTypes: []string{"mongodb"}, Scopes: []string{"schema"}, Target: LaunchTarget{Type: "window"}}}
		}},
		{"duplicate connection action", func(m *Manifest) {
			m.Window = &Window{Entry: "index.html"}
			m.Contributes.ConnectionActions = []ConnectionAction{
				{ID: "open", Title: "Open", ConnectionTypes: []string{"mongodb"}, Target: LaunchTarget{Type: "window"}},
				{ID: "open", Title: "Open again", ConnectionTypes: []string{"mongodb"}, Target: LaunchTarget{Type: "window"}},
			}
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			m := basicManifest("test.fixture")
			test.modify(&m)
			if err := ValidateManifest(m); err == nil {
				t.Fatal("unsafe manifest accepted")
			}
		})
	}
	m := basicManifest("test.fixture")
	if err := ValidateManifest(m); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ParseManifest(encoded); err != nil {
		t.Fatal(err)
	}
	if _, err = ParseManifest(append(encoded, encoded...)); err == nil {
		t.Fatal("trailing json accepted")
	}
	if _, err = ParseManifest([]byte(strings.Replace(string(encoded), `"name":`, `"official":true,"name":`, 1))); err == nil {
		t.Fatal("unknown field accepted")
	}
	withAction := basicManifest("test.fixture")
	withAction.Window = &Window{Entry: "index.html"}
	withAction.Contributes.ConnectionActions = []ConnectionAction{{
		ID: "open", Title: "MongoShell", ConnectionTypes: []string{"mongodb"},
		Scopes: []string{"connection", "database", "collection"}, Target: LaunchTarget{Type: "window"},
	}}
	if err := ValidateManifest(withAction); err != nil {
		t.Fatal(err)
	}
}
func TestSafePackagePaths(t *testing.T) {
	for _, path := range []string{"../a", "/a", "C:/a", "a\\b", "a/../b", "a//b", "a.", "NUL.txt", "COM1.bin", "COM0", "LPT0.txt", "CLOCK$", "a/CON", "a:b", ".", "a<b", "a|b", "a?b", "a*b", "a\"b", "a\tb", strings.Repeat("a", 241), strings.Repeat("a/", 33) + "b"} {
		t.Run(path, func(t *testing.T) {
			if safePackagePath(path) == nil {
				t.Fatal("unsafe path accepted")
			}
		})
	}
	for _, path := range []string{"assets/index.html", "bin/backend.exe", "deep/path/file", strings.Repeat("b", 240), strings.Repeat("c/", 32) + "d", strings.Repeat("文", 80)} {
		if err := safePackagePath(path); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	wide := strings.Repeat(strings.Repeat("文", 77)+"/", 12) + "file"
	if utf8.RuneCountInString(wide) > 1024 {
		t.Fatal("multibyte fixture exceeds 1024 characters")
	}
	for _, path := range []string{wide, strings.Repeat("文", 81)} {
		if safePackagePath(path) == nil {
			t.Fatalf("accepted multibyte path %q", path)
		}
	}
}

func TestManifestIdentityByteBounds(t *testing.T) {
	manifest := basicManifest("example.identity")
	manifest.Name = strings.Repeat("中", 85)
	manifest.Description = strings.Repeat("文", 5461)
	manifest.Author = strings.Repeat("界", 170)
	manifest.License = strings.Repeat("界", 85)
	manifest.Backend = &Backend{Default: &Entry{Executable: "plugin"}}
	manifest.Contributes.Commands = []Command{{ID: "run", Title: strings.Repeat("中", 85)}}
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Name = strings.Repeat("中", 86)
	if ValidateManifest(manifest) == nil {
		t.Fatal("name over 256 bytes was accepted")
	}
	manifest.Name = "Fixture"
	manifest.Description = strings.Repeat("文", 5462)
	if ValidateManifest(manifest) == nil {
		t.Fatal("description over 16384 bytes was accepted")
	}
	manifest.Description = ""
	manifest.Author = strings.Repeat("界", 171)
	if ValidateManifest(manifest) == nil {
		t.Fatal("author over 512 bytes was accepted")
	}
	manifest.Author = ""
	manifest.License = strings.Repeat("界", 86)
	if ValidateManifest(manifest) == nil {
		t.Fatal("license over 256 bytes was accepted")
	}
	manifest.License = ""
	manifest.Contributes.Commands[0].Title = strings.Repeat("中", 86)
	if ValidateManifest(manifest) == nil {
		t.Fatal("command title over 256 bytes was accepted")
	}
}
