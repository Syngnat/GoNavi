package plugin

import "fmt"

// PagesPermission is the explicit trust a package declares to render its pages
// and attach their navigation to the main window.
const PagesPermission = "ui.pages"

// Host capability permissions gate page calls through the page gateway. They
// never grant page rendering on their own.
const (
	ConnectionsReadPermission        = "host.connections.read"
	ConnectionsCredentialsPermission = "host.connections.credentials"
	MetadataReadPermission           = "host.metadata.read"
	QueryReadPermission              = "host.query.read"
	SchemaWritePermission            = "host.schema.write"
)

// OpenExternalPermission lets a page or a plugin window hand one http(s) link
// to the system browser. It grants no in-app navigation and no file, mail or
// custom-scheme handler. The identifier stays lowercase because manifest
// permissions must match ^[a-z][a-z0-9._:-]{0,127}$.
const OpenExternalPermission = "system.open-external"

// PageLocationTools is the only navigation location v1 accepts: the title-bar
// plugin menu. Unknown values stay rejected so a typo cannot silently render
// nothing.
const PageLocationTools = "tools"

// Page and navigation declarations are bounded per manifest, and navigation
// order only reorders entries of the same plugin.
const (
	MaxPages           = 32
	MaxNavigation      = 32
	MinNavigationOrder = -1000
	MaxNavigationOrder = 1000
)

// validatePages enforces the pages and navigation contract. Both arrays are
// optional, but declaring either requires ui.pages. Ids stay unique inside each
// array and independent across arrays, so a navigation entry may reuse its
// page id.
func validatePages(manifest Manifest, permissions, commands map[string]bool) error {
	pages := manifest.Contributes.Pages
	navigation := manifest.Contributes.Navigation
	if len(pages) == 0 && len(navigation) == 0 {
		return nil
	}
	if !permissions[PagesPermission] {
		return fmt.Errorf("pages or navigation require the %s permission", PagesPermission)
	}
	if len(pages) > MaxPages || len(navigation) > MaxNavigation {
		return fmt.Errorf("too many pages or navigation entries")
	}
	declared, err := validatePageDeclarations(pages, permissions, commands)
	if err != nil {
		return err
	}
	return validateNavigationDeclarations(navigation, declared)
}

// validatePageDeclarations returns the declared page ids for navigation
// resolution. The node budget is cumulative across pages, exactly like panels.
func validatePageDeclarations(pages []Page, permissions, commands map[string]bool) (map[string]bool, error) {
	declared := make(map[string]bool, len(pages))
	nodes := 0
	for _, page := range pages {
		if !localIDPattern.MatchString(page.ID) || declared[page.ID] || !validText(page.Title, 256) {
			return nil, fmt.Errorf("invalid or duplicate page")
		}
		declared[page.ID] = true
		switch {
		case page.Body != nil && page.HTML != nil:
			return nil, fmt.Errorf("page declares both a declarative body and custom html")
		case page.HTML != nil:
			if !permissions[CustomPanelPermission] {
				return nil, fmt.Errorf("custom html page requires the %s permission", CustomPanelPermission)
			}
			if err := validatePanelHTML(*page.HTML); err != nil {
				return nil, err
			}
		case page.Body != nil:
			if err := validateNode(*page.Body, commands, 0, &nodes); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("page declares no body")
		}
	}
	return declared, nil
}

func validateNavigationDeclarations(navigation []Navigation, pages map[string]bool) error {
	declared := make(map[string]bool, len(navigation))
	for _, item := range navigation {
		if !localIDPattern.MatchString(item.ID) || declared[item.ID] || !validText(item.Title, 256) {
			return fmt.Errorf("invalid or duplicate navigation entry")
		}
		declared[item.ID] = true
		if !pages[item.Page] {
			return fmt.Errorf("navigation references an undeclared page")
		}
		if item.Location != PageLocationTools {
			return fmt.Errorf("unsupported navigation location")
		}
		if item.Order < MinNavigationOrder || item.Order > MaxNavigationOrder {
			return fmt.Errorf("navigation order exceeds limit")
		}
	}
	return nil
}
