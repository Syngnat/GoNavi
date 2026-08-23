package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/jvm"
	"GoNavi-Wails/internal/logger"
	nacosbackend "GoNavi-Wails/internal/nacos"
	proxytunnel "GoNavi-Wails/internal/proxy"
	redisbackend "GoNavi-Wails/internal/redis"
	"GoNavi-Wails/internal/requesttrace"
	"GoNavi-Wails/internal/resultdiff"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/sqlaudit"
	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/synccdc"
	"GoNavi-Wails/internal/syncjob"
	"GoNavi-Wails/internal/uievents"
	"GoNavi-Wails/shared/i18n"
	"github.com/google/uuid"
	"golang.org/x/sync/singleflight"
)

const dbCachePingInterval = 30 * time.Second
const dbConnectFailureCooldown = 30 * time.Second

const (
	startupConnectRetryWindow   = 20 * time.Second
	startupConnectRetryDelay    = 800 * time.Millisecond
	startupConnectRetryAttempts = 4
)

var (
	newDatabaseFunc                = db.NewDatabase
	resolveDialConfigWithProxyFunc = resolveDialConfigWithProxy
	driverRuntimeSupportStatusFunc = db.DriverRuntimeSupportStatus
	verifyDriverAgentRevisionFunc  = verifyRuntimeOptionalDriverAgentRevision
	defaultAppTextMu               sync.RWMutex
	defaultAppTextLanguage         = i18n.LanguageEnUS
	defaultAppTextLocalizer        *i18n.Localizer
)

var (
	errDatabaseConnectionReleased = errors.New("数据库连接请求已被释放")
	errDatabaseConnectionShutdown = errors.New("应用正在关闭，无法建立数据库连接")
)

type cachedDatabase struct {
	inst                      db.Database
	lastPing                  time.Time
	lastKeepAliveAt           time.Time
	config                    connection.ConnectionConfig
	keepAliveEnabled          bool
	keepAliveInterval         time.Duration
	keepAliveSQL              string
	keepAliveDBType           string
	keepAliveRevision         uint64
	keepAliveInFlight         bool
	keepAliveInFlightRevision uint64
}

type connectionKeepAlivePolicy struct {
	enabled  bool
	interval time.Duration
	sql      string
	dbType   string
}

func resolveConnectionKeepAlivePolicy(config connection.ConnectionConfig) connectionKeepAlivePolicy {
	enabled, interval := resolveConnectionKeepAliveSettings(config)
	sql, dbType := resolveConnectionKeepAliveSQL(config)
	return connectionKeepAlivePolicy{
		enabled:  enabled,
		interval: interval,
		sql:      sql,
		dbType:   dbType,
	}
}

func (policy connectionKeepAlivePolicy) matches(entry cachedDatabase) bool {
	return entry.keepAliveEnabled == policy.enabled &&
		entry.keepAliveInterval == policy.interval &&
		entry.keepAliveSQL == policy.sql &&
		entry.keepAliveDBType == policy.dbType
}

func (policy connectionKeepAlivePolicy) apply(entry cachedDatabase, now time.Time) cachedDatabase {
	if policy.matches(entry) {
		return entry
	}
	wasKeepAliveEnabled := entry.keepAliveEnabled
	entry.keepAliveRevision = nextConnectionKeepAliveRevision(entry.keepAliveRevision)
	entry.keepAliveEnabled = policy.enabled
	entry.keepAliveInterval = policy.interval
	entry.keepAliveSQL = policy.sql
	entry.keepAliveDBType = policy.dbType
	if !policy.enabled {
		entry.keepAliveInFlight = false
		entry.keepAliveInFlightRevision = 0
		entry.lastKeepAliveAt = time.Time{}
	} else if !wasKeepAliveEnabled || entry.lastKeepAliveAt.IsZero() {
		entry.lastKeepAliveAt = now
	}
	return entry
}

type cachedConnectFailure struct {
	occurredAt time.Time
	err        error
}

type databaseConnectFlight struct {
	id              uint64
	groupKey        string
	cacheKey        string
	releaseMatchKey string
	cancelErr       error
}

type databaseConnectResult struct {
	inst     db.Database
	cacheKey string
}

type queryContext struct {
	cancel                  context.CancelFunc
	started                 time.Time
	retainUntilDone         bool
	cancellationUnsupported bool
	registrationID          uint64
}

type managedSQLTransaction struct {
	mu           sync.Mutex
	id           string
	execer       db.StatementExecer
	transactor   db.TransactionExecer
	cancel       context.CancelFunc
	config       connection.ConnectionConfig
	dbType       string
	boundaryMode string
	commitSQL    string
	rollbackSQL  string
	createdAt    time.Time
	finished     bool
}

// App struct
type App struct {
	ctx                           context.Context
	webRuntime                    bool
	headlessRuntime               bool
	startedAt                     time.Time
	dbCache                       map[string]cachedDatabase // Cache for DB connections
	connectFailures               map[string]cachedConnectFailure
	dbConnectGroup                singleflight.Group
	dbConnectFlights              map[uint64]*databaseConnectFlight
	metadataSession               *metadataSession
	nextDBConnectFlightID         uint64
	dbShuttingDown                bool
	dbConnectBeforeForgetHook     func()       // Test seam for release/singleflight ordering.
	mu                            sync.RWMutex // Mutex for cache access
	updateMu                      sync.Mutex
	updateState                   updateState
	i18nMu                        sync.RWMutex
	localizer                     *i18n.Localizer
	applicationQuitMu             sync.Mutex
	allowApplicationQuit          bool
	applicationQuitPromptInFlight bool
	queryMu                       sync.RWMutex
	nextQueryRegistrationID       uint64
	importArtifactMu              sync.Mutex
	importErrorArtifacts          *importErrorArtifactStore
	importJobMu                   sync.Mutex
	importJobStore                *importjob.Store
	importTaskMu                  sync.Mutex
	importTasks                   map[string]importTaskRegistration
	importTasksWG                 sync.WaitGroup
	importTasksClosing            bool
	driverDownloadTaskMu          sync.RWMutex
	driverDownloadTasks           map[string]DriverDownloadTaskStatus
	driverDownloadActiveTaskID    string
	driverDownloadTaskRunner      func(string, string, string, string) connection.QueryResult
	dataRootApplyMu               sync.Mutex
	configDir                     string
	sqliteTableStatsMu            sync.Mutex
	secretStore                   secretstore.SecretStore
	runningQueries                map[string]queryContext // queryID -> cancelFunc and start time
	sqlTransactionMu              sync.Mutex
	sqlTransactions               map[string]*managedSQLTransaction
	sqlAuditMu                    sync.RWMutex
	sqlAuditStore                 *sqlaudit.Store
	sqlAuditStorePath             string
	sqlAuditRuntimeActive         bool
	sqlAuditSuspended             bool
	sqlAuditAppendMu              sync.Mutex
	requestTraceMu                sync.Mutex
	requestTraceStore             *requesttrace.Store
	sqlAuditHealthMu              sync.RWMutex
	sqlAuditHealth                sqlAuditHealthState
	sqlAuditHealthPath            string
	sqlAuditHealthRevision        uint64
	sqlAuditSuspensionDropped     int64
	sqlAuditSuspensionFirstAt     int64
	sqlAuditSuspensionLastAt      int64
	sqlAuditSuspensionLastError   string
	jvmPreviewTokenMu             sync.Mutex
	jvmPreviewTokens              map[string]jvmPreviewConfirmationToken
	jvmPreviewTokenTTL            time.Duration
	elasticsearchConsoleTokenMu   sync.Mutex
	elasticsearchConsoleTokens    map[string]elasticsearchConsoleConfirmationToken
	elasticsearchConsoleTokenTTL  time.Duration
	keepAliveCancel               context.CancelFunc
	keepAliveDone                 chan struct{}
	resultDiffManager             *resultdiff.Manager
	saveFileDialog                saveFileDialogFunc
	cloudBackupSyncMu             sync.Mutex
	cloudBackupStateMu            sync.Mutex
	cloudBackupSecretMu           sync.Mutex
	cloudBackupSchedulerMu        sync.Mutex
	cloudBackupSchedulerCancel    context.CancelFunc
	cloudBackupDirtyMu            sync.Mutex
	cloudBackupDirty              bool
	cloudBackupDirtyRevision      uint64
	cloudBackupRestoreTokenMu     sync.Mutex
	cloudBackupRestoreTokens      map[string]cloudBackupRestoreConfirmationToken
	cloudBackupRestoreTokenTTL    time.Duration
	dataSyncJobApprovalMu         sync.Mutex
	dataSyncJobApprovalTokens     map[string]dataSyncJobApprovalToken
	dataSyncJobApprovalChallenges map[string]dataSyncJobApprovalChallenge
	dataSyncJobApprovalTokenTTL   time.Duration
	dataSyncJobApprovalDelay      time.Duration
	dataSyncFingerprintMu         sync.Mutex
	dataSyncFingerprintKey        []byte
	dataSyncJobsMu                sync.Mutex
	dataSyncJobStore              *syncjob.Store
	dataSyncJobManager            *syncjob.Manager
	dataSyncJobLeaseOwner         string
	dataSyncJobsDraining          bool
	dataSyncCDCRegistry           *synccdc.Registry
	dataSyncChangeEventRunner     func(context.Context, syncbackend.ChangeEventRequest) syncbackend.ChangeEventResult
}

// NewApp creates a new App application struct
func NewApp() *App {
	return NewAppWithSecretStore(secretstore.NewKeyringStore())
}

// NewWebApp creates the backend used by the authenticated browser server.
// The immutable runtime marker keeps desktop-only Wails APIs from being
// reached through the reflective Web RPC bridge.
func NewWebApp() *App {
	app := NewApp()
	app.webRuntime = true
	return app
}

// NewHeadlessApp creates an App with only the lifecycle resources required by
// non-GUI callers such as the CLI and MCP server.
func NewHeadlessApp(ctx context.Context, configDir string) (*App, error) {
	app := NewApp()
	if err := InitializeHeadlessLifecycle(app, ctx, configDir); err != nil {
		return nil, err
	}
	return app, nil
}

func NewAppWithSecretStore(store secretstore.SecretStore) *App {
	if store == nil {
		store = secretstore.NewUnavailableStore("secret store unavailable")
	}
	return &App{
		dbCache:                       make(map[string]cachedDatabase),
		connectFailures:               make(map[string]cachedConnectFailure),
		dbConnectFlights:              make(map[uint64]*databaseConnectFlight),
		runningQueries:                make(map[string]queryContext),
		importTasks:                   make(map[string]importTaskRegistration),
		driverDownloadTasks:           make(map[string]DriverDownloadTaskStatus),
		sqlTransactions:               make(map[string]*managedSQLTransaction),
		requestTraceStore:             requesttrace.NewStore(requesttrace.DefaultCapacity),
		configDir:                     resolveAppConfigDir(),
		secretStore:                   store,
		localizer:                     newAppLocalizer(),
		jvmPreviewTokens:              make(map[string]jvmPreviewConfirmationToken),
		jvmPreviewTokenTTL:            defaultJVMPreviewConfirmationTokenTTL,
		elasticsearchConsoleTokens:    make(map[string]elasticsearchConsoleConfirmationToken),
		elasticsearchConsoleTokenTTL:  defaultElasticsearchConsoleConfirmationTokenTTL,
		cloudBackupRestoreTokens:      make(map[string]cloudBackupRestoreConfirmationToken),
		cloudBackupRestoreTokenTTL:    defaultCloudBackupRestoreConfirmationTokenTTL,
		dataSyncJobApprovalTokens:     make(map[string]dataSyncJobApprovalToken),
		dataSyncJobApprovalChallenges: make(map[string]dataSyncJobApprovalChallenge),
		dataSyncJobApprovalTokenTTL:   defaultDataSyncJobApprovalTokenTTL,
		dataSyncJobApprovalDelay:      defaultDataSyncJobApprovalDelay,
		dataSyncJobLeaseOwner:         "sync-manager-" + uuid.NewString(),
		dataSyncCDCRegistry:           synccdc.NewRegistry(),
		resultDiffManager:             resultdiff.NewManager(30 * time.Minute),
	}
}

func newAppLocalizer() *i18n.Localizer {
	localizer, err := i18n.NewLocalizer(i18n.LanguageEnUS)
	if err != nil {
		logger.Warnf("加载应用多语言目录失败：%v", err)
		return nil
	}
	return localizer
}

func setDefaultAppLanguage(language i18n.Language) {
	defaultAppTextMu.Lock()
	defer defaultAppTextMu.Unlock()

	defaultAppTextLanguage = language
	if defaultAppTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(language)
		if err != nil {
			logger.Warnf("加载默认多语言目录失败：%v", err)
			return
		}
		defaultAppTextLocalizer = localizer
		return
	}
	defaultAppTextLocalizer.SetLanguage(language)
}

func defaultAppText(key string, params map[string]any) string {
	defaultAppTextMu.RLock()
	if defaultAppTextLocalizer != nil {
		text := defaultAppTextLocalizer.T(key, params)
		defaultAppTextMu.RUnlock()
		return text
	}
	defaultAppTextMu.RUnlock()

	defaultAppTextMu.Lock()
	defer defaultAppTextMu.Unlock()
	if defaultAppTextLocalizer == nil {
		localizer, err := i18n.NewLocalizer(defaultAppTextLanguage)
		if err != nil {
			logger.Warnf("加载默认多语言目录失败：%v", err)
			return key
		}
		defaultAppTextLocalizer = localizer
	}
	return defaultAppTextLocalizer.T(key, params)
}

func (a *App) SetLanguage(language string) {
	normalized, ok := i18n.NormalizeLanguage(language)
	if !ok {
		return
	}
	a.i18nMu.Lock()
	defer a.i18nMu.Unlock()
	if a.localizer == nil {
		a.localizer = newAppLocalizer()
	}
	if a.localizer != nil {
		a.localizer.SetLanguage(normalized)
	}
	setDefaultAppLanguage(normalized)
	db.SetBackendLanguage(normalized)
	jvm.SetBackendLanguage(normalized)
	proxytunnel.SetBackendLanguage(normalized)
	redisbackend.SetBackendLanguage(normalized)
	nacosbackend.SetBackendLanguage(normalized)
	syncbackend.SetBackendLanguage(normalized)
}

func (a *App) appText(key string, params map[string]any) string {
	if a == nil {
		return key
	}
	a.i18nMu.RLock()
	if a.localizer != nil {
		text := a.localizer.T(key, params)
		a.i18nMu.RUnlock()
		return text
	}
	a.i18nMu.RUnlock()

	a.i18nMu.Lock()
	defer a.i18nMu.Unlock()
	if a.localizer == nil {
		a.localizer = newAppLocalizer()
	}
	if a.localizer == nil {
		return key
	}
	return a.localizer.T(key, params)
}

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
func (a *App) SetWindowTranslucency(opacity float64, blur float64) {
	setMacWindowTranslucency(opacity, blur)
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

func normalizeCacheKeyConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	normalized := config
	normalized.ID = ""
	normalized.Type = strings.ToLower(strings.TrimSpace(normalized.Type))
	if normalized.Type == "oceanbase" {
		protocol := resolveOceanBaseProtocolForApp(normalized)
		normalized.ConnectionParams = normalizeOceanBaseConnectionParamsForCacheWithProtocol(normalized.ConnectionParams, protocol)
		normalized.OceanBaseProtocol = ""
	}
	// Connection/query timeouts affect operations, not physical connection identity.
	normalized.Timeout = 0
	normalized.QueryTimeout = 0
	// keepalive 仅影响后台保活策略，不应参与物理连接复用键。
	normalized.KeepAliveEnabled = false
	normalized.KeepAliveIntervalMinutes = 0
	normalized.KeepAliveSQL = ""
	normalized.SavePassword = false

	if !normalized.UseSSH {
		normalized.SSH = connection.SSHConfig{}
	}
	if !normalized.UseProxy {
		normalized.Proxy = connection.ProxyConfig{}
	}
	if !normalized.UseHTTPTunnel {
		normalized.HTTPTunnel = connection.HTTPTunnelConfig{}
	}

	if isFileDatabaseType(normalized.Type) {
		dsn := strings.TrimSpace(normalized.Host)
		if dsn == "" {
			dsn = strings.TrimSpace(normalized.Database)
		}
		if dsn == "" {
			dsn = ":memory:"
		}

		// DuckDB/SQLite 仅基于文件来源识别连接，其他网络字段不参与键计算。
		normalized.Host = dsn
		normalized.Database = ""
		normalized.Port = 0
		normalized.User = ""
		normalized.Password = ""
		normalized.URI = ""
		normalized.ConnectionParams = ""
		normalized.Hosts = nil
		normalized.Topology = ""
		normalized.RedisSentinelMaster = ""
		normalized.RedisSentinelUser = ""
		normalized.RedisSentinelPassword = ""
		normalized.MySQLReplicaUser = ""
		normalized.MySQLReplicaPassword = ""
		normalized.ReplicaSet = ""
		normalized.AuthSource = ""
		normalized.ReadPreference = ""
		normalized.MongoSRV = false
		normalized.MongoAuthMechanism = ""
		normalized.MongoReplicaUser = ""
		normalized.MongoReplicaPassword = ""
		normalized.UseHTTPTunnel = false
		normalized.HTTPTunnel = connection.HTTPTunnelConfig{}
	}

	return normalized
}

func resolveFileDatabaseDSN(config connection.ConnectionConfig) string {
	dsn := strings.TrimSpace(config.Host)
	if dsn == "" {
		dsn = strings.TrimSpace(config.Database)
	}
	if dsn == "" {
		dsn = ":memory:"
	}
	return dsn
}

// Helper: Generate a unique key for the connection config
func getCacheKey(config connection.ConnectionConfig) string {
	normalized := normalizeCacheKeyConfig(config)
	b, _ := json.Marshal(normalized)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func normalizeConnectionReleaseMatchConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	normalized := normalizeCacheKeyConfig(config)
	normalized.Database = ""
	normalized.RedisDB = 0
	normalized.ConnectionParams = ""
	return normalized
}

func getConnectionReleaseMatchKey(config connection.ConnectionConfig) string {
	normalized := normalizeConnectionReleaseMatchConfig(config)
	b, _ := json.Marshal(normalized)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

type cachedDatabaseCloseTarget struct {
	key  string
	inst db.Database
}

func (a *App) beginDatabaseConnectFlight(groupKey string, config connection.ConnectionConfig) (*databaseConnectFlight, error) {
	if a == nil {
		return nil, errDatabaseConnectionShutdown
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.dbShuttingDown {
		return nil, errDatabaseConnectionShutdown
	}
	if a.dbConnectFlights == nil {
		a.dbConnectFlights = make(map[uint64]*databaseConnectFlight)
	}
	// Keep only active physical leaders. Release can invalidate these tokens
	// without retaining a generation/tombstone for every connection ever seen.
	a.nextDBConnectFlightID++
	flight := &databaseConnectFlight{
		id:              a.nextDBConnectFlightID,
		groupKey:        groupKey,
		cacheKey:        groupKey,
		releaseMatchKey: getConnectionReleaseMatchKey(config),
	}
	a.dbConnectFlights[flight.id] = flight
	return flight, nil
}

func (a *App) finishDatabaseConnectFlight(flight *databaseConnectFlight) {
	if a == nil || flight == nil {
		return
	}
	a.mu.Lock()
	if current, exists := a.dbConnectFlights[flight.id]; exists && current == flight {
		delete(a.dbConnectFlights, flight.id)
	}
	a.mu.Unlock()
}

func (a *App) databaseConnectFlightErrorLocked(flight *databaseConnectFlight) error {
	if a.dbShuttingDown {
		return errDatabaseConnectionShutdown
	}
	if flight == nil {
		return errDatabaseConnectionReleased
	}
	current, exists := a.dbConnectFlights[flight.id]
	if !exists || current != flight {
		return errDatabaseConnectionReleased
	}
	return flight.cancelErr
}

func (a *App) databaseConnectFlightError(flight *databaseConnectFlight) error {
	if a == nil {
		return errDatabaseConnectionShutdown
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.databaseConnectFlightErrorLocked(flight)
}

func (a *App) databaseConnectionReturnError(cacheKey string, inst db.Database) error {
	if a == nil {
		return errDatabaseConnectionShutdown
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.dbShuttingDown {
		return errDatabaseConnectionShutdown
	}
	entry, exists := a.dbCache[cacheKey]
	if !exists || entry.inst == nil || entry.inst != inst {
		return errDatabaseConnectionReleased
	}
	return nil
}

func (a *App) markCachedDatabaseHealthy(inst db.Database, healthyAt time.Time) {
	if a == nil || inst == nil {
		return
	}
	if healthyAt.IsZero() {
		healthyAt = time.Now()
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	for key, entry := range a.dbCache {
		if entry.inst != inst || !healthyAt.After(entry.lastPing) {
			continue
		}
		entry.lastPing = healthyAt
		a.dbCache[key] = entry
	}
}

func (a *App) cancelDatabaseConnectFlightsLocked(match func(*databaseConnectFlight) bool, cancelErr error, excludedFlightID uint64) []string {
	groupKeys := make([]string, 0)
	for _, flight := range a.dbConnectFlights {
		if flight == nil || flight.id == excludedFlightID || !match(flight) {
			continue
		}
		if flight.cancelErr == nil || errors.Is(cancelErr, errDatabaseConnectionShutdown) {
			flight.cancelErr = cancelErr
		}
		if a.connectFailures != nil {
			delete(a.connectFailures, flight.cacheKey)
		}
		groupKeys = append(groupKeys, flight.groupKey)
	}
	return groupKeys
}

func (a *App) forgetDatabaseConnectGroupsLocked(groupKeys []string) {
	if a == nil || len(groupKeys) == 0 {
		return
	}
	// Keep Forget in the same app-cache critical section as flight cancellation.
	// Otherwise an old leader can finish, a fresh group can be installed, and a
	// delayed Forget can accidentally remove that fresh group (ABA).
	if a.dbConnectBeforeForgetHook != nil {
		a.dbConnectBeforeForgetHook()
	}
	forgotten := make(map[string]struct{}, len(groupKeys))
	for _, groupKey := range groupKeys {
		if _, exists := forgotten[groupKey]; exists {
			continue
		}
		forgotten[groupKey] = struct{}{}
		// A request that starts after release must create a fresh physical flight
		// instead of joining the invalidated leader still unwinding in Connect.
		a.dbConnectGroup.Forget(groupKey)
	}
}

func (a *App) beginDatabaseShutdown() {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.dbShuttingDown = true
	groupKeys := a.cancelDatabaseConnectFlightsLocked(func(*databaseConnectFlight) bool { return true }, errDatabaseConnectionShutdown, 0)
	a.forgetDatabaseConnectGroupsLocked(groupKeys)
	a.mu.Unlock()
}

func (a *App) closeCachedDatabasesForShutdown() {
	if a == nil {
		return
	}
	targets := make([]cachedDatabaseCloseTarget, 0)
	a.mu.Lock()
	for key, entry := range a.dbCache {
		targets = append(targets, cachedDatabaseCloseTarget{key: key, inst: entry.inst})
	}
	a.dbCache = make(map[string]cachedDatabase)
	a.connectFailures = make(map[string]cachedConnectFailure)
	a.mu.Unlock()

	for _, target := range targets {
		if target.inst == nil {
			continue
		}
		if err := target.inst.Close(); err != nil {
			logger.Error(err, "关闭数据库连接失败：缓存Key=%s", shortCacheKey(target.key))
		}
	}
}

func (a *App) releaseCachedDatabaseConnectionsForConfig(config connection.ConnectionConfig) int {
	if a == nil {
		return 0
	}
	return a.releaseCachedDatabaseConnectionsForConfigExcludingFlight(config, 0)
}

func (a *App) releaseCachedDatabaseConnectionsForConfigExcludingFlight(config connection.ConnectionConfig, excludedFlightID uint64) int {
	if a == nil {
		return 0
	}
	return a.releaseCachedDatabaseConnectionsByMatchKeyExcludingFlight(getConnectionReleaseMatchKey(config), excludedFlightID)
}

func (a *App) releaseCachedDatabaseConnectionsByMatchKey(targetKey string) int {
	return a.releaseCachedDatabaseConnectionsByMatchKeyExcludingFlight(targetKey, 0)
}

func (a *App) releaseCachedDatabaseConnectionsByMatchKeyExcludingFlight(targetKey string, excludedFlightID uint64) int {
	if a == nil || strings.TrimSpace(targetKey) == "" {
		return 0
	}

	targets := make([]cachedDatabaseCloseTarget, 0)
	a.mu.Lock()
	// Mark leaders under the same lock used by the final cache write. This is
	// the release/store linearization point that prevents late resurrection.
	groupKeys := a.cancelDatabaseConnectFlightsLocked(func(flight *databaseConnectFlight) bool {
		return flight.releaseMatchKey == targetKey
	}, errDatabaseConnectionReleased, excludedFlightID)
	for key, entry := range a.dbCache {
		entryConfig := entry.config
		if strings.TrimSpace(entryConfig.Type) == "" {
			continue
		}
		if getConnectionReleaseMatchKey(entryConfig) != targetKey {
			continue
		}
		targets = append(targets, cachedDatabaseCloseTarget{key: key, inst: entry.inst})
		groupKeys = append(groupKeys, key)
		delete(a.dbCache, key)
	}
	a.forgetDatabaseConnectGroupsLocked(groupKeys)
	a.mu.Unlock()

	for _, target := range targets {
		if target.inst == nil {
			continue
		}
		if closeErr := target.inst.Close(); closeErr != nil {
			logger.Error(closeErr, "关闭缓存连接失败：缓存Key=%s", shortCacheKey(target.key))
		}
	}

	return len(targets)
}

func isMySQLMaxUserConnectionsError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(normalizeErrorMessage(err))
	return strings.Contains(message, "max_user_connections") ||
		(strings.Contains(message, "error 1226") && strings.Contains(message, "has exceeded"))
}

func withMySQLMaxUserConnectionsHint(err error, released int) error {
	if err == nil {
		return nil
	}
	if !isMySQLMaxUserConnectionsError(err) {
		return err
	}
	if released > 0 {
		return fmt.Errorf("%w；数据库账号连接数已达上限(max_user_connections)，GoNavi 已释放同一连接实例的 %d 个缓存连接并重试；若仍失败，请关闭 Navicat/其他客户端连接或提高数据库用户 max_user_connections", err, released)
	}
	return fmt.Errorf("%w；数据库账号连接数已达上限(max_user_connections)，GoNavi 未找到可释放的同实例缓存连接；请关闭 Navicat/其他客户端连接或提高数据库用户 max_user_connections", err)
}

func shortCacheKey(cacheKey string) string {
	shortKey := cacheKey
	if len(shortKey) > 12 {
		shortKey = shortKey[:12]
	}
	return shortKey
}

func shouldRefreshCachedConnection(err error) bool {
	if err == nil {
		return false
	}
	normalized := strings.ToLower(normalizeErrorMessage(err))
	if normalized == "" {
		return false
	}

	patterns := []string{
		"invalid connection",
		"bad connection",
		"database is closed",
		"connection is already closed",
		"use of closed network connection",
		"broken pipe",
		"connection reset by peer",
		"server has gone away",
		"eof",
	}
	for _, pattern := range patterns {
		if strings.Contains(normalized, pattern) {
			return true
		}
	}
	return false
}

func (a *App) invalidateCachedDatabase(config connection.ConnectionConfig, reason error) bool {
	if effectiveConfig, err := a.resolveEffectiveConnectionConfig(config); err == nil {
		config = effectiveConfig
	}
	effectiveConfig := config
	key := getCacheKey(effectiveConfig)
	shortKey := shortCacheKey(key)

	a.mu.Lock()
	groupKeys := a.cancelDatabaseConnectFlightsLocked(func(flight *databaseConnectFlight) bool {
		return flight.cacheKey == key
	}, errDatabaseConnectionReleased, 0)
	groupKeys = append(groupKeys, key)
	entry, exists := a.dbCache[key]
	if !exists || entry.inst == nil {
		a.forgetDatabaseConnectGroupsLocked(groupKeys)
		a.mu.Unlock()
		return false
	}
	delete(a.dbCache, key)
	a.forgetDatabaseConnectGroupsLocked(groupKeys)
	a.mu.Unlock()

	if closeErr := entry.inst.Close(); closeErr != nil {
		logger.Error(closeErr, "关闭失效缓存连接失败：缓存Key=%s", shortKey)
	}
	if reason != nil {
		logger.Errorf("检测到连接失效，已清理缓存连接：%s 缓存Key=%s 原因=%s", formatConnSummary(effectiveConfig), shortKey, normalizeErrorMessage(reason))
	} else {
		logger.Infof("已清理缓存连接：%s 缓存Key=%s", formatConnSummary(effectiveConfig), shortKey)
	}
	return true
}

func wrapConnectError(config connection.ConnectionConfig, err error) error {
	if err == nil {
		return nil
	}
	err = sanitizeMongoConnectErrorLabel(config, err)

	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		dbName := config.Database
		if dbName == "" {
			dbName = "(default)"
		}
		err = errorMessageOverride{
			message: defaultAppText("db.backend.message.connect_timeout_detail", map[string]any{
				"dbType":   config.Type,
				"host":     config.Host,
				"port":     config.Port,
				"database": dbName,
				"detail":   normalizeErrorMessage(err),
			}),
			cause: err,
		}
	}

	return withLogHint{err: err, logPath: logger.Path()}
}

type errorMessageOverride struct {
	message string
	cause   error
}

type mongoConnectErrorLabelRewrite struct {
	legacy string
	key    string
}

var mongoConnectErrorLabelRewrites = []mongoConnectErrorLabelRewrite{
	{legacy: "SSL \u4e3b\u5e93\u51ed\u636e", key: "db.backend.message.mongo_primary_credentials_label"},
	{legacy: "SSL \u4ece\u5e93\u51ed\u636e", key: "db.backend.message.mongo_replica_credentials_label"},
}

func (e errorMessageOverride) Error() string {
	return e.message
}

func (e errorMessageOverride) Unwrap() error {
	return e.cause
}

func sanitizeMongoConnectErrorLabel(config connection.ConnectionConfig, err error) error {
	if err == nil {
		return nil
	}
	if strings.ToLower(strings.TrimSpace(config.Type)) != "mongodb" {
		return err
	}
	if mongoConnectUsesTLS(config) {
		return err
	}
	original := err.Error()
	rewritten := original
	for _, candidate := range mongoConnectErrorLabelRewrites {
		replacement := defaultAppText(candidate.key, nil)
		if replacement == "" || replacement == candidate.key {
			continue
		}
		rewritten = strings.ReplaceAll(rewritten, candidate.legacy, replacement)
	}
	if rewritten == original {
		return err
	}
	return errorMessageOverride{
		message: rewritten,
		cause:   err,
	}
}

func mongoConnectUsesTLS(config connection.ConnectionConfig) bool {
	if config.UseSSL {
		return true
	}
	uriText := strings.TrimSpace(config.URI)
	if uriText == "" {
		return false
	}
	parsed, err := url.Parse(uriText)
	if err != nil {
		return false
	}
	for _, key := range []string{"tls", "ssl"} {
		if enabled, known := parseMongoBool(parsed.Query().Get(key)); known {
			return enabled
		}
	}
	return strings.EqualFold(strings.TrimSpace(parsed.Scheme), "mongodb+srv")
}

func parseMongoBool(raw string) (enabled bool, known bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	switch value {
	case "1", "true", "t", "yes", "y", "on", "required":
		return true, true
	case "0", "false", "f", "no", "n", "off", "disable", "disabled":
		return false, true
	default:
		return false, false
	}
}

type withLogHint struct {
	err     error
	logPath string
}

func unwrapLogHintError(err error) error {
	if err == nil {
		return nil
	}
	var hinted withLogHint
	if errors.As(err, &hinted) && hinted.err != nil {
		return hinted.err
	}
	return err
}

func (e withLogHint) Error() string {
	message := normalizeErrorMessage(e.err)
	path := strings.TrimSpace(e.logPath)
	if path == "" {
		return message
	}
	info, statErr := os.Stat(path)
	if statErr != nil || info.IsDir() || info.Size() <= 0 {
		return message
	}
	return message + defaultAppText("driver_manager.backend.message.log_hint", map[string]any{"path": path})
}

func (e withLogHint) Unwrap() error {
	return e.err
}

func formatConnSummary(config connection.ConnectionConfig) string {
	timeoutSeconds := config.Timeout
	if timeoutSeconds <= 0 {
		timeoutSeconds = 30
	}

	dbName := config.Database
	if strings.TrimSpace(dbName) == "" {
		dbName = "(default)"
	}

	var b strings.Builder
	normalizedType := strings.ToLower(strings.TrimSpace(config.Type))
	if normalizedType == "sqlite" || normalizedType == "duckdb" {
		path := strings.TrimSpace(config.Host)
		if path == "" {
			path = "(未配置)"
		}
		b.WriteString(fmt.Sprintf("类型=%s 路径=%s 超时=%ds", config.Type, path, timeoutSeconds))
	} else {
		b.WriteString(fmt.Sprintf("类型=%s 地址=%s:%d 数据库=%s 用户=%s 超时=%ds",
			config.Type, config.Host, config.Port, dbName, config.User, timeoutSeconds))
	}

	if len(config.Hosts) > 0 {
		b.WriteString(fmt.Sprintf(" 节点数=%d", len(config.Hosts)))
	}
	if strings.TrimSpace(config.Topology) != "" {
		b.WriteString(fmt.Sprintf(" 拓扑=%s", strings.TrimSpace(config.Topology)))
	}
	if strings.TrimSpace(config.URI) != "" {
		b.WriteString(fmt.Sprintf(" URI=已配置(长度=%d)", len(config.URI)))
	}
	if strings.TrimSpace(config.ConnectionParams) != "" {
		b.WriteString(fmt.Sprintf(" 连接参数=已配置(长度=%d)", len(config.ConnectionParams)))
	}
	if strings.TrimSpace(config.MySQLReplicaUser) != "" {
		b.WriteString(" MySQL从库凭据=已配置")
	}
	if strings.EqualFold(strings.TrimSpace(config.Type), "mongodb") {
		if strings.TrimSpace(config.MongoReplicaUser) != "" {
			b.WriteString(" Mongo从库凭据=已配置")
		}
		if strings.TrimSpace(config.ReplicaSet) != "" {
			b.WriteString(fmt.Sprintf(" 副本集=%s", strings.TrimSpace(config.ReplicaSet)))
		}
		if strings.TrimSpace(config.ReadPreference) != "" {
			b.WriteString(fmt.Sprintf(" 读偏好=%s", strings.TrimSpace(config.ReadPreference)))
		}
		if strings.TrimSpace(config.AuthSource) != "" {
			b.WriteString(fmt.Sprintf(" 认证库=%s", strings.TrimSpace(config.AuthSource)))
		}
	}
	if strings.EqualFold(strings.TrimSpace(config.Type), "clickhouse") {
		protocol := strings.ToLower(strings.TrimSpace(config.ClickHouseProtocol))
		if protocol == "" {
			protocol = "auto"
		}
		b.WriteString(fmt.Sprintf(" ClickHouse协议=%s", protocol))
	}
	if strings.EqualFold(strings.TrimSpace(config.Type), "oceanbase") {
		protocol := "mysql"
		if isOceanBaseOracleProtocol(config) {
			protocol = "oracle"
		}
		b.WriteString(fmt.Sprintf(" OceanBase协议=%s", protocol))
	}

	if config.UseSSH {
		b.WriteString(fmt.Sprintf(" SSH=%s:%d 用户=%s", config.SSH.Host, config.SSH.Port, config.SSH.User))
	}
	if config.UseProxy {
		b.WriteString(fmt.Sprintf(" 代理=%s://%s:%d", strings.ToLower(strings.TrimSpace(config.Proxy.Type)), config.Proxy.Host, config.Proxy.Port))
		if strings.TrimSpace(config.Proxy.User) != "" {
			b.WriteString(" 代理认证=已配置")
		}
	}
	if config.UseHTTPTunnel {
		b.WriteString(fmt.Sprintf(" HTTP隧道=%s:%d", strings.TrimSpace(config.HTTPTunnel.Host), config.HTTPTunnel.Port))
		if strings.TrimSpace(config.HTTPTunnel.User) != "" {
			b.WriteString(" HTTP隧道认证=已配置")
		}
	}

	if config.Type == "custom" {
		driver := strings.TrimSpace(config.Driver)
		if driver == "" {
			driver = "(未配置)"
		}
		dsnState := "未配置"
		if strings.TrimSpace(config.DSN) != "" {
			dsnState = fmt.Sprintf("已配置(长度=%d)", len(config.DSN))
		}
		b.WriteString(fmt.Sprintf(" 驱动=%s DSN=%s", driver, dsnState))
	}

	return b.String()
}

func (a *App) getDatabaseForcePing(config connection.ConnectionConfig) (db.Database, error) {
	if a != nil && a.metadataSession != nil {
		instance, err := a.getDatabaseWithContext(a.metadataSession.ctx, config, true)
		a.bindMetadataDatabase(instance)
		return instance, err
	}
	instance, err := a.getDatabaseWithPing(config, true)
	a.bindMetadataDatabase(instance)
	return instance, err
}

// Helper: Get or create a database connection
func (a *App) getDatabase(config connection.ConnectionConfig) (db.Database, error) {
	if a != nil && a.metadataSession != nil {
		instance, err := a.getDatabaseWithContext(a.metadataSession.ctx, config, false)
		a.bindMetadataDatabase(instance)
		return instance, err
	}
	instance, err := a.getDatabaseWithPing(config, false)
	a.bindMetadataDatabase(instance)
	return instance, err
}

func (a *App) bindMetadataDatabase(instance db.Database) {
	if a == nil || a.metadataSession == nil || instance == nil {
		return
	}
	a.metadataSession.bindDatabase(instance)
}

type databaseWaitResult struct {
	instance db.Database
	err      error
}

// getDatabaseWithContext makes waiting for cache lookup, singleflight, and a
// driver's non-context-aware Connect call cancellable. The physical Connect
// may finish in the worker after the caller leaves; the normal flight and
// shutdown checks still decide whether that instance may enter the cache.
func (a *App) getDatabaseWithContext(ctx context.Context, config connection.ConnectionConfig, forcePing bool) (db.Database, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	resultCh := make(chan databaseWaitResult, 1)
	go func() {
		instance, err := a.getDatabaseWithPing(config, forcePing)
		resultCh <- databaseWaitResult{instance: instance, err: err}
	}()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-resultCh:
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return result.instance, result.err
	}
}

func (a *App) openDatabaseIsolated(config connection.ConnectionConfig) (db.Database, error) {
	effectiveConfig, err := a.resolveEffectiveConnectionConfig(config)
	if err != nil {
		return nil, err
	}
	if supported, reason := driverRuntimeSupportStatusFunc(effectiveConfig.Type); !supported {
		if strings.TrimSpace(reason) == "" {
			reason = a.appText("driver_manager.backend.status.optional_disabled", map[string]any{"name": strings.TrimSpace(effectiveConfig.Type)})
		}
		return nil, withLogHint{err: fmt.Errorf("%s", reason), logPath: logger.Path()}
	}
	if revisionErr := verifyDriverAgentRevisionFunc(effectiveConfig); revisionErr != nil {
		return nil, withLogHint{err: revisionErr, logPath: logger.Path()}
	}

	dbInst, err := newDatabaseFunc(effectiveConfig.Type)
	if err != nil {
		return nil, err
	}

	connectConfig, proxyErr := resolveDialConfigWithProxyFunc(effectiveConfig)
	if proxyErr != nil {
		_ = dbInst.Close()
		return nil, wrapConnectError(effectiveConfig, proxyErr)
	}
	if err := dbInst.Connect(connectConfig); err != nil {
		_ = dbInst.Close()
		return nil, wrapConnectError(effectiveConfig, err)
	}
	return dbInst, nil
}

func (a *App) resolveEffectiveConnectionConfig(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		return config, wrapConnectError(config, err)
	}
	runtimeConfig, err := a.resolveCustomClickHouseRuntimeConfig(resolvedConfig)
	if err != nil {
		return config, wrapConnectError(resolvedConfig, err)
	}
	return a.withManagedSSHHostKeyTrustStore(runtimeConfig), nil
}

func (a *App) getDatabaseWithPing(config connection.ConnectionConfig, forcePing bool) (db.Database, error) {
	effectiveConfig, err := a.resolveEffectiveConnectionConfig(config)
	if err != nil {
		return nil, err
	}
	a.mu.RLock()
	shuttingDown := a.dbShuttingDown
	a.mu.RUnlock()
	if shuttingDown {
		return nil, errDatabaseConnectionShutdown
	}
	isFileDB := isFileDatabaseType(effectiveConfig.Type)

	key := getCacheKey(effectiveConfig)
	shortKey := shortenCacheKey(key)
	if isFileDB {
		rawDSN := resolveFileDatabaseDSN(effectiveConfig)
		normalizedDSN := resolveFileDatabaseDSN(normalizeCacheKeyConfig(effectiveConfig))
		logger.Infof("文件库连接缓存探测：类型=%s 原始DSN=%s 归一化DSN=%s timeout=%ds forcePing=%t 缓存Key=%s",
			strings.TrimSpace(effectiveConfig.Type), rawDSN, normalizedDSN, effectiveConfig.Timeout, forcePing, shortKey)
	}

	if supported, reason := driverRuntimeSupportStatusFunc(effectiveConfig.Type); !supported {
		if strings.TrimSpace(reason) == "" {
			reason = a.appText("driver_manager.backend.status.optional_disabled", map[string]any{"name": strings.TrimSpace(effectiveConfig.Type)})
		}
		// Best-effort cleanup: if cached instance exists for this exact config, close it.
		var staleDatabase db.Database
		a.mu.Lock()
		groupKeys := a.cancelDatabaseConnectFlightsLocked(func(flight *databaseConnectFlight) bool {
			return flight.cacheKey == key
		}, errDatabaseConnectionReleased, 0)
		groupKeys = append(groupKeys, key)
		if cur, exists := a.dbCache[key]; exists && cur.inst != nil {
			staleDatabase = cur.inst
			delete(a.dbCache, key)
		}
		a.forgetDatabaseConnectGroupsLocked(groupKeys)
		a.mu.Unlock()
		if staleDatabase != nil {
			_ = staleDatabase.Close()
		}
		return nil, withLogHint{err: fmt.Errorf("%s", reason), logPath: logger.Path()}
	}

	a.mu.RLock()
	entry, ok := a.dbCache[key]
	a.mu.RUnlock()
	if ok {
		keepAlivePolicy := resolveConnectionKeepAlivePolicy(effectiveConfig)
		if !keepAlivePolicy.matches(entry) {
			if current, exists := a.applyCachedDatabaseKeepAlivePolicy(key, entry.inst, keepAlivePolicy, time.Now()); exists {
				entry = current
			}
		}
		if isFileDB {
			logger.Infof("命中文件库连接缓存：类型=%s 缓存Key=%s", strings.TrimSpace(effectiveConfig.Type), shortKey)
		}
		needPing := forcePing
		if !needPing {
			lastPing := entry.lastPing
			if lastPing.IsZero() || time.Since(lastPing) >= dbCachePingInterval {
				needPing = true
			}
		}

		if !needPing {
			if isFileDB {
				logger.Infof("复用文件库连接缓存（免 Ping）：类型=%s 缓存Key=%s", strings.TrimSpace(effectiveConfig.Type), shortKey)
			}
			if returnErr := a.databaseConnectionReturnError(key, entry.inst); returnErr != nil {
				return nil, returnErr
			}
			return entry.inst, nil
		}

		if err := entry.inst.Ping(); err == nil {
			// Update lastPing (best effort)
			a.mu.Lock()
			if cur, exists := a.dbCache[key]; exists && cur.inst == entry.inst {
				cur.lastPing = time.Now()
				a.dbCache[key] = cur
			}
			a.mu.Unlock()
			if isFileDB {
				logger.Infof("复用文件库连接缓存（Ping 成功）：类型=%s 缓存Key=%s", strings.TrimSpace(effectiveConfig.Type), shortKey)
			}
			if returnErr := a.databaseConnectionReturnError(key, entry.inst); returnErr != nil {
				return nil, returnErr
			}
			return entry.inst, nil
		} else {
			logger.Error(err, "缓存连接不可用，准备重建：%s 缓存Key=%s", formatConnSummary(effectiveConfig), shortKey)
		}

		// Ping failed: remove cached instance (best effort)
		var staleDatabase db.Database
		a.mu.Lock()
		if cur, exists := a.dbCache[key]; exists && cur.inst == entry.inst {
			staleDatabase = cur.inst
			delete(a.dbCache, key)
		}
		a.mu.Unlock()
		if staleDatabase != nil {
			if err := staleDatabase.Close(); err != nil {
				logger.Error(err, "关闭失效缓存连接失败：缓存Key=%s", shortKey)
			}
		}
		if isFileDB {
			logger.Infof("文件库缓存连接已剔除，准备新建连接：类型=%s 缓存Key=%s", strings.TrimSpace(effectiveConfig.Type), shortKey)
		}
	}
	if isFileDB {
		logger.Infof("未命中文件库连接缓存，开始创建连接：类型=%s 缓存Key=%s", strings.TrimSpace(effectiveConfig.Type), shortKey)
	}
	if failureErr := a.cachedConnectFailureError(effectiveConfig, key, "db.backend.message.connect_failure_cooldown"); failureErr != nil {
		return nil, failureErr
	}
	value, err, _ := a.dbConnectGroup.Do(key, func() (any, error) {
		flight, beginErr := a.beginDatabaseConnectFlight(key, effectiveConfig)
		if beginErr != nil {
			return nil, beginErr
		}
		defer a.finishDatabaseConnectFlight(flight)
		return a.connectAndCacheDatabase(effectiveConfig, key, isFileDB, flight)
	})
	if err != nil {
		return nil, err
	}
	result, ok := value.(databaseConnectResult)
	if !ok || result.inst == nil || strings.TrimSpace(result.cacheKey) == "" {
		return nil, fmt.Errorf("数据库连接缓存返回了无效实例")
	}
	if _, exists := a.applyCachedDatabaseKeepAlivePolicy(result.cacheKey, result.inst, resolveConnectionKeepAlivePolicy(effectiveConfig), time.Now()); !exists {
		if returnErr := a.databaseConnectionReturnError(result.cacheKey, result.inst); returnErr != nil {
			return nil, returnErr
		}
		return nil, errDatabaseConnectionReleased
	}
	if returnErr := a.databaseConnectionReturnError(result.cacheKey, result.inst); returnErr != nil {
		return nil, returnErr
	}
	return result.inst, nil
}

func (a *App) applyCachedDatabaseKeepAlivePolicy(key string, expectedInst db.Database, policy connectionKeepAlivePolicy, now time.Time) (cachedDatabase, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()

	entry, exists := a.dbCache[key]
	if !exists || entry.inst == nil || entry.inst != expectedInst {
		return cachedDatabase{}, false
	}
	if !policy.matches(entry) {
		entry = policy.apply(entry, now)
		a.dbCache[key] = entry
	}
	return entry, true
}

func (a *App) connectAndCacheDatabase(effectiveConfig connection.ConnectionConfig, initialKey string, isFileDB bool, flight *databaseConnectFlight) (databaseConnectResult, error) {
	key := initialKey
	shortKey := shortenCacheKey(key)

	// A caller can observe a cold cache immediately before another caller
	// finishes its keyed connection flight. Recheck after becoming the leader so
	// a completed flight can never be followed by a duplicate physical connect.
	a.mu.RLock()
	flightErr := a.databaseConnectFlightErrorLocked(flight)
	existing, exists := a.dbCache[key]
	a.mu.RUnlock()
	if flightErr != nil {
		return databaseConnectResult{}, flightErr
	}
	if exists && existing.inst != nil {
		return databaseConnectResult{inst: existing.inst, cacheKey: key}, nil
	}

	if failureErr := a.cachedConnectFailureError(effectiveConfig, key, "db.backend.message.connect_failure_cooldown"); failureErr != nil {
		return databaseConnectResult{}, failureErr
	}
	if revisionErr := verifyDriverAgentRevisionFunc(effectiveConfig); revisionErr != nil {
		return databaseConnectResult{}, withLogHint{err: revisionErr, logPath: logger.Path()}
	}

	dbInst, connectedConfig, err := a.connectEffectiveDatabaseWithStartupRetry(effectiveConfig)
	if flightErr := a.databaseConnectFlightError(flight); flightErr != nil {
		if dbInst != nil {
			_ = dbInst.Close()
		}
		return databaseConnectResult{}, flightErr
	}
	if err != nil {
		retryInst, retryConfig, retryErr := a.retryConnectAfterMySQLMaxUserConnections(effectiveConfig, connectedConfig, err, flight)
		if retryErr != nil {
			failedKey := getCacheKey(retryConfig)
			if flightErr := a.recordConnectFailureForFlight(flight, failedKey, retryErr); flightErr != nil {
				return databaseConnectResult{}, flightErr
			}
			return databaseConnectResult{}, retryErr
		}
		dbInst = retryInst
		connectedConfig = retryConfig
	}
	effectiveConfig = connectedConfig
	key = getCacheKey(effectiveConfig)
	shortKey = shortenCacheKey(key)

	now := time.Now()
	keepAlivePolicy := resolveConnectionKeepAlivePolicy(effectiveConfig)

	a.mu.Lock()
	// A successful driver Connect is not publishable until its flight token is
	// revalidated under the cache lock. Close any invalidated instance outside it.
	flightErr = a.databaseConnectFlightErrorLocked(flight)
	if flightErr == nil {
		flight.cacheKey = key
		flight.releaseMatchKey = getConnectionReleaseMatchKey(effectiveConfig)
	}
	if flightErr != nil {
		a.mu.Unlock()
		_ = dbInst.Close()
		return databaseConnectResult{}, flightErr
	}
	if existing, exists = a.dbCache[key]; exists && existing.inst != nil {
		existing = keepAlivePolicy.apply(existing, now)
		a.dbCache[key] = existing
		if clearErr := a.clearConnectFailuresForFlightLocked(flight, initialKey, key); clearErr != nil {
			a.mu.Unlock()
			_ = dbInst.Close()
			return databaseConnectResult{}, clearErr
		}
		a.mu.Unlock()
		// Prefer existing cached connection to avoid cache racing duplicates.
		_ = dbInst.Close()
		if isFileDB {
			logger.Infof("并发创建命中已存在文件库连接，关闭新建连接并复用缓存：类型=%s 缓存Key=%s", strings.TrimSpace(effectiveConfig.Type), shortKey)
		}
		return databaseConnectResult{inst: existing.inst, cacheKey: key}, nil
	}
	a.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		lastPing:          now,
		lastKeepAliveAt:   now,
		config:            normalizeCacheKeyConfig(effectiveConfig),
		keepAliveEnabled:  keepAlivePolicy.enabled,
		keepAliveInterval: keepAlivePolicy.interval,
		keepAliveSQL:      keepAlivePolicy.sql,
		keepAliveDBType:   keepAlivePolicy.dbType,
		keepAliveRevision: 1,
	}
	if clearErr := a.clearConnectFailuresForFlightLocked(flight, initialKey, key); clearErr != nil {
		delete(a.dbCache, key)
		a.mu.Unlock()
		_ = dbInst.Close()
		return databaseConnectResult{}, clearErr
	}
	a.mu.Unlock()

	logger.Infof("数据库连接成功并写入缓存：%s 缓存Key=%s", formatConnSummary(effectiveConfig), shortKey)
	return databaseConnectResult{inst: dbInst, cacheKey: key}, nil
}

func (a *App) cachedConnectFailureError(effectiveConfig connection.ConnectionConfig, key string, messageKey string) error {
	failure, remaining, ok := a.getCachedConnectFailureByKey(key)
	if !ok {
		return nil
	}
	message := a.appText(messageKey, map[string]any{
		"remaining": formatConnectFailureCooldown(remaining),
		"detail":    normalizeErrorMessage(unwrapLogHintError(failure.err)),
	})
	logger.Warnf("命中数据库连接失败冷却：%s 缓存Key=%s 剩余=%s 原因=%s",
		formatConnSummary(effectiveConfig), shortenCacheKey(key), formatConnectFailureCooldown(remaining), normalizeErrorMessage(failure.err))
	return withLogHint{err: fmt.Errorf("%s", message), logPath: logger.Path()}
}

func (a *App) retryConnectAfterMySQLMaxUserConnections(rawConfig connection.ConnectionConfig, failedConfig connection.ConnectionConfig, err error, flight *databaseConnectFlight) (db.Database, connection.ConnectionConfig, error) {
	if !isMySQLMaxUserConnectionsError(err) {
		return nil, failedConfig, err
	}

	excludedFlightID := uint64(0)
	if flight != nil {
		excludedFlightID = flight.id
	}
	released := a.releaseCachedDatabaseConnectionsForConfigExcludingFlight(failedConfig, excludedFlightID)
	logger.Warnf("检测到 MySQL 用户连接数超限，已释放同实例缓存连接：%s 数量=%d", formatConnSummary(failedConfig), released)
	if released <= 0 {
		return nil, failedConfig, withMySQLMaxUserConnectionsHint(err, released)
	}

	dbInst, connectedConfig, retryErr := a.connectEffectiveDatabaseWithStartupRetry(rawConfig)
	if retryErr != nil {
		if isMySQLMaxUserConnectionsError(retryErr) {
			return nil, connectedConfig, withMySQLMaxUserConnectionsHint(retryErr, released)
		}
		return nil, connectedConfig, retryErr
	}
	logger.Infof("MySQL 用户连接数超限释放缓存后重连成功：%s 释放数量=%d", formatConnSummary(connectedConfig), released)
	return dbInst, connectedConfig, nil
}

func (a *App) getCachedConnectFailureByKey(key string) (cachedConnectFailure, time.Duration, bool) {
	if a == nil || strings.TrimSpace(key) == "" {
		return cachedConnectFailure{}, 0, false
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	entry, exists := a.connectFailures[key]
	if !exists || entry.err == nil || entry.occurredAt.IsZero() {
		return cachedConnectFailure{}, 0, false
	}

	remaining := dbConnectFailureCooldown - time.Since(entry.occurredAt)
	if remaining <= 0 {
		a.clearConnectFailureByKeyLocked(key)
		return cachedConnectFailure{}, 0, false
	}

	return entry, remaining, true
}

func (a *App) recordConnectFailureForFlight(flight *databaseConnectFlight, key string, err error) error {
	if a == nil {
		return errDatabaseConnectionShutdown
	}
	if strings.TrimSpace(key) == "" || err == nil {
		return nil
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if flightErr := a.databaseConnectFlightErrorLocked(flight); flightErr != nil {
		return flightErr
	}
	// Keep the final failure key on the active token so a release that wins
	// immediately after this commit can clear the just-recorded cooldown.
	flight.cacheKey = key
	if a.connectFailures == nil {
		a.connectFailures = make(map[string]cachedConnectFailure)
	}
	a.connectFailures[key] = cachedConnectFailure{
		occurredAt: time.Now(),
		err:        err,
	}
	return nil
}

func (a *App) clearConnectFailureByKeyLocked(key string) {
	if strings.TrimSpace(key) == "" || a.connectFailures == nil {
		return
	}
	delete(a.connectFailures, key)
}

func (a *App) clearConnectFailuresForFlightLocked(flight *databaseConnectFlight, keys ...string) error {
	if flightErr := a.databaseConnectFlightErrorLocked(flight); flightErr != nil {
		return flightErr
	}
	for _, key := range keys {
		a.clearConnectFailureByKeyLocked(key)
	}
	return nil
}

func formatConnectFailureCooldown(remaining time.Duration) time.Duration {
	if remaining <= time.Second {
		return time.Second
	}
	return remaining.Truncate(time.Second)
}

func verifyRuntimeOptionalDriverAgentRevision(config connection.ConnectionConfig) error {
	driverType := normalizeDriverType(config.Type)
	if !db.IsOptionalGoDriver(driverType) {
		return nil
	}
	executablePath, err := db.ResolveOptionalDriverAgentExecutablePath("", driverType)
	if err != nil {
		return err
	}
	pkg, packageMetaExists := readInstalledDriverPackage("", driverType)
	selectedVersion := ""
	if packageMetaExists {
		selectedVersion = strings.TrimSpace(pkg.Version)
	}
	if !shouldVerifyOptionalDriverAgentRevision(driverType, selectedVersion) {
		return nil
	}
	expectedRevision := strings.TrimSpace(db.OptionalDriverAgentRevision(driverType))
	if expectedRevision == "" {
		return nil
	}
	displayName := resolveDriverDisplayName(driverDefinition{Type: driverType})
	agentRevision, err := verifyInstalledOptionalDriverAgentRevision(driverType, executablePath, selectedVersion)
	if err != nil {
		logger.Warnf("%s driver-agent revision 校验失败，已阻止使用不匹配代理：当前需要=%s version=%s path=%s err=%v",
			displayName, expectedRevision, selectedVersion, executablePath, err)
		return err
	}
	logger.Infof("%s driver-agent revision 校验通过：已安装=%s 当前需要=%s version=%s path=%s",
		displayName, strings.TrimSpace(agentRevision), expectedRevision, selectedVersion, executablePath)
	return nil
}

func shortenCacheKey(key string) string {
	if len(key) > 12 {
		return key[:12]
	}
	return key
}

func (a *App) connectDatabaseWithStartupRetry(rawConfig connection.ConnectionConfig) (db.Database, connection.ConnectionConfig, error) {
	effectiveConfig, err := a.resolveEffectiveConnectionConfig(rawConfig)
	if err != nil {
		return nil, rawConfig, err
	}
	return a.connectEffectiveDatabaseWithStartupRetry(effectiveConfig)
}

func (a *App) connectEffectiveDatabaseWithStartupRetry(rawConfig connection.ConnectionConfig) (db.Database, connection.ConnectionConfig, error) {
	var lastErr error
	var lastEffectiveConfig connection.ConnectionConfig

	for attempt := 1; attempt <= startupConnectRetryAttempts; attempt++ {
		effectiveConfig := rawConfig
		lastEffectiveConfig = effectiveConfig
		cacheKey := shortenCacheKey(getCacheKey(effectiveConfig))

		logger.Infof("获取数据库连接：%s 缓存Key=%s 启动阶段=%s", formatConnSummary(effectiveConfig), cacheKey, a.startupPhaseLabel())
		logger.Infof("创建数据库驱动实例：类型=%s 缓存Key=%s 尝试=%d/%d", effectiveConfig.Type, cacheKey, attempt, startupConnectRetryAttempts)

		dbInst, err := newDatabaseFunc(effectiveConfig.Type)
		if err != nil {
			logger.Error(err, "创建数据库驱动实例失败：类型=%s 缓存Key=%s", effectiveConfig.Type, cacheKey)
			return nil, effectiveConfig, err
		}

		connectConfig, proxyErr := resolveDialConfigWithProxyFunc(effectiveConfig)
		if proxyErr != nil {
			_ = dbInst.Close()
			wrapped := wrapConnectError(effectiveConfig, proxyErr)
			logger.Error(wrapped, "连接代理准备失败：%s 缓存Key=%s", formatConnSummary(effectiveConfig), cacheKey)
			return nil, effectiveConfig, wrapped
		}

		if err := dbInst.Connect(connectConfig); err == nil {
			if attempt > 1 {
				logger.Warnf("数据库连接在重试后成功：%s 缓存Key=%s 尝试=%d/%d", formatConnSummary(effectiveConfig), cacheKey, attempt, startupConnectRetryAttempts)
			}
			return dbInst, effectiveConfig, nil
		} else {
			_ = dbInst.Close()
			wrapped := wrapConnectError(effectiveConfig, err)
			lastErr = wrapped
			logger.Error(wrapped, "建立数据库连接失败：%s 缓存Key=%s", formatConnSummary(effectiveConfig), cacheKey)
			if !a.shouldRetryConnect(err, attempt) {
				return nil, effectiveConfig, wrapped
			}
			logger.Warnf("检测到瞬时网络失败，准备重试连接：%s 缓存Key=%s 尝试=%d/%d 延迟=%s 原因=%s",
				formatConnSummary(effectiveConfig), cacheKey, attempt, startupConnectRetryAttempts, startupConnectRetryDelay, normalizeErrorMessage(err))
			time.Sleep(startupConnectRetryDelay)
		}
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("建立数据库连接失败")
	}
	return nil, lastEffectiveConfig, lastErr
}

func (a *App) startupPhaseLabel() string {
	if a == nil || a.startedAt.IsZero() {
		return "未知"
	}
	age := time.Since(a.startedAt).Round(time.Millisecond)
	if age < 0 {
		age = 0
	}
	if age <= startupConnectRetryWindow {
		return fmt.Sprintf("启动期(age=%s)", age)
	}
	return fmt.Sprintf("稳定期(age=%s)", age)
}

func (a *App) shouldRetryConnect(err error, attempt int) bool {
	if attempt >= startupConnectRetryAttempts {
		return false
	}
	if !isTransientStartupConnectError(err) {
		return false
	}
	if a != nil && !a.startedAt.IsZero() {
		age := time.Since(a.startedAt)
		if age >= 0 && age <= startupConnectRetryWindow {
			return true
		}
	}
	return false
}

func isTransientStartupConnectError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(normalizeErrorMessage(err))
	transientHints := []string{
		"no route to host",
		"network is unreachable",
		"connection refused",
		"connection timed out",
		"i/o timeout",
		"context deadline exceeded",
	}
	for _, hint := range transientHints {
		if strings.Contains(message, hint) {
			return true
		}
	}
	return false
}

// generateQueryID generates a unique ID for a query using UUID v4
func generateQueryID() string {
	return "query-" + uuid.New().String()
}

func (a *App) registerRunningQuery(queryID string, cancel context.CancelFunc, retainUntilDone bool) func() {
	cleanup, _ := a.registerRunningQueryWithCancellationCapability(queryID, cancel, retainUntilDone)
	return cleanup
}

func (a *App) registerRunningQueryWithCancellationCapability(queryID string, cancel context.CancelFunc, retainUntilDone bool) (func(), func(bool)) {
	a.queryMu.Lock()
	if a.runningQueries == nil {
		a.runningQueries = make(map[string]queryContext)
	}
	a.nextQueryRegistrationID++
	if a.nextQueryRegistrationID == 0 {
		a.nextQueryRegistrationID++
	}
	registrationID := a.nextQueryRegistrationID
	a.runningQueries[queryID] = queryContext{
		cancel:          cancel,
		started:         time.Now(),
		retainUntilDone: retainUntilDone,
		registrationID:  registrationID,
	}
	a.queryMu.Unlock()

	cleanup := func() {
		a.queryMu.Lock()
		if current, exists := a.runningQueries[queryID]; exists && current.registrationID == registrationID {
			delete(a.runningQueries, queryID)
		}
		a.queryMu.Unlock()
	}
	setCancellable := func(cancellable bool) {
		a.queryMu.Lock()
		if current, exists := a.runningQueries[queryID]; exists && current.registrationID == registrationID {
			current.cancellationUnsupported = !cancellable
			a.runningQueries[queryID] = current
		}
		a.queryMu.Unlock()
	}
	return cleanup, setCancellable
}

// registerExclusiveRunningQuery registers a long-running task only when the
// caller-provided ID is not already owned by another task. Import jobs use this
// stricter contract because replacing an owner would make cancellation target
// the wrong operation and let an older cleanup remove the newer task.
func (a *App) registerExclusiveRunningQuery(queryID string, cancel context.CancelFunc, retainUntilDone bool) (func(), bool) {
	a.queryMu.Lock()
	if a.runningQueries == nil {
		a.runningQueries = make(map[string]queryContext)
	}
	if _, exists := a.runningQueries[queryID]; exists {
		a.queryMu.Unlock()
		return func() {}, false
	}
	a.nextQueryRegistrationID++
	if a.nextQueryRegistrationID == 0 {
		a.nextQueryRegistrationID++
	}
	registrationID := a.nextQueryRegistrationID
	a.runningQueries[queryID] = queryContext{
		cancel:          cancel,
		started:         time.Now(),
		retainUntilDone: retainUntilDone,
		registrationID:  registrationID,
	}
	a.queryMu.Unlock()

	return func() {
		a.queryMu.Lock()
		if current, exists := a.runningQueries[queryID]; exists && current.registrationID == registrationID {
			delete(a.runningQueries, queryID)
		}
		a.queryMu.Unlock()
	}, true
}

// CancelQuery cancels a running query by its ID
func (a *App) CancelQuery(queryID string) connection.QueryResult {
	a.queryMu.Lock()
	defer a.queryMu.Unlock()

	if ctx, exists := a.runningQueries[queryID]; exists {
		if ctx.cancellationUnsupported {
			logger.Warnf("取消查询失败：queryID=%s 的底层驱动不支持取消", queryID)
			return connection.QueryResult{
				Success:           false,
				Message:           a.appText("query_editor.message.cancel_unsupported", nil),
				CancellationState: connection.QueryCancellationStateUnsupported,
			}
		}
		ctx.cancel()
		a.requestDiagnostics().MarkCancellation(queryID, true)
		if !ctx.retainUntilDone {
			delete(a.runningQueries, queryID)
		}
		logger.Infof("查询已取消：queryID=%s", queryID)
		return connection.QueryResult{Success: true, Message: a.appText("query_editor.message.cancel_success", nil)}
	}
	a.requestDiagnostics().MarkCancellation(queryID, false)
	logger.Warnf("取消查询失败：queryID=%s 不存在或已完成", queryID)
	return connection.QueryResult{Success: false, Message: a.appText("query_editor.message.cancel_no_running", nil)}
}

// cleanupStaleQueries removes queries older than maxAge.
func (a *App) cleanupStaleQueries(maxAge time.Duration) {
	a.queryMu.Lock()
	defer a.queryMu.Unlock()

	now := time.Now()
	for id, ctx := range a.runningQueries {
		if now.Sub(ctx.started) > maxAge {
			// Query likely finished or stuck, remove from tracking
			delete(a.runningQueries, id)
			// Query expired, silently remove
		}
	}
}

// GenerateQueryID generates a unique query ID for cancellation tracking
func (a *App) GenerateQueryID() string {
	return generateQueryID()
}
