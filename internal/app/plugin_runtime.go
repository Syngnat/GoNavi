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
	// windowsMu serializes on-demand window-host creation. state.mu is never
	// held while the factory starts a controller.
	windowsMu sync.Mutex
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
			if startErr := startPluginExecution(lifetime, manager); startErr != nil {
				// Another host may own execution. This controller must still allow disable.
				logger.Warnf("Plugin execution owner unavailable; retaining local management: %v", startErr)
			} else if factory != nil && !a.webRuntime && !a.headlessRuntime {
				windows, err = factory(lifetime, manager)
				if err != nil {
					logger.Warnf("Plugin window runtime unavailable: %v", err)
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

// Plugin execution has exactly one owner, guarded by an OS file lock. A dev hot
// restart - and a quick quit-then-relaunch - overlaps the outgoing process with
// the incoming one for a moment, and a single unlocked attempt would then keep
// management while silently dropping the plugin window host for the rest of the
// session: "打开独立窗口" answered window_unavailable forever. Wait out the
// handover instead, but only for a bounded time so a real second host still
// loses the race instead of hanging startup.
const (
	pluginExecutionLeaseAttempts = 20
	pluginExecutionLeaseInterval = 250 * time.Millisecond
)

func startPluginExecution(ctx context.Context, manager *plugin.Manager) error {
	var err error
	for attempt := 0; attempt < pluginExecutionLeaseAttempts; attempt++ {
		if err = manager.Start(ctx); !errors.Is(err, plugin.ErrLocked) {
			return err
		}
		timer := time.NewTimer(pluginExecutionLeaseInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return err
}

// ensurePluginWindows returns the plugin window host and creates it on demand
// when the startup attempt could not. A quick quit-and-relaunch overlaps the
// outgoing process with the incoming one, so the incoming host can keep plugin
// management while owning no window host at all - and then answers every later
// "打开独立窗口" with window_unavailable for the rest of the session. The next
// click recovers it once the previous owner has exited.
func (a *App) ensurePluginWindows(ctx context.Context) (PluginWindowHost, error) {
	if a == nil || ctx == nil {
		return nil, errors.New("plugin window host unavailable")
	}
	state := &a.plugins
	state.mu.Lock()
	windows, manager, lifetime, factory := state.windows, state.manager, state.lifetime, state.factory
	closing := state.closing
	state.mu.Unlock()
	if windows != nil || closing || manager == nil || lifetime == nil || factory == nil || a.webRuntime || a.headlessRuntime {
		return windows, nil
	}

	state.windowsMu.Lock()
	defer state.windowsMu.Unlock()

	state.mu.Lock()
	windows, manager, lifetime, closing = state.windows, state.manager, state.lifetime, state.closing
	state.mu.Unlock()
	if windows != nil || closing || manager == nil || lifetime == nil {
		return windows, nil
	}
	if err := startPluginExecution(ctx, manager); err != nil {
		return nil, err
	}
	host, err := factory(lifetime, manager)
	if err != nil {
		return nil, err
	}
	state.mu.Lock()
	stale := state.closing || state.manager != manager
	if !stale && state.windows == nil {
		state.windows = host
	}
	winner := state.windows
	state.mu.Unlock()
	if !stale && winner == host {
		return host, nil
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := host.Close(closeCtx); err != nil {
		logger.Warnf("Plugin UI cleanup is still pending")
	}
	if stale {
		return nil, plugin.ErrClosed
	}
	return winner, nil
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
