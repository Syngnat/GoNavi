package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/cli"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/nativewindow"
	"GoNavi-Wails/internal/plugin"
)

type desktopPluginWindows struct {
	controller *nativewindow.PluginController
}

func (w desktopPluginWindows) Open(ctx context.Context, pluginID, windowKey string, launchContext json.RawMessage, locale, theme string) (any, error) {
	return w.controller.Open(ctx, pluginID, windowKey, launchContext, locale, theme)
}
func (w desktopPluginWindows) UpdatePreferences(raw json.RawMessage) error {
	return w.controller.UpdatePreferences(raw)
}
func (w desktopPluginWindows) Revoke(id string)                { w.controller.Revoke(id) }
func (w desktopPluginWindows) Close(ctx context.Context) error { return w.controller.Close(ctx) }

func configureDesktopPlugins(application *app.App) {
	app.ConfigurePluginWindows(application, func(ctx context.Context, manager *plugin.Manager) (app.PluginWindowHost, error) {
		runtimeAssets, err := pluginWindowAssets()
		if err != nil {
			return nil, err
		}
		controller, err := nativewindow.NewPluginController(manager, nativewindow.PluginControllerOptions{
			Assets:     runtimeAssets,
			Capability: app.PluginWindowCapabilityHandler(application),
			// 清理旧窗口所属 generation 的连接，避免重开窗口后
			// 留下无法在 UI 中管理的后台会话。
			OnWindowClosed: func(ctx context.Context, info nativewindow.PluginWindowInfo) {
				if _, invokeErr := manager.InvokeGeneration(ctx, info.PluginID, info.Generation, "session.teardown", nil); invokeErr != nil {
					logger.Warnf("plugin window closed teardown failed: %s generation %d", info.PluginID, info.Generation)
				}
			},
		})
		if err != nil {
			return nil, err
		}
		if err = controller.Start(ctx); err != nil {
			return nil, err
		}
		return desktopPluginWindows{controller: controller}, nil
	})
}

func preparePluginSafeMode(args []string) ([]string, error) {
	if len(args) == 0 || args[0] != "--disable-plugins" {
		return args, nil
	}
	if err := os.Setenv("GONAVI_DISABLE_PLUGINS", "1"); err != nil {
		return nil, err
	}
	return args[1:], nil
}

func runPluginWindowMode(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return nativewindow.RunPluginChild(ctx, args)
}

func runDesktopPluginCLI(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runDesktopPluginCLIWithIO(ctx, args, os.Stdout, os.Stderr)
}

type desktopCLIExit struct{ code int }

func (e *desktopCLIExit) Error() string { return fmt.Sprintf("CLI exit %d", e.code) }

func runDesktopPluginCLIWithIO(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	// The desktop release injects AppVersion, not the standalone CLI version.
	cli.Version = app.CurrentVersion()
	if code := cli.Run(ctx, args, stdout, stderr); code != cli.ExitSuccess {
		return &desktopCLIExit{code: code}
	}
	return nil
}

func hasDesktopCLIPrefix(args []string) bool {
	if len(args) == 0 {
		return false
	}
	return args[0] == "--data-root" || strings.HasPrefix(args[0], "--data-root=")
}
