package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"github.com/google/uuid"
)

const dbCachePingInterval = 30 * time.Second

type cachedDatabase struct {
	inst     db.Database
	lastPing time.Time
}

type queryContext struct {
	cancel  context.CancelFunc
	started time.Time
}

// App struct
type App struct {
	ctx            context.Context
	dbCache        map[string]cachedDatabase // Cache for DB connections
	mu             sync.RWMutex              // Mutex for cache access
	updateMu       sync.Mutex
	updateState    updateState
	queryMu        sync.RWMutex
	runningQueries map[string]queryContext // queryID -> cancelFunc and start time
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		dbCache:        make(map[string]cachedDatabase),
		runningQueries: make(map[string]queryContext),
	}
}

// Startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	logger.Init()
	applyMacWindowTranslucencyFix()
	logger.Infof("应用启动完成")
}

// SetWindowTranslucency 动态调整 macOS 窗口透明度。
// 前端在加载用户外观设置后、以及用户修改外观时调用此方法。
// opacity=1.0 且 blur=0 时窗口标记为 opaque，GPU 不再持续计算窗口背后的模糊合成。
func (a *App) SetWindowTranslucency(opacity float64, blur float64) {
	setMacWindowTranslucency(opacity, blur)
}

// Shutdown is called when the app terminates
func (a *App) Shutdown(ctx context.Context) {
	logger.Infof("应用开始关闭，准备释放资源")
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, dbInst := range a.dbCache {
		if err := dbInst.inst.Close(); err != nil {
			logger.Error(err, "关闭数据库连接失败")
		}
	}
	proxytunnel.CloseAllForwarders()
	// Close all Redis connections
	CloseAllRedisClients()
	logger.Infof("资源释放完成，应用已关闭")
	logger.Close()
}

func normalizeCacheKeyConfig(config connection.ConnectionConfig) connection.ConnectionConfig {
	normalized := config
	normalized.Type = strings.ToLower(strings.TrimSpace(normalized.Type))
	// timeout 仅用于 Query/Ping 控制，不应作为物理连接复用键的一部分。
	normalized.Timeout = 0
	normalized.SavePassword = false

	if !normalized.UseSSH {
		normalized.SSH = connection.SSHConfig{}
	}
	if !normalized.UseProxy {
		normalized.Proxy = connection.ProxyConfig{}
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
		normalized.Hosts = nil
		normalized.Topology = ""
		normalized.MySQLReplicaUser = ""
		normalized.MySQLReplicaPassword = ""
		normalized.ReplicaSet = ""
		normalized.AuthSource = ""
		normalized.ReadPreference = ""
		normalized.MongoSRV = false
		normalized.MongoAuthMechanism = ""
		normalized.MongoReplicaUser = ""
		normalized.MongoReplicaPassword = ""
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
	effectiveConfig := applyGlobalProxyToConnection(config)
	key := getCacheKey(effectiveConfig)
	shortKey := shortCacheKey(key)

	a.mu.Lock()
	defer a.mu.Unlock()

	entry, exists := a.dbCache[key]
	if !exists || entry.inst == nil {
		return false
	}

	if closeErr := entry.inst.Close(); closeErr != nil {
		logger.Error(closeErr, "关闭失效缓存连接失败：缓存Key=%s", shortKey)
	}
	delete(a.dbCache, key)
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

	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		dbName := config.Database
		if dbName == "" {
			dbName = "(default)"
		}
		err = fmt.Errorf("数据库连接超时：%s %s:%d/%s：%w", config.Type, config.Host, config.Port, dbName, err)
	}

	return withLogHint{err: err, logPath: logger.Path()}
}

type withLogHint struct {
	err     error
	logPath string
}

func (e withLogHint) Error() string {
	message := normalizeErrorMessage(e.err)
	if strings.TrimSpace(e.logPath) == "" {
		return message
	}
	return fmt.Sprintf("%s（详细日志：%s）", message, e.logPath)
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

	if config.UseSSH {
		b.WriteString(fmt.Sprintf(" SSH=%s:%d 用户=%s", config.SSH.Host, config.SSH.Port, config.SSH.User))
	}
	if config.UseProxy {
		b.WriteString(fmt.Sprintf(" 代理=%s://%s:%d", strings.ToLower(strings.TrimSpace(config.Proxy.Type)), config.Proxy.Host, config.Proxy.Port))
		if strings.TrimSpace(config.Proxy.User) != "" {
			b.WriteString(" 代理认证=已配置")
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
	return a.getDatabaseWithPing(config, true)
}

// Helper: Get or create a database connection
func (a *App) getDatabase(config connection.ConnectionConfig) (db.Database, error) {
	return a.getDatabaseWithPing(config, false)
}

func (a *App) openDatabaseIsolated(config connection.ConnectionConfig) (db.Database, error) {
	effectiveConfig := applyGlobalProxyToConnection(config)
	if supported, reason := db.DriverRuntimeSupportStatus(effectiveConfig.Type); !supported {
		if strings.TrimSpace(reason) == "" {
			reason = fmt.Sprintf("%s 驱动未启用，请先在驱动管理中安装启用", strings.TrimSpace(effectiveConfig.Type))
		}
		return nil, withLogHint{err: fmt.Errorf("%s", reason), logPath: logger.Path()}
	}

	dbInst, err := db.NewDatabase(effectiveConfig.Type)
	if err != nil {
		return nil, err
	}

	connectConfig, proxyErr := resolveDialConfigWithProxy(effectiveConfig)
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

func (a *App) getDatabaseWithPing(config connection.ConnectionConfig, forcePing bool) (db.Database, error) {
	effectiveConfig := applyGlobalProxyToConnection(config)
	isFileDB := isFileDatabaseType(effectiveConfig.Type)

	key := getCacheKey(effectiveConfig)
	shortKey := key
	if len(shortKey) > 12 {
		shortKey = shortKey[:12]
	}
	if isFileDB {
		rawDSN := resolveFileDatabaseDSN(effectiveConfig)
		normalizedDSN := resolveFileDatabaseDSN(normalizeCacheKeyConfig(effectiveConfig))
		logger.Infof("文件库连接缓存探测：类型=%s 原始DSN=%s 归一化DSN=%s timeout=%ds forcePing=%t 缓存Key=%s",
			strings.TrimSpace(effectiveConfig.Type), rawDSN, normalizedDSN, effectiveConfig.Timeout, forcePing, shortKey)
	}

	if supported, reason := db.DriverRuntimeSupportStatus(effectiveConfig.Type); !supported {
		if strings.TrimSpace(reason) == "" {
			reason = fmt.Sprintf("%s 驱动未启用，请先在驱动管理中安装启用", strings.TrimSpace(effectiveConfig.Type))
		}
		// Best-effort cleanup: if cached instance exists for this exact config, close it.
		a.mu.Lock()
		if cur, exists := a.dbCache[key]; exists && cur.inst != nil {
			_ = cur.inst.Close()
			delete(a.dbCache, key)
		}
		a.mu.Unlock()
		return nil, withLogHint{err: fmt.Errorf("%s", reason), logPath: logger.Path()}
	}

	a.mu.RLock()
	entry, ok := a.dbCache[key]
	a.mu.RUnlock()
	if ok {
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
			return entry.inst, nil
		} else {
			logger.Error(err, "缓存连接不可用，准备重建：%s 缓存Key=%s", formatConnSummary(effectiveConfig), shortKey)
		}

		// Ping failed: remove cached instance (best effort)
		a.mu.Lock()
		if cur, exists := a.dbCache[key]; exists && cur.inst == entry.inst {
			if err := cur.inst.Close(); err != nil {
				logger.Error(err, "关闭失效缓存连接失败：缓存Key=%s", shortKey)
			}
			delete(a.dbCache, key)
		}
		a.mu.Unlock()
		if isFileDB {
			logger.Infof("文件库缓存连接已剔除，准备新建连接：类型=%s 缓存Key=%s", strings.TrimSpace(effectiveConfig.Type), shortKey)
		}
	}
	if isFileDB {
		logger.Infof("未命中文件库连接缓存，开始创建连接：类型=%s 缓存Key=%s", strings.TrimSpace(effectiveConfig.Type), shortKey)
	}

	logger.Infof("获取数据库连接：%s 缓存Key=%s", formatConnSummary(effectiveConfig), shortKey)
	logger.Infof("创建数据库驱动实例：类型=%s 缓存Key=%s", effectiveConfig.Type, shortKey)
	dbInst, err := db.NewDatabase(effectiveConfig.Type)
	if err != nil {
		logger.Error(err, "创建数据库驱动实例失败：类型=%s 缓存Key=%s", effectiveConfig.Type, shortKey)
		return nil, err
	}

	connectConfig, proxyErr := resolveDialConfigWithProxy(effectiveConfig)
	if proxyErr != nil {
		wrapped := wrapConnectError(effectiveConfig, proxyErr)
		logger.Error(wrapped, "连接代理准备失败：%s 缓存Key=%s", formatConnSummary(effectiveConfig), shortKey)
		return nil, wrapped
	}

	if err := dbInst.Connect(connectConfig); err != nil {
		wrapped := wrapConnectError(effectiveConfig, err)
		logger.Error(wrapped, "建立数据库连接失败：%s 缓存Key=%s", formatConnSummary(effectiveConfig), shortKey)
		return nil, wrapped
	}

	now := time.Now()

	a.mu.Lock()
	if existing, exists := a.dbCache[key]; exists && existing.inst != nil {
		a.mu.Unlock()
		// Prefer existing cached connection to avoid cache racing duplicates.
		_ = dbInst.Close()
		if isFileDB {
			logger.Infof("并发创建命中已存在文件库连接，关闭新建连接并复用缓存：类型=%s 缓存Key=%s", strings.TrimSpace(effectiveConfig.Type), shortKey)
		}
		return existing.inst, nil
	}
	a.dbCache[key] = cachedDatabase{inst: dbInst, lastPing: now}
	a.mu.Unlock()

	logger.Infof("数据库连接成功并写入缓存：%s 缓存Key=%s", formatConnSummary(effectiveConfig), shortKey)
	return dbInst, nil
}

// generateQueryID generates a unique ID for a query using UUID v4
func generateQueryID() string {
	return "query-" + uuid.New().String()
}

// CancelQuery cancels a running query by its ID
func (a *App) CancelQuery(queryID string) connection.QueryResult {
	a.queryMu.Lock()
	defer a.queryMu.Unlock()

	if ctx, exists := a.runningQueries[queryID]; exists {
		ctx.cancel()
		delete(a.runningQueries, queryID)
		logger.Infof("查询已取消：queryID=%s", queryID)
		return connection.QueryResult{Success: true, Message: "查询已取消"}
	}
	logger.Warnf("取消查询失败：queryID=%s 不存在或已完成", queryID)
	return connection.QueryResult{Success: false, Message: "查询不存在或已完成"}
}

// CleanupStaleQueries removes queries older than maxAge
func (a *App) CleanupStaleQueries(maxAge time.Duration) {
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
