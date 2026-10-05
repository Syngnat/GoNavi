package app

import (
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

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
	if a.inStartupConnectRetryWindow() {
		return nil
	}
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
	if a.inStartupConnectRetryWindow() {
		return nil
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
	// revision 不匹配只告警不阻断连接：旧 agent 仍可正常连库。
	agentRevision, err := verifyInstalledOptionalDriverAgentRevision(driverType, executablePath, selectedVersion)
	if err != nil {
		logger.Warnf("%s driver-agent revision 不匹配，放行连接（建议在驱动管理中重装）：当前需要=%s version=%s path=%s err=%v",
			displayName, expectedRevision, selectedVersion, executablePath, err)
		return nil
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
	if a.inStartupConnectRetryWindow() {
		return fmt.Sprintf("启动期(age=%s)", age)
	}
	return fmt.Sprintf("稳定期(age=%s)", age)
}

func (a *App) inStartupConnectRetryWindow() bool {
	if a == nil || a.startedAt.IsZero() {
		return false
	}
	age := time.Since(a.startedAt)
	return age >= 0 && age <= startupConnectRetryWindow
}

func (a *App) shouldRetryConnect(err error, attempt int) bool {
	if attempt >= startupConnectRetryAttempts {
		return false
	}
	if !isTransientStartupConnectError(err) {
		return false
	}
	return a.inStartupConnectRetryWindow()
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
