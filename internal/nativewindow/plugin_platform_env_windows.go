//go:build windows

package nativewindow

import "path/filepath"

func pluginPlatformEnvironment(profile string) []string {
	// WebView2 also reads environment overrides; the parent environment is not
	// inherited, and the sole data-folder override points to this child's profile.
	return []string{"WEBVIEW2_USER_DATA_FOLDER=" + filepath.Join(profile, "webview2")}
}
