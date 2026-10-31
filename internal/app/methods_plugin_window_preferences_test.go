package app

import (
	"encoding/json"
	"testing"
)

type preferenceTestWindows struct {
	pluginTestWindows
	updates []json.RawMessage
}

func (w *preferenceTestWindows) UpdatePreferences(raw json.RawMessage) error {
	w.updates = append(w.updates, append(json.RawMessage(nil), raw...))
	return nil
}

func TestPluginUpdateWindowPreferencesBinding(t *testing.T) {
	for _, mode := range []string{"desktop", "web", "headless", "safe", "invalid", "legacy", "ordered"} {
		t.Run(mode, func(t *testing.T) {
			a := newPluginTestApp(t)
			windows := &preferenceTestWindows{}
			a.plugins.windows = windows
			raw := `{"locale":"zh-CN","theme":"light"}`
			switch mode {
			case "ordered":
				raw = `{"locale":"zh-CN","theme":"light","requestRevision":42}`
			case "web":
				a.webRuntime = true
				t.Setenv("GONAVI_WEB_PLUGIN_MANAGEMENT", "1")
			case "headless":
				a.headlessRuntime = true
			case "safe":
				t.Setenv("GONAVI_DISABLE_PLUGINS", "1")
			case "invalid":
				raw = "null"
			case "legacy":
				a.plugins.windows = &pluginTestWindows{}
			}
			if mode == "desktop" || mode == "invalid" || mode == "legacy" || mode == "ordered" {
				if _, err := a.pluginManager(a.pluginContext()); err != nil {
					t.Fatal(err)
				}
				if mode != "legacy" {
					a.plugins.windows = windows
				} else {
					a.plugins.windows = &pluginTestWindows{}
				}
			}
			result := a.PluginUpdateWindowPreferences(raw)
			if mode == "desktop" || mode == "ordered" {
				if !result.Success || len(windows.updates) != 1 || string(windows.updates[0]) != raw {
					t.Fatalf("valid update rejected: %+v", result)
				}
				return
			}
			if result.Success || len(windows.updates) != 0 {
				t.Fatalf("%s update bypassed boundary: %+v", mode, result)
			}
		})
	}
}
