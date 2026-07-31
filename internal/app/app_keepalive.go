package app

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
)

const (
	defaultConnectionKeepAliveIntervalMinutes = 240
	minConnectionKeepAliveIntervalMinutes     = 1
	maxConnectionKeepAliveIntervalMinutes     = 1440
	connectionKeepAliveScanInterval           = 30 * time.Second
	connectionKeepAliveQueryTimeout           = 30 * time.Second
	connectionKeepAliveStopTimeout            = 5 * time.Second
	maxConnectionKeepAliveSQLLength           = 4096
)

var (
	errInvalidConnectionKeepAliveSQL              = errors.New("custom keep-alive SQL must be one SELECT or WITH statement without write operations")
	errConnectionKeepAliveQueryContextUnsupported = errors.New("database driver does not support cancellable custom keep-alive SQL")
)

type cachedDatabaseKeepAliveTarget struct {
	key      string
	inst     db.Database
	config   connection.ConnectionConfig
	sql      string
	dbType   string
	revision uint64
}

func nextConnectionKeepAliveRevision(current uint64) uint64 {
	next := current + 1
	if next == 0 {
		return 1
	}
	return next
}

func supportsConnectionKeepAliveSQL(config connection.ConnectionConfig) bool {
	dbType := resolveDDLDBType(config)
	if dbType == "mongodb" || isFileDatabaseType(dbType) {
		return false
	}
	_, supported := connectionReadOnlySupportedTypes[dbType]
	return supported
}

func resolveConnectionKeepAliveSQL(config connection.ConnectionConfig) (string, string) {
	if !config.KeepAliveEnabled || !supportsConnectionKeepAliveSQL(config) {
		return "", ""
	}
	return strings.TrimSpace(config.KeepAliveSQL), resolveDDLDBType(config)
}

func executeConnectionKeepAlive(ctx context.Context, target cachedDatabaseKeepAliveTarget) error {
	if strings.TrimSpace(target.sql) == "" {
		if ctx == nil {
			ctx = context.Background()
		}
		if pinger, ok := target.inst.(interface {
			PingContext(context.Context) error
		}); ok {
			pingCtx, cancel := context.WithTimeout(ctx, connectionKeepAliveQueryTimeout)
			defer cancel()
			return pinger.PingContext(pingCtx)
		}
		return target.inst.Ping()
	}
	if utf8.RuneCountInString(target.sql) > maxConnectionKeepAliveSQLLength ||
		!isSafeExplainQuery(target.dbType, target.sql) {
		return errInvalidConnectionKeepAliveSQL
	}

	if ctx == nil {
		ctx = context.Background()
	}
	queryCtx, cancel := context.WithTimeout(ctx, connectionKeepAliveQueryTimeout)
	defer cancel()
	queryer, ok := target.inst.(interface {
		QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
	})
	if !ok {
		return errConnectionKeepAliveQueryContextUnsupported
	}
	_, _, err := queryer.QueryContext(queryCtx, target.sql)
	return err
}

func isConnectionKeepAlivePolicyError(err error) bool {
	return errors.Is(err, errInvalidConnectionKeepAliveSQL) ||
		errors.Is(err, errConnectionKeepAliveQueryContextUnsupported)
}

func resolveConnectionKeepAliveSettings(config connection.ConnectionConfig) (bool, time.Duration) {
	if !config.KeepAliveEnabled || isFileDatabaseType(config.Type) {
		return false, 0
	}

	minutes := config.KeepAliveIntervalMinutes
	switch {
	case minutes <= 0:
		minutes = defaultConnectionKeepAliveIntervalMinutes
	case minutes < minConnectionKeepAliveIntervalMinutes:
		minutes = minConnectionKeepAliveIntervalMinutes
	case minutes > maxConnectionKeepAliveIntervalMinutes:
		minutes = maxConnectionKeepAliveIntervalMinutes
	}

	return true, time.Duration(minutes) * time.Minute
}

func (a *App) startConnectionKeepAliveLoop() {
	if a == nil || a.keepAliveCancel != nil {
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	a.keepAliveCancel = cancel
	a.keepAliveDone = done

	go func() {
		defer close(done)

		ticker := time.NewTicker(connectionKeepAliveScanInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				a.runConnectionKeepAliveTickContext(ctx, now)
			}
		}
	}()
}

func (a *App) stopConnectionKeepAliveLoop() {
	if a == nil {
		return
	}

	cancel := a.keepAliveCancel
	done := a.keepAliveDone
	a.keepAliveCancel = nil
	a.keepAliveDone = nil

	if cancel != nil {
		cancel()
	}
	if done != nil {
		timer := time.NewTimer(connectionKeepAliveStopTimeout)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
			logger.Warnf("等待连接保活循环退出超时（%s），继续执行应用关停", connectionKeepAliveStopTimeout)
		}
	}
}

func (a *App) runConnectionKeepAliveTick(now time.Time) {
	a.runConnectionKeepAliveTickContext(context.Background(), now)
}

func (a *App) runConnectionKeepAliveTickContext(ctx context.Context, now time.Time) {
	if ctx == nil {
		ctx = context.Background()
	}
	if a != nil && a.resultDiffManager != nil {
		a.resultDiffManager.PruneExpired(now)
	}
	targets := a.collectDueConnectionKeepAliveTargets(now)
	for index, target := range targets {
		if ctx.Err() != nil {
			a.releaseCachedDatabaseKeepAliveTargets(targets[index:])
			return
		}
		if target.inst == nil || !a.isCachedDatabaseKeepAliveTargetCurrent(target) {
			continue
		}
		if err := executeConnectionKeepAlive(ctx, target); err != nil {
			if ctx.Err() != nil {
				a.releaseCachedDatabaseKeepAliveTargets(targets[index:])
				return
			}
			if isConnectionKeepAlivePolicyError(err) {
				if a.markCachedDatabaseKeepAliveSkipped(target, time.Now()) {
					logger.Warnf(
						"连接自定义保活配置无效，已跳过本次探活：%s 缓存Key=%s 原因=%s",
						formatConnSummary(target.config),
						shortCacheKey(target.key),
						sqlaudit.RedactError(normalizeErrorMessage(err)),
					)
				}
				continue
			}
			if closed, summary := a.evictCachedDatabaseAfterKeepAliveFailure(target); closed {
				logger.Warnf(
					"连接保活失败，已清理缓存连接：%s 缓存Key=%s 原因=%s",
					summary,
					shortCacheKey(target.key),
					sqlaudit.RedactError(normalizeErrorMessage(err)),
				)
			}
			continue
		}
		a.markCachedDatabaseKeepAliveSuccess(target, time.Now())
	}
}

func cachedDatabaseKeepAliveTargetOwnsInFlight(entry cachedDatabase, target cachedDatabaseKeepAliveTarget) bool {
	return entry.inst == target.inst &&
		entry.keepAliveInFlight &&
		entry.keepAliveInFlightRevision == target.revision
}

func cachedDatabaseKeepAliveTargetMatches(entry cachedDatabase, target cachedDatabaseKeepAliveTarget) bool {
	return cachedDatabaseKeepAliveTargetOwnsInFlight(entry, target) &&
		entry.keepAliveEnabled &&
		entry.keepAliveRevision == target.revision &&
		entry.keepAliveSQL == target.sql &&
		entry.keepAliveDBType == target.dbType
}

func (a *App) isCachedDatabaseKeepAliveTargetCurrent(target cachedDatabaseKeepAliveTarget) bool {
	if a == nil {
		return false
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	entry, exists := a.dbCache[target.key]
	if !exists {
		return false
	}
	if cachedDatabaseKeepAliveTargetMatches(entry, target) {
		return true
	}
	if cachedDatabaseKeepAliveTargetOwnsInFlight(entry, target) {
		entry.keepAliveInFlight = false
		entry.keepAliveInFlightRevision = 0
		a.dbCache[target.key] = entry
	}
	return false
}

func (a *App) releaseCachedDatabaseKeepAliveTargets(targets []cachedDatabaseKeepAliveTarget) {
	if a == nil || len(targets) == 0 {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	for _, target := range targets {
		entry, exists := a.dbCache[target.key]
		if !exists || !cachedDatabaseKeepAliveTargetOwnsInFlight(entry, target) {
			continue
		}
		entry.keepAliveInFlight = false
		entry.keepAliveInFlightRevision = 0
		a.dbCache[target.key] = entry
	}
}

func (a *App) collectDueConnectionKeepAliveTargets(now time.Time) []cachedDatabaseKeepAliveTarget {
	if a == nil {
		return nil
	}

	targets := make([]cachedDatabaseKeepAliveTarget, 0)
	a.mu.Lock()
	defer a.mu.Unlock()

	for key, entry := range a.dbCache {
		if entry.inst == nil || !entry.keepAliveEnabled || entry.keepAliveInterval <= 0 || entry.keepAliveInFlight {
			continue
		}
		if !entry.lastKeepAliveAt.IsZero() && now.Sub(entry.lastKeepAliveAt) < entry.keepAliveInterval {
			continue
		}

		entry.keepAliveInFlight = true
		entry.keepAliveInFlightRevision = entry.keepAliveRevision
		a.dbCache[key] = entry
		targets = append(targets, cachedDatabaseKeepAliveTarget{
			key:      key,
			inst:     entry.inst,
			config:   entry.config,
			sql:      entry.keepAliveSQL,
			dbType:   entry.keepAliveDBType,
			revision: entry.keepAliveRevision,
		})
	}

	return targets
}

func (a *App) markCachedDatabaseKeepAliveSuccess(target cachedDatabaseKeepAliveTarget, pingedAt time.Time) {
	if a == nil {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	entry, exists := a.dbCache[target.key]
	if !exists {
		return
	}
	if cachedDatabaseKeepAliveTargetMatches(entry, target) {
		entry.keepAliveInFlight = false
		entry.keepAliveInFlightRevision = 0
		entry.lastPing = pingedAt
		entry.lastKeepAliveAt = pingedAt
		a.dbCache[target.key] = entry
		return
	}
	if cachedDatabaseKeepAliveTargetOwnsInFlight(entry, target) {
		entry.keepAliveInFlight = false
		entry.keepAliveInFlightRevision = 0
		a.dbCache[target.key] = entry
	}
}

func (a *App) markCachedDatabaseKeepAliveSkipped(target cachedDatabaseKeepAliveTarget, attemptedAt time.Time) bool {
	if a == nil {
		return false
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	entry, exists := a.dbCache[target.key]
	if !exists {
		return false
	}
	if cachedDatabaseKeepAliveTargetMatches(entry, target) {
		entry.keepAliveInFlight = false
		entry.keepAliveInFlightRevision = 0
		entry.lastKeepAliveAt = attemptedAt
		a.dbCache[target.key] = entry
		return true
	}
	if cachedDatabaseKeepAliveTargetOwnsInFlight(entry, target) {
		entry.keepAliveInFlight = false
		entry.keepAliveInFlightRevision = 0
		a.dbCache[target.key] = entry
	}
	return false
}

func (a *App) evictCachedDatabaseAfterKeepAliveFailure(target cachedDatabaseKeepAliveTarget) (bool, string) {
	if a == nil {
		return false, ""
	}

	var (
		inst    db.Database
		summary string
	)

	a.mu.Lock()
	entry, exists := a.dbCache[target.key]
	if exists && cachedDatabaseKeepAliveTargetMatches(entry, target) {
		inst = entry.inst
		summary = formatConnSummary(entry.config)
		delete(a.dbCache, target.key)
	} else if exists && cachedDatabaseKeepAliveTargetOwnsInFlight(entry, target) {
		entry.keepAliveInFlight = false
		entry.keepAliveInFlightRevision = 0
		a.dbCache[target.key] = entry
	}
	a.mu.Unlock()

	if inst == nil {
		return false, ""
	}
	if closeErr := inst.Close(); closeErr != nil {
		logger.Error(closeErr, "关闭保活失败的缓存连接时出错：缓存Key=%s", shortCacheKey(target.key))
	}
	return true, summary
}
