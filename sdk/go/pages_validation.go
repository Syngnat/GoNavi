package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// PagesPermission is the explicit trust a package declares to render its pages
// and attach their navigation to the main window. It grants no host capability.
const PagesPermission = "ui.pages"

// PageCustomHTMLPermission allows a page to declare custom HTML. A page still
// needs separate host.* permissions for every capability the bridge may call.
const PageCustomHTMLPermission = "ui.html-panel"

// PageLocationTools is the only navigation location version one accepts.
const PageLocationTools = "tools"

// Navigation targets stay an enumeration. An empty target is the page target so
// manifests written before windows could be attached keep their meaning. They stay
// unexported because the SDK guide documents the JSON contract, not Go constants.
const (
	pageTargetPage   = "page"
	pageTargetWindow = "window"
)

const (
	maxPageDeclarations  = 32
	maxNavigationEntries = 32
	minNavigationOrder   = -1000
	maxNavigationOrder   = 1000
	maxPageHTMLBytes     = 256 << 10
	maxPageNodes         = 512
	maxPageNodeDepth     = 16
)

var pageDeclarationID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)

// ValidatePages checks contributes.pages and contributes.navigation with the same
// rules as the host: both arrays are optional, but declaring either requires
// ui.pages. Ids stay unique inside each array and independent across arrays, so a
// navigation entry may reuse its page id. A page declares exactly one body; an HTML
// page also requires ui.html-panel. A declarative button may only reference a
// declared command. Validation renders nothing and grants no host capability.
func ValidatePages(manifest Manifest) error {
	if manifest.Contributes == nil {
		return nil
	}
	pages := manifest.Contributes.Pages
	navigation := manifest.Contributes.Navigation
	if len(pages) == 0 && len(navigation) == 0 {
		return nil
	}
	if len(pages) > maxPageDeclarations || len(navigation) > maxNavigationEntries {
		return errors.New("too many pages or navigation entries")
	}
	// ui.pages gates page declarations and page navigation; a window target only opens
	// the plugin's own window, exactly like a window connection action, so a manifest
	// whose navigation entries all target the window needs no page permission.
	declaresPages := len(pages) > 0
	for _, item := range navigation {
		if item.Target != pageTargetWindow {
			declaresPages = true
		}
	}
	if declaresPages && !pagePermissionGranted(manifest.Permissions, PagesPermission) {
		return fmt.Errorf("pages or navigation require the %s permission", PagesPermission)
	}
	commands := make(map[string]bool, len(manifest.Contributes.Commands))
	for _, command := range manifest.Contributes.Commands {
		commands[command.ID] = true
	}
	// A page button can only invoke commands the page gateway dispatches; commands reserved by
	// a data source, AI provider or exporter are not part of that catalogue.
	for _, source := range manifest.Contributes.DataSources {
		delete(commands, source.Command)
	}
	for _, provider := range manifest.Contributes.AIProviders {
		delete(commands, provider.Command)
	}
	for _, exporter := range manifest.Contributes.Exporters {
		delete(commands, exporter.Command)
	}
	declared, err := validatePageEntries(pages, manifest.Permissions, commands)
	if err != nil {
		return err
	}
	return validatePageNavigation(navigation, declared, manifest.Window != nil)
}

// validatePageEntries returns the declared page ids for navigation resolution.
// The node budget is cumulative across pages, exactly like host panels.
func validatePageEntries(pages []Page, permissions []string, commands map[string]bool) (map[string]bool, error) {
	declared := make(map[string]bool, len(pages))
	nodes := 0
	for _, page := range pages {
		if !pageDeclarationID.MatchString(page.ID) || declared[page.ID] || !validPageText(page.Title, 256) {
			return nil, errors.New("invalid or duplicate page")
		}
		declared[page.ID] = true
		switch {
		case page.Body != nil && page.HTML != nil:
			return nil, errors.New("page declares both a declarative body and custom html")
		case page.HTML != nil:
			if !pagePermissionGranted(permissions, PageCustomHTMLPermission) {
				return nil, fmt.Errorf("custom html page requires the %s permission", PageCustomHTMLPermission)
			}
			if err := validatePageHTML(*page.HTML); err != nil {
				return nil, err
			}
		case page.Body != nil:
			if err := validatePageNode(*page.Body, commands, 0, &nodes); err != nil {
				return nil, err
			}
		default:
			return nil, errors.New("page declares no body")
		}
	}
	return declared, nil
}

func validatePageNavigation(navigation []Navigation, pages map[string]bool, hasWindow bool) error {
	declared := make(map[string]bool, len(navigation))
	for _, item := range navigation {
		if !pageDeclarationID.MatchString(item.ID) || declared[item.ID] || !validPageText(item.Title, 256) {
			return errors.New("invalid or duplicate navigation entry")
		}
		declared[item.ID] = true
		switch item.Target {
		case "", pageTargetPage:
			if !pages[item.Page] {
				return errors.New("navigation references an undeclared page")
			}
		case pageTargetWindow:
			if !hasWindow {
				return errors.New("window navigation requires a window")
			}
			if item.Page != "" {
				return errors.New("window navigation cannot declare a page")
			}
		default:
			return errors.New("unsupported navigation target")
		}
		if item.Location != PageLocationTools {
			return errors.New("unsupported navigation location")
		}
		if item.Order < minNavigationOrder || item.Order > maxNavigationOrder {
			return errors.New("navigation order exceeds limit")
		}
	}
	return nil
}

func validatePageHTML(html PageHTML) error {
	if strings.TrimSpace(html.Source) == "" {
		return errors.New("custom html page is empty")
	}
	if len(html.Source) > maxPageHTMLBytes {
		return errors.New("custom html page exceeds size limit")
	}
	if !utf8.ValidString(html.Source) || strings.ContainsRune(html.Source, 0) {
		return errors.New("custom html page is not valid text")
	}
	return nil
}

// validatePageNode mirrors the host declarative-node budget: depth 16, 512 nodes
// per manifest, bounded text/arguments and buttons that reference declared commands.
func validatePageNode(node UINode, commands map[string]bool, depth int, count *int) error {
	*count++
	if depth > maxPageNodeDepth || *count > maxPageNodes {
		return errors.New("page tree exceeds limit")
	}
	if len(node.Text) > 16384 || len(node.Title) > 1024 || len(node.Arguments) > 64<<10 {
		return errors.New("page text or arguments exceed limit")
	}
	if len(node.Arguments) > 0 && !json.Valid(node.Arguments) {
		return errors.New("invalid page arguments")
	}
	switch node.Type {
	case "text", "alert", "column", "row", "button", "table":
	default:
		return errors.New("unsupported page element")
	}
	if node.Type == "button" && !commands[node.Command] {
		return errors.New("page button references undeclared command")
	}
	if node.Type != "button" && node.Command != "" {
		return errors.New("non-button command is unsupported")
	}
	switch node.Type {
	case "text", "alert":
		if len(node.Children) > 0 || len(node.Arguments) > 0 || len(node.Columns) > 0 || len(node.Rows) > 0 {
			return errors.New("page element field is not supported")
		}
	case "column", "row":
		if len(node.Arguments) > 0 || len(node.Columns) > 0 || len(node.Rows) > 0 {
			return errors.New("page element field is not supported")
		}
	case "button":
		if len(node.Children) > 0 || len(node.Columns) > 0 || len(node.Rows) > 0 {
			return errors.New("page element field is not supported")
		}
	case "table":
		if len(node.Children) > 0 || len(node.Arguments) > 0 {
			return errors.New("page element field is not supported")
		}
	}
	if len(node.Columns) > 32 || len(node.Rows) > 500 || len(node.Children) > 128 {
		return errors.New("page data exceeds limit")
	}
	keys := make(map[string]bool)
	for _, column := range node.Columns {
		if !validPageText(column.Key, 128) || !validPageText(column.Title, 256) || keys[column.Key] {
			return errors.New("invalid page column")
		}
		keys[column.Key] = true
	}
	dataBytes := 0
	for _, row := range node.Rows {
		if len(row) > 32 {
			return errors.New("page row exceeds limit")
		}
		for key, value := range row {
			dataBytes += len(key) + len(value)
			if !keys[key] || !json.Valid(value) {
				return errors.New("invalid page cell")
			}
		}
	}
	if dataBytes > 256<<10 {
		return errors.New("page data exceeds byte limit")
	}
	for _, child := range node.Children {
		if err := validatePageNode(child, commands, depth+1, count); err != nil {
			return err
		}
	}
	return nil
}

func pagePermissionGranted(permissions []string, want string) bool {
	for _, permission := range permissions {
		if permission == want {
			return true
		}
	}
	return false
}

func validPageText(value string, limit int) bool {
	return strings.TrimSpace(value) != "" && len(value) <= limit && !strings.ContainsRune(value, 0)
}
