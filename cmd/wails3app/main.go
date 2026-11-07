//go:build wails3

// Command wails3app is the Wails v3 migration entry point. It is built only
// with the wails3 tag so the shipping v2 desktop build and CI keep their
// current dependency graph until the migration lands.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/deeplink"
	"GoNavi-Wails/internal/desktop"
	"GoNavi-Wails/internal/mcpserver"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	frontendReadyEvent         = "gonavi:frontend-ready"
	deepLinkWakeEvent          = "gonavi:deeplink:ai-login"
	deepLinkPluginInstallEvent = "gonavi:deeplink:plugin-install"
)

func firstDeepLinkArg(args []string) string {
	for _, arg := range args {
		trimmed := strings.TrimSpace(arg)
		if strings.HasPrefix(strings.ToLower(trimmed), "gonavi://") {
			return trimmed
		}
	}
	return ""
}

// dispatchDeepLink forwards a gonavi:// link to the same frontend events the
// v2 deep-link waker uses.
func dispatchDeepLink(app *application.App, raw string) {
	link, ok := deeplink.Parse(raw)
	if !ok {
		return
	}
	if link.Action == deeplink.ActionPluginInstall {
		app.Event.Emit(deepLinkPluginInstallEvent, map[string]string{
			"spec": link.Spec,
			"id":   link.PluginID,
			"raw":  raw,
		})
		return
	}
	app.Event.Emit(deepLinkWakeEvent)
}

// runHeadlessMode keeps CLI child processes out of the GUI. The MCP HTTP
// server and scheduled sync workers re-execute this binary; without this
// dispatch each child would start another Wails application (and another MCP
// child), so the process tree grows without bound.
func runHeadlessMode(args []string) bool {
	if len(args) == 0 {
		return false
	}
	mode := strings.ToLower(strings.TrimSpace(args[0]))
	switch mode {
	case "mcp-server", "--mcp-server":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := runMCPServerMode(ctx, args[1:]); err != nil {
			log.Printf("mcp server exited: %v", err)
		}
		return true
	case "sync-worker":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := appcore.RunSyncWorker(ctx, args[1:]); err != nil {
			log.Printf("sync worker exited: %v", err)
		}
		return true
	case "run-sync-job":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := appcore.RunScheduledJobOnce(ctx, args[1:]); err != nil {
			log.Printf("scheduled job exited: %v", err)
		}
		return true
	default:
		return false
	}
}

func runMCPServerMode(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return mcpserver.RunAppStdioServer(ctx)
	}
	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "help", "--help", "-h":
		mcpserver.WriteAppMCPServerUsage(os.Stdout)
		return nil
	case "stdio", "--stdio":
		return mcpserver.RunAppStdioServer(ctx)
	case "http", "--http", "streamable-http", "--streamable-http":
		options, err := mcpserver.ParseHTTPServerOptions(args[1:])
		if err != nil {
			if errors.Is(err, flag.ErrHelp) {
				mcpserver.WriteHTTPServerUsage(os.Stdout)
				return nil
			}
			return err
		}
		return mcpserver.RunAppStreamableHTTPServer(ctx, options)
	case "remote-config", "--remote-config":
		return mcpserver.WriteRemoteMCPClientConfig(os.Stdout, args[1:])
	default:
		return fmt.Errorf("unknown MCP server mode: %s", args[0])
	}
}

// lifecycleService receives the v3 application context before any window is
// shown, mirroring the v2 OnStartup hook the desktop backend expects.
type lifecycleService struct {
	backend *appcore.App
	ai      *aiservice.Service
}

func (s *lifecycleService) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	appcore.InitializeLifecycle(s.backend, ctx)
	aiservice.InitializeLifecycle(s.ai, ctx)
	return nil
}

func (s *lifecycleService) ServiceShutdown() error {
	aiservice.ShutdownWithContext(s.ai, context.Background())
	s.backend.Shutdown()
	return nil
}

func main() {
	if appcore.HandleWindowsRuntimeReaperArgs(os.Args[1:]) {
		return
	}
	if runHeadlessMode(os.Args[1:]) {
		return
	}

	backend := appcore.NewApp()
	aiService := aiservice.NewServiceWithConfigChangeHandler(appcore.NewCloudBackupChangeHandler(backend))
	if err := aiservice.ConfigurePluginProviderFactory(aiService, appcore.PluginAIProviderFactoryForIntegration(backend)); err != nil {
		log.Printf("configure plugin AI provider failed: %v", err)
	}
	aiservice.SetBuiltinAIClientVersion(appcore.CurrentVersion())
	aiservice.PreloadConfig(aiService)
	aiservice.WarmModelCatalog(aiService)

	var wailsApp *application.App
	var mainWindow *application.WebviewWindow
	pendingDeepLink := firstDeepLinkArg(os.Args[1:])

	wailsApp = application.New(application.Options{
		Name:             "GoNavi",
		Description:      "Database client",
		FileAssociations: []string{".sql"},
		Services: []application.Service{
			application.NewService(backend),
			application.NewService(aiService),
			application.NewService(&lifecycleService{backend: backend, ai: aiService}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(os.DirFS("frontend/dist")),
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.gonavi.desktop",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				if mainWindow != nil {
					mainWindow.Show()
					mainWindow.Focus()
				}
				if raw := firstDeepLinkArg(data.Args); raw != "" {
					dispatchDeepLink(wailsApp, raw)
				}
			},
		},
	})

	// The frontend registers its listeners during startup; replay a cold-start
	// link once it signals readiness so it is not lost.
	wailsApp.Event.On(frontendReadyEvent, func(*application.CustomEvent) {
		if pendingDeepLink == "" {
			return
		}
		raw := pendingDeepLink
		pendingDeepLink = ""
		dispatchDeepLink(wailsApp, raw)
	})
	wailsApp.Event.OnApplicationEvent(events.Common.ApplicationLaunchedWithUrl, func(event *application.ApplicationEvent) {
		if mainWindow != nil {
			mainWindow.Show()
			mainWindow.Focus()
		}
		dispatchDeepLink(wailsApp, event.Context().URL())
	})
	wailsApp.Event.OnApplicationEvent(events.Common.ApplicationOpenedWithFile, func(event *application.ApplicationEvent) {
		for _, path := range event.Context().OpenedFiles() {
			wailsApp.Event.Emit("gonavi:open-file", map[string]string{"path": path})
		}
	})

	windowOptions := application.WebviewWindowOptions{
		Title:          "GoNavi",
		Width:          1440,
		Height:         900,
		MinWidth:       900,
		MinHeight:      600,
		URL:            "/",
		EnableFileDrop: true,
	}
	if os.Getenv("GONAVI_V3_DEBUG") == "1" {
		windowOptions.OpenInspectorOnStartup = true
	}
	mainWindow = wailsApp.Window.NewWithOptions(windowOptions)
	desktop.Bind(wailsApp, mainWindow)
	mainWindow.Show()

	if err := wailsApp.Run(); err != nil {
		log.Fatal(err)
	}
}
