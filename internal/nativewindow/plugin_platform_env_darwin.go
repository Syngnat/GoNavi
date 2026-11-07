//go:build darwin

package nativewindow

func pluginPlatformEnvironment(string) []string {
	return []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
}
