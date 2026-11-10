//go:build wails3

// Command wails3app is the Wails v3 migration entry point. It is built only
// with the wails3 tag so the shipping v2 desktop build and CI keep their
// current dependency graph until the migration lands.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	frontendbundle "GoNavi-Wails/frontend"
	"GoNavi-Wails/internal/agenttools"
	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/cli"
	"GoNavi-Wails/internal/deeplink"
	"GoNavi-Wails/internal/desktop"
	"GoNavi-Wails/internal/mcpserver"
	"GoNavi-Wails/internal/nativewindow"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/uievents"
	"GoNavi-Wails/internal/webserver"
	"GoNavi-Wails/shared/i18n"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	frontendReadyEvent         = "gonavi:frontend-ready"
	deepLinkWakeEvent          = "gonavi:deeplink:ai-login"
	deepLinkPluginInstallEvent = "gonavi:deeplink:plugin-install"
)

// devBuild is set by the Taskfile DEV build (-X main.devBuild=1); dev
// instances must not claim the production single-instance id or gonavi:// handler.
var devBuild = "0"

var (
	// pendingMu guards the readiness flag and both replay queues. The frontend
	// emits gonavi:frontend-ready after its listeners are registered; any event
	// queued before that is replayed, and WindowRuntimeReady (every reload)
	// clears the flag again.
	pendingMu        sync.Mutex
	frontendReady    bool
	pendingOpenFiles []string
	pendingDeepLinks []string
)

func isSQLFilePath(value string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(value)), ".sql")
}

func sqlFileArgs(args []string) []string {
	files := make([]string, 0, len(args))
	for _, arg := range args {
		candidate := strings.TrimSpace(arg)
		if strings.HasPrefix(strings.ToLower(candidate), "file://") {
			candidate = fileURLPath(candidate)
		}
		if isSQLFilePath(candidate) {
			files = append(files, candidate)
		}
	}
	return dedupeStrings(files)
}

// fileURLPath converts a file:// URI delivered by %u desktop entries into a
// local path. Windows file URLs use a leading slash before the drive letter.
func fileURLPath(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || !strings.EqualFold(parsed.Scheme, "file") {
		return raw
	}
	if parsed.Host != "" && !strings.EqualFold(parsed.Host, "localhost") {
		return raw
	}
	path := parsed.Path
	if unescaped, err := url.PathUnescape(path); err == nil {
		path = unescaped
	}
	if runtime.GOOS == "windows" && len(path) >= 3 && path[0] == '/' && path[2] == ':' {
		path = path[1:]
	}
	return path
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

// emitOpenFilesLocked runs under pendingMu so a concurrent reload cannot clear
// the queue between the readiness check and the emit.
func emitOpenFilesLocked(app *application.App, files []string) {
	if app == nil {
		return
	}
	for _, path := range files {
		app.Event.Emit("gonavi:open-file", map[string]string{"path": path})
	}
}

// queueOrOpenFiles holds files opened before the frontend registered its
// listener; the frontend-ready handler replays them.
func queueOrOpenFiles(app *application.App, paths []string) {
	files := sqlFileArgs(paths)
	if len(files) == 0 {
		return
	}
	pendingMu.Lock()
	defer pendingMu.Unlock()
	if !frontendReady {
		pendingOpenFiles = dedupeStrings(append(pendingOpenFiles, files...))
		return
	}
	emitOpenFilesLocked(app, files)
}

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
	if app == nil {
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

// queueOrDispatchDeepLink queues a link until the frontend has registered its
// listeners. macOS delivers URL-scheme launches through ApplicationLaunchedWithUrl
// (not argv), and the second-instance callback can also arrive during a reload.
func queueOrDispatchDeepLink(app *application.App, raw string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return
	}
	pendingMu.Lock()
	defer pendingMu.Unlock()
	if !frontendReady {
		pendingDeepLinks = dedupeStrings(append(pendingDeepLinks, raw))
		return
	}
	dispatchDeepLink(app, raw)
}

// runHeadlessMode keeps CLI child processes out of the GUI. The MCP HTTP
// server and scheduled sync workers re-execute this binary; without this
// dispatch each child would start another Wails application (and another MCP
// child), so the process tree grows without bound.
func runHeadlessMode(args []string) (bool, int) {
	if len(args) == 0 {
		return false, 0
	}
	first := strings.TrimSpace(args[0])
	// `--data-root ... plugin ...` is the plugin CLI's data-root prefix, not a
	// GUI launch.
	if first == "--data-root" || strings.HasPrefix(first, "--data-root=") {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		cli.Version = appcore.CurrentVersion()
		code := cli.Run(ctx, args, os.Stdout, os.Stderr)
		if code != cli.ExitSuccess {
			log.Printf("plugin CLI exited with code %d", code)
		}
		return true, code
	}
	mode := strings.ToLower(first)
	switch mode {
	case "mcp-server", "--mcp-server":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := runMCPServerMode(ctx, args[1:]); err != nil {
			log.Printf("mcp server exited: %v", err)
			return true, 1
		}
		return true, 0
	case "sync-worker":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := appcore.RunSyncWorker(ctx, args[1:]); err != nil {
			log.Printf("sync worker exited: %v", err)
			return true, 1
		}
		return true, 0
	case "run-sync-job":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := appcore.RunScheduledJobOnce(ctx, args[1:]); err != nil {
			log.Printf("scheduled job exited: %v", err)
			return true, 1
		}
		return true, 0
	case "plugin-window", "--plugin-window":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := nativewindow.RunPluginChild(ctx, args[1:]); err != nil {
			log.Printf("plugin window exited: %v", err)
			return true, 1
		}
		return true, 0
	case "web-server", "--web-server":
		// Documented fallback when WebView2 is unavailable: serve the browser
		// build instead of opening a GUI.
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := webserver.Run(ctx, frontendbundle.Assets, args[1:]); err != nil {
			log.Printf("web server exited: %v", err)
			return true, 1
		}
		return true, 0
	case "plugin":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		cli.Version = appcore.CurrentVersion()
		code := cli.Run(ctx, args, os.Stdout, os.Stderr)
		if code != cli.ExitSuccess {
			log.Printf("plugin CLI exited with code %d", code)
		}
		return true, code
	default:
		return false, 0
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

// desktopEventEmitter adapts the v3 event bus to uievents. Wails v2 injected an
// "events" value into the startup context; v3 does not, so every backend push
// would otherwise be dropped silently.
type desktopEventEmitter struct{}

func (desktopEventEmitter) Emit(name string, args ...any) {
	desktop.EventsEmit(context.Background(), name, args...)
}

func (s *lifecycleService) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	ctx = uievents.WithEmitter(ctx, desktopEventEmitter{})
	appcore.InitializeLifecycle(s.backend, ctx)
	aiservice.InitializeLifecycle(s.ai, ctx)
	// Portable updates rename the executable; refresh GoNavi-managed MCP client
	// commands so external clients keep launching the current path.
	if err := aiservice.RepairInstalledLocalMCPClientConfigs(s.ai); err != nil {
		log.Printf("repair local MCP client configs failed: %v", err)
	}
	return nil
}

func (s *lifecycleService) ServiceShutdown() error {
	appcore.StartWindowsRuntimeProcessReaper()
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

// UpdatePreferences implements the optional host capability probed by
// App.PluginUpdateWindowPreferences; without it, open plugin windows would keep
// their launch-time locale/theme.
func (h pluginWindowHost) UpdatePreferences(raw json.RawMessage) error {
	return h.controller.UpdatePreferences(raw)
}

// pluginWindowRuntimeAssets prefers the Vite-built directory during wails3 dev
// so plugin UI edits are visible without rebuilding the embedded bundle.
func pluginWindowRuntimeAssets() (fs.FS, error) {
	if strings.TrimSpace(os.Getenv("FRONTEND_DEVSERVER_URL")) != "" {
		return os.DirFS(filepath.Join("frontend", "dist", "plugin-window")), nil
	}
	return fs.Sub(frontendbundle.Assets, "plugin-window")
}

func newPluginWindowFactory(backend *appcore.App) appcore.PluginWindowFactory {
	return func(ctx context.Context, manager *plugin.Manager) (appcore.PluginWindowHost, error) {
		runtimeAssets, err := pluginWindowRuntimeAssets()
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
	if len(os.Args) > 1 && strings.EqualFold(strings.TrimSpace(os.Args[1]), "--disable-plugins") {
		_ = os.Setenv("GONAVI_DISABLE_PLUGINS", "1")
		os.Args = append(os.Args[:1], os.Args[2:]...)
	}
	if appcore.HandleWindowsRuntimeReaperArgs(os.Args[1:]) {
		return
	}
	// An update restart launches the new process before the old one exits. Wait
	// here so Wails' SingleInstance acquisition does not mistake the new process
	// for a second instance and exit.
	if err := appcore.WaitForWindowsRestartParent(os.Args[1:]); err != nil {
		log.Printf("wait for restart parent failed: %v", err)
		return
	}
	// Match the v2 memory profile: large exports otherwise keep a 5-8x JSON copy
	// until the next doubling of the heap.
	debug.SetGCPercent(50)
	isDevRuntime := devBuild == "1" || strings.TrimSpace(os.Getenv("FRONTEND_DEVSERVER_URL")) != ""
	// The maintenance gate must run before headless dispatch: scheduled jobs and
	// MCP clients can start during an MSI replacement and would lock the exe.
	if executablePath, err := os.Executable(); err == nil {
		active, checkErr := appcore.WindowsUpdateMaintenanceActive(runtime.GOOS, executablePath)
		if checkErr != nil {
			log.Printf("check Windows update maintenance failed: %v", checkErr)
			return
		}
		if active {
			log.Printf("GoNavi installation is being updated; refusing to start")
			return
		}
	}
	if handled, code := runHeadlessMode(os.Args[1:]); handled {
		if code != 0 {
			os.Exit(code)
		}
		return
	}
	// The process identity must be fixed before Wails creates its HWND, or
	// Explorer groups the window under the executable's default identity.
	if err := appcore.InitializeWindowsApplicationIdentity(); err != nil {
		log.Printf("initialize Windows application identity failed: %v", err)
	}

	backend := appcore.NewApp()
	appcore.ConfigurePluginWindows(backend, newPluginWindowFactory(backend))
	// Clear WebView2 processes left behind by an earlier exit, then arm the
	// reaper for this process (same lifecycle as the v2 entry point).
	appcore.ReapOrphanedWindowsWebViewProcesses()
	appcore.StartWindowsRuntimeProcessReaper()
	if runtime.GOOS == "windows" && !isDevRuntime {
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
	// Serve the built-in MCP HTTP endpoint in-process: enabling it no longer
	// costs a second GoNavi process. The child-process mode stays as a fallback
	// when the in-process server cannot start.
	aiservice.SetMCPHTTPProcessStarter(func(ctx context.Context, options aiservice.MCPHTTPStartOptions) (aiservice.MCPHTTPProcess, error) {
		mcpBackend, err := mcpserver.NewAppBackendFromApp(backend)
		if err != nil {
			return nil, err
		}
		return mcpserver.StartStreamableHTTPServer(ctx, mcpBackend, mcpserver.HTTPServerOptions{
			Addr:       options.Addr,
			Path:       options.Path,
			Token:      options.Token,
			SchemaOnly: options.SchemaOnly,
		})
	})
	aiService := aiservice.NewServiceWithConfigChangeHandler(appcore.NewCloudBackupChangeHandler(backend))
	if err := aiservice.ConfigurePluginProviderFactory(aiService, appcore.PluginAIProviderFactoryForIntegration(backend)); err != nil {
		log.Printf("configure plugin AI provider failed: %v", err)
	}
	aiservice.SetBuiltinAIClientVersion(appcore.CurrentVersion())
	aiservice.PreloadConfig(aiService)
	aiservice.WarmModelCatalog(aiService)
	agentTools, agentToolsErr := agenttools.NewDesktopToolCatalog(backend, aiService)
	if agentToolsErr != nil {
		log.Printf("initialize AI agent tool catalog failed: %v", agentToolsErr)
	} else if err := aiservice.ConfigureAgentHarnessDependencies(aiService, aiservice.AgentHarnessDependencies{
		Tools: agentTools,
	}); err != nil {
		log.Printf("configure AI agent harness dependencies failed: %v", err)
	}

	var wailsApp *application.App
	var mainWindow *application.WebviewWindow
	queueOrDispatchDeepLink(nil, firstDeepLinkArg(os.Args[1:]))
	queueOrOpenFiles(nil, sqlFileArgs(os.Args[1:]))
	closeGuard := appcore.NewBeforeCloseHandler(backend)
	var quitting atomic.Bool
	var brandIconOnce sync.Once

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
			Handler:    detachedWindowAssetHandler(frontendbundle.Assets),
			Middleware: appcore.GalleryAssetMiddleware(backend, frontendbundle.Assets),
		},
		Windows: application.WindowsOptions{
			// Keep the same WebView2 profile as the v2 build so localStorage
			// (theme, proxy, background image) survives the upgrade/rollback.
			WebviewUserDataPath: appdata.ResolveWindowsWebviewUserDataPath(),
		},
		ShouldQuit: func() bool {
			// Cmd+Q and the menu quit path must honour the same pending-edit
			// confirmation as the window close button. ForceQuitApplication sets
			// the handler's allow flag, so the retried quit passes through.
			if closeGuard(nil) {
				return false
			}
			quitting.Store(true)
			return true
		},
	}
	if !isDevRuntime {
		appOptions.SingleInstance = &application.SingleInstanceOptions{
			UniqueID: "com.gonavi.desktop",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				if mainWindow != nil {
					mainWindow.Show()
					mainWindow.Focus()
				}
				queueOrDispatchDeepLink(wailsApp, firstDeepLinkArg(data.Args))
				queueOrOpenFiles(wailsApp, sqlFileArgs(data.Args))
			},
		}
	}
	if os.Getenv("GONAVI_V3_DEBUG") == "1" {
		// Lets the migration harness drive the WebView through CDP. Never set in
		// release builds.
		appOptions.Windows.AdditionalBrowserArgs = []string{"--remote-debugging-port=9222"}
	}
	if extra := strings.TrimSpace(os.Getenv("GONAVI_V3_BROWSER_ARGS")); extra != "" {
		// Diagnostics switch for WebView2/Chromium flags (memory experiments,
		// tracing). Empty in normal runs.
		appOptions.Windows.AdditionalBrowserArgs = append(appOptions.Windows.AdditionalBrowserArgs, strings.Fields(extra)...)
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

	// The frontend registers its listeners during startup; replay everything
	// queued before it signalled readiness. The flag and both queues share one
	// mutex so a concurrent reload cannot drop an event between them.
	wailsApp.Event.On(frontendReadyEvent, func(*application.CustomEvent) {
		pendingMu.Lock()
		frontendReady = true
		openedFiles := pendingOpenFiles
		pendingOpenFiles = nil
		deepLinks := pendingDeepLinks
		pendingDeepLinks = nil
		emitOpenFilesLocked(wailsApp, openedFiles)
		for _, raw := range deepLinks {
			dispatchDeepLink(wailsApp, raw)
		}
		pendingMu.Unlock()

		// A reload drops the editor's in-memory transaction IDs while the backend
		// transaction still holds row locks; roll the orphaned ones back.
		appcore.HandleFrontendDomReady(backend)
		if mainWindow != nil {
			mainWindow.Show()
			mainWindow.Focus()
		}
		if runtime.GOOS == "windows" {
			brandIconOnce.Do(func() {
				if err := appcore.InitializePersistedNativeBrandIcon(backend, context.Background()); err != nil {
					log.Printf("apply persisted brand icon failed: %v", err)
				}
			})
		}
	})
	wailsApp.Event.OnApplicationEvent(events.Common.ApplicationLaunchedWithUrl, func(event *application.ApplicationEvent) {
		if mainWindow != nil {
			mainWindow.Show()
			mainWindow.Focus()
		}
		// macOS delivers cold-start URLs here, not through os.Args; queue until
		// the React listeners exist.
		queueOrDispatchDeepLink(wailsApp, event.Context().URL())
	})
	wailsApp.Event.OnApplicationEvent(events.Common.ApplicationOpenedWithFile, func(event *application.ApplicationEvent) {
		queueOrOpenFiles(wailsApp, event.Context().OpenedFiles())
	})

	hideUntilFrontendReady := runtime.GOOS == "windows" || runtime.GOOS == "darwin"
	frameless, backgroundType, backgroundColour, macWindow := resolveV3WindowChrome(runtime.GOOS)
	windowOptions := application.WebviewWindowOptions{
		Title:            "GoNavi",
		Width:            1440,
		Height:           900,
		MinWidth:         900,
		MinHeight:        600,
		Hidden:           hideUntilFrontendReady,
		Frameless:        frameless,
		BackgroundType:   backgroundType,
		BackgroundColour: backgroundColour,
		Mac:              macWindow,
		URL:              resolveV3StartURL(runtime.GOOS),
		EnableFileDrop:   true,
	}
	if os.Getenv("GONAVI_V3_DEBUG") == "1" {
		windowOptions.OpenInspectorOnStartup = true
	}
	mainWindow = wailsApp.Window.NewWithOptions(windowOptions)
	desktop.Bind(wailsApp, mainWindow)
	// Closing the main window goes through the same pending-edit confirmation
	// the v2 OnBeforeClose hook used; the frontend answers with
	// ForceQuitApplication, which lets the retried close pass.
	// Hooks run synchronously before Wails' built-in close listener, so Cancel
	// reliably blocks the close. OnWindowEvent is asynchronous and could let the
	// window close before the pending-edit confirmation appears.
	mainWindow.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if quitting.Load() {
			return
		}
		if closeGuard(nil) {
			event.Cancel()
		}
	})
	// Hidden or minimised windows hand idle Go heap back to the OS after a
	// delay; the trim skips while queries, imports or exports are running.
	for _, eventType := range []events.WindowEventType{events.Common.WindowHide, events.Common.WindowMinimise} {
		mainWindow.OnWindowEvent(eventType, func(*application.WindowEvent) {
			backend.SetWindowHiddenForMemoryTrim(true)
		})
	}
	for _, eventType := range []events.WindowEventType{events.Common.WindowRestore, events.Common.WindowUnMinimise} {
		mainWindow.OnWindowEvent(eventType, func(*application.WindowEvent) {
			backend.SetWindowHiddenForMemoryTrim(false)
		})
	}
	// Every navigation (including Ctrl+R) re-creates the frontend while backend
	// transactions survive; roll back the orphaned ones before the new UI runs.
	mainWindow.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
		// Every navigation recreates the frontend. Queue file/deep-link events
		// again until the new document registers its listeners.
		pendingMu.Lock()
		frontendReady = false
		pendingMu.Unlock()
		appcore.HandleFrontendDomReady(backend)
	})
	// v3 reports native drops as a window event; the frontend keeps its v2
	// OnFileDrop contract through the compatibility runtime.
	mainWindow.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		context := event.Context()
		payload := map[string]any{
			"x":     0,
			"y":     0,
			"paths": context.DroppedFiles(),
		}
		if details := context.DropTargetDetails(); details != nil {
			payload["x"] = details.X
			payload["y"] = details.Y
			payload["dropTarget"] = details
		}
		// Deliver only to the window that received the drop; EmitEvent goes through
		// the application-wide bus and would make every detached workbench open
		// the same file.
		mainWindow.DispatchWailsEvent(&application.CustomEvent{
			Name:   "gonavi:file-drop",
			Data:   payload,
			Sender: mainWindow.Name(),
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

		id := ""
		if detached {
			id = strings.Trim(strings.TrimPrefix(r.URL.Path, prefix), "/")
			if id == "" {
				http.NotFound(w, r)
				return
			}
		}

		// Ask the v3 asset handler for the SPA document instead of reading the
		// embedded FS directly: in wails3 dev it proxies Vite (so the injected
		// page keeps HMR), and in production it serves the embedded bundle.
		sub := r.Clone(r.Context())
		sub.URL.Path = "/"
		sub.URL.RawPath = ""
		captured := &responseCapture{header: make(http.Header)}
		static.ServeHTTP(captured, sub)
		contentType := strings.ToLower(captured.header.Get("Content-Type"))
		if captured.status != http.StatusOK || !strings.Contains(contentType, "text/html") {
			captured.writeTo(w)
			return
		}

		// The flag tells the frontend bundle it is running inside Wails v3
		// before any frame script executes; the v3 runtime itself is injected
		// only after navigation completes, which is too late for the first
		// binding calls and would otherwise fall through to the browser mock.
		script := `<script>window.__GONAVI_WAILS3__=true;</script>`
		if detached {
			script += fmt.Sprintf(
				`<script>(function(){var id=%s;window.__GONAVI_DETACHED_ID__=id;window.__GONAVI_DETACHED__={loadBootstrap:function(){return window.go.nativewindow.Manager.Bootstrap(id);},action:function(action,payload){return window.go.nativewindow.Manager.Action(id,action,payload||{});},present:function(){return window.go.nativewindow.Manager.Present(id);}};})();</script>`,
				strconv.Quote(id),
			)
		}
		page := strings.Replace(captured.body.String(), "</head>", script+"</head>", 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(page))
	})
}

// responseCapture lets the index injection pass through the v3 asset handler
// (including its dev-server proxy) without writing to the real response.
type responseCapture struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (c *responseCapture) Header() http.Header { return c.header }

func (c *responseCapture) WriteHeader(status int) {
	if c.status == 0 {
		c.status = status
	}
}

func (c *responseCapture) Write(payload []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	return c.body.Write(payload)
}

func (c *responseCapture) writeTo(w http.ResponseWriter) {
	for name, values := range c.header {
		w.Header()[name] = values
	}
	status := c.status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_, _ = w.Write(c.body.Bytes())
}
