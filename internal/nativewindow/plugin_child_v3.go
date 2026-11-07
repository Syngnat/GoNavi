//go:build wails3

package nativewindow

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"GoNavi-Wails/internal/desktop"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// RunPluginChild starts only an isolated plugin UI in its own process. The v3
// application has no bound services, so plugin JavaScript can reach neither the
// host app nor any other Go service; the only channel is the token-scoped
// loopback proxy back to the host.
func RunPluginChild(parentCtx context.Context, args []string) error {
	cfg, err := parsePluginChildOptions(args)
	if err != nil {
		return err
	}
	signalCtx, stopSignals := signal.NotifyContext(parentCtx, os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := preparePluginProfile(cfg.profile); err != nil {
		return err
	}
	if err := preparePluginChildPlatform(cfg.profile); err != nil {
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

	var wailsCtxPtr atomic.Pointer[context.Context]
	readyCtx := context.Background()
	wailsCtxPtr.Store(&readyCtx)
	handler := &pickPathHandler{
		next:       newPluginChildProxy(cfg, transport),
		wailsCtx:   &wailsCtxPtr,
		openFile:   desktop.OpenFileDialog,
		openFolder: desktop.OpenDirectoryDialog,
	}

	app := application.New(application.Options{
		Name: "GoNaviPluginWindow",
		Assets: application.AssetOptions{
			Handler:    handler,
			Middleware: denyPluginRuntime,
		},
		Windows: application.WindowsOptions{
			WebviewUserDataPath: filepath.Join(cfg.profile, "webview2"),
		},
		Mac: application.MacOptions{
			ActivationPolicy: application.ActivationPolicyAccessory,
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		OnShutdown: func() { cancel() },
	})
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:          cfg.title,
		Width:          cfg.width,
		Height:         cfg.height,
		MinWidth:       320,
		MinHeight:      240,
		URL:            "/",
		EnableFileDrop: false,
		Permissions: map[application.PermissionType]application.Permission{
			application.PermissionMicrophone:    application.PermissionDeny,
			application.PermissionCamera:        application.PermissionDeny,
			application.PermissionGeolocation:   application.PermissionDeny,
			application.PermissionNotifications: application.PermissionDeny,
			application.PermissionClipboardRead: application.PermissionDeny,
		},
	})
	desktop.Bind(app, window)
	window.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		go app.Quit()
	})
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		watchWG.Add(1)
		go func() {
			defer watchWG.Done()
			watchPluginChild(ctx, signalCtx, cfg, watcher, transport, func() { app.Quit() })
		}()
	})
	return app.Run()
}

// denyPluginRuntime keeps plugin JavaScript away from the v3 runtime endpoint.
func denyPluginRuntime(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/wails/") {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}
