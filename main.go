//go:build !bindings

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/mcpserver"
	"GoNavi-Wails/internal/nativewindow"
	"GoNavi-Wails/internal/webserver"
	"GoNavi-Wails/shared/i18n"

	"github.com/wailsapp/wails/v2"
	wailslogger "github.com/wailsapp/wails/v2/pkg/logger"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const nativeSelectCurrentLineEvent = "gonavi:native-select-current-line"
const windowsMSISingleInstanceID = "CDD6BF2F-ED1E-4345-A0AB-DCDB7E15FB23"

type primaryWindowActivator struct {
	mu      sync.Mutex
	ctx     context.Context
	pending bool
	show    func(context.Context)
}

type mainWindowChromeOptions struct {
	Frameless bool
	TitleBar  *mac.TitleBar
}

func (a *primaryWindowActivator) requestActivation() {
	if a == nil {
		return
	}
	a.mu.Lock()
	ctx := a.ctx
	if ctx == nil {
		a.pending = true
		a.mu.Unlock()
		return
	}
	show := a.show
	a.mu.Unlock()
	if show != nil {
		show(ctx)
	}
}

func (a *primaryWindowActivator) bindRuntimeContext(ctx context.Context) {
	if a == nil || ctx == nil {
		return
	}
	a.mu.Lock()
	a.ctx = ctx
	activatePending := a.pending
	a.pending = false
	show := a.show
	a.mu.Unlock()
	if activatePending && show != nil {
		show(ctx)
	}
}

func shouldEnableWindowsMSISingleInstance(goos string, executablePath string) bool {
	return app.IsWindowsMSIInstallExecutable(goos, executablePath)
}

func main() {
	if app.HandleWindowsRuntimeReaperArgs(os.Args[1:]) {
		return
	}
	// 大结果集导出（88W+ 行）时，JSON 编解码会产生 5-8 倍内存副本，
	// Go 默认 GOGC=100 下堆翻倍才触发 GC，叠加 Windows MADV_FREE 不归还 RSS，
	// 会导致 RSS 单调爬升到峰值后不下降。这里收紧到 50，让 GC 更早触发。
	// 代价是 CPU 开销略增，但导出/导入场景属 I/O 密集型，GC 开销可忽略。
	debug.SetGCPercent(50)
	if err := waitForWindowsRestartParent(os.Args[1:]); err != nil {
		logger.Errorf("等待旧 GoNavi 进程退出失败：%v", err)
		return
	}

	executablePath, executableErr := os.Executable()
	if executableErr == nil {
		maintenanceActive, err := app.WindowsUpdateMaintenanceActive(runtime.GOOS, executablePath)
		if err != nil {
			logger.Errorf("检查 Windows 更新维护状态失败：%v", err)
			return
		}
		if maintenanceActive {
			logger.Warnf("当前 GoNavi 安装正在更新，已阻止新进程启动：%s", executablePath)
			return
		}
	}
	// Started by a "Return to GoNavi" link while GoNavi is already open: wake it and leave.
	if handOffDeepLink(os.Args[1:], executablePath) {
		return
	}
	handled, err := runSpecialMode(os.Args[1:])
	if handled {
		if err != nil && !isNormalSpecialModeExit(err) {
			reportFatalError(err, "GoNavi 特殊模式退出")
			os.Exit(1)
		}
		return
	}
	isWindowsDesktop := strings.EqualFold(strings.TrimSpace(runtime.GOOS), "windows")
	// macOS 之前只在 Windows 上隐藏启动，用户会看到“先按默认尺寸摆普通窗、
	// 再切到记忆 bounds/最大化”的两段式动画。这里让两端都先隐藏，等前端把
	// 启动几何应用到最终状态后再显示。
	hideWindowUntilFrontendReady := isWindowsDesktop || strings.EqualFold(strings.TrimSpace(runtime.GOOS), "darwin")
	// The process identity must be fixed before Wails creates its HWND. If it
	// is assigned from OnStartup, Explorer may already have grouped the window
	// under the executable's default identity and keep its old taskbar icon.
	if err := app.InitializeWindowsApplicationIdentity(); err != nil {
		logger.Warnf("初始化 Windows 应用任务栏身份失败：%v", err)
	}
	primaryActivator := &primaryWindowActivator{show: wailsRuntime.WindowShow}
	if executableErr != nil {
		logger.Warnf("检测 MSI 单实例模式失败：%v", executableErr)
	} else if shouldEnableWindowsMSISingleInstance(runtime.GOOS, executablePath) {
		releaseSingleInstance, isPrimary, err := acquireWindowsMSISingleInstance(
			windowsMSISingleInstanceID,
			primaryActivator.requestActivation,
		)
		if err != nil {
			logger.Errorf("启用 MSI 单实例模式失败：%v", err)
			return
		}
		if !isPrimary {
			return
		}
		if releaseSingleInstance != nil {
			defer releaseSingleInstance()
		}
	}
	deepLinks := &deepLinkWaker{activator: primaryActivator}
	defer startDeepLinks(executablePath, deepLinks)()
	// Clear WebView2 processes left behind by an earlier exit before this
	// process creates its own browser, then arm a reaper for the next exit.
	app.ReapOrphanedWindowsWebViewProcesses()
	app.StartWindowsRuntimeProcessReaper()
	// Create an instance of the app structure
	application := app.NewApp()
	aiService := aiservice.NewServiceWithConfigChangeHandler(app.NewCloudBackupChangeHandler(application))
	aiservice.SetBuiltinAIClientVersion(app.CurrentVersion())
	agentTools, agentToolsErr := newDesktopAgentToolCatalog(application, aiService)
	if agentToolsErr != nil {
		logger.Warnf("初始化 AI Agent 工具目录失败：%v", agentToolsErr)
	} else if err := aiservice.ConfigureAgentHarnessDependencies(aiService, aiservice.AgentHarnessDependencies{
		Tools: agentTools,
	}); err != nil {
		logger.Warnf("配置 AI Agent Run Harness 依赖失败：%v", err)
	}
	nativeWindowManager, nativeWindowErr := nativewindow.NewManager(assets, application, aiService)
	if nativeWindowErr != nil {
		logger.Warnf("初始化原生独立窗口管理器失败：%v", nativeWindowErr)
	}
	bindings := collectWailsBindings(application, aiService, nativeWindowManager)
	lowMemoryMode := isLowMemoryMode()
	backgroundColour, windowsOptions := resolveWindowVisualOptions(runtime.GOOS, lowMemoryMode)
	windowsOptions.WebviewUserDataPath = resolveWindowsWebviewUserDataPath()
	windowChrome := resolveMainWindowChrome(runtime.GOOS)
	var runtimeCtx context.Context
	var appMenu *menu.Menu
	var preferencesMenu *macPreferencesMenu
	if strings.EqualFold(strings.TrimSpace(runtime.GOOS), "darwin") {
		emitNative := func(event string) {
			if runtimeCtx != nil {
				wailsRuntime.EventsEmit(runtimeCtx, event)
			}
		}
		menuLocalizer, localizerErr := i18n.NewLocalizer(resolveStartupMenuLanguage())
		if localizerErr != nil {
			logger.Warnf("加载菜单栏多语言目录失败：%v", localizerErr)
		}
		preferencesMenu = newMacPreferencesMenu(menuLocalizer, emitNative)
		appMenu = buildMacApplicationMenu(func() {
			emitNative(nativeSelectCurrentLineEvent)
		}, windowChrome.Frameless, preferencesMenu.topLevelItems()...)
	}

	// Keep the native startup barrier before showing the packaged application icon.
	startupNativeIconReady := make(chan struct{})
	var signalStartupNativeIconReadyOnce sync.Once
	signalStartupNativeIconReady := func() {
		signalStartupNativeIconReadyOnce.Do(func() { close(startupNativeIconReady) })
	}
	var showInitialWindowOnce sync.Once
	startupGate := newStartupWindowGate()

	// Create application with options
	err = wails.Run(&options.App{
		Title:              "GoNavi",
		Logger:             logger.NewWailsAdapter(),
		LogLevel:           wailslogger.INFO,
		LogLevelProduction: wailslogger.INFO,
		Width:              1440,
		Height:             900,
		MinWidth:           900,
		MinHeight:          600,
		WindowStartState:   resolveInitialWindowStartState(runtime.GOOS),
		StartHidden:        hideWindowUntilFrontendReady,
		Frameless:          windowChrome.Frameless,
		// 打开 Wails 原生文件拖放：查询编辑器接收操作系统 .sql 文件拖入
		// （frontend/src/components/queryEditor/useExternalSqlFileDrop.ts），
		// 同时由 Wails 运行时拦截拖放默认行为，避免 WebView 导航离开应用。
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: backgroundColour,
		Menu:             appMenu,
		OnStartup: func(ctx context.Context) {
			defer signalStartupNativeIconReady()
			runtimeCtx = ctx
			if preferencesMenu != nil {
				wailsRuntime.EventsOn(ctx, nativeMenuLanguageEvent, func(data ...interface{}) {
					if len(data) == 0 {
						return
					}
					if language, ok := data[0].(string); ok && preferencesMenu.setLanguage(language) {
						wailsRuntime.MenuUpdateApplicationMenu(ctx)
					}
				})
				wailsRuntime.EventsOn(ctx, nativeMenuThemeEvent, func(data ...interface{}) {
					if len(data) == 0 {
						return
					}
					if mode, ok := data[0].(string); ok && preferencesMenu.setTheme(mode) {
						wailsRuntime.MenuUpdateApplicationMenu(ctx)
					}
				})
			}
			if hideWindowUntilFrontendReady {
				// Subscribe before startup continues so a fast first paint cannot
				// emit gonavi:frontend-ready into an empty event bus.
				wailsRuntime.EventsOn(ctx, startupFrontendReadyEvent, func(...interface{}) {
					startupGate.markFrontendReady()
				})
				// 显示回调与兜底定时器都在 OnStartup 绑定：OnDomReady 依赖 WebView
				// 成功导航，页面加载失败时不会触发，绑定放在那里会让窗口一直隐藏。
				startupGate.bindShow(func() {
					showInitialWindowOnce.Do(func() {
						// WebView2 控制器边界刷新只有 Windows 需要，macOS 调用会返回失败，
						// 不能让它污染启动日志。
						if isWindowsDesktop {
							result := application.RefreshWebViewBounds()
							if !result.Success && strings.TrimSpace(result.Message) != "" {
								logger.Warnf("启动时刷新 WebView2 窗口边界失败：%s", result.Message)
							}
						}
						wailsRuntime.WindowShow(ctx)
					})
				})
				startupGate.startFallback(startupWindowShowFallback, func() {
					logger.Warnf("前端首屏握手超时，仍显示主窗口以免一直不可见")
					startupGate.markTimedOut()
				})
			}
			if isWindowsDesktop {
				if err := app.InitializePersistedNativeBrandIcon(application, ctx); err != nil {
					logger.Warnf("启动时应用已保存的 Windows 品牌图标失败：%v", err)
				}
			}
			// The icon is now ready; the remaining lifecycle services may continue
			// initializing without delaying the first visible frame. Bind queued
			// second-instance activations only after this barrier as they may show
			// the native window immediately.
			signalStartupNativeIconReady()
			if hideWindowUntilFrontendReady {
				startupGate.markIconReady()
			}
			primaryActivator.bindRuntimeContext(ctx)
			deepLinks.bind(ctx)
			lifecycleCtx := ctx
			if nativeWindowManager != nil {
				if err := nativewindow.InitializeLifecycle(nativeWindowManager, ctx); err != nil {
					logger.Warnf("启动原生独立窗口服务失败：%v", err)
				} else {
					lifecycleCtx = nativewindow.WithLifecycleContext(nativeWindowManager, ctx)
				}
			}
			app.InitializeLifecycle(application, lifecycleCtx)
			aiservice.InitializeLifecycle(aiService, lifecycleCtx)
			if err := aiservice.RepairInstalledLocalMCPClientConfigs(aiService); err != nil {
				logger.Warnf("自动修复本地 MCP 客户端配置失败：%v", err)
			}
		},
		OnDomReady: func(ctx context.Context) {
			// 每次 WebView 导航完成（含用户刷新前端）都会触发。
			// 刷新会让 SQL 编辑器的待提交事务 ID 随组件内存一起丢失，
			// 但后端事务仍开着并持有行锁：不清理的话，重新执行同一条 DML 会卡满
			// innodb_lock_wait_timeout 并报 Error 1205，只能重启应用恢复。
			app.HandleFrontendDomReady(application)
		},
		OnShutdown: func(ctx context.Context) {
			app.StartWindowsRuntimeProcessReaper()
			nativewindow.ShutdownLifecycle(nativeWindowManager)
			aiservice.ShutdownWithContext(aiService, ctx)
			application.Shutdown()
		},
		OnBeforeClose: app.NewBeforeCloseHandler(application),
		Bind:          bindings,
		Windows:       windowsOptions,
		Mac: &mac.Options{
			TitleBar:             windowChrome.TitleBar,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
			OnUrlOpen:            deepLinks.openURL,
		},
	})

	if err != nil {
		reportFatalError(err, "应用启动失败")
		os.Exit(1)
	}
}

// reportFatalError 把启动期致命错误同时写入日志文件与 stderr。
//
// internal/logger 默认只写文件，成功路径终端静默是设计如此；但**失败路径**
// 同样静默就只剩一个空白终端和一个退出码：用户既看不到原因，也不知道该去
// 哪里查（缺 WebKitGTK、前端资源缺失、数据目录不可写都只体现在日志里）。
// stdout 承载 CLI 的 JSONL 契约不能占用，stderr 未被任何机器可读输出使用，
// 因此在这里回显一份是安全的。
func reportFatalError(err error, message string) {
	// 固定格式串，避免 message 内的 % 被当成格式指令。
	logger.Error(err, "%s", message)
	if err == nil {
		return
	}
	fmt.Fprintf(os.Stderr, "[ERROR] %s；错误链：%s\n", message, logger.ErrorChain(err))
}

// newDesktopAgentToolCatalog keeps the Wails adapter on the same complete Go
// tool catalog as the CLI: database/MCP tools plus snapshot-bound workspace
// inspection. The catalog itself owns no desktop lifecycle; AppBackend merely
// borrows the already-created application instance.
func newDesktopAgentToolCatalog(application *app.App, aiService *aiservice.Service) (*mcpserver.CompositeToolCatalog, error) {
	backend, err := mcpserver.NewAppBackendFromApp(application)
	if err != nil {
		return nil, err
	}
	return mcpserver.NewCompositeToolCatalog(
		mcpserver.NewAgentToolCatalogWithDynamicSource(backend, mcpserver.NewServiceMCPSource(aiService)),
		mcpserver.NewWorkspaceSnapshotToolCatalog(),
	), nil
}

// buildMacApplicationMenu 组装 macOS 菜单栏；extraMenus 按顺序追加在 SQL 之后。
func buildMacApplicationMenu(onNativeSelectCurrentLine func(), frameless bool, extraMenus ...*menu.MenuItem) *menu.Menu {
	result := menu.NewMenuFromItems(
		menu.AppMenu(),
		menu.EditMenu(),
	)
	if !frameless {
		result.Append(menu.WindowMenu())
	}
	queryEditorMenu := result.AddSubmenu("SQL")
	queryEditorMenu.AddText("Copy Current Line", keys.CmdOrCtrl("e"), func(_ *menu.CallbackData) {
		if onNativeSelectCurrentLine != nil {
			onNativeSelectCurrentLine()
		}
	})
	for _, extra := range extraMenus {
		if extra != nil {
			result.Append(extra)
		}
	}
	return result
}

func runSpecialMode(args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}

	mode := strings.ToLower(strings.TrimSpace(args[0]))
	switch mode {
	case "sync-worker":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return true, app.RunSyncWorker(ctx, args[1:])
	case "run-sync-job":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return true, app.RunScheduledJobOnce(ctx, args[1:])
	case "mcp-server", "--mcp-server":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return true, runMCPServerMode(ctx, args[1:])
	case "web-server", "--web-server":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return true, webserver.Run(ctx, assets, args[1:])
	case "detached-window", nativewindow.DetachedWindowArgument:
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return true, nativewindow.RunChild(ctx, assets, args[1:])
	default:
		return false, nil
	}
}

func isNormalSpecialModeExit(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, io.EOF)
}

func runMCPServerMode(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return mcpserver.RunAppStdioServer(ctx)
	}

	mode := strings.ToLower(strings.TrimSpace(args[0]))
	switch mode {
	case "help", "--help", "-h":
		// 与 internal/cli 的 writeMCPUsage 同一惯例：帮助走 stdout、退出成功。
		mcpserver.WriteAppMCPServerUsage(os.Stdout)
		return nil
	case "stdio", "--stdio":
		return mcpserver.RunAppStdioServer(ctx)
	case "http", "--http", "streamable-http", "--streamable-http":
		options, err := mcpserver.ParseHTTPServerOptions(args[1:])
		if err != nil {
			return reportUsageHelp(err, func() { mcpserver.WriteHTTPServerUsage(os.Stdout) })
		}
		logger.Infof("GoNavi MCP Streamable HTTP Server 启动：addr=%s path=%s schemaOnly=%v", options.Addr, options.Path, options.SchemaOnly)
		return mcpserver.RunAppStreamableHTTPServer(ctx, options)
	case "remote-config", "--remote-config":
		err := mcpserver.WriteRemoteMCPClientConfig(os.Stdout, args[1:])
		return reportUsageHelp(err, func() { mcpserver.WriteRemoteMCPClientConfigUsage(os.Stdout) })
	default:
		return fmt.Errorf("未知 MCP server 模式: %s（支持 stdio/http/remote-config）", args[0])
	}
}

// reportUsageHelp 把 -h/--help 从错误转成正常退出：用户主动求助不是失败。
// flag 包会把 ErrHelp 当错误返回，而各子模式的用法输出都被设成了丢弃
// （io.Discard），若不在这里补打，终端只会剩一屏空白加一个非零退出码。
func reportUsageHelp(err error, writeUsage func()) error {
	if !errors.Is(err, flag.ErrHelp) {
		return err
	}
	writeUsage()
	return nil
}

func isLowMemoryMode() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("GONAVI_LOW_MEMORY_MODE"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// The startup preference lives in frontend storage, which is unavailable until
// hydration. Native startup must stay normal so it cannot override a disabled preference.
func resolveInitialWindowStartState(string) options.WindowStartState {
	return options.Normal
}

func resolveMainWindowChrome(goos string) mainWindowChromeOptions {
	if strings.EqualFold(strings.TrimSpace(goos), "darwin") {
		return mainWindowChromeOptions{
			Frameless: false,
			TitleBar:  mac.TitleBarHidden(),
		}
	}

	return mainWindowChromeOptions{Frameless: true}
}

func resolveWindowVisualOptions(goos string, lowMemoryMode bool) (*options.RGBA, *windows.Options) {
	// A visible Acrylic surface keeps DWM composing after GoNavi loses focus.
	// Windows therefore uses an opaque surface by default; macOS keeps its separate native effect path.
	disableTransparency := lowMemoryMode || strings.EqualFold(strings.TrimSpace(goos), "windows")
	if disableTransparency {
		return &options.RGBA{R: 255, G: 255, B: 255, A: 255}, &windows.Options{
			WebviewIsTransparent:              false,
			WindowIsTranslucent:               false,
			BackdropType:                      windows.None,
			DisableWindowIcon:                 false,
			DisableFramelessWindowDecorations: false,
			Messages:                          resolveWindowsRuntimeMessages(),
		}
	}

	return &options.RGBA{R: 0, G: 0, B: 0, A: 0}, &windows.Options{
		WebviewIsTransparent:              true,
		WindowIsTranslucent:               true,
		BackdropType:                      windows.Acrylic,
		DisableWindowIcon:                 false,
		DisableFramelessWindowDecorations: false,
		Messages:                          resolveWindowsRuntimeMessages(),
	}
}

func resolveWindowsRuntimeMessages() *windows.Messages {
	messages := windows.DefaultMessages()
	messages.InstallationRequired = "GoNavi 需要 Microsoft Edge WebView2 运行时。点击确定下载并安装（安装程序会在后台下载，请稍候）。\n\nGoNavi requires the Microsoft Edge WebView2 Runtime. Press OK to download and install."
	messages.UpdateRequired = "GoNavi 需要更新 Microsoft Edge WebView2 运行时。点击确定下载并安装。\n\nThe WebView2 runtime needs updating. Press OK to download and install."
	messages.MissingRequirements = "缺少运行组件 / Missing Requirements"
	messages.Webview2NotInstalled = "未安装 WebView2 运行时 / WebView2 runtime not installed"
	messages.Error = "GoNavi 启动失败"
	messages.FailedToInstall = "WebView2 运行时安装失败，请重试或由管理员安装独立安装包。\n\nThe runtime failed to install. Please retry, or ask an administrator to install the standalone installer."
	messages.DownloadPage = "GoNavi 需要 Microsoft Edge WebView2 运行时。点击确定打开下载页。最低版本：\n\nThis application requires the WebView2 runtime. Press OK to open the download page. Minimum version required: "
	messages.PressOKToInstall = "点击确定安装 / Press OK to install."
	messages.ContactAdmin = "GoNavi 需要 Microsoft Edge WebView2 运行时才能打开。请联系系统管理员安装。\n\nThe WebView2 runtime is required to run GoNavi. Please contact your system administrator."
	messages.InvalidFixedWebview2 = "已指定的 WebView2 运行时无效，请检查路径与最低版本。\n\nThe specified WebView2 runtime is not valid."
	messages.WebView2ProcessCrash = "WebView2 进程已崩溃，需要重新打开 GoNavi。\n\nThe WebView2 process crashed and GoNavi needs to be restarted."
	return messages
}
