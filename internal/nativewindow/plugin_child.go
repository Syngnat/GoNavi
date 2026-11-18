//go:build !wails3

package nativewindow

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"GoNavi-Wails/internal/desktop"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// RunPluginChild starts only an isolated plugin UI. Dispatch this before
// creating App, host bindings, credentials, or the main frontend runtime.
func RunPluginChild(parentCtx context.Context, args []string) error {
	cfg, err := parsePluginChildOptions(args)
	if err != nil {
		return err
	}
	signalCtx, stopSignals := signal.NotifyContext(parentCtx, os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	// Separate normal Wails shutdown from host/signal termination: do not post
	// another Quit to a native event loop that has already exited.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := preparePluginProfile(cfg.profile); err != nil {
		return err
	}
	watcher, err := newDetachedParentWatcher(cfg.parentPID)
	if err != nil {
		return fmt.Errorf("watch plugin window parent: %w", err)
	}
	defer watcher.Close()
	var watchWG sync.WaitGroup
	defer func() { cancel(); watchWG.Wait() }()
	transport := &http.Transport{Proxy: nil, MaxConnsPerHost: 16, MaxIdleConnsPerHost: 4, ResponseHeaderTimeout: 32 * time.Second}
	defer transport.CloseIdleConnections()
	// wails 启动上下文在 OnStartup 异步到达；文件选择器路由在就绪前返回 503。
	var wailsCtxPtr atomic.Pointer[context.Context]
	handler := &pickPathHandler{next: newPluginChildProxy(cfg, transport), wailsCtx: &wailsCtxPtr,
		openFile: desktop.OpenFileDialog, openFolder: desktop.OpenDirectoryDialog}
	app := &options.App{Title: cfg.title, Width: cfg.width, Height: cfg.height, MinWidth: 320, MinHeight: 240,
		AssetServer: &assetserver.Options{Handler: handler},
		DragAndDrop: &options.DragAndDrop{DisableWebViewDrop: true},
		// No App, no detached bridge, and no Go methods are bound to this WebView.
		Bind: []interface{}{}, OnStartup: func(wailsCtx context.Context) {
			started := wailsCtx
			wailsCtxPtr.Store(&started)
			watchWG.Add(1)
			go func() {
				defer watchWG.Done()
				watchPluginChild(ctx, signalCtx, cfg, watcher, transport, func() { desktop.Quit(wailsCtx) })
			}()
		}, OnShutdown: func(context.Context) { cancel() }}
	if err := configurePluginWebview(app, cfg.profile); err != nil {
		return err
	}
	return wails.Run(app)
}
