package plugin

import "fmt"

// SidebarPermission lets a package attach an expandable group to the host's
// left connection tree. Node data is produced by a declared command and
// rendered by the host as text; the permission grants no host capability.
const SidebarPermission = "ui.sidebar"

// Sidebar groups are bounded per manifest, and order only reorders groups of
// the same plugin.
const MaxSidebarGroups = 4

// validateSidebar enforces the sidebar declaration contract. Runtime node data
// is validated separately by the host before it reaches the tree.
func validateSidebar(m Manifest, permissions, commands map[string]bool) error {
	groups := m.Contributes.Sidebar
	if len(groups) == 0 {
		return nil
	}
	if !permissions[SidebarPermission] {
		return fmt.Errorf("sidebar requires the %s permission", SidebarPermission)
	}
	if len(groups) > MaxSidebarGroups {
		return fmt.Errorf("too many sidebar groups")
	}
	pages := make(map[string]bool, len(m.Contributes.Pages))
	for _, page := range m.Contributes.Pages {
		pages[page.ID] = true
	}
	seen := make(map[string]bool, len(groups))
	for _, group := range groups {
		if !localIDPattern.MatchString(group.ID) || seen[group.ID] || !validText(group.Title, 128) {
			return fmt.Errorf("invalid or duplicate sidebar group")
		}
		seen[group.ID] = true
		if !commands[group.ListCommand] {
			return fmt.Errorf("sidebar list command is not declared")
		}
		if group.EmptyText != "" && !validText(group.EmptyText, 128) {
			return fmt.Errorf("invalid sidebar empty text")
		}
		if group.Icon != "" && !validPackageIcon(group.Icon) {
			return fmt.Errorf("invalid sidebar icon")
		}
		if group.Order < MinNavigationOrder || group.Order > MaxNavigationOrder {
			return fmt.Errorf("sidebar order exceeds limit")
		}
		if group.Open == nil {
			continue
		}
		switch group.Open.Type {
		case "window":
			if m.Window == nil {
				return fmt.Errorf("window sidebar target requires a window")
			}
			if group.Open.Page != "" {
				return fmt.Errorf("window sidebar target cannot declare a page")
			}
		case "page":
			if !permissions[PagesPermission] {
				return fmt.Errorf("page sidebar target requires the %s permission", PagesPermission)
			}
			if !pages[group.Open.Page] {
				return fmt.Errorf("sidebar references an undeclared page")
			}
		default:
			return fmt.Errorf("unsupported sidebar target")
		}
	}
	return nil
}
