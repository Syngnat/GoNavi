package plugin

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func pagesManifest(id string, permissions ...string) Manifest {
	m := basicManifest(id)
	m.Permissions = permissions
	return m
}

func textPage(id, title string) Page {
	return Page{ID: id, Title: title, Body: &UINode{Type: "text", Text: "hello"}}
}

func indexedPages(count int) []Page {
	pages := make([]Page, 0, count)
	for i := 0; i < count; i++ {
		pages = append(pages, textPage(fmt.Sprintf("page%d", i), "Page"))
	}
	return pages
}

func TestManifestAcceptsPagesAndNavigation(t *testing.T) {
	m := pagesManifest("example.pages", PagesPermission, CustomPanelPermission)
	m.Contributes.Pages = []Page{
		textPage("overview", "Overview"),
		{ID: "dashboard", Title: "Dashboard", HTML: &HTMLPanel{Source: "<h1>Dash</h1>"}},
	}
	m.Contributes.Navigation = []Navigation{
		{ID: "overview", Title: "Overview", Page: "overview", Location: PageLocationTools, Order: MinNavigationOrder},
		{ID: "dashboard-tools", Title: "Dashboard", Page: "dashboard", Location: PageLocationTools, Order: MaxNavigationOrder},
	}
	if err := ValidateManifest(m); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseManifest(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Contributes.Pages) != 2 || len(parsed.Contributes.Navigation) != 2 {
		t.Fatalf("pages or navigation dropped: %+v", parsed.Contributes)
	}
	if parsed.Contributes.Pages[1].HTML == nil || parsed.Contributes.Pages[1].HTML.Source != "<h1>Dash</h1>" {
		t.Fatalf("html page did not round-trip: %+v", parsed.Contributes.Pages[1])
	}
	if parsed.Contributes.Navigation[0].Order != MinNavigationOrder {
		t.Fatalf("navigation order did not round-trip: %d", parsed.Contributes.Navigation[0].Order)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	pages := decoded["contributes"].(map[string]any)["pages"].([]any)
	if _, present := pages[1].(map[string]any)["body"]; present {
		t.Fatal("an html page must omit the declarative body key")
	}
	if _, present := pages[0].(map[string]any)["html"]; present {
		t.Fatal("a declarative page must omit the html key")
	}
}

func TestNavigationOrderDefaultsToZero(t *testing.T) {
	raw := []byte(`{"schemaVersion":1,"apiVersion":1,"id":"example.default-order","name":"Pages","version":"1.0.0","permissions":["ui.pages"],"contributes":{"pages":[{"id":"main","title":"Main","body":{"type":"text"}}],"navigation":[{"id":"main-tools","title":"Main","page":"main","location":"tools"}]}}`)
	m, err := ParseManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if m.Contributes.Navigation[0].Order != 0 {
		t.Fatalf("default order = %d", m.Contributes.Navigation[0].Order)
	}
}

func TestPagesRequireDeclaredPermission(t *testing.T) {
	m := pagesManifest("example.pages")
	m.Contributes.Pages = []Page{textPage("overview", "Overview")}
	if ValidateManifest(m) == nil {
		t.Fatal("pages without ui.pages were accepted")
	}
	m = pagesManifest("example.navigation")
	m.Contributes.Navigation = []Navigation{{ID: "nav", Title: "Nav", Page: "missing", Location: PageLocationTools}}
	if ValidateManifest(m) == nil {
		t.Fatal("navigation without ui.pages was accepted")
	}
	m = pagesManifest("example.unused", PagesPermission)
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("ui.pages without declarations must stay valid: %v", err)
	}
}

func TestPageDeclarationRejectsUnsafeDeclarations(t *testing.T) {
	htmlPage := func(source string) []Page {
		return []Page{{ID: "dashboard", Title: "Dashboard", HTML: &HTMLPanel{Source: source}}}
	}
	cases := []struct {
		name        string
		permissions []string
		pages       []Page
	}{
		{"duplicate id", []string{PagesPermission}, []Page{textPage("dup", "First"), textPage("dup", "Second")}},
		{"both bodies", []string{PagesPermission, CustomPanelPermission}, []Page{{
			ID: "both", Title: "Both", Body: &UINode{Type: "text"}, HTML: &HTMLPanel{Source: "<p>x</p>"},
		}}},
		{"no body", []string{PagesPermission}, []Page{{ID: "empty", Title: "Empty"}}},
		{"invalid id", []string{PagesPermission}, []Page{{ID: "../escape", Title: "Escape", Body: &UINode{Type: "text"}}}},
		{"blank title", []string{PagesPermission}, []Page{{ID: "blank", Title: " ", Body: &UINode{Type: "text"}}}},
		{"title bytes", []string{PagesPermission}, []Page{{ID: "long", Title: strings.Repeat("中", 86), Body: &UINode{Type: "text"}}}},
		{"unsupported node", []string{PagesPermission}, []Page{{ID: "node", Title: "Node", Body: &UINode{Type: "html"}}}},
		{"undeclared command", []string{PagesPermission}, []Page{{ID: "button", Title: "Button", Body: &UINode{Type: "button", Command: "run"}}}},
		{"text with children", []string{PagesPermission}, []Page{{ID: "text", Title: "Text", Body: &UINode{Type: "text", Text: "x", Children: []UINode{{Type: "text", Text: "y"}}}}}},
		{"button with rows", []string{PagesPermission}, []Page{{ID: "button", Title: "Button", Body: &UINode{Type: "button", Title: "Run", Command: "run", Rows: []map[string]json.RawMessage{{"a": json.RawMessage(`1`)}}}}}},
		{"html without permission", []string{PagesPermission}, htmlPage("<p>ok</p>")},
		{"empty html", []string{PagesPermission, CustomPanelPermission}, htmlPage("  \n ")},
		{"nul html", []string{PagesPermission, CustomPanelPermission}, htmlPage("<p>a\x00b</p>")},
		{"oversized html", []string{PagesPermission, CustomPanelPermission}, htmlPage(strings.Repeat("a", MaxCustomPanelHTMLBytes+1))},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			m := pagesManifest("example.pages", test.permissions...)
			m.Contributes.Pages = test.pages
			if ValidateManifest(m) == nil {
				t.Fatalf("unsafe page declaration %q was accepted", test.name)
			}
		})
	}
}

func TestPageDeclarationAcceptsBoundedHTML(t *testing.T) {
	m := pagesManifest("example.html-page", PagesPermission, CustomPanelPermission)
	m.Contributes.Pages = []Page{{ID: "dashboard", Title: "Dashboard", HTML: &HTMLPanel{Source: strings.Repeat("中", MaxCustomPanelHTMLBytes/3)}}}
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("bounded multibyte html page was rejected: %v", err)
	}
	m.Contributes.Pages[0].HTML.Source = strings.Repeat("中", MaxCustomPanelHTMLBytes/3+1)
	if ValidateManifest(m) == nil {
		t.Fatal("html page over the byte limit was accepted")
	}
	m.Contributes.Pages[0].HTML.Source = "<p>ok</p>"
	m.Contributes.Pages[0].Title = strings.Repeat("中", 85)
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("256-byte page title was rejected: %v", err)
	}
}

func TestNavigationDeclarationRejectsUnsafeEntries(t *testing.T) {
	cases := []struct {
		name       string
		navigation Navigation
	}{
		{"invalid id", Navigation{ID: "../nav", Title: "Nav", Page: "main", Location: PageLocationTools}},
		{"blank title", Navigation{ID: "nav", Title: " ", Page: "main", Location: PageLocationTools}},
		{"undeclared page", Navigation{ID: "nav", Title: "Nav", Page: "missing", Location: PageLocationTools}},
		{"empty location", Navigation{ID: "nav", Title: "Nav", Page: "main"}},
		{"unknown location", Navigation{ID: "nav", Title: "Nav", Page: "main", Location: "menu"}},
		{"case sensitive location", Navigation{ID: "nav", Title: "Nav", Page: "main", Location: "TOOLS"}},
		{"order high", Navigation{ID: "nav", Title: "Nav", Page: "main", Location: PageLocationTools, Order: MaxNavigationOrder + 1}},
		{"order low", Navigation{ID: "nav", Title: "Nav", Page: "main", Location: PageLocationTools, Order: MinNavigationOrder - 1}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			m := pagesManifest("example.navigation", PagesPermission)
			m.Contributes.Pages = []Page{textPage("main", "Main")}
			m.Contributes.Navigation = []Navigation{test.navigation}
			if ValidateManifest(m) == nil {
				t.Fatalf("unsafe navigation %q was accepted", test.name)
			}
		})
	}
	m := pagesManifest("example.navigation", PagesPermission)
	m.Contributes.Pages = []Page{textPage("main", "Main")}
	m.Contributes.Navigation = []Navigation{{ID: "nav", Title: "Nav", Page: "main", Location: PageLocationTools}}
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("valid navigation was rejected: %v", err)
	}
	m.Contributes.Navigation = append(m.Contributes.Navigation, m.Contributes.Navigation[0])
	if ValidateManifest(m) == nil {
		t.Fatal("duplicate navigation id was accepted")
	}
}

func TestPageButtonCannotInvokeAReservedCommand(t *testing.T) {
	m := pagesManifest("example.reserved", PagesPermission, "data.sources")
	m.Backend = &Backend{Default: &Entry{Executable: "backend"}}
	m.Contributes.Commands = []Command{{ID: "query", Title: "Query", Effect: "read"}}
	m.Contributes.DataSources = []DataSource{{ID: "db", Name: "DB", Dialect: "mysql", Command: "query", ReadOnly: true}}
	m.Contributes.Pages = []Page{{ID: "main", Title: "Main", Body: &UINode{Type: "button", Title: "Run", Command: "query"}}}
	if ValidateManifest(m) == nil {
		t.Fatal("page button referencing a data source command was accepted")
	}
}

func TestNavigationWindowTargetOpensThePluginWindow(t *testing.T) {
	m := pagesManifest("example.window-nav")
	m.Window = &Window{Entry: "index.html"}
	m.Contributes.Navigation = []Navigation{{ID: "ssh", Title: "SSH", Target: PageTargetWindow, Location: PageLocationTools}}
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("window navigation without ui.pages was rejected: %v", err)
	}
	encoded, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"target":"window"`) {
		t.Fatalf("window target did not round-trip: %s", encoded)
	}
	parsed, err := ParseManifest(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Contributes.Navigation[0].Target != PageTargetWindow {
		t.Fatalf("target = %q", parsed.Contributes.Navigation[0].Target)
	}

	withoutWindow := pagesManifest("example.window-nav")
	withoutWindow.Contributes.Navigation = []Navigation{{ID: "ssh", Title: "SSH", Target: PageTargetWindow, Location: PageLocationTools}}
	if ValidateManifest(withoutWindow) == nil {
		t.Fatal("window navigation without a window was accepted")
	}

	withPage := pagesManifest("example.window-nav")
	withPage.Window = &Window{Entry: "index.html"}
	withPage.Contributes.Navigation = []Navigation{{ID: "ssh", Title: "SSH", Target: PageTargetWindow, Page: "overview", Location: PageLocationTools}}
	if ValidateManifest(withPage) == nil {
		t.Fatal("window navigation with a page was accepted")
	}

	unknown := pagesManifest("example.window-nav")
	unknown.Window = &Window{Entry: "index.html"}
	unknown.Contributes.Navigation = []Navigation{{ID: "ssh", Title: "SSH", Target: "popover", Location: PageLocationTools}}
	if ValidateManifest(unknown) == nil {
		t.Fatal("unknown navigation target was accepted")
	}
}

func TestPageAndNavigationIDNamespacesAreIndependent(t *testing.T) {
	m := pagesManifest("example.namespaces", PagesPermission)
	m.Contributes.Pages = []Page{textPage("shared", "Page")}
	m.Contributes.Navigation = []Navigation{{ID: "shared", Title: "Same name", Page: "shared", Location: PageLocationTools}}
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("cross-array id reuse must stay allowed: %v", err)
	}
}

func TestPageAndNavigationCountBounds(t *testing.T) {
	m := pagesManifest("example.counts", PagesPermission)
	m.Contributes.Pages = indexedPages(MaxPages)
	m.Contributes.Navigation = []Navigation{{ID: "nav", Title: "Nav", Page: "page0", Location: PageLocationTools}}
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("%d pages were rejected: %v", MaxPages, err)
	}
	m.Contributes.Pages = append(m.Contributes.Pages, textPage("extra", "Extra"))
	if ValidateManifest(m) == nil {
		t.Fatalf("%d pages were accepted", MaxPages+1)
	}
	m = pagesManifest("example.navigation-count", PagesPermission)
	m.Contributes.Pages = []Page{textPage("main", "Main")}
	for i := 0; i < MaxNavigation; i++ {
		m.Contributes.Navigation = append(m.Contributes.Navigation, Navigation{
			ID: fmt.Sprintf("nav%d", i), Title: "Nav", Page: "main", Location: PageLocationTools,
		})
	}
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("%d navigation entries were rejected: %v", MaxNavigation, err)
	}
	m.Contributes.Navigation = append(m.Contributes.Navigation, Navigation{ID: "extra", Title: "Nav", Page: "main", Location: PageLocationTools})
	if ValidateManifest(m) == nil {
		t.Fatalf("%d navigation entries were accepted", MaxNavigation+1)
	}
}

func TestPageNodeBudgetIsCumulative(t *testing.T) {
	page := func(id string) Page {
		children := make([]UINode, 128)
		for i := range children {
			children[i] = UINode{Type: "text"}
		}
		return Page{ID: id, Title: "Page", Body: &UINode{Type: "column", Children: children}}
	}
	m := pagesManifest("example.nodes", PagesPermission)
	m.Contributes.Pages = []Page{page("a"), page("b"), page("c")}
	if err := ValidateManifest(m); err != nil {
		t.Fatalf("bounded cumulative page tree was rejected: %v", err)
	}
	m.Contributes.Pages = append(m.Contributes.Pages, page("d"))
	if ValidateManifest(m) == nil {
		t.Fatal("page tree over the shared node budget was accepted")
	}
}

func TestParseManifestPageStrictFields(t *testing.T) {
	base := `{"schemaVersion":1,"apiVersion":1,"id":"example.pages","name":"Pages","version":"1.0.0","permissions":["ui.pages"],"contributes":%s}`
	cases := []string{
		`{"pages":[{"id":"p","title":"P","body":{"type":"text"},"icon":"x"}]}`,
		`{"pages":[{"id":"p","title":"P","body":{"type":"text","script":"evil()"}}]}`,
		`{"navigation":[{"id":"n","title":"N","page":"p","location":"tools","icon":"x"}]}`,
		`{"navigation":[{"id":"n","title":"N","page":"p","location":"tools","order":"first"}]}`,
		`{"pages":[],"menu":[]}`,
	}
	for _, contributes := range cases {
		raw := []byte(strings.Replace(base, "%s", contributes, 1))
		if _, err := ParseManifest(raw); err == nil {
			t.Fatalf("unknown or invalid page declaration was accepted: %s", contributes)
		}
	}
}
