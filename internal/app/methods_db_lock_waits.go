package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

// DBListLockWaits returns which server sessions are waiting for a lock and
// which sessions hold it. Unsupported engines return a successful empty
// payload so the frontend can show an honest capability state without opening
// a connection. Terminating a blocker goes through DBExecuteSessionAction.
func (a *App) DBListLockWaits(
	config connection.ConnectionConfig,
	dbName string,
) connection.QueryResult {
	return a.dbListLockWaitsContext(a.sessionWorkbenchParentContext(), config, dbName)
}

func (a *App) dbListLockWaitsContext(
	parent context.Context,
	config connection.ConnectionConfig,
	dbName string,
) connection.QueryResult {
	runConfig := normalizeRunConfig(config, dbName)
	engine, capability := db.LockWaitCapabilityFor(runConfig)
	if !capability.Supported {
		return connection.QueryResult{Success: true, Data: connection.LockWaitPayload{
			Engine:     engine,
			Capability: capability,
			Waits:      []connection.DatabaseLockWait{},
		}}
	}

	database, queryContext, cleanup, err := a.openSessionWorkbenchDatabase(parent, runConfig)
	if err != nil {
		logger.Error(err, "DBListLockWaits 获取隔离连接失败：%s", formatConnSummary(runConfig))
		return a.lockWaitListFailure(err)
	}
	defer cleanup()

	payload, err := db.NewLockWaitInspector(database, runConfig).ListLockWaits(queryContext)
	if err != nil {
		logger.Error(err, "DBListLockWaits 查询锁等待失败：%s", formatConnSummary(runConfig))
		return a.lockWaitListFailure(err)
	}
	payload.ScopedDatabase = strings.TrimSpace(runConfig.Database)
	return connection.QueryResult{Success: true, Data: payload}
}

func (a *App) lockWaitListFailure(err error) connection.QueryResult {
	return connection.QueryResult{
		Success: false,
		Message: a.appText("session_workbench.backend.error.lock_waits_failed", map[string]any{
			"detail": sessionWorkbenchErrorDetail(err),
		}),
	}
}
