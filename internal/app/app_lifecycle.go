package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/uievents"
)

// InitializeLifecycle attaches runtime context without exposing lifecycle internals to Wails bindings.
func InitializeLifecycle(a *App, ctx context.Context) {
	a.startup(ctx)
}

type headlessEventEmitter struct{}

func (headlessEventEmitter) Emit(string, ...any) {}

// InitializeHeadlessLifecycle attaches a non-Wails context and starts the
// shared config, import-job, proxy, and SQL-audit services. It intentionally
// excludes desktop window APIs, keep-alives, cloud backup, and data-sync
// schedulers.
func InitializeHeadlessLifecycle(a *App, ctx context.Context, configDir string) error {
	if a == nil {
		return errors.New("application is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	configDir = strings.TrimSpace(configDir)
	if configDir == "" {
		configDir = resolveAppConfigDir()
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}

	a.headlessRuntime = true
	a.ctx = uievents.WithEmitter(ctx, headlessEventEmitter{})
	a.startedAt = time.Now()
	a.configDir = configDir
	db.SetExternalDriverDownloadDirectory(appdata.DriverRoot(configDir))
	logger.Init()
	if err := migrateDailySecretsIfNeeded(a); err != nil {
		logger.Warnf("无头运行时迁移日常密文失败：%v", err)
	}
	// A headless process can run alongside the desktop app. Opening the shared
	// store is required by batch commands, but crash recovery is desktop-owned:
	// without a process lease it cannot distinguish stale jobs from work that a
	// live GUI process is still executing.
	if _, err := a.ensureImportJobStore(); err != nil {
		a.Shutdown()
		return fmt.Errorf("initialize SQL-file job store: %w", err)
	}
	a.loadPersistedGlobalProxy()
	a.loadPersistedDownloadSource()
	a.activateSQLAudit()
	logger.Infof("无头运行时启动完成")
	return nil
}

// HandleFrontendDomReady 在 WebView 每次完成导航（含前端刷新）后调用。
//
// SQL 编辑器待提交事务的 ID 只存在于前端组件内存，刷新后无法再被提交或回滚，
// 却仍在后端占着 pinned 连接与数据库行锁，直到应用退出。这里把这些孤儿事务回滚掉。
// 首次加载时事务表为空，因此本调用是无副作用的。
func HandleFrontendDomReady(a *App) {
	if a == nil {
		return
	}
	a.rollbackAbandonedSQLTransactionsOnReload()
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.startedAt = time.Now()
	if strings.TrimSpace(a.configDir) == "" {
		a.configDir = resolveAppConfigDir()
	}
	db.SetExternalDriverDownloadDirectory(appdata.DriverRoot(a.configDir))
	logger.Init()
	logStartupDiagnostics(a.configDir)
	if err := migrateDailySecretsIfNeeded(a); err != nil {
		logger.Warnf("迁移日常密文失败：%v", err)
	}
	if err := a.recoverImportJobsOnStartup(); err != nil {
		logger.Warnf("恢复导入任务状态失败：%v", err)
	}
	a.loadPersistedGlobalProxy()
	a.loadPersistedDownloadSource()
	if err := migrateLegacyWebKitStorageIfNeeded(a); err != nil {
		logger.Warnf("迁移旧 WebKit 连接存储失败：%v", err)
	}
	a.activateSQLAudit()
	if shouldInstallMacNativeWindowDiagnostics() {
		installMacNativeWindowDiagnostics(logger.Path())
	}
	applyMacWindowTranslucencyFix()
	a.startConnectionKeepAliveLoop()
	a.initializeDataSyncJobs(ctx)
	a.initializeCloudBackup(ctx)
	logger.Infof("应用启动完成（首次连接保护窗口=%s，最多重试=%d 次）", startupConnectRetryWindow, startupConnectRetryAttempts)
}

// SetWindowTranslucency 动态调整 macOS 窗口透明度。
// 前端在加载用户外观设置后、以及用户修改外观时调用此方法。
// opacity=1.0 且 blur=0 时窗口标记为 opaque，GPU 不再持续计算窗口背后的模糊合成。
func (a *App) SetWindowTranslucency(opacity float64, blur float64, darkAppearance bool) {
	setMacWindowTranslucency(opacity, blur, darkAppearance)
}

// SetMacNativeWindowControls is retained for compatibility with older frontends.
// macOS native traffic-light controls are now an application invariant.
func (a *App) SetMacNativeWindowControls(bool) {
	setMacNativeWindowControls(true)
}

// ResetWebViewZoom 把 WebView2 zoom factor 强制重置为 1.0，让 WebView2 重算字体度量。
// 用于 Windows 任务栏恢复后字体异常变大的"零感知"修复：不动窗口、零动画。
// 仅 Windows 上生效，其他平台返回错误（前端按需忽略）。
func (a *App) ResetWebViewZoom() (result connection.QueryResult) {
	defer func() {
		if recovered := recover(); recovered != nil {
			logger.Errorf("重置 WebView2 zoom 失败：%v", recovered)
			result = connection.QueryResult{
				Success: false,
				Message: a.appText("app.backend.error.reset_webview_zoom_failed", map[string]any{"detail": fmt.Sprint(recovered)}),
			}
		}
	}()
	if err := resetWebViewZoomFactor(a.ctx, 1.0); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "WebView2 zoom factor reset to 1.0"}
}

// RefreshWebViewBounds synchronises WebView2 controller bounds with the native
// Windows client rect. It repairs a startup maximise race without toggling the window.
func (a *App) RefreshWebViewBounds() (result connection.QueryResult) {
	defer func() {
		if recovered := recover(); recovered != nil {
			logger.Errorf("刷新 WebView2 窗口边界失败：%v", recovered)
			result = connection.QueryResult{
				Success: false,
				Message: fmt.Sprintf("failed to refresh WebView2 bounds: %v", recovered),
			}
		}
	}()
	if a == nil || a.ctx == nil {
		return connection.QueryResult{Success: false, Message: "application context is unavailable"}
	}
	if err := refreshWebViewBounds(a.ctx); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "WebView2 bounds refreshed"}
}

// LogWindowDiagnostic 记录前端采集到的窗口诊断信息，便于排查 macOS 原生全屏异常。
func (a *App) LogWindowDiagnostic(stage string, payload string) {
	stage = strings.TrimSpace(stage)
	payload = strings.TrimSpace(payload)
	if stage == "" {
		stage = "unknown"
	}
	logger.Warnf("窗口诊断：stage=%s payload=%s", stage, payload)
}

// Shutdown is called when the app terminates.
func (a *App) Shutdown() {
	logger.Infof("应用开始关闭，准备释放资源")
	if !a.cancelAndWaitConnectionHealthRuns(5 * time.Second) {
		logger.Warnf("连接健康检查任务未能在关闭超时内全部退出；将继续释放数据库资源")
	}
	a.shutdownCloudBackup()
	a.shutdownDataSyncJobs()
	if !a.cancelAndWaitImportTasks(5 * time.Second) {
		logger.Warnf("导入任务未能在关闭超时内全部退出；将继续释放数据库资源")
	}
	a.beginDatabaseShutdown()
	a.stopConnectionKeepAliveLoop()
	closeJVMMonitoringSessions()
	a.closeResultDiffSessions()
	a.rollbackPendingSQLTransactionsOnShutdown()
	a.closeSQLAuditStore()
	a.closeCachedDatabasesForShutdown()
	proxytunnel.CloseAllForwarders()
	// Close all Redis connections
	CloseAllRedisClients()
	// Close Nacos listeners and connections
	CloseAllNacosClients()
	logger.Infof("资源释放完成，应用已关闭")
	logger.Close()
}

func dataRootInfoPayload(activeRoot string) map[string]interface{} {
	defaultRoot := appdata.DefaultRoot()
	currentRoot := strings.TrimSpace(activeRoot)
	if currentRoot == "" {
		currentRoot = appdata.MustResolveActiveRoot()
	}
	defaultSavedQueryDirectory := appdata.DefaultSavedQueryDirectory(currentRoot)
	savedQueryDirectory, err := appdata.ResolveSavedQueryDirectory(currentRoot)
	if err != nil || strings.TrimSpace(savedQueryDirectory) == "" {
		savedQueryDirectory = defaultSavedQueryDirectory
	}
	savedQueryDirectorySource := "custom"
	if directoriesEqual(savedQueryDirectory, defaultSavedQueryDirectory) {
		savedQueryDirectorySource = "default"
	}
	payload := map[string]interface{}{
		"path":                       currentRoot,
		"defaultPath":                defaultRoot,
		"driverPath":                 appdata.DriverRoot(currentRoot),
		"isDefaultPath":              filepath.Clean(currentRoot) == filepath.Clean(defaultRoot),
		"bootstrapPath":              appdata.BootstrapPath(),
		"savedQueryDirectory":        savedQueryDirectory,
		"defaultSavedQueryDirectory": defaultSavedQueryDirectory,
		"savedQueryDirectorySource":  savedQueryDirectorySource,
	}
	for key, value := range logDirectoryInfoPayload() {
		payload[key] = value
	}
	return payload
}
