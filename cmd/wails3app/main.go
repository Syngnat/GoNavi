//go:build wails3

// Command wails3app is the Wails v3 migration entry point. It is built only
// with the wails3 tag so the shipping v2 desktop build and CI keep their
// current dependency graph until the migration lands.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	frontendbundle "GoNavi-Wails/frontend"
	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/deeplink"
	"GoNavi-Wails/internal/desktop"
	"GoNavi-Wails/internal/mcpserver"
	"GoNavi-Wails/internal/nativewindow"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/shared/i18n"

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
	case "plugin-window", "--plugin-window":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := nativewindow.RunPluginChild(ctx, args[1:]); err != nil {
			log.Printf("plugin window exited: %v", err)
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

// pluginWindowHost keeps plugin windows on the isolated v2 child path while the
// main window runs on v3. Plugin JavaScript can then never reach the host's Go
// services directly: it only sees the token-scoped loopback bridge.
type pluginWindowHost struct {
	controller *nativewindow.PluginController
}

func (h pluginWindowHost) Open(ctx context.Context, pluginID, windowKey string, launchContext json.RawMessage, locale, theme string) (any, error) {
	return h.controller.Open(ctx, pluginID, windowKey, launchContext, locale, theme)
}

func (h pluginWindowHost) Revoke(id string) {
	h.controller.Revoke(id)
}

func (h pluginWindowHost) Close(ctx context.Context) error {
	return h.controller.Close(ctx)
}

func newPluginWindowFactory(backend *appcore.App) appcore.PluginWindowFactory {
	return func(ctx context.Context, manager *plugin.Manager) (appcore.PluginWindowHost, error) {
		runtimeAssets, err := fs.Sub(frontendbundle.Assets, "plugin-window")
		if err != nil {
			return nil, err
		}
		controller, err := nativewindow.NewPluginController(manager, nativewindow.PluginControllerOptions{
			Assets:     runtimeAssets,
			Capability: appcore.PluginWindowCapabilityHandler(backend),
			OnWindowClosed: func(ctx context.Context, info nativewindow.PluginWindowInfo) {
				if _, invokeErr := manager.InvokeGeneration(ctx, info.PluginID, info.Generation, "session.teardown", nil); invokeErr != nil {
					log.Printf("plugin window closed teardown failed: %s generation %d", info.PluginID, info.Generation)
				}
			},
		})
		if err != nil {
			return nil, err
		}
		if err := controller.Start(ctx); err != nil {
			return nil, err
		}
		return pluginWindowHost{controller: controller}, nil
	}
}

func main() {
	if appcore.HandleWindowsRuntimeReaperArgs(os.Args[1:]) {
		return
	}
	if runHeadlessMode(os.Args[1:]) {
		return
	}

	backend := appcore.NewApp()
	appcore.ConfigurePluginWindows(backend, newPluginWindowFactory(backend))
	if runtime.GOOS == "windows" {
		// v3's SingleInstance forwards protocol launches as second-instance
		// arguments; registering the handler still has to happen before the
		// marketplace or sign-in pages open a gonavi:// link.
		if executablePath, err := os.Executable(); err == nil {
			if _, err := deeplink.Register(executablePath); err != nil {
				log.Printf("register gonavi:// handler failed: %v", err)
			} else {
				aiservice.SetBuiltinAILoginStartHook(func() {
					if _, err := deeplink.Register(executablePath); err != nil {
						log.Printf("re-register gonavi:// handler failed: %v", err)
					}
				})
			}
		}
	}
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

	appOptions := application.Options{
		Name:             "GoNavi",
		Description:      "Database client",
		FileAssociations: []string{".sql"},
		Services: []application.Service{
			application.NewService(backend),
			application.NewService(aiService),
			application.NewService(&lifecycleService{backend: backend, ai: aiService}),
		},
		Assets: application.AssetOptions{
			Handler: detachedWindowAssetHandler(frontendbundle.Assets),
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
	}
	if os.Getenv("GONAVI_V3_DEBUG") == "1" {
		// Lets the migration harness drive the WebView through CDP. Never set in
		// release builds.
		appOptions.Windows.AdditionalBrowserArgs = []string{"--remote-debugging-port=9222"}
	}
	wailsApp = application.New(appOptions)

	windowManager := nativewindow.NewV3Manager(wailsApp)
	wailsApp.RegisterService(application.NewService(windowManager))

	if runtime.GOOS == "darwin" {
		menu := wailsApp.Menu.New()
		menu.AddRole(application.AppMenu)
		menu.AddRole(application.EditMenu)
		menu.AddRole(application.WindowMenu)
		sqlMenu := menu.AddSubmenu("SQL")
		sqlMenu.Add("Copy Current Line").
			SetAccelerator("CmdOrCtrl+E").
			OnClick(func(*application.Context) {
				wailsApp.Event.Emit("gonavi:native-select-current-line")
			})
		localizer, localizerErr := i18n.NewLocalizer(resolveStartupMenuLanguage())
		if localizerErr != nil {
			log.Printf("load menu language catalog failed: %v", localizerErr)
		}
		preferences := newMacPreferencesMenu(localizer, func(event string) {
			wailsApp.Event.Emit(event)
		})
		preferences.appendTo(menu)
		wailsApp.Menu.SetApplicationMenu(menu)
		wailsApp.Event.On(nativeMenuLanguageEvent, func(event *application.CustomEvent) {
			if value, ok := event.Data.(string); ok && preferences.setLanguage(value) {
				menu.Update()
			}
		})
		wailsApp.Event.On(nativeMenuThemeEvent, func(event *application.CustomEvent) {
			if value, ok := event.Data.(string); ok && preferences.setTheme(value) {
				menu.Update()
			}
		})
	}

	// The frontend registers its listeners during startup; replay a cold-start
	// link once it signals readiness so it is not lost.
	wailsApp.Event.On(frontendReadyEvent, func(*application.CustomEvent) {
		if mainWindow != nil {
			mainWindow.Show()
			mainWindow.Focus()
		}
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

	hideUntilFrontendReady := runtime.GOOS == "windows" || runtime.GOOS == "darwin"
	windowOptions := application.WebviewWindowOptions{
		Title:          "GoNavi",
		Width:          1440,
		Height:         900,
		MinWidth:       900,
		MinHeight:      600,
		Hidden:         hideUntilFrontendReady,
		URL:            "/",
		EnableFileDrop: true,
	}
	if os.Getenv("GONAVI_V3_DEBUG") == "1" {
		windowOptions.OpenInspectorOnStartup = true
	}
	mainWindow = wailsApp.Window.NewWithOptions(windowOptions)
	desktop.Bind(wailsApp, mainWindow)
	// v3 reports native drops as a window event; the frontend keeps its v2
	// OnFileDrop contract through the compatibility runtime.
	mainWindow.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		// v3 keeps the drop coordinates unexported; the frontend's SQL drop
		// target only needs the paths.
		wailsApp.Event.Emit("gonavi:file-drop", map[string]any{
			"x":     0,
			"y":     0,
			"paths": event.Context().DroppedFiles(),
		})
	})
	if hideUntilFrontendReady {
		// The frontend shows the window after its first paint; this fallback
		// keeps a broken bundle visible instead of leaving an invisible app.
		time.AfterFunc(5*time.Second, func() { mainWindow.Show() })
	} else {
		mainWindow.Show()
	}

	if err := wailsApp.Run(); err != nil {
		log.Fatal(err)
	}
}

// detachedWindowAssetHandler serves the SPA and injects the detached-window
// runtime for /__gonavi/detached/window/<id>. The injected script reuses the
// same window.go bindings every other page uses, so no HTTP bridge or token is
// needed between windows in the v3 build.
func detachedWindowAssetHandler(frontendFS fs.FS) http.Handler {
	static := application.AssetFileServerFS(frontendFS)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "/__gonavi/detached/window/"
		detached := strings.HasPrefix(r.URL.Path, prefix)
		if !detached && r.URL.Path != "/" && r.URL.Path != "/index.html" {
			static.ServeHTTP(w, r)
			return
		}
		index, err := fs.ReadFile(frontendFS, "index.html")
		if err != nil {
			http.Error(w, "frontend bundle is not built", http.StatusInternalServerError)
			return
		}
		// The flag tells the frontend bundle it is running inside Wails v3
		// before any frame script executes; the v3 runtime itself is injected
		// only after navigation completes, which is too late for the first
		// binding calls and would otherwise fall through to the browser mock.
		script := `<script>window.__GONAVI_WAILS3__=true;</script>`
		if detached {
			id := strings.Trim(strings.TrimPrefix(r.URL.Path, prefix), "/")
			if id == "" {
				http.NotFound(w, r)
				return
			}
			script += fmt.Sprintf(
				`<script>(function(){var id=%s;window.__GONAVI_DETACHED__={loadBootstrap:function(){return window.go.nativewindow.Manager.Bootstrap(id);},action:function(action,payload){return window.go.nativewindow.Manager.Action(id,action,payload||{});},present:function(){return window.go.nativewindow.Manager.Present(id);}};})();</script>`,
				strconv.Quote(id),
			)
		}
		page := strings.Replace(string(index), "</head>", script+"</head>", 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(page))
	})
}
