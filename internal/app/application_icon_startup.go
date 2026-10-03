package app

import (
	"context"
	"errors"
	"strings"
)

// InitializePersistedNativeBrandIcon applies the last selected desktop icon
// before the first Wails window is shown. It is intentionally a package
// function so it is not exposed through the reflective Wails bridge.
func InitializePersistedNativeBrandIcon(a *App, ctx context.Context) error {
	if a == nil {
		return errors.New("application is unavailable")
	}

	// The WebView can call SetApplicationBrandIcon while OnStartup is still
	// restoring the persisted icon. Publish the runtime context first, then use
	// the same lock as the Wails method so both updates run in a defined order.
	// a.ctx 只在此处发布一次：latch 打开后 app.startup 还会无锁写 a.ctx
	//（app.go:511），若这里之后再写会产生数据竞争（审查发现）。
	if a.ctx == nil {
		a.ctx = ctx
	}
	applicationBrandIconMu.Lock()
	defer applicationBrandIconMu.Unlock()

	configDir := strings.TrimSpace(a.configDir)
	if configDir == "" {
		configDir = resolveAppConfigDir()
		a.configDir = configDir
	}
	return applyPersistedWindowsApplicationIcon(ctx, configDir)
}
