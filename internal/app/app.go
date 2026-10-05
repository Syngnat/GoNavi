package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

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
	driverType      string
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
	driverType              string
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
	// 按驱动类型索引的活动任务：同一类型只能有一个在跑，不同类型可并行。
	// 此前是单个全局 taskID，等价于「全局只允许一个安装任务」，是驱动并行安装的闸门。
	driverDownloadActiveTaskIDByType map[string]string
	driverDownloadTaskRunner         driverDownloadTaskRunner
	driverDownloadTaskControls       map[string]driverDownloadTaskControl
	exportTaskMu                     sync.Mutex
	exportTasks                      map[string]*exportTaskRegistration
	// 驱动安装锁：按驱动类型分片，替代此前的全局单锁（见 driver_install_lock.go）。
	driverInstallLock             driverInstallLockManager
	driverMaintenance             map[string]int
	dataRootApplyMu               sync.Mutex
	configDir                     string
	downloadSourceMu              sync.RWMutex
	downloadSource                DownloadSource
	downloadSourceLoaded          bool
	sqliteTableStatsMu            sync.Mutex
	secretStore                   secretstore.SecretStore
	runningQueries                map[string]queryContext // queryID -> cancelFunc and start time
	connectionHealthRunsMu        sync.Mutex
	connectionHealthRuns          map[string]*connectionHealthRun
	connectionHealthRunsClosing   bool
	connectionHealthRunInspect    func(context.Context, string) connection.ConnectionHealthReport // 测试钩子：用于确定性控制批量任务执行时序。
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
	cloudBackupLifecycleMu        sync.Mutex
	cloudBackupLifecycleCtx       context.Context
	cloudBackupLifecycleCancel    context.CancelFunc
	cloudBackupBackgroundWG       sync.WaitGroup
	cloudBackupShuttingDown       bool
	cloudBackupImmediateSignal    chan struct{}
	cloudBackupImmediateStarted   bool
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
	dataSyncJobsState
	dataSyncJobLeaseOwner     string
	dataSyncCDCRegistry       *synccdc.Registry
	dataSyncChangeEventRunner func(context.Context, syncbackend.ChangeEventRequest) syncbackend.ChangeEventResult
}

// NewApp creates a new App application struct
func NewApp() *App {
	return NewAppWithSecretStore(secretstore.NewKeyringStore())
}

// ConfigDirForIntegration returns the directory used for persisted application
// settings. It is a package function rather than an App method so Wails does
// not expose the local filesystem path through its reflective RPC bridge.
func ConfigDirForIntegration(a *App) string {
	if a == nil {
		return ""
	}
	return strings.TrimSpace(a.configDir)
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
		connectionHealthRuns:          make(map[string]*connectionHealthRun),
		importTasks:                   make(map[string]importTaskRegistration),
		driverDownloadTasks:           make(map[string]DriverDownloadTaskStatus),
		driverDownloadTaskControls:    make(map[string]driverDownloadTaskControl),
		driverMaintenance:             make(map[string]int),
		sqlTransactions:               make(map[string]*managedSQLTransaction),
		requestTraceStore:             requesttrace.NewStore(requesttrace.DefaultCapacity),
		configDir:                     resolveAppConfigDir(),
		downloadSource:                DownloadSourceCst,
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
