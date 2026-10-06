package app

import (
	"context"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

// DBListLongTransactions returns the sessions holding an open transaction,
// oldest first, for the long-transaction alerts. Unsupported engines return a
// successful empty payload without opening a connection.
func (a *App) DBListLongTransactions(
	config connection.ConnectionConfig,
	dbName string,
) connection.QueryResult {
	return a.dbListLongTransactionsContext(a.sessionWorkbenchParentContext(), config, dbName)
}

func (a *App) dbListLongTransactionsContext(
	parent context.Context,
	config connection.ConnectionConfig,
	dbName string,
) connection.QueryResult {
	runConfig := normalizeRunConfig(config, dbName)
	engine, capability := db.LongTransactionCapabilityFor(runConfig)
	if !capability.Supported {
		return connection.QueryResult{Success: true, Data: connection.LongTransactionPayload{
			Engine:       engine,
			Capability:   capability,
			Transactions: []connection.DatabaseSession{},
		}}
	}

	database, queryContext, cleanup, err := a.openSessionWorkbenchDatabase(parent, runConfig)
	if err != nil {
		logger.Error(err, "DBListLongTransactions 获取隔离连接失败：%s", formatConnSummary(runConfig))
		return a.longTransactionListFailure(err)
	}
	defer cleanup()

	payload, err := db.NewLongTransactionInspector(database, runConfig).ListLongTransactions(queryContext)
	if err != nil {
		logger.Error(err, "DBListLongTransactions 查询未结束事务失败：%s", formatConnSummary(runConfig))
		return a.longTransactionListFailure(err)
	}
	return connection.QueryResult{Success: true, Data: payload}
}

// DBGetSessionMonitorCapabilities reports which alert checks a data source
// supports. It never opens a connection.
func (a *App) DBGetSessionMonitorCapabilities(config connection.ConnectionConfig) connection.QueryResult {
	runConfig := normalizeRunConfig(config, "")
	engine, lockWaits := db.LockWaitCapabilityFor(runConfig)
	_, longTransactions := db.LongTransactionCapabilityFor(runConfig)
	return connection.QueryResult{Success: true, Data: connection.SessionMonitorCapabilities{
		Engine:           engine,
		LockWaits:        lockWaits,
		LongTransactions: longTransactions,
	}}
}

func (a *App) longTransactionListFailure(err error) connection.QueryResult {
	return connection.QueryResult{
		Success: false,
		Message: a.appText("session_workbench.backend.error.long_transactions_failed", map[string]any{
			"detail": sessionWorkbenchErrorDetail(err),
		}),
	}
}
