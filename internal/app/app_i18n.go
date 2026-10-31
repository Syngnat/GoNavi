package app

import (
	"sync"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/shared/i18n"
)

// 本文件持有 App 的多语言辅助：默认 localizer 与实例级文案翻译。
// 自 app.go 拆出，保持该债务文件不净增长。

var (
	defaultAppTextMu        sync.RWMutex
	defaultAppTextLanguage  = i18n.LanguageEnUS
	defaultAppTextLocalizer *i18n.Localizer
)

func newAppLocalizer() *i18n.Localizer {
	localizer, err := i18n.NewLocalizer(i18n.LanguageEnUS)
	if err != nil {
		logger.Warnf("加载应用多语言目录失败：%v", err)
		return nil
	}
	return localizer
}

func setDefaultAppLanguage(language i18n.Language) {
	defaultAppTextMu.Lock()
	defer defaultAppTextMu.Unlock()

	defaultAppTextLanguage = language
	if defaultAppTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(language)
		if err != nil {
			logger.Warnf("加载默认多语言目录失败：%v", err)
			return
		}
		defaultAppTextLocalizer = localizer
		return
	}
	defaultAppTextLocalizer.SetLanguage(language)
}

func defaultAppText(key string, params map[string]any) string {
	defaultAppTextMu.RLock()
	if defaultAppTextLocalizer != nil {
		text := defaultAppTextLocalizer.T(key, params)
		defaultAppTextMu.RUnlock()
		return text
	}
	defaultAppTextMu.RUnlock()

	defaultAppTextMu.Lock()
	defer defaultAppTextMu.Unlock()
	if defaultAppTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(defaultAppTextLanguage)
		if err != nil {
			logger.Warnf("加载默认多语言目录失败：%v", err)
			return key
		}
		defaultAppTextLocalizer = localizer
	}
	return defaultAppTextLocalizer.T(key, params)
}

func (a *App) appText(key string, params map[string]any) string {
	if a == nil {
		return key
	}
	a.i18nMu.RLock()
	if a.localizer != nil {
		text := a.localizer.T(key, params)
		a.i18nMu.RUnlock()
		return text
	}
	a.i18nMu.RUnlock()

	a.i18nMu.Lock()
	defer a.i18nMu.Unlock()
	if a.localizer == nil {
		a.localizer = newAppLocalizer()
	}
	if a.localizer == nil {
		return key
	}
	return a.localizer.T(key, params)
}
