//go:build !windows && !linux && !darwin

package nativewindow

func pluginPlatformEnvironment(string) []string { return nil }
