package nativewindow

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
)

const pluginMaxPreferencesBytes = 8192

var preferenceColor = regexp.MustCompile("(?i)^(?:#[0-9a-f]{3}(?:[0-9a-f]|[0-9a-f]{3}|[0-9a-f]{5})?|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\([0-9\\s.,%+/-]+\\)|color\\((?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65) [0-9\\s.,%+/-]+\\))$")
var preferenceFont = regexp.MustCompile("^(?:\\s*(?:\"[^\"\\\\]+\"|'[^'\\\\]+'|[-\\w ]+)\\s*)(?:,\\s*(?:\"[^\"\\\\]+\"|'[^'\\\\]+'|[-\\w ]+)\\s*)*$")

type pluginHostPreferences struct {
	Locale     string            `json:"locale"`
	Theme      string            `json:"theme"`
	Palette    map[string]string `json:"palette,omitempty"`
	Appearance map[string]any    `json:"appearance,omitempty"`
}

// UpdatePreferences fences ordered requests and exposes only safe presentation values to plugins.
func (c *PluginController) UpdatePreferences(raw json.RawMessage) error {
	safe, err := sanitizeWindowPreferences(raw)
	if err != nil {
		return err
	}
	var request struct {
		Revision uint64 `json:"requestRevision"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("plugin window controller is closed")
	}
	if request.Revision != 0 {
		if request.Revision <= c.preferenceRequestRevision {
			return errors.New("stale plugin window preference request")
		}
		c.preferenceRequestRevision = request.Revision
	}
	if !bytes.Equal(c.preferences, safe) {
		c.preferences = safe
		c.preferencesRevision++
	}
	return nil
}

func sanitizeWindowPreferences(raw json.RawMessage) (json.RawMessage, error) {
	invalid := errors.New("invalid plugin window preferences")
	if len(raw) == 0 || len(raw) > pluginMaxPreferencesBytes {
		return nil, invalid
	}
	var source map[string]json.RawMessage
	if json.Unmarshal(raw, &source) != nil || source == nil {
		return nil, invalid
	}
	for key := range source {
		if key != "locale" && key != "theme" && key != "palette" && key != "appearance" && key != "requestRevision" {
			return nil, invalid
		}
	}
	if value, ok := source["requestRevision"]; ok {
		var revision uint64
		if json.Unmarshal(value, &revision) != nil || revision == 0 || revision > 9007199254740991 {
			return nil, invalid
		}
	}
	var prefs pluginHostPreferences
	if json.Unmarshal(source["locale"], &prefs.Locale) != nil || json.Unmarshal(source["theme"], &prefs.Theme) != nil {
		return nil, invalid
	}
	switch prefs.Locale {
	case "zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "ru-RU":
	default:
		return nil, invalid
	}
	if prefs.Theme != "light" && prefs.Theme != "dark" {
		return nil, invalid
	}
	if value, ok := source["palette"]; ok {
		var colors map[string]json.RawMessage
		if json.Unmarshal(value, &colors) != nil || colors == nil {
			return nil, invalid
		}
		prefs.Palette = make(map[string]string)
		for _, key := range []string{"bg", "panel", "input", "code", "text", "muted", "border", "border1", "accent", "accentSoft", "ok", "warn", "warnBg", "chip", "hover"} {
			if value, ok := colors[key]; ok {
				var color string
				if json.Unmarshal(value, &color) != nil || len(color) > 128 || !preferenceColor.MatchString(color) {
					return nil, invalid
				}
				prefs.Palette[key] = color
			}
		}
	}
	if value, ok := source["appearance"]; ok {
		var values map[string]json.RawMessage
		if json.Unmarshal(value, &values) != nil || values == nil {
			return nil, invalid
		}
		prefs.Appearance = make(map[string]any)
		for _, key := range []string{"fontFamily", "monoFontFamily"} {
			if value, ok := values[key]; ok {
				var font string
				if json.Unmarshal(value, &font) != nil || len(font) > 512 || !preferenceFont.MatchString(font) || strings.ContainsAny(font, "\\;<>@\x00\r\n") || !safePreferenceFont(font) {
					return nil, invalid
				}
				prefs.Appearance[key] = font
			}
		}
		for key, bounds := range map[string][2]float64{"fontSize": {8, 48}, "monoFontSize": {8, 48}, "radius": {0, 32}, "opacity": {.1, 1}} {
			if value, ok := values[key]; ok {
				var number float64
				if string(value) == "null" || json.Unmarshal(value, &number) != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < bounds[0] || number > bounds[1] {
					return nil, invalid
				}
				prefs.Appearance[key] = number
			}
		}
		if value, ok := values["background"]; ok {
			var background map[string]json.RawMessage
			if json.Unmarshal(value, &background) != nil || background == nil {
				return nil, invalid
			}
			var enabled bool
			if string(background["enabled"]) == "null" || json.Unmarshal(background["enabled"], &enabled) != nil {
				return nil, invalid
			}
			safe := map[string]any{"enabled": enabled}
			if value, ok := background["tint"]; ok {
				var tint float64
				if json.Unmarshal(value, &tint) != nil || tint < .7 || tint > .95 {
					return nil, invalid
				}
				safe["tint"] = tint
			}
			prefs.Appearance["background"] = safe
		}
	}
	safe, err := json.Marshal(prefs)
	return safe, err
}

func safePreferenceFont(font string) bool {
	for _, r := range font {
		if r < 32 || r == 127 {
			return false
		}
	}
	switch strings.ToLower(strings.TrimSpace(font)) {
	case "inherit", "initial", "unset", "revert", "revert-layer":
		return false
	}
	return true
}

// preferencesLocked returns an immutable snapshot while the controller mutex is held.
func (c *PluginController) preferencesLocked(entry *pluginWindowEntry) (json.RawMessage, uint64) {
	if len(c.preferences) != 0 {
		return append(json.RawMessage(nil), c.preferences...), c.preferencesRevision
	}
	safe, _ := json.Marshal(map[string]string{"locale": entry.locale, "theme": entry.theme})
	return safe, 0
}
