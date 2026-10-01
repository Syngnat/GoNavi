//go:build !bindings

package main

import (
	"os"
	"strings"

	"GoNavi-Wails/shared/i18n"

	"github.com/wailsapp/wails/v2/pkg/menu"
)

// macOS 菜单栏「GoNavi 设置」「主题」「驱动管理」「关于」菜单向前端派发的事件。
//
// 原生菜单只能放文字菜单项（Wails v2 的 MenuItem 没有图标字段），点击后
// 由前端复用标题栏同名按钮的处理函数，保证两处入口行为一致。
const (
	nativeOpenPreferencesEvent   = "gonavi:native-open-preferences"
	nativeToggleThemeEvent       = "gonavi:native-toggle-theme"
	nativeOpenThemeSettingsEvent = "gonavi:native-open-theme-settings"
	nativeOpenDriversEvent       = "gonavi:native-open-drivers"
	nativeCheckUpdateEvent       = "gonavi:native-check-update"
	nativeOpenAboutEvent         = "gonavi:native-open-about"
	// nativeMenuLanguageEvent 由前端在界面语言变化时发出，携带语言代码。
	// 语言偏好只存在前端持久化里，Go 启动时拿不到，所以菜单先按环境变量
	// 猜一个语言渲染，前端就绪后再按这个事件校正标签。
	nativeMenuLanguageEvent = "gonavi:native-menu-language"
	// nativeMenuThemeEvent 由前端在主题模式变化时发出，携带 "light" / "dark"。
	// 「切换主题」子项的标签要说明点击后会切到哪个模式，所以菜单需要知道当前模式。
	nativeMenuThemeEvent = "gonavi:native-menu-theme"
)

// macPreferencesMenu 是菜单栏上并列的四个顶层菜单：GoNavi 设置 / 主题 / 驱动管理 / 关于。
//
// macOS 菜单栏顶层项必须挂子菜单才能响应点击，所以「驱动管理」只有一个子项，
// 动作放在子项上；「主题」有两个子项：切换亮暗模式、打开主题设置；「关于」有两个
// 子项：检查更新、打开关于页。
type macPreferencesMenu struct {
	root          *menu.MenuItem
	preferences   *menu.MenuItem
	themeRoot     *menu.MenuItem
	theme         *menu.MenuItem
	themeSettings *menu.MenuItem
	driversRoot   *menu.MenuItem
	drivers       *menu.MenuItem
	aboutRoot     *menu.MenuItem
	checkUpdate   *menu.MenuItem
	about         *menu.MenuItem
	localizer     *i18n.Localizer
	// darkMode 是前端最近一次同步过来的主题模式；启动时前端还没就绪，先按亮色渲染。
	darkMode bool
}

// newMacPreferencesMenu 构建菜单栏里的「GoNavi 设置」「主题」「驱动管理」「关于」四个顶层菜单。
//
// 刻意不绑定快捷键：⌘, 已被前端的「快捷键管理」占用，且前端快捷键可由用户
// 自定义；原生加速键会在 WebView 之前截获按键，写死在这里会让用户的自定义失效。
func newMacPreferencesMenu(localizer *i18n.Localizer, emit func(event string)) *macPreferencesMenu {
	emitOnClick := func(event string) menu.Callback {
		return func(_ *menu.CallbackData) {
			if emit != nil {
				emit(event)
			}
		}
	}
	m := &macPreferencesMenu{
		preferences:   menu.Text("", nil, emitOnClick(nativeOpenPreferencesEvent)),
		theme:         menu.Text("", nil, emitOnClick(nativeToggleThemeEvent)),
		themeSettings: menu.Text("", nil, emitOnClick(nativeOpenThemeSettingsEvent)),
		drivers:       menu.Text("", nil, emitOnClick(nativeOpenDriversEvent)),
		checkUpdate:   menu.Text("", nil, emitOnClick(nativeCheckUpdateEvent)),
		about:         menu.Text("", nil, emitOnClick(nativeOpenAboutEvent)),
		localizer:     localizer,
	}
	m.root = menu.SubMenu("", menu.NewMenuFromItems(m.preferences))
	m.themeRoot = menu.SubMenu("", menu.NewMenuFromItems(m.theme, m.themeSettings))
	m.driversRoot = menu.SubMenu("", menu.NewMenuFromItems(m.drivers))
	m.aboutRoot = menu.SubMenu("", menu.NewMenuFromItems(m.checkUpdate, m.about))
	m.relabel()
	return m
}

// topLevelItems 按菜单栏从左到右的顺序返回要追加的顶层菜单。
func (m *macPreferencesMenu) topLevelItems() []*menu.MenuItem {
	if m == nil {
		return nil
	}
	return []*menu.MenuItem{m.root, m.themeRoot, m.driversRoot, m.aboutRoot}
}

// setTheme 同步前端当前主题模式（"dark" 之外一律按亮色处理）；返回 true 表示
// 「切换主题」的标签有变化，调用方需刷新原生菜单。
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

// setLanguage 切换菜单语言；返回 true 表示标签有变化，调用方需刷新原生菜单。
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
	t := func(key string) string {
		if m.localizer == nil {
			return key
		}
		return m.localizer.T(key, nil)
	}
	m.root.SetLabel(t("app.sidebar.settings"))
	m.preferences.SetLabel(t("app.settings.group.preferences.title"))
	m.themeRoot.SetLabel(t("app.titlebar.theme"))
	// 标签直接说明点击后的结果：当前是亮色就叫「切换暗色模式」，反之亦然。
	if m.darkMode {
		m.theme.SetLabel(t("app.native_menu.theme.to_light"))
	} else {
		m.theme.SetLabel(t("app.native_menu.theme.to_dark"))
	}
	m.themeSettings.SetLabel(t("app.native_menu.theme_settings"))
	// 顶层与子项复用同一个文案：驱动管理没有「切换」「关于 GoNavi」那样的动词/
	// 限定语，标题栏按钮用的也是这个 key，两处入口叫法保持一致。
	m.driversRoot.SetLabel(t("app.tools.entry.drivers.title"))
	m.drivers.SetLabel(t("app.tools.entry.drivers.title"))
	m.aboutRoot.SetLabel(t("app.settings.group.about.title"))
	// 检查更新复用关于页「检查更新」按钮的文案，两处入口叫法一致。
	m.checkUpdate.SetLabel(t("app.about.action.check_updates"))
	m.about.SetLabel(t("app.native_menu.about"))
}

// resolveStartupMenuLanguage 从 POSIX 语言环境变量猜首帧菜单语言。
//
// 从 Finder 启动的 .app 通常没有这些变量，会落到英文；前端就绪后发出的
// nativeMenuLanguageEvent 会立即校正，所以这里只求「大多数终端启动时不闪」。
func resolveStartupMenuLanguage() i18n.Language {
	candidates := make([]string, 0, 3)
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if value := os.Getenv(name); value != "" {
			// 形如 zh_CN.UTF-8：去掉编码后缀交给 NormalizeLanguage。
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
