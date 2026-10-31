package plugin

import (
	"encoding/base64"
	"net/http"
)

// IconPath returns the package-relative raster path the host should render for this plugin.
// The manifest icon wins; manifests that only declared an AI provider icon still get a logo.
func (m Manifest) IconPath() string {
	if m.Icon != "" {
		return m.Icon
	}
	for _, provider := range m.Contributes.AIProviders {
		if provider.Icon != "" {
			return provider.Icon
		}
	}
	return ""
}

// RasterIconDataURL turns bounded package bytes into a data URL, or "" when the content is not
// a sniffable raster image. SVG is refused: icons render in the main window, so an executable
// vector document is not needed.
func RasterIconDataURL(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	mimeType := http.DetectContentType(data)
	switch mimeType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)
	default:
		return ""
	}
}

// IconDataURL reads the declared logo of an installed plugin as a bounded raster data URL.
// It never starts, enables or invokes the plugin, so logos render for disabled packages too.
func (m *Manager) IconDataURL(id string) string {
	if m == nil || id == "" {
		return ""
	}
	for _, status := range m.List() {
		if status.Manifest.ID != id {
			continue
		}
		icon := status.Manifest.IconPath()
		if icon == "" {
			return ""
		}
		data, err := m.ReadPackageFile(id, icon, maxPackageIconBytes)
		if err != nil {
			return ""
		}
		return RasterIconDataURL(data)
	}
	return ""
}
