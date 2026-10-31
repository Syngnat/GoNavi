package app

import "strings"

// PluginIcon returns one bounded raster data URL for an installed plugin logo. The package is
// read as metadata only: the plugin is never started, enabled or invoked, and the bytes are
// sniffed before they reach the window. An empty string means "no logo declared or readable",
// and the UI falls back to a monogram. Management policy does not gate this read because a
// logo is non-executable metadata, exactly like the market's published description.
func (a *App) PluginIcon(id string) string {
	if a == nil {
		return ""
	}
	manager, err := a.pluginManager(a.pluginContext())
	if err != nil || manager == nil {
		return ""
	}
	return manager.IconDataURL(strings.TrimSpace(id))
}
