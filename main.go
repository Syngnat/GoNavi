package main

import (
	"context"
	"errors"
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
	// 大结果集导出（88W+ 行）时，JSON 编解码会产生 5-8 倍内存副本，
	// Go 默认 GOGC=100 下堆翻倍才触发 GC，叠加 Windows MADV_FREE 不归还 RSS，
	// 会导致 RSS 单调爬升到峰值后不下降。这里收紧到 50，让 GC 更早触发。
	// 代价是 CPU 开销略增，但导出/导入场景属 I/O 密集型，GC 开销可忽略。
	debug.SetGCPercent(50)

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
	handled, err := runSpecialMode(os.Args[1:])
	if handled {
		if err != nil && !isNormalSpecialModeExit(err) {
			logger.Error(err, "GoNavi 特殊模式退出")
			os.Exit(1)
		}
		return
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

	// Create an instance of the app structure
	application := app.NewApp()
	aiService := aiservice.NewServiceWithConfigChangeHandler(app.NewCloudBackupChangeHandler(application))
	nativeWindowManager, nativeWindowErr := nativewindow.NewManager(assets, application, aiService)
	if nativeWindowErr != nil {
		logger.Warnf("初始化原生独立窗口管理器失败：%v", nativeWindowErr)
	}
	bindings := []interface{}{application, aiService}
	if nativeWindowManager != nil {
		bindings = append(bindings, nativeWindowManager)
	}
	lowMemoryMode := isLowMemoryMode()
	backgroundColour, windowsOptions := resolveWindowVisualOptions(runtime.GOOS, lowMemoryMode)
	windowsOptions.WebviewUserDataPath = resolveWindowsWebviewUserDataPath()
	windowChrome := resolveMainWindowChrome(runtime.GOOS)
	var runtimeCtx context.Context
	var appMenu *menu.Menu
	if strings.EqualFold(strings.TrimSpace(runtime.GOOS), "darwin") {
		appMenu = buildMacApplicationMenu(func() {
			if runtimeCtx == nil {
				return
			}
			wailsRuntime.EventsEmit(runtimeCtx, nativeSelectCurrentLineEvent)
		}, windowChrome.Frameless)
	}

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
		Frameless:          windowChrome.Frameless,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: backgroundColour,
		Menu:             appMenu,
		OnStartup: func(ctx context.Context) {
			runtimeCtx = ctx
			primaryActivator.bindRuntimeContext(ctx)
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
		OnDomReady: func(_ context.Context) {
			// 每次 WebView 导航完成（含用户刷新前端）都会触发。
			// 刷新会让 SQL 编辑器的待提交事务 ID 随组件内存一起丢失，
			// 但后端事务仍开着并持有行锁：不清理的话，重新执行同一条 DML 会卡满
			// innodb_lock_wait_timeout 并报 Error 1205，只能重启应用恢复。
			app.HandleFrontendDomReady(application)
		},
		OnShutdown: func(ctx context.Context) {
			nativewindow.ShutdownLifecycle(nativeWindowManager)
			aiService.Shutdown()
			application.Shutdown()
		},
		OnBeforeClose: app.NewBeforeCloseHandler(application),
		Bind:          bindings,
		Windows:       windowsOptions,
		Mac: &mac.Options{
			TitleBar:             windowChrome.TitleBar,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
		},
	})

	if err != nil {
		logger.Error(err, "应用启动失败")
	}
}

func buildMacApplicationMenu(onNativeSelectCurrentLine func(), frameless bool) *menu.Menu {
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
	return result
}

func runSpecialMode(args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}

	mode := strings.ToLower(strings.TrimSpace(args[0]))
	switch mode {
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
	case "stdio", "--stdio":
		return mcpserver.RunAppStdioServer(ctx)
	case "http", "--http", "streamable-http", "--streamable-http":
		options, err := mcpserver.ParseHTTPServerOptions(args[1:])
		if err != nil {
			return err
		}
		logger.Infof("GoNavi MCP Streamable HTTP Server 启动：addr=%s path=%s schemaOnly=%v", options.Addr, options.Path, options.SchemaOnly)
		return mcpserver.RunAppStreamableHTTPServer(ctx, options)
	case "remote-config", "--remote-config":
		return mcpserver.WriteRemoteMCPClientConfig(os.Stdout, args[1:])
	default:
		return fmt.Errorf("未知 MCP server 模式: %s（支持 stdio/http/remote-config）", args[0])
	}
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
		}
	}

	return &options.RGBA{R: 0, G: 0, B: 0, A: 0}, &windows.Options{
		WebviewIsTransparent:              true,
		WindowIsTranslucent:               true,
		BackdropType:                      windows.Acrylic,
		DisableWindowIcon:                 false,
		DisableFramelessWindowDecorations: false,
	}
}
