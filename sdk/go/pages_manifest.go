package plugin

// Page declares one host-rendered surface: a bounded declarative body or a
// sandboxed custom HTML document. Exactly one of Body and HTML is present, so
// an HTML page omits the body key instead of serializing an empty tree.
// Pages require the ui.pages permission.
type Page struct {
	ID    string    `json:"id"`
	Title string    `json:"title"`
	Body  *UINode   `json:"body,omitempty"`
	HTML  *PageHTML `json:"html,omitempty"`
}

// PageHTML carries bounded custom markup as inert data. The host only renders it
// inside an opaque-origin sandboxed frame and never inlines it into the main window.
// Declaring an HTML page requires the ui.html-panel permission in addition to ui.pages.
type PageHTML struct {
	Source string `json:"source"`
}

// Navigation attaches a declared page to one host location. Location is an
// enumeration whose only version-one value is PageLocationTools; Order only
// reorders entries of the same plugin.
type Navigation struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Page     string `json:"page"`
	Location string `json:"location"`
	Order    int    `json:"order,omitempty"`
}
