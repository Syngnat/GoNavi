package plugin

import (
	"fmt"
	"regexp"
	"strings"
)

// MaxKeybindings bounds shortcuts per manifest.
const MaxKeybindings = 16

var keybindingMainKeyPattern = regexp.MustCompile(`^[A-Za-z0-9]+$`)

var keybindingModifiers = map[string]bool{
	"CmdOrCtrl": true, "Ctrl": true, "Cmd": true, "Alt": true, "Shift": true,
}

// ValidKeybindingKeys accepts one or more modifiers followed by exactly one
// main key, e.g. "CmdOrCtrl+Shift+T".
func ValidKeybindingKeys(value string) bool {
	parts := strings.Split(value, "+")
	if len(parts) < 1 || len(parts) > 5 {
		return false
	}
	main := strings.TrimSpace(parts[len(parts)-1])
	if main == "" || len(main) > 16 || !keybindingMainKeyPattern.MatchString(main) {
		return false
	}
	for _, modifier := range parts[:len(parts)-1] {
		if !keybindingModifiers[strings.TrimSpace(modifier)] {
			return false
		}
	}
	return true
}

func validateKeybindings(m Manifest, permissions map[string]bool) error {
	bindings := m.Contributes.Keybindings
	if len(bindings) == 0 {
		return nil
	}
	if len(bindings) > MaxKeybindings {
		return fmt.Errorf("too many keybindings")
	}
	pages := make(map[string]bool, len(m.Contributes.Pages))
	for _, page := range m.Contributes.Pages {
		pages[page.ID] = true
	}
	seen := make(map[string]bool, len(bindings))
	seenKeys := make(map[string]bool, len(bindings))
	for _, binding := range bindings {
		if !localIDPattern.MatchString(binding.ID) || seen[binding.ID] || !validText(binding.Title, 128) {
			return fmt.Errorf("invalid or duplicate keybinding")
		}
		seen[binding.ID] = true
		if !ValidKeybindingKeys(binding.Keys) {
			return fmt.Errorf("invalid keybinding keys")
		}
		key := strings.ToLower(binding.Keys)
		if seenKeys[key] {
			return fmt.Errorf("duplicate keybinding keys")
		}
		seenKeys[key] = true
		switch binding.Target.Type {
		case "window":
			if m.Window == nil {
				return fmt.Errorf("window keybinding requires a window")
			}
			if binding.Target.Page != "" {
				return fmt.Errorf("window keybinding cannot declare a page")
			}
		case "page":
			if !permissions[PagesPermission] {
				return fmt.Errorf("page keybinding requires the %s permission", PagesPermission)
			}
			if !pages[binding.Target.Page] {
				return fmt.Errorf("keybinding references an undeclared page")
			}
		default:
			return fmt.Errorf("unsupported keybinding target")
		}
	}
	return nil
}
