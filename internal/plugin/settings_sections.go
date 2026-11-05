package plugin

import "fmt"

// Settings slots are host-owned positions inside the settings center. Version one
// exposes only the appearance background block so the host can keep its exact
// place and title while a plugin renders the content.
const (
	SettingsSlotAppearanceBackground = "appearance.background"
)

// MaxSettingsSections bounds embedded settings blocks per manifest.
const MaxSettingsSections = 8

func validateSettingsSections(m Manifest, permissions map[string]bool) error {
	sections := m.Contributes.SettingsSections
	if len(sections) == 0 {
		return nil
	}
	if !permissions[PagesPermission] {
		return fmt.Errorf("settings sections require the %s permission", PagesPermission)
	}
	if len(sections) > MaxSettingsSections {
		return fmt.Errorf("too many settings sections")
	}
	pages := make(map[string]bool, len(m.Contributes.Pages))
	for _, page := range m.Contributes.Pages {
		pages[page.ID] = true
	}
	seen := make(map[string]bool, len(sections))
	slots := make(map[string]bool, len(sections))
	for _, section := range sections {
		if !localIDPattern.MatchString(section.ID) || seen[section.ID] {
			return fmt.Errorf("invalid or duplicate settings section")
		}
		seen[section.ID] = true
		if !pages[section.Page] {
			return fmt.Errorf("settings section references an undeclared page")
		}
		if section.Slot != SettingsSlotAppearanceBackground {
			return fmt.Errorf("unsupported settings slot")
		}
		// One provider per slot: the host renders a single block in each host-owned
		// position, so a second declaration would only be silently dropped.
		if slots[section.Slot] {
			return fmt.Errorf("duplicate settings slot")
		}
		slots[section.Slot] = true
		if section.Title != "" && !validText(section.Title, 128) {
			return fmt.Errorf("invalid settings section title")
		}
		if section.Description != "" && !validText(section.Description, 512) {
			return fmt.Errorf("invalid settings section description")
		}
		if section.Order < MinNavigationOrder || section.Order > MaxNavigationOrder {
			return fmt.Errorf("settings section order exceeds limit")
		}
	}
	return nil
}
