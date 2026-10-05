package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func (a *App) getDatabaseForcePing(config connection.ConnectionConfig) (db.Database, error) {
	if a != nil && a.metadataSession != nil {
		var instance db.Database
		var err error
		if a.metadataSession.synchronous {
			instance, err = a.getDatabaseSynchronouslyWithContext(a.metadataSession.ctx, config, true)
		} else {
			instance, err = a.getDatabaseWithContext(a.metadataSession.ctx, config, true)
		}
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
		var instance db.Database
		var err error
		if a.metadataSession.synchronous {
			instance, err = a.getDatabaseSynchronouslyWithContext(a.metadataSession.ctx, config, false)
		} else {
			instance, err = a.getDatabaseWithContext(a.metadataSession.ctx, config, false)
		}
		a.bindMetadataDatabase(instance)
		return instance, err
	}
	instance, err := a.getDatabaseWithPing(config, false)
	a.bindMetadataDatabase(instance)
	return instance, err
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

// getDatabaseSynchronouslyWithContext keeps non-context-aware Connect work in
// the current request goroutine. It cannot interrupt Connect, but it guarantees
// that a canceled Web RPC does not return while a detached connection worker is
// still running. The context is checked again before any SQL is dispatched.
func (a *App) getDatabaseSynchronouslyWithContext(ctx context.Context, config connection.ConnectionConfig, forcePing bool) (db.Database, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	instance, err := a.getDatabaseWithPing(config, forcePing)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return instance, nil
}

func (a *App) openDatabaseIsolated(config connection.ConnectionConfig) (db.Database, error) {
	effectiveConfig, err := a.resolveEffectiveConnectionConfig(config)
	if err != nil {
		return nil, err
	}
	runtimeDriverType := optionalDriverTypeForConnectionConfig(effectiveConfig)
	a.mu.RLock()
	shuttingDown := a.dbShuttingDown
	driverMaintenance := runtimeDriverType != "" && a.driverMaintenance[runtimeDriverType] > 0
	a.mu.RUnlock()
	if shuttingDown {
		return nil, errDatabaseConnectionShutdown
	}
	if driverMaintenance {
		return nil, fmt.Errorf("%s", a.appText("driver_manager.backend.error.driver_maintenance_active", map[string]any{
			"name": a.driverStatusDisplayName(driverDefinition{Type: runtimeDriverType}),
		}))
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
	runtimeDriverType := optionalDriverTypeForConnectionConfig(effectiveConfig)
	a.mu.RLock()
	shuttingDown := a.dbShuttingDown
	driverMaintenance := runtimeDriverType != "" && a.driverMaintenance[runtimeDriverType] > 0
	a.mu.RUnlock()
	if shuttingDown {
		return nil, errDatabaseConnectionShutdown
	}
	if driverMaintenance {
		return nil, fmt.Errorf("%s", a.appText("driver_manager.backend.error.driver_maintenance_active", map[string]any{
			"name": a.driverStatusDisplayName(driverDefinition{Type: runtimeDriverType}),
		}))
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
