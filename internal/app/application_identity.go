package app

import (
	"strings"
)

// windowsApplicationUserModelID is the base Windows taskbar identity for
// GoNavi. Explorer caches the taskbar group icon under this key and never
// re-renders it, so any brand-icon selection must rotate to a fresh identity
// instead of reusing the cached one.
const windowsApplicationUserModelID = "Syngnat.GoNavi"

const (
	windowsApplicationUserModelIDIconPrefix = "gonavi-brand-"
	windowsApplicationUserModelIDIconSuffix = ".Icon."
)

// windowsApplicationUserModelIDForIconPath derives the taskbar identity from a
// content-addressed brand ICO (gonavi-brand-<hash>.ico). The hash token makes
// each selection a brand-new identity for Explorer, which forces the taskbar
// group to render the new icon instead of serving the bitmap cached under the
// previous identity. Paths outside the brand-icon scheme keep the base
// identity.
//
// 文件名提取同时识别 \ 与 /：不能用 filepath.Base——Linux 上反斜杠是普通字符，
// 整条 Windows 路径会被当成一个文件名，轮换判定随宿主 OS 漂移（CI 全量套件
// 曾因此在 Linux 连红）。AUMID 虽是 Windows 概念，但解析逻辑必须跨平台确定。
func windowsApplicationUserModelIDForIconPath(iconPath string) string {
	name := iconPath
	if index := strings.LastIndexAny(name, `\/`); index >= 0 {
		name = name[index+1:]
	}
	name = strings.TrimSuffix(name, ".ico")
	if !strings.HasPrefix(name, windowsApplicationUserModelIDIconPrefix) {
		return windowsApplicationUserModelID
	}
	token := strings.ToLower(strings.TrimPrefix(name, windowsApplicationUserModelIDIconPrefix))
	if token == "" || len(token) > 64 {
		return windowsApplicationUserModelID
	}
	for _, r := range token {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return windowsApplicationUserModelID
		}
	}
	return windowsApplicationUserModelID + windowsApplicationUserModelIDIconSuffix + token
}

// windowsApplicationUserModelIDForStartup derives the process identity from the
// persisted brand selection. It must run before the first window exists so the
// taskbar groups the window under an identity whose icon cache already matches
// the active icon. Any read failure degrades to the base identity, which keeps
// a broken state file from stranding the window on an orphaned group.
func windowsApplicationUserModelIDForStartup(configDir string) string {
	iconPath, err := loadPersistedWindowsApplicationIcon(configDir)
	if err != nil || strings.TrimSpace(iconPath) == "" {
		return windowsApplicationUserModelID
	}
	return windowsApplicationUserModelIDForIconPath(iconPath)
}
