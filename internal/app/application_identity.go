package app

// windowsApplicationUserModelID is the single Windows taskbar identity for
// GoNavi. It must remain stable across brand-icon changes so a pinned shortcut
// and the running process stay in the same taskbar group.
const windowsApplicationUserModelID = "Syngnat.GoNavi"

// windowsApplicationUserModelIDForIconPath intentionally ignores iconPath.
// Explorer uses the AUMID to group the running window with a pinned shortcut;
// rotating it per icon creates a second taskbar button instead of refreshing
// the existing one. Icon changes are refreshed through WM_SETICON,
// IPropertyStore, and shell notifications.
func windowsApplicationUserModelIDForIconPath(iconPath string) string {
	_ = iconPath
	return windowsApplicationUserModelID
}

// windowsApplicationUserModelIDForStartup is fixed before Wails creates the
// first HWND. It intentionally does not depend on the selected icon.
func windowsApplicationUserModelIDForStartup(configDir string) string {
	_ = configDir
	return windowsApplicationUserModelID
}

// windowsBrandShortcutMatchTargetOnlyEnv is "1" unless this executable is the
// MSI install. A portable process may sit next to an MSI pin; it may refresh
// its own shortcut icon, but it must not rewrite the other pin.
func windowsBrandShortcutMatchTargetOnlyEnv(executablePath string) string {
	if resolveUpdateInstallModeForExecutable("windows", executablePath) == updateInstallModeMSI {
		return "0"
	}
	return "1"
}
