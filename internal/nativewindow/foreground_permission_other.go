//go:build !windows && !wails3

package nativewindow

func grantParentForegroundAccess() error {
	return nil
}
