package app

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/pluginmarket"
)

// pluginOfficialMarketURL seeds a fresh install with the official marketplace and
// stays release-owned: a build may override or clear it with -ldflags -X. A
// user-selected custom endpoint never becomes official merely by returning official=true.
var pluginOfficialMarketURL = "https://plugin.gonavi.org"

type pluginMarketRuntimeState struct {
	mu           sync.Mutex
	initializing chan struct{}
	service      *pluginmarket.Service
	root         string
	lifecycle    context.Context
	cancel       context.CancelFunc
	closing      bool
	approvals    map[string]*marketInstallApproval
	epoch        uint64
}

func (a *App) marketplace(ctx context.Context) (*pluginmarket.Service, context.Context, error) {
	if a == nil || ctx == nil || a.ctx == nil {
		return nil, nil, errors.New("marketplace lifecycle unavailable")
	}
	state := &a.pluginMarket
	root := filepath.Join(a.configDir, "plugin-market")
	for {
		state.mu.Lock()
		if state.closing {
			state.mu.Unlock()
			return nil, nil, context.Canceled
		}
		if state.service != nil {
			service, life, previous := state.service, state.lifecycle, state.root
			state.mu.Unlock()
			if previous != root {
				return nil, nil, errors.New("marketplace data root changed; restart required")
			}
			return service, life, nil
		}
		if ready := state.initializing; ready != nil {
			state.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, nil, ctx.Err()
			case <-ready:
				continue
			}
		}
		ready := make(chan struct{})
		state.initializing = ready
		epoch := state.epoch
		state.mu.Unlock()
		service, err := pluginmarket.NewService(pluginmarket.Options{Root: root, HostVersion: CurrentVersion(), TrustedOfficialURL: pluginOfficialMarketURL, Client: &http.Client{Transport: backgroundGalleryProxyTransport{}}})
		state.mu.Lock()
		if state.closing || state.epoch != epoch || root != filepath.Join(a.configDir, "plugin-market") {
			err = context.Canceled
		}
		if err == nil {
			state.service, state.root = service, root
			state.lifecycle, state.cancel = context.WithCancel(a.ctx)
		}
		life := state.lifecycle
		state.initializing = nil
		close(ready)
		state.mu.Unlock()
		return service, life, err
	}
}

func (a *App) marketCall(parent context.Context, call func(context.Context, *pluginmarket.Service) (any, error)) connection.QueryResult {
	service, life, err := a.marketplace(parent)
	if err != nil {
		return a.pluginFailure("market_unavailable")
	}
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(life, cancel)
	defer func() { stop(); cancel() }()
	value, err := call(ctx, service)
	if err == nil {
		return connection.QueryResult{Success: true, Data: value}
	}
	code := marketFailureCode(err)
	result := a.pluginFailure(code)
	// A failed refresh may still carry explicitly stale, last-good catalog data.
	if page, ok := value.(pluginmarket.CatalogPage); ok {
		result.Data = page
	}
	if status, ok := value.(plugin.Status); ok {
		result.Data = map[string]any{"code": code, "installed": status, "provenanceRecorded": false}
	}
	return result
}

func (a *App) shutdownPluginMarket() {
	if a == nil {
		return
	}
	a.pluginMarket.mu.Lock()
	a.pluginMarket.closing = true
	a.pluginMarket.epoch++
	cancel := a.pluginMarket.cancel
	approvals := a.pluginMarket.approvals
	a.pluginMarket.approvals = nil
	a.pluginMarket.mu.Unlock()
	for _, approval := range approvals {
		approval.dispose()
	}
	if cancel != nil {
		cancel()
	}
}
