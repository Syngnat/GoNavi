package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/plugin"
)

// PluginWindowHost exposes only the independently supervised window lifecycle.
// Open carries the host locale and theme ("light"/"dark") so plugin windows
// can follow the main application appearance.
type PluginWindowHost interface {
	Open(ctx context.Context, pluginID, windowKey string, launchContext json.RawMessage, locale, theme string) (any, error)
	Revoke(string)
	Close(context.Context) error
}

// PluginWindowFactory connects the desktop shell without an app/nativewindow cycle.
type PluginWindowFactory func(context.Context, *plugin.Manager) (PluginWindowHost, error)

type pluginRuntimeState struct {
	mutationMu sync.Mutex
	mu         sync.Mutex
	// fetch 持有 github:/npm 远程安装的一次性审批令牌（plugin_fetch_approval.go）。
	fetch        pluginFetchState
	initializing chan struct{}
	manager      *plugin.Manager
	root         string
	windows      PluginWindowHost
	factory      PluginWindowFactory
	closing      bool
	shuttingDown bool
	lifetime     context.Context
	cancel       context.CancelFunc
}

// ConfigurePluginWindows installs the desktop window factory before startup.
// It is not an App method and cannot be invoked through Wails or Web RPC.
func ConfigurePluginWindows(a *App, factory PluginWindowFactory) {
	if a == nil {
		return
	}
	a.plugins.mu.Lock()
	defer a.plugins.mu.Unlock()
	a.plugins.factory = factory
}

func pluginEnvEnabled(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func (a *App) pluginManager(ctx context.Context) (*plugin.Manager, error) {
	if a == nil || ctx == nil || a.ctx == nil || a.configDir == "" {
		return nil, errors.New("plugin lifecycle unavailable")
	}
	state := &a.plugins
	root := filepath.Join(a.configDir, "plugins")
	for {
		state.mu.Lock()
		if state.closing {
			state.mu.Unlock()
			return nil, plugin.ErrClosed
		}
		if state.manager != nil {
			manager, previous := state.manager, state.root
			state.mu.Unlock()
			if previous != root {
				return nil, errors.New("plugin data root changed; restart required")
			}
			return manager, nil
		}
		if ready := state.initializing; ready != nil {
			state.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-ready:
				continue
			}
		}
		ready := make(chan struct{})
		state.initializing = ready
		factory := state.factory
		lifetime, stop := context.WithCancel(a.ctx)
		state.lifetime, state.cancel = lifetime, stop
		state.mu.Unlock()
		manager, err := plugin.NewManager(plugin.Options{
			Root:             root,
			HostVersion:      CurrentVersion(),
			Disabled:         pluginEnvEnabled("GONAVI_DISABLE_PLUGINS"),
			HostCapability:   a.pluginHostCapability,
			ProxyEnvironment: pluginProxyEnvironment,
		})
		var windows PluginWindowHost
		if err == nil {
			if startErr := manager.Start(lifetime); startErr != nil {
				// Another host may own execution. This controller must still allow disable.
				logger.Warnf("Plugin execution owner unavailable; retaining local management")
			} else if factory != nil && !a.webRuntime && !a.headlessRuntime {
				windows, err = factory(lifetime, manager)
				if err != nil {
					logger.Warnf("Plugin window runtime unavailable")
					err = nil
				}
			}
		}
		state.mu.Lock()
		closing := state.closing
		if !closing && err == nil {
			state.manager, state.root, state.windows = manager, root, windows
		}
		if !closing && err == nil {
			state.initializing = nil
			close(ready)
		}
		state.mu.Unlock()
		if closing || err != nil {
			stop()
			closePluginResources(manager, windows)
			state.mu.Lock()
			state.initializing = nil
			close(ready)
			state.mu.Unlock()
			if closing {
				return nil, plugin.ErrClosed
			}
			return nil, err
		}
		return manager, nil
	}
}

func closePluginResources(manager *plugin.Manager, windows PluginWindowHost) bool {
	clean := true
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if windows != nil {
		if err := windows.Close(ctx); err != nil {
			logger.Warnf("Plugin UI cleanup is still pending")
			clean = false
		}
	}
	if manager != nil {
		if err := manager.Close(ctx); err != nil {
			logger.Warnf("Plugin process cleanup is still pending")
			clean = false
		}
	}
	return clean
}

func (a *App) initializePlugins(ctx context.Context) {
	if _, err := a.pluginManager(ctx); err != nil {
		logger.Warnf("Plugin runtime unavailable; core application remains usable")
	}
}

func (a *App) shutdownPlugins() {
	a.shutdownPluginMarket()
	a.plugins.fetch.close()
	if a == nil {
		return
	}
	state := &a.plugins
	state.mu.Lock()
	state.closing, state.shuttingDown = true, true
	manager, windows, cancel, ready := state.manager, state.windows, state.cancel, state.initializing
	state.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if ready != nil {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-ready:
		case <-timer.C:
			logger.Warnf("Plugin initialization cleanup is still pending")
		}
	}
	closePluginResources(manager, windows)
}

func (a *App) revokePluginWindows(id string) {
	a.plugins.mu.Lock()
	windows := a.plugins.windows
	a.plugins.mu.Unlock()
	if windows != nil {
		windows.Revoke(id)
	}
}

func (a *App) pluginContext() context.Context {
	if a != nil {
		return a.ctx
	}
	return nil
}

func (a *App) pluginManagementAllowed() bool {
	if a == nil {
		return false
	}
	if !a.webRuntime {
		return true
	}
	// Browser-server management is fail-closed unless the server operator opts in
	// with GONAVI_WEB_PLUGIN_MANAGEMENT. Browser clients cannot grant it themselves.
	return pluginEnvEnabled("GONAVI_WEB_PLUGIN_MANAGEMENT")
}
