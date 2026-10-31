package plugin

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func pageManifest(permissions ...string) Manifest {
	return Manifest{
		SchemaVersion: 1, APIVersion: 1, ID: "example.pages", Name: "Pages", Version: "1.0.0",
		Permissions: permissions,
		Contributes: &Contributions{
			Commands: []Command{{ID: "refresh", Title: "Refresh", Effect: "read"}},
		},
	}
}

func textPage(id, title string) Page {
	return Page{ID: id, Title: title, Body: &UINode{Type: "text", Text: "hello"}}
}

func TestValidatePagesAcceptsDeclarativeAndHTMLPages(t *testing.T) {
	manifest := pageManifest(PagesPermission, PageCustomHTMLPermission)
	manifest.Contributes.Pages = []Page{
		{ID: "overview", Title: "Overview", Body: &UINode{Type: "column", Children: []UINode{{Type: "text", Text: "hello"}, {Type: "button", Title: "Refresh", Command: "refresh"}}}},
		{ID: "dashboard", Title: "Dashboard", HTML: &PageHTML{Source: "<h1>Dashboard</h1>"}},
	}
	manifest.Contributes.Navigation = []Navigation{
		{ID: "overview-tools", Title: "Overview", Page: "overview", Location: PageLocationTools, Order: -1000},
		{ID: "dashboard-tools", Title: "Dashboard", Page: "dashboard", Location: PageLocationTools, Order: 1000},
	}
	if err := ValidatePages(manifest); err != nil {
		t.Fatal(err)
	}
}

func TestValidatePagesKeepsLegacyManifestsValid(t *testing.T) {
	manifest := pageManifest()
	if err := ValidatePages(manifest); err != nil {
		t.Fatal(err)
	}
	var empty Manifest
	if err := ValidatePages(empty); err != nil {
		t.Fatal(err)
	}
}

func TestValidatePagesRequiresPermissions(t *testing.T) {
	manifest := pageManifest()
	manifest.Contributes.Pages = []Page{textPage("overview", "Overview")}
	if err := ValidatePages(manifest); err == nil || !strings.Contains(err.Error(), PagesPermission) {
		t.Fatalf("missing ui.pages: %v", err)
	}
	manifest.Permissions = []string{PagesPermission}
	manifest.Contributes.Navigation = []Navigation{{ID: "overview-tools", Title: "Overview", Page: "overview", Location: PageLocationTools}}
	if err := ValidatePages(manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Contributes.Pages = append(manifest.Contributes.Pages, Page{ID: "dashboard", Title: "Dashboard", HTML: &PageHTML{Source: "<h1>Dashboard</h1>"}})
	if err := ValidatePages(manifest); err == nil || !strings.Contains(err.Error(), PageCustomHTMLPermission) {
		t.Fatalf("missing ui.html-panel: %v", err)
	}
}

func TestValidatePagesRejectsDuplicateAndMalformedDeclarations(t *testing.T) {
	for _, tt := range []struct {
		name   string
		mutate func(*Manifest)
	}{
		{"duplicate page id", func(m *Manifest) {
			m.Contributes.Pages = []Page{textPage("overview", "Overview"), textPage("overview", "Again")}
		}},
		{"duplicate navigation id", func(m *Manifest) {
			m.Contributes.Pages = []Page{textPage("overview", "Overview")}
			m.Contributes.Navigation = []Navigation{
				{ID: "entry", Title: "One", Page: "overview", Location: PageLocationTools},
				{ID: "entry", Title: "Two", Page: "overview", Location: PageLocationTools},
			}
		}},
		{"body and html", func(m *Manifest) {
			m.Contributes.Pages = []Page{{ID: "overview", Title: "Overview", Body: &UINode{Type: "text", Text: "x"}, HTML: &PageHTML{Source: "<h1>x</h1>"}}}
		}},
		{"no body", func(m *Manifest) { m.Contributes.Pages = []Page{{ID: "overview", Title: "Overview"}} }},
		{"empty title", func(m *Manifest) { m.Contributes.Pages = []Page{textPage("overview", "  ")} }},
		{"title too long", func(m *Manifest) {
			m.Contributes.Pages = []Page{textPage("overview", strings.Repeat("a", 257))}
		}},
		{"bad page id", func(m *Manifest) { m.Contributes.Pages = []Page{textPage("../escape", "Escape")} }},
		{"empty html", func(m *Manifest) {
			m.Contributes.Pages = []Page{{ID: "dashboard", Title: "Dashboard", HTML: &PageHTML{Source: " "}}}
		}},
		{"html with NUL", func(m *Manifest) {
			m.Contributes.Pages = []Page{{ID: "dashboard", Title: "Dashboard", HTML: &PageHTML{Source: "a\x00b"}}}
		}},
		{"unknown page reference", func(m *Manifest) {
			m.Contributes.Pages = []Page{textPage("overview", "Overview")}
			m.Contributes.Navigation = []Navigation{{ID: "entry", Title: "One", Page: "missing", Location: PageLocationTools}}
		}},
		{"unsupported location", func(m *Manifest) {
			m.Contributes.Pages = []Page{textPage("overview", "Overview")}
			m.Contributes.Navigation = []Navigation{{ID: "entry", Title: "One", Page: "overview", Location: "statusbar"}}
		}},
		{"order below range", func(m *Manifest) {
			m.Contributes.Pages = []Page{textPage("overview", "Overview")}
			m.Contributes.Navigation = []Navigation{{ID: "entry", Title: "One", Page: "overview", Location: PageLocationTools, Order: -1001}}
		}},
		{"order above range", func(m *Manifest) {
			m.Contributes.Pages = []Page{textPage("overview", "Overview")}
			m.Contributes.Navigation = []Navigation{{ID: "entry", Title: "One", Page: "overview", Location: PageLocationTools, Order: 1001}}
		}},
		{"undeclared button command", func(m *Manifest) {
			m.Contributes.Pages = []Page{{ID: "overview", Title: "Overview", Body: &UINode{Type: "button", Title: "Run", Command: "missing"}}}
		}},
		{"unsupported node", func(m *Manifest) {
			m.Contributes.Pages = []Page{{ID: "overview", Title: "Overview", Body: &UINode{Type: "iframe"}}}
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			manifest := pageManifest(PagesPermission, PageCustomHTMLPermission)
			tt.mutate(&manifest)
			if err := ValidatePages(manifest); err == nil {
				t.Fatal("declaration was accepted")
			}
		})
	}
}

func TestValidatePagesRejectsOversizedDeclarations(t *testing.T) {
	manifest := pageManifest(PagesPermission)
	for i := 0; i < 32; i++ {
		manifest.Contributes.Pages = append(manifest.Contributes.Pages, textPage(fmt.Sprintf("page%d", i), "Page"))
	}
	manifest.Contributes.Navigation = append(manifest.Contributes.Navigation, Navigation{ID: "entry", Title: "Entry", Page: "page0", Location: PageLocationTools})
	if err := ValidatePages(manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Contributes.Pages = append(manifest.Contributes.Pages, textPage("extra", "Extra"))
	if err := ValidatePages(manifest); err == nil {
		t.Fatal("33 pages were accepted")
	}
	manifest.Contributes.Pages = manifest.Contributes.Pages[:32]
	for i := 0; i < 32; i++ {
		manifest.Contributes.Navigation = append(manifest.Contributes.Navigation, Navigation{ID: fmt.Sprintf("entry%d", i), Title: "Entry", Page: "page0", Location: PageLocationTools})
	}
	if err := ValidatePages(manifest); err == nil {
		t.Fatal("33 navigation entries were accepted")
	}
}

func TestPageDeclarationsRoundTripJSON(t *testing.T) {
	manifest := pageManifest(PagesPermission, PageCustomHTMLPermission)
	manifest.Contributes.Pages = []Page{
		{ID: "overview", Title: "Overview", Body: &UINode{Type: "text", Text: "hello"}},
		{ID: "dashboard", Title: "Dashboard", HTML: &PageHTML{Source: "<h1>Dashboard</h1>"}},
	}
	manifest.Contributes.Navigation = []Navigation{{ID: "overview-tools", Title: "Overview", Page: "overview", Location: PageLocationTools}}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{`"pages"`, `"navigation"`, `"html":{"source"`, `"location":"tools"`} {
		if !strings.Contains(string(raw), name) {
			t.Fatalf("missing %s in %s", name, raw)
		}
	}
	if strings.Contains(string(raw), `"id":"dashboard","title":"Dashboard","body"`) {
		t.Fatalf("html page serialized an empty body: %s", raw)
	}
	var decoded Manifest
	if err = json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Contributes == nil || len(decoded.Contributes.Pages) != 2 || decoded.Contributes.Pages[0].Body == nil || decoded.Contributes.Pages[1].HTML == nil || len(decoded.Contributes.Navigation) != 1 {
		t.Fatalf("round trip: %+v", decoded.Contributes)
	}
	if err = ValidatePages(decoded); err != nil {
		t.Fatal(err)
	}
}

func TestValidatePagesAcceptsWindowTargetNavigation(t *testing.T) {
	manifest := pageManifest()
	manifest.Window = &Window{Entry: "index.html"}
	manifest.Contributes.Navigation = []Navigation{{ID: "ssh", Title: "SSH", Target: "window", Location: PageLocationTools}}
	if err := ValidatePages(manifest); err != nil {
		t.Fatalf("window navigation without ui.pages: %v", err)
	}

	withoutWindow := pageManifest()
	withoutWindow.Contributes.Navigation = []Navigation{{ID: "ssh", Title: "SSH", Target: "window", Location: PageLocationTools}}
	if err := ValidatePages(withoutWindow); err == nil {
		t.Fatal("window navigation without a window was accepted")
	}

	withPage := pageManifest()
	withPage.Window = &Window{Entry: "index.html"}
	withPage.Contributes.Navigation = []Navigation{{ID: "ssh", Title: "SSH", Target: "window", Page: "overview", Location: PageLocationTools}}
	if err := ValidatePages(withPage); err == nil {
		t.Fatal("window navigation with a page was accepted")
	}

	unknown := pageManifest()
	unknown.Window = &Window{Entry: "index.html"}
	unknown.Contributes.Navigation = []Navigation{{ID: "ssh", Title: "SSH", Target: "popover", Location: PageLocationTools}}
	if err := ValidatePages(unknown); err == nil {
		t.Fatal("unknown navigation target was accepted")
	}
}
