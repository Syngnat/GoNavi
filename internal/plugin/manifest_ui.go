package plugin

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// CustomPanelPermission is the explicit trust a package declares to ship custom
// HTML. Install previews and permission lists show it before anything runs.
const CustomPanelPermission = "ui.html-panel"

// MaxCustomPanelHTMLBytes bounds one custom HTML document. The host copies at
// most this many bytes into the sandboxed frame and renders nothing beyond it.
const MaxCustomPanelHTMLBytes = 256 << 10

// validatePanelHTML accepts bounded UTF-8 text only. Markup is inert data here:
// the host never renders it, so no sanitizer can be bypassed in the host DOM.
func validatePanelHTML(p HTMLPanel) error {
	if strings.TrimSpace(p.Source) == "" {
		return fmt.Errorf("custom html panel is empty")
	}
	if len(p.Source) > MaxCustomPanelHTMLBytes {
		return fmt.Errorf("custom html panel exceeds size limit")
	}
	if !utf8.ValidString(p.Source) || strings.ContainsRune(p.Source, 0) {
		return fmt.Errorf("custom html panel is not valid text")
	}
	return nil
}

func validateNode(n UINode, commands map[string]bool, depth int, count *int) error {
	*count++
	if depth > 16 || *count > 512 {
		return fmt.Errorf("panel tree exceeds limit")
	}
	if len(n.Text) > 16384 || len(n.Title) > 1024 || len(n.Arguments) > 64<<10 {
		return fmt.Errorf("panel text or arguments exceed limit")
	}
	if len(n.Arguments) > 0 && !json.Valid(n.Arguments) {
		return fmt.Errorf("invalid panel arguments")
	}
	switch n.Type {
	case "text", "alert", "column", "row", "button", "table":
	default:
		return fmt.Errorf("unsupported panel element")
	}
	if n.Type == "button" && !commands[n.Command] {
		return fmt.Errorf("panel button references undeclared command")
	}
	if n.Type != "button" && n.Command != "" {
		return fmt.Errorf("non-button command is unsupported")
	}
	// Keep installation and rendering in agreement: the renderer ignores fields that do not
	// belong to a node type, so a manifest that declares them must not be accepted either.
	switch n.Type {
	case "text", "alert":
		if len(n.Children) > 0 || len(n.Arguments) > 0 || len(n.Columns) > 0 || len(n.Rows) > 0 {
			return fmt.Errorf("panel element field is not supported")
		}
	case "column", "row":
		if len(n.Arguments) > 0 || len(n.Columns) > 0 || len(n.Rows) > 0 {
			return fmt.Errorf("panel element field is not supported")
		}
	case "button":
		if len(n.Children) > 0 || len(n.Columns) > 0 || len(n.Rows) > 0 {
			return fmt.Errorf("panel element field is not supported")
		}
	case "table":
		if len(n.Children) > 0 || len(n.Arguments) > 0 {
			return fmt.Errorf("panel element field is not supported")
		}
	}
	if len(n.Columns) > 32 || len(n.Rows) > 500 || len(n.Children) > 128 {
		return fmt.Errorf("panel data exceeds limit")
	}
	keys := make(map[string]bool)
	for _, c := range n.Columns {
		if !validText(c.Key, 128) || !validText(c.Title, 256) || keys[c.Key] {
			return fmt.Errorf("invalid panel column")
		}
		keys[c.Key] = true
	}
	dataBytes := 0
	for _, row := range n.Rows {
		if len(row) > 32 {
			return fmt.Errorf("panel row exceeds limit")
		}
		for key, value := range row {
			dataBytes += len(key) + len(value)
			if !keys[key] || !json.Valid(value) {
				return fmt.Errorf("invalid panel cell")
			}
		}
	}
	if dataBytes > 256<<10 {
		return fmt.Errorf("panel data exceeds byte limit")
	}
	for _, child := range n.Children {
		if err := validateNode(child, commands, depth+1, count); err != nil {
			return err
		}
	}
	return nil
}
