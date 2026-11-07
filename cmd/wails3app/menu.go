//go:build wails3

package main

import (
	"os"
	"strings"

	"GoNavi-Wails/shared/i18n"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const (
	nativeOpenPreferencesEvent   = "gonavi:native-open-preferences"
	nativeToggleThemeEvent       = "gonavi:native-toggle-theme"
	nativeOpenThemeSettingsEvent = "gonavi:native-open-theme-settings"
	nativeOpenDriversEvent       = "gonavi:native-open-drivers"
	nativeCheckUpdateEvent       = "gonavi:native-check-update"
	nativeOpenAboutEvent         = "gonavi:native-open-about"
	nativeMenuLanguageEvent      = "gonavi:native-menu-language"
	nativeMenuThemeEvent         = "gonavi:native-menu-theme"
)

// macPreferencesMenu is the v3 port of the v2 preferences menu: four top-level
// menus that dispatch the same frontend events, relabelled when the frontend
// reports a language or theme change.
type macPreferencesMenu struct {
	root          *application.Menu
	preferences   *application.MenuItem
	themeRoot     *application.Menu
	theme         *application.MenuItem
	themeSettings *application.MenuItem
	driversRoot   *application.Menu
	drivers       *application.MenuItem
	aboutRoot     *application.Menu
	checkUpdate   *application.MenuItem
	about         *application.MenuItem
	localizer     *i18n.Localizer
	darkMode      bool
	emit          func(string)
}

func newMacPreferencesMenu(localizer *i18n.Localizer, emit func(string)) *macPreferencesMenu {
	return &macPreferencesMenu{localizer: localizer, emit: emit}
}

func (m *macPreferencesMenu) click(event string) func(*application.Context) {
	return func(*application.Context) {
		if m.emit != nil {
			m.emit(event)
		}
	}
}

func (m *macPreferencesMenu) appendTo(menu *application.Menu) {
	if m == nil || menu == nil {
		return
	}
	m.root = menu.AddSubmenu("")
	m.preferences = m.root.Add("")
	m.preferences.OnClick(m.click(nativeOpenPreferencesEvent))
	m.themeRoot = menu.AddSubmenu("")
	m.theme = m.themeRoot.Add("")
	m.theme.OnClick(m.click(nativeToggleThemeEvent))
	m.themeSettings = m.themeRoot.Add("")
	m.themeSettings.OnClick(m.click(nativeOpenThemeSettingsEvent))
	m.driversRoot = menu.AddSubmenu("")
	m.drivers = m.driversRoot.Add("")
	m.drivers.OnClick(m.click(nativeOpenDriversEvent))
	m.aboutRoot = menu.AddSubmenu("")
	m.checkUpdate = m.aboutRoot.Add("")
	m.checkUpdate.OnClick(m.click(nativeCheckUpdateEvent))
	m.about = m.aboutRoot.Add("")
	m.about.OnClick(m.click(nativeOpenAboutEvent))
	m.relabel()
}

func (m *macPreferencesMenu) setTheme(mode string) bool {
	if m == nil {
		return false
	}
	dark := strings.EqualFold(strings.TrimSpace(mode), "dark")
	if dark == m.darkMode {
		return false
	}
	m.darkMode = dark
	m.relabel()
	return true
}

func (m *macPreferencesMenu) setLanguage(value string) bool {
	if m == nil || m.localizer == nil {
		return false
	}
	language, ok := i18n.NormalizeLanguage(value)
	if !ok || language == m.localizer.Language() {
		return false
	}
	m.localizer.SetLanguage(language)
	m.relabel()
	return true
}

func (m *macPreferencesMenu) relabel() {
	if m == nil {
		return
	}
	t := func(key string) string {
		if m.localizer == nil {
			return key
		}
		return m.localizer.T(key, nil)
	}
	m.root.SetLabel(t("app.sidebar.settings"))
	m.preferences.SetLabel(t("app.settings.group.preferences.title"))
	m.themeRoot.SetLabel(t("app.titlebar.theme"))
	if m.darkMode {
		m.theme.SetLabel(t("app.native_menu.theme.to_light"))
	} else {
		m.theme.SetLabel(t("app.native_menu.theme.to_dark"))
	}
	m.themeSettings.SetLabel(t("app.native_menu.theme_settings"))
	m.driversRoot.SetLabel(t("app.tools.entry.drivers.title"))
	m.drivers.SetLabel(t("app.tools.entry.drivers.title"))
	m.aboutRoot.SetLabel(t("app.settings.group.about.title"))
	m.checkUpdate.SetLabel(t("app.about.action.check_updates"))
	m.about.SetLabel(t("app.native_menu.about"))
}

// resolveStartupMenuLanguage guesses the first-frame menu language from the
// POSIX locale; the frontend corrects it as soon as it reports its preference.
func resolveStartupMenuLanguage() i18n.Language {
	candidates := make([]string, 0, 3)
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if value := os.Getenv(name); value != "" {
			for i, r := range value {
				if r == '.' || r == '@' {
					value = value[:i]
					break
				}
			}
			candidates = append(candidates, value)
		}
	}
	return i18n.ResolveLanguage("", candidates)
}
