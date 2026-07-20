package main

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"strings"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/mcpserver"
	"GoNavi-Wails/internal/nativewindow"
	"GoNavi-Wails/internal/singleinstance"
	"GoNavi-Wails/internal/webserver"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const nativeSelectCurrentLineEvent = "gonavi:native-select-current-line"

// singleInstanceName 是 GoNavi 单实例锁的稳定标识符。便携版和安装版共用
// 同一名称，确保同一用户会话中同时只能有一个主 GoNavi 进程。
const singleInstanceName = "gonavi"

// loggerLogger 把 internal/logger 接到 singleinstance 包。
type loggerLogger struct{}

func (loggerLogger) Infof(format string, args ...any) { logger.Infof(format, args...) }
func (loggerLogger) Warnf(format string, args ...any) { logger.Warnf(format, args...) }

func main() {
	// 大结果集导出（88W+ 行）时，JSON 编解码会产生 5-8 倍内存副本，
	// Go 默认 GOGC=100 下堆翻倍才触发 GC，叠加 Windows MADV_FREE 不归还 RSS，
	// 会导致 RSS 单调爬升到峰值后不下降。这里收紧到 50，让 GC 更早触发。
	// 代价是 CPU 开销略增，但导出/导入场景属 I/O 密集型，GC 开销可忽略。
	debug.SetGCPercent(50)

	// detached-window / mcp-server / web-server 等特殊模式不参与单实例判断。
	if runSpecialMode(os.Args[1:]) {
		return
	}

	// 单实例约束：第二个主实例启动时，转发启动参数给已运行的主实例后退出。
	singleinstance.SetLogger(loggerLogger{})
	singleInstanceResult := singleinstance.Acquire(singleInstanceName, os.Args[1:])
	if !singleInstanceResult.Acquired {
		if singleInstanceResult.AcquireErr != nil {
			logger.Errorf("GoNavi 单实例初始化失败，终止当前 GUI 启动：%v", singleInstanceResult.AcquireErr)
		} else if singleInstanceResult.NotifyErr != nil {
			logger.Warnf("GoNavi 单实例：通知主实例失败：%v", singleInstanceResult.NotifyErr)
		} else {
			logger.Infof("GoNavi 单实例：已通知运行中的主实例，当前进程退出")
		}
		return
	}
	singleInstanceHandle := singleInstanceResult.Handle
	defer func() {
		if singleInstanceHandle != nil {
			_ = singleInstanceHandle.Close()
		}
	}()

	activationState := &singleInstanceActivationState{}
	// 主实例被再次拉起时，把窗口调到前台并取消最小化。激活是纯信号，
	// 不携带任何参数——仅用于"第二次点击图标/命令时唤起已有窗口"。
	activatePrimaryWindow := func(ctx context.Context) {
		if ctx == nil {
			return
		}
		wailsRuntime.WindowShow(ctx)
		wailsRuntime.WindowUnminimise(ctx)
	}
	// 拿到主实例锁后立即建立 IPC，避免首窗口冷启动期间第二实例找不到 endpoint。
	if singleInstanceHandle != nil {
		if err := singleInstanceHandle.Listen(singleInstanceName, func(message singleinstance.ActivationMessage) error {
			logger.Infof("GoNavi 单实例：收到次实例激活信号")
			if ctx := activationState.request(); ctx != nil {
				activatePrimaryWindow(ctx)
			}
			return nil
		}); err != nil {
			logger.Warnf("启动单实例 IPC 服务失败：%v", err)
		}
	}

	// Create an instance of the app structure
	application := app.NewApp()
	aiService := aiservice.NewService()
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
	var runtimeCtx context.Context
	var appMenu *menu.Menu
	if strings.EqualFold(strings.TrimSpace(runtime.GOOS), "darwin") {
		appMenu = buildMacApplicationMenu(func() {
			if runtimeCtx == nil {
				return
			}
			wailsRuntime.EventsEmit(runtimeCtx, nativeSelectCurrentLineEvent)
		}, true)
	}

	// Windows 冷启动：原生先最大化，避免 main 默认小窗先闪一帧；
	// 前端 hydration 后再按用户记忆（最大化 / 普通尺寸）精细恢复。
	// 其它平台仍用 Normal，由前端恢复逻辑接管。
	windowStartState := options.Normal
	if strings.EqualFold(strings.TrimSpace(runtime.GOOS), "windows") {
		windowStartState = options.Maximised
	}

	// Create application with options
	err := wails.Run(&options.App{
		Title:            "GoNavi",
		Width:            1440,
		Height:           900,
		MinWidth:         900,
		MinHeight:        600,
		WindowStartState: windowStartState,
		Frameless:        true,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: backgroundColour,
		Menu:             appMenu,
		OnStartup: func(ctx context.Context) {
			runtimeCtx = ctx
			// 绑定 runtime context，供次实例激活时唤起前台使用。
			if pending := activationState.start(ctx); pending {
				activatePrimaryWindow(ctx)
			}
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
		OnShutdown: func(ctx context.Context) {
			activationState.stop()
			nativewindow.ShutdownLifecycle(nativeWindowManager)
			aiService.Shutdown()
			application.Shutdown()
		},
		OnBeforeClose: app.NewBeforeCloseHandler(application),
		Bind:          bindings,
		Windows:       windowsOptions,
		Mac: &mac.Options{
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

func runSpecialMode(args []string) bool {
	if len(args) == 0 {
		return false
	}

	mode := strings.ToLower(strings.TrimSpace(args[0]))
	switch mode {
	case "mcp-server", "--mcp-server":
		if err := runMCPServerMode(context.Background(), args[1:]); err != nil {
			logger.Error(err, "GoNavi MCP Server 退出")
		}
		return true
	case "web-server", "--web-server":
		if err := webserver.Run(context.Background(), assets, args[1:]); err != nil {
			logger.Error(err, "GoNavi Web Server 退出")
		}
		return true
	case "detached-window", nativewindow.DetachedWindowArgument:
		if err := nativewindow.RunChild(context.Background(), assets, args[1:]); err != nil {
			logger.Error(err, "GoNavi 原生独立窗口退出")
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
