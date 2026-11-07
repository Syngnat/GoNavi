//go:build linux

package nativewindow

func pluginPlatformEnvironment(string) []string {
	return []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
}
