package nativewindow

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/plugin"
)

const pluginEnvPrefix = "GONAVI_PLUGIN_WINDOW_"

func (c *PluginController) processSpec(entry *pluginWindowEntry, status plugin.Status) pluginProcessSpec {
	env := pluginChildEnvironment(os.Environ(), entry.profile)
	values := map[string]string{
		"ENDPOINT": c.endpoint, "TOKEN": entry.token, "ID": entry.info.ID,
		"PARENT_PID": strconv.Itoa(os.Getpid()), "PROFILE": entry.profile, "TITLE": entry.title,
		"WIDTH":  strconv.Itoa(pluginWindowDimension(status.Manifest.Window.Width, 960, 320, 3840)),
		"HEIGHT": strconv.Itoa(pluginWindowDimension(status.Manifest.Window.Height, 720, 240, 2160)),
		// 宿主外观镜像：子进程把它注入插件 entry HTML，插件窗口据此跟随语言/主题。
		"LOCALE": sanitizeHostPref(entry.locale), "THEME": sanitizeHostPref(entry.theme),
	}
	for key, value := range values {
		env = append(env, pluginEnvPrefix+key+"="+value)
	}
	return pluginProcessSpec{executable: c.executable, args: []string{strings.TrimLeft(PluginWindowArgument, "-")}, env: env, directory: entry.profile}
}

func pluginChildEnvironment(parent []string, profile string) []string {
	// Allowlisting, instead of removing a few known tokens, prevents accidental
	// inheritance of database/cloud credentials, App RPC and development servers.
	allowed := map[string]bool{
		"SYSTEMROOT": true, "WINDIR": true, "SYSTEMDRIVE": true, "COMSPEC": true,
		"DISPLAY": true, "WAYLAND_DISPLAY": true, "XAUTHORITY": true, "XDG_RUNTIME_DIR": true,
		"DBUS_SESSION_BUS_ADDRESS": true, "LANG": true, "LC_ALL": true, "LC_CTYPE": true,
	}
	result := make([]string, 0, len(allowed)+14)
	seen := make(map[string]bool, len(allowed))
	for _, item := range parent {
		key, _, ok := strings.Cut(item, "=")
		upper := strings.ToUpper(key)
		if ok && allowed[upper] && !seen[upper] {
			result = append(result, item)
			seen[upper] = true
		}
	}
	for key, value := range map[string]string{
		"HOME": profile, "USERPROFILE": profile,
		"APPDATA": filepath.Join(profile, "config"), "LOCALAPPDATA": filepath.Join(profile, "cache"),
		"XDG_CONFIG_HOME": filepath.Join(profile, "config"), "XDG_DATA_HOME": filepath.Join(profile, "data"),
		"XDG_CACHE_HOME": filepath.Join(profile, "cache"), "TMP": filepath.Join(profile, "tmp"),
		"TEMP": filepath.Join(profile, "tmp"), "TMPDIR": filepath.Join(profile, "tmp"),
	} {
		result = append(result, key+"="+value)
	}
	return append(result, pluginPlatformEnvironment(profile)...)
}

func preparePluginProfile(profile string) error {
	for _, part := range []string{"config", "data", "cache", "tmp"} {
		if err := os.MkdirAll(filepath.Join(profile, part), 0700); err != nil {
			return fmt.Errorf("prepare plugin webview profile: %w", err)
		}
	}
	return nil
}

func pluginWindowDimension(value, fallback, minimum, maximum int) int {
	if value <= 0 {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}
