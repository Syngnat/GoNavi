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

// metadataLaneCacheKeySuffix 是「元数据通道」连接缓存 key 的后缀。
//
// 元数据流量（表清单/列/索引/DDL、补全预热、locator 后台预取）与查询通道同配置但各自
// 持有一个物理连接：OceanBase/Oracle 上 all_tab_columns 这类秒级元数据查询若与用户查询
// 共用同一个 4 槽连接池，会占满槽位让主查询排队（实测随会话推进主查询 B 段涨到 1.6s+）。
// 拆成独立通道后两类流量互不阻塞，后台慢查询与逐表补全也拖不慢用户查询。
const metadataLaneCacheKeySuffix = "|lane:metadata"

// getDatabaseLane 是取连接的唯一入口，cacheKeySuffix 决定走哪条通道：
// "" 是查询通道，metadataLaneCacheKeySuffix 是元数据通道。
//
// 后缀参与 dbCache key、singleflight key 与连接失败冷却 key（见 app_db_connect.go），
// 所以两条通道各有独立缓存条目、独立合并组与独立冷却，物理上互不影响。
func (a *App) getDatabaseLane(config connection.ConnectionConfig, forcePing bool, cacheKeySuffix string) (db.Database, error) {
	if a != nil && a.metadataSession != nil {
		var instance db.Database
		var err error
		if a.metadataSession.synchronous {
			instance, err = a.getDatabaseSynchronouslyWithContextLane(a.metadataSession.ctx, config, forcePing, cacheKeySuffix)
		} else {
			instance, err = a.getDatabaseWithContextLane(a.metadataSession.ctx, config, forcePing, cacheKeySuffix)
		}
		a.bindMetadataDatabase(instance)
		return instance, err
	}
	instance, err := a.getDatabaseWithPingLane(config, forcePing, cacheKeySuffix)
	a.bindMetadataDatabase(instance)
	return instance, err
}

func (a *App) getDatabaseForcePing(config connection.ConnectionConfig) (db.Database, error) {
	return a.getDatabaseLane(config, true, "")
}

// Helper: Get or create a database connection
func (a *App) getDatabase(config connection.ConnectionConfig) (db.Database, error) {
	return a.getDatabaseLane(config, false, "")
}

// metadataLaneSuffixForConfig 决定一个配置是否该走元数据通道。
//
// 文件库（sqlite / duckdb，含 custom 连接指向它们）必须留在查询通道，理由有三条，
// 都是正确性问题而不是优化取舍：
//  1. `:memory:` 是受支持的连接目标（DSN 为空也会归一化成它）。第二次物理建连得到的是
//     另一个空库，元数据查询会静默返回空结构 —— 侧栏树直接消失。
//  2. SQLite/DuckDB 的连接级状态（ATTACH、临时表、未提交 DDL）不跨连接可见，独立通道
//     会让刚建的表在元数据里"不存在"。
//  3. 文件库没有共享连接池可抢，拆通道零收益。
func metadataLaneSuffixForConfig(config connection.ConnectionConfig) string {
	driverType := normalizeDriverType(config.Type)
	if driverType == "custom" {
		driverType = normalizeDriverType(config.Driver)
	}
	if isFileDatabaseType(driverType) {
		return ""
	}
	return metadataLaneCacheKeySuffix
}

// getMetadataDatabase 获取元数据通道的连接（不命中缓存即新建，走同一套缓存生命周期）。
// 元数据类调用点（DBGetTables / DBGetIndexes / DBGetColumns / DBGetAllColumns）必须用它，
// 不要用 getDatabase —— 否则元数据查询又回到用户查询的连接池里抢槽位。
func (a *App) getMetadataDatabase(config connection.ConnectionConfig) (db.Database, error) {
	return a.getDatabaseLane(config, false, metadataLaneSuffixForConfig(config))
}

func (a *App) getMetadataDatabaseForcePing(config connection.ConnectionConfig) (db.Database, error) {
	return a.getDatabaseLane(config, true, metadataLaneSuffixForConfig(config))
}

// invalidateMetadataDatabase 失效元数据通道的缓存连接，不影响查询通道。
// 元数据查询报「连接已断开」时只能清这一条通道：连带清掉查询通道会误杀用户正在用的连接。
func (a *App) invalidateMetadataDatabase(config connection.ConnectionConfig, reason error) bool {
	return a.invalidateCachedDatabaseLane(config, reason, metadataLaneSuffixForConfig(config))
}

// invalidateCachedDatabaseLane 是 invalidateCachedDatabase 的带后缀版本。
//
// //DEBT: 与 app_db_connect_errors.go 的 invalidateCachedDatabase 是同一段逻辑的两份实现，
// 差别只有 key 后缀。之所以没有合并成「加一个后缀参数」的单一函数，是因为本次改动白名单
// 不含 app_db_connect_errors.go；白名单放开后应把两者合并为
// invalidateCachedDatabaseLane(config, reason, "")，删除重复实现。
func (a *App) invalidateCachedDatabaseLane(config connection.ConnectionConfig, reason error, cacheKeySuffix string) bool {
	if effectiveConfig, err := a.resolveEffectiveConnectionConfig(config); err == nil {
		config = effectiveConfig
	}
	effectiveConfig := config
	key := getCacheKey(effectiveConfig) + cacheKeySuffix
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

type databaseWaitResult struct {
	instance db.Database
	err      error
}

// getDatabaseWithContext makes waiting for cache lookup, singleflight, and a
// driver's non-context-aware Connect call cancellable. The physical Connect
// may finish in the worker after the caller leaves; the normal flight and
// shutdown checks still decide whether that instance may enter the cache.
func (a *App) getDatabaseWithContext(ctx context.Context, config connection.ConnectionConfig, forcePing bool) (db.Database, error) {
	return a.getDatabaseWithContextLane(ctx, config, forcePing, "")
}

func (a *App) getDatabaseWithContextLane(ctx context.Context, config connection.ConnectionConfig, forcePing bool, cacheKeySuffix string) (db.Database, error) {
	if isPluginDataSourceType(config.Type) {
		return a.getPluginDataSource(ctx, config, forcePing, cacheKeySuffix)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	resultCh := make(chan databaseWaitResult, 1)
	go func() {
		instance, err := a.getDatabaseWithPingLane(config, forcePing, cacheKeySuffix)
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
	return a.getDatabaseSynchronouslyWithContextLane(ctx, config, forcePing, "")
}

func (a *App) getDatabaseSynchronouslyWithContextLane(ctx context.Context, config connection.ConnectionConfig, forcePing bool, cacheKeySuffix string) (db.Database, error) {
	if isPluginDataSourceType(config.Type) {
		return a.getPluginDataSource(ctx, config, forcePing, cacheKeySuffix)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	instance, err := a.getDatabaseWithPingLane(config, forcePing, cacheKeySuffix)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return instance, nil
}

func (a *App) openDatabaseIsolated(config connection.ConnectionConfig) (db.Database, error) {
	if isPluginDataSourceType(config.Type) {
		return a.openPluginDataSource(a.pluginDataSourceContext(), config)
	}
	effectiveConfig, err := a.resolveEffectiveConnectionConfig(config)
	if err != nil {
		return nil, err
	}
	if isPluginDataSourceType(effectiveConfig.Type) {
		return a.openPluginDataSource(a.pluginDataSourceContext(), effectiveConfig)
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
	if isPluginDataSourceType(config.Type) {
		if _, valid := pluginDataSourceDialect(config.Type); !valid {
			return config, fmt.Errorf("invalid plugin data source type")
		}
	}
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		return config, wrapConnectError(config, err)
	}
	runtimeConfig, err := a.resolveCustomClickHouseRuntimeConfig(resolvedConfig)
	if err != nil {
		return config, wrapConnectError(resolvedConfig, err)
	}
	runtimeConfig = a.withManagedSSHHostKeyTrustStore(runtimeConfig)
	if runtimeConfig.UseSSH && runtimeConfig.SSH.ConnectTimeout <= 0 {
		runtimeConfig.SSH.ConnectTimeout = int(appConnectTimeout(runtimeConfig).Seconds())
	}
	return runtimeConfig, nil
}

func (a *App) getDatabaseWithPing(config connection.ConnectionConfig, forcePing bool) (db.Database, error) {
	return a.getDatabaseWithPingLane(config, forcePing, "")
}

func (a *App) getDatabaseWithPingLane(config connection.ConnectionConfig, forcePing bool, cacheKeySuffix string) (db.Database, error) {
	if isPluginDataSourceType(config.Type) {
		return a.getPluginDataSource(a.pluginDataSourceContext(), config, forcePing, cacheKeySuffix)
	}
	effectiveConfig, err := a.resolveEffectiveConnectionConfig(config)
	if err != nil {
		return nil, err
	}
	if isPluginDataSourceType(effectiveConfig.Type) {
		return a.getPluginDataSource(a.pluginDataSourceContext(), effectiveConfig, forcePing, cacheKeySuffix)
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

	key := getCacheKey(effectiveConfig) + cacheKeySuffix
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

	if cached, found, cacheErr := a.cachedBuiltinDatabaseForLookup(effectiveConfig, key, forcePing, isFileDB); found {
		return cached, cacheErr
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
		return a.connectAndCacheDatabase(effectiveConfig, key, cacheKeySuffix, isFileDB, flight)
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

// cachedBuiltinDatabaseForLookup keeps legacy cache reuse separate from plugin generation fencing.
func (a *App) cachedBuiltinDatabaseForLookup(effectiveConfig connection.ConnectionConfig, key string, forcePing, isFileDB bool) (db.Database, bool, error) {
	shortKey := shortenCacheKey(key)
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
				return nil, true, returnErr
			}
			return entry.inst, true, nil
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
				return nil, true, returnErr
			}
			return entry.inst, true, nil
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
	return nil, false, nil
}
