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

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

// App struct
type App struct {
	ctx     context.Context
	dbCache map[string]db.Database // Cache for DB connections
	mu      sync.Mutex             // Mutex for cache access
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		dbCache: make(map[string]db.Database),
	}
}

// Startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	logger.Init()
	logger.Infof("应用启动完成")
}

// Shutdown is called when the app terminates
func (a *App) Shutdown(ctx context.Context) {
	logger.Infof("应用开始关闭，准备释放资源")
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, dbInst := range a.dbCache {
		if err := dbInst.Close(); err != nil {
			logger.Error(err, "关闭数据库连接失败")
		}
	}
	logger.Infof("资源释放完成，应用已关闭")
	logger.Close()
}

// Helper: Generate a unique key for the connection config
func getCacheKey(config connection.ConnectionConfig) string {
	if !config.UseSSH {
		config.SSH = connection.SSHConfig{}
	}
	// 保持与驱动默认一致，避免同一连接被重复缓存
	if config.Type == "postgres" && config.Database == "" {
		config.Database = "postgres"
	}

	b, _ := json.Marshal(config)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
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
	if strings.TrimSpace(e.logPath) == "" {
		return e.err.Error()
	}
	return fmt.Sprintf("%s（详细日志：%s）", e.err.Error(), e.logPath)
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
	b.WriteString(fmt.Sprintf("类型=%s 地址=%s:%d 数据库=%s 用户=%s 超时=%ds",
		config.Type, config.Host, config.Port, dbName, config.User, timeoutSeconds))

	if config.UseSSH {
		b.WriteString(fmt.Sprintf(" SSH=%s:%d 用户=%s", config.SSH.Host, config.SSH.Port, config.SSH.User))
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

// Helper: Get or create a database connection
func (a *App) getDatabase(config connection.ConnectionConfig) (db.Database, error) {
	key := getCacheKey(config)
	shortKey := key
	if len(shortKey) > 12 {
		shortKey = shortKey[:12]
	}
	logger.Infof("获取数据库连接：%s 缓存Key=%s", formatConnSummary(config), shortKey)

	a.mu.Lock()
	defer a.mu.Unlock()

	if dbInst, ok := a.dbCache[key]; ok {
		logger.Infof("命中连接缓存，开始检测可用性：缓存Key=%s", shortKey)
		if err := dbInst.Ping(); err == nil {
			logger.Infof("缓存连接可用：缓存Key=%s", shortKey)
			return dbInst, nil
		} else {
			logger.Error(err, "缓存连接不可用，准备重建：缓存Key=%s", shortKey)
		}
		if err := dbInst.Close(); err != nil {
			logger.Error(err, "关闭失效缓存连接失败：缓存Key=%s", shortKey)
		}
		delete(a.dbCache, key)
	}

	logger.Infof("创建数据库驱动实例：类型=%s 缓存Key=%s", config.Type, shortKey)
	dbInst, err := db.NewDatabase(config.Type)
	if err != nil {
		logger.Error(err, "创建数据库驱动实例失败：类型=%s 缓存Key=%s", config.Type, shortKey)
		return nil, err
	}

	if err := dbInst.Connect(config); err != nil {
		wrapped := wrapConnectError(config, err)
		logger.Error(wrapped, "建立数据库连接失败：%s 缓存Key=%s", formatConnSummary(config), shortKey)
		return nil, wrapped
	}

	a.dbCache[key] = dbInst
	logger.Infof("数据库连接成功并写入缓存：%s 缓存Key=%s", formatConnSummary(config), shortKey)
	return dbInst, nil
}
