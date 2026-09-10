package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func optionalDriverTypeForConnectionConfig(config connection.ConnectionConfig) string {
	driverType := normalizeDriverType(config.Type)
	if driverType == "custom" {
		driverType = normalizeDriverType(config.Driver)
	}
	if driverType == "" || !db.IsOptionalGoDriver(driverType) {
		return ""
	}
	return driverType
}

func (a *App) activeConnectionDriverUsageCounts() map[string]int {
	counts := map[string]int{}
	if a == nil {
		return counts
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	for _, entry := range a.dbCache {
		if driverType := optionalDriverTypeForConnectionConfig(entry.config); driverType != "" {
			counts[driverType]++
		}
	}
	return counts
}

func (a *App) driverMaintenanceActive(driverType string) bool {
	if a == nil {
		return false
	}
	normalized := normalizeDriverType(driverType)
	if normalized == "" {
		return false
	}
	a.mu.RLock()
	active := a.driverMaintenance[normalized] > 0
	a.mu.RUnlock()
	return active
}

func (a *App) cancelRunningQueriesForDriverType(driverType string) int {
	if a == nil {
		return 0
	}
	normalized := normalizeDriverType(driverType)
	if normalized == "" {
		return 0
	}
	cancels := make([]context.CancelFunc, 0)
	a.queryMu.Lock()
	for _, query := range a.runningQueries {
		if query.driverType == normalized && query.cancel != nil {
			cancels = append(cancels, query.cancel)
		}
	}
	a.queryMu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	return len(cancels)
}

// beginOptionalDriverReplacement creates a short maintenance boundary around
// activation. New connections for this driver are rejected until finish is
// called; existing cached agents and transactions are released before Windows
// is asked to replace the executable.
func (a *App) beginOptionalDriverReplacement(driverType string, targetPaths []string) (closedConnections int, finish func(), err error) {
	if a == nil {
		return 0, func() {}, nil
	}
	normalized := normalizeDriverType(driverType)
	if normalized == "" || !db.IsOptionalGoDriver(normalized) {
		return 0, nil, fmt.Errorf("optional driver type is invalid: %s", strings.TrimSpace(driverType))
	}

	targets := make([]cachedDatabaseCloseTarget, 0)
	a.mu.Lock()
	if a.driverMaintenance == nil {
		a.driverMaintenance = make(map[string]int)
	}
	if a.driverMaintenance[normalized] > 0 {
		a.mu.Unlock()
		return 0, nil, fmt.Errorf("driver maintenance is already active: %s", normalized)
	}
	a.driverMaintenance[normalized] = 1
	groupKeys := a.cancelDatabaseConnectFlightsLocked(func(flight *databaseConnectFlight) bool {
		return flight != nil && flight.driverType == normalized
	}, errDatabaseConnectionReleased, 0)
	for key, entry := range a.dbCache {
		if optionalDriverTypeForConnectionConfig(entry.config) != normalized {
			continue
		}
		targets = append(targets, cachedDatabaseCloseTarget{key: key, inst: entry.inst})
		groupKeys = append(groupKeys, key)
		delete(a.dbCache, key)
	}
	a.forgetDatabaseConnectGroupsLocked(groupKeys)
	a.mu.Unlock()

	finished := false
	finish = func() {
		if finished {
			return
		}
		finished = true
		a.mu.Lock()
		delete(a.driverMaintenance, normalized)
		a.mu.Unlock()
	}
	succeeded := false
	defer func() {
		if !succeeded {
			finish()
		}
	}()

	canceledQueries := a.cancelRunningQueriesForDriverType(normalized)
	rolledBack := a.rollbackPendingSQLTransactionsForDriverType(normalized, "driver_reinstall", "重装驱动前")
	var closeErrs []error
	for _, target := range targets {
		if target.inst == nil {
			continue
		}
		if closeErr := target.inst.Close(); closeErr != nil {
			closeErrs = append(closeErrs, fmt.Errorf("close cached connection %s: %w", shortCacheKey(target.key), closeErr))
		}
	}
	if closeErr := errors.Join(closeErrs...); closeErr != nil {
		return 0, nil, closeErr
	}

	closedPIDs, processErr := closeOtherWindowsUpdateInstancesForInstall(targetPaths, os.Getpid())
	if processErr != nil {
		return 0, nil, processErr
	}
	if len(targets) > 0 || canceledQueries > 0 || rolledBack > 0 || len(closedPIDs) > 0 {
		logger.Infof("重装驱动前已释放运行资源：driver=%s 活动连接=%d 取消查询=%d 回滚事务=%d 残留进程=%v", normalized, len(targets), canceledQueries, rolledBack, closedPIDs)
	}

	succeeded = true
	return len(targets), finish, nil
}
