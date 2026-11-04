package plugin

import "fmt"

// View locations stay an enumeration. Version one docks pages on the right side
// of the workbench; the page keeps the page bridge and its permissions.
const ViewLocationRight = "right"

// MaxViews bounds docked views per manifest.
const MaxViews = 8

func validateViews(m Manifest, permissions map[string]bool) error {
	views := m.Contributes.Views
	if len(views) == 0 {
		return nil
	}
	if !permissions[PagesPermission] {
		return fmt.Errorf("views require the %s permission", PagesPermission)
	}
	if len(views) > MaxViews {
		return fmt.Errorf("too many views")
	}
	pages := make(map[string]bool, len(m.Contributes.Pages))
	for _, page := range m.Contributes.Pages {
		pages[page.ID] = true
	}
	seen := make(map[string]bool, len(views))
	for _, view := range views {
		if !localIDPattern.MatchString(view.ID) || seen[view.ID] || !validText(view.Title, 128) {
			return fmt.Errorf("invalid or duplicate view")
		}
		seen[view.ID] = true
		if !pages[view.Page] {
			return fmt.Errorf("view references an undeclared page")
		}
		if view.Location != ViewLocationRight {
			return fmt.Errorf("unsupported view location")
		}
		if view.Icon != "" && !validPackageIcon(view.Icon) {
			return fmt.Errorf("invalid view icon")
		}
		if view.Order < MinNavigationOrder || view.Order > MaxNavigationOrder {
			return fmt.Errorf("view order exceeds limit")
		}
	}
	return nil
}
