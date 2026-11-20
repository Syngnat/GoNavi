package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/mockdata"
	"GoNavi-Wails/internal/scriptlib"
	"GoNavi-Wails/internal/sqlaudit"
	syncengine "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

var requiredIssue1098WebRPCContextMethods = []string{
	"DBQuery", "DBQueryApplicationWithCancel", "DBQueryWithCancel", "DBQueryMulti", "DBQueryMultiWithOptions", "DBQueryMultiCompact", "DBQueryMultiWithOptionsCompact", "DBQueryAudited", "DBQueryAI", "DBQueryIsolated", "MySQLQuery",
	"DBQueryMultiTransactional", "DBQueryMultiTransactionalWithParams", "DBQueryMultiTransactionalWithOptions",
	"DBQueryMultiInTransaction", "DBQueryMultiInTransactionWithOptions", "DBQueryMultiWithParamsInTransaction",
	"DBCommitTransaction", "DBRollbackTransaction", "DBCommitTransactionWithTrigger", "DBRollbackTransactionWithTrigger",
	"DBGetDatabases", "DBGetTables", "DBGetViews", "DBGetObjects", "DBGetAllColumns", "DBGetColumns", "DBGetIndexes",
	"DBGetForeignKeys", "DBGetDatabaseForeignKeys", "DBGetTriggers", "DBShowCreateTable", "DBTableExists",
	"DBListSessions", "DBListLockWaits", "DBListLongTransactions", "DBExecuteSessionAction", "DBExecuteSessionActions",
	"MySQLGetDatabases", "MySQLGetTables", "MySQLShowCreateTable", "MongoDiscoverMembers", "DBRefreshTableStats", "DiagnoseQuery", "DiagnoseQueryWithOptions",
	"DataSyncDatabaseList", "DataSyncObjectList", "DataSyncFieldList", "DataSyncCapabilityResolve", "DataSyncCDCProbe", "DataSyncJobPreflight",
	"DataSyncJobList", "DataSyncJobGet", "DataSyncRunGet", "DataSyncRunList", "DataSyncRunPage", "DataSyncRunEventList",
	"DataSyncErrorRowList", "DataSyncErrorRowGet", "DataSyncCheckpointGet", "DataSync", "DataSyncAnalyze", "DataSyncPreview",
	"PreviewImportFile", "PreviewImportFileWithOptions", "InferImportTableSchema", "ImportDataWithProgress", "ImportDataWithProgressOptions",
	"ImportDatabaseSQL", "ImportDatabaseSQLWithOptions", "PreflightDatabaseSQLImport", "ExecuteSQLFile", "ResumeImportJob", "RetryImportJobFailedRows", "VerifySQLAuditIntegrity",
	"MockDataInspect", "MockDataPreview", "MockDataGenerate",
	"TestConnectionWithProgress", "NacosTestConnectionWithProgress",
	"BackgroundGalleryRefresh", "BackgroundGalleryDownload",
	"FontGalleryRefresh", "FontGalleryDownload", "FontGalleryPreview",
	"GetScriptLibrarySnapshot", "SaveScriptLibraryScript", "SaveScriptLibraryFolder",
	"DeleteScriptLibraryScript", "DeleteScriptLibraryFolder", "SetScriptLibraryScriptVisibility",
	"SetScriptLibraryFolderVisibility",
	"RunScriptWorkbench", "CancelScriptWorkbenchRun", "GetScriptWorkbenchRun", "GetScriptWorkbenchOutput",
	"PrepareScriptWorkbenchWrite", "ListScriptInputSheets",
	"GetSQLAuditEvents",
	"GetSavedConnections", "BuildSQLAuditExport",
}

// RequiredIssue1098WebRPCContextMethods returns the exact App method set whose
// Web RPC lifetime is request-scoped. Callers receive a copy so the contract
// cannot be mutated after server construction.
func RequiredIssue1098WebRPCContextMethods() []string {
	return append(append([]string(nil), requiredIssue1098WebRPCContextMethods...), pluginContextMethodNames...)
}

// WebRPCContextHandlers keeps context injection outside App's exported Wails
// method set. Every handler has the original public signature prefixed by a
// context.Context; the Web server validates the complete map at construction.
func WebRPCContextHandlers(a *App) map[string]any {
	return withPluginContextHandlers(a, withFontGalleryContextHandlers(a, withBackgroundGalleryContextHandlers(a, map[string]any{
		"DBQueryMultiTransactional": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
			return a.dbQueryMultiTransactionalWithBindingsSource(ctx, config, dbName, query, queryID, nil, true, nil, "query_editor")
		},
		"DBQueryMultiTransactionalWithParams": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string, bindings []connection.QueryParamBinding, quotedPlaceholders bool) connection.QueryResult {
			return a.dbQueryMultiTransactionalWithBindingsSource(ctx, config, dbName, query, queryID, bindings, quotedPlaceholders, nil, "query_editor")
		},
		"DBQueryMultiTransactionalWithOptions": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string, options QueryResultBudgetOptions) connection.QueryResult {
			budget := normalizeQueryResultBudgetOptions(options)
			return a.dbQueryMultiTransactionalWithBindingsSource(ctx, config, dbName, query, queryID, nil, true, &budget, "query_editor")
		},
		"DBQueryMultiInTransaction": func(ctx context.Context, transactionID, query, queryID string) connection.QueryResult {
			return a.dbQueryMultiInTransactionContext(ctx, transactionID, query, queryID, nil)
		},
		"DBQueryMultiInTransactionWithOptions": func(ctx context.Context, transactionID, query, queryID string, options QueryResultBudgetOptions) connection.QueryResult {
			budget := normalizeQueryResultBudgetOptions(options)
			return a.dbQueryMultiInTransactionContext(ctx, transactionID, query, queryID, &budget)
		},
		"DBQueryMultiWithParamsInTransaction": func(ctx context.Context, transactionID, query, queryID string, bindings []connection.QueryParamBinding, quotedPlaceholders bool) connection.QueryResult {
			return a.dbQueryMultiWithParamsInTransactionSource(ctx, transactionID, query, queryID, bindings, quotedPlaceholders, nil, "")
		},
		"DBCommitTransaction": func(ctx context.Context, transactionID string) connection.QueryResult {
			return a.finishManagedSQLTransactionContext(ctx, transactionID, true, "manual")
		},
		"DBRollbackTransaction": func(ctx context.Context, transactionID string) connection.QueryResult {
			return a.finishManagedSQLTransactionContext(ctx, transactionID, false, "manual")
		},
		"DBCommitTransactionWithTrigger": func(ctx context.Context, transactionID, trigger string) connection.QueryResult {
			return a.finishManagedSQLTransactionContext(ctx, transactionID, true, trigger)
		},
		"DBRollbackTransactionWithTrigger": func(ctx context.Context, transactionID, trigger string) connection.QueryResult {
			return a.finishManagedSQLTransactionContext(ctx, transactionID, false, trigger)
		},
		"DBQuery": func(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
			return a.dbQueryContext(ctx, config, dbName, query)
		},
		"DBQueryApplicationWithCancel": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
			return a.dbQueryApplicationWithCancelContext(ctx, config, dbName, query, queryID)
		},
		"DBQueryWithCancel": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
			return a.dbQueryWithCancelContext(ctx, config, dbName, query, queryID)
		},
		"DBQueryMulti": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
			return a.dbQueryMultiContext(ctx, config, dbName, query, queryID)
		},
		"DBQueryMultiWithOptions": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string, options QueryResultBudgetOptions) connection.QueryResult {
			return a.dbQueryMultiWithOptionsContext(ctx, config, dbName, query, queryID, options)
		},
		"DBQueryMultiCompact": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) CompactQueryResult {
			return a.dbQueryMultiCompactContext(ctx, config, dbName, query, queryID)
		},
		"DBQueryMultiWithOptionsCompact": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string, options QueryResultBudgetOptions) CompactQueryResult {
			return a.dbQueryMultiWithOptionsCompactContext(ctx, config, dbName, query, queryID, options)
		},
		"DBQueryAudited": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, source string) connection.QueryResult {
			return a.dbQueryAuditedContext(ctx, config, dbName, query, source)
		},
		"DBQueryAI": func(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
			return a.dbQueryAIContext(ctx, config, dbName, query)
		},
		"DBQueryIsolated": func(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
			return a.dbQueryIsolatedContext(ctx, config, dbName, query)
		},
		"MySQLQuery": func(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
			config.Type = "mysql"
			return a.dbQueryContext(ctx, config, dbName, query)
		},
		"DBListSessions": func(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
			return a.dbListSessionsContext(ctx, config, dbName)
		},
		"DBListLockWaits": func(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
			return a.dbListLockWaitsContext(ctx, config, dbName)
		},
		"DBListLongTransactions": func(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
			return a.dbListLongTransactionsContext(ctx, config, dbName)
		},
		"DBExecuteSessionAction": func(ctx context.Context, config connection.ConnectionConfig, dbName string, request connection.SessionActionRequest) connection.QueryResult {
			return a.dbExecuteSessionActionWithAuditContext(ctx, config, dbName, request)
		},
		"DBExecuteSessionActions": func(ctx context.Context, config connection.ConnectionConfig, dbName string, requests []connection.SessionActionRequest) connection.QueryResult {
			return a.dbExecuteSessionActionsWithAuditContext(ctx, config, dbName, requests)
		},

		"DBGetDatabases": func(ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetDatabases(config) })
		},
		"DBGetTables": func(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetTables(config, dbName) })
		},
		"DBGetViews": func(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetViews(config, dbName) })
		},
		"DBGetObjects": func(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetObjects(config, dbName) })
		},
		"DBGetAllColumns": func(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetAllColumns(config, dbName) })
		},
		"DBGetColumns": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetColumns(config, dbName, tableName) })
		},
		"DBGetIndexes": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetIndexes(config, dbName, tableName) })
		},
		"DBGetForeignKeys": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetForeignKeys(config, dbName, tableName) })
		},
		"DBGetDatabaseForeignKeys": func(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetDatabaseForeignKeys(config, dbName) })
		},
		"DBGetTriggers": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetTriggers(config, dbName, tableName) })
		},
		"DBShowCreateTable": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBShowCreateTable(config, dbName, tableName) })
		},
		"DBTableExists": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBTableExists(config, dbName, tableName) })
		},
		"MySQLGetDatabases": func(ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
			config.Type = "mysql"
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetDatabases(config) })
		},
		"MySQLGetTables": func(ctx context.Context, config connection.ConnectionConfig, dbName string) connection.QueryResult {
			config.Type = "mysql"
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBGetTables(config, dbName) })
		},
		"MySQLShowCreateTable": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName string) connection.QueryResult {
			config.Type = "mysql"
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult { return session.DBShowCreateTable(config, dbName, tableName) })
		},
		"MongoDiscoverMembers": func(ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
			return a.mongoDiscoverMembersContext(ctx, config)
		},
		"DBRefreshTableStats": func(ctx context.Context, config connection.ConnectionConfig, dbName string, rawTables []string) connection.QueryResult {
			return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
				return session.DBRefreshTableStats(config, dbName, rawTables)
			})
		},
		"DiagnoseQuery": func(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
			return a.diagnoseQueryContext(ctx, config, dbName, query)
		},
		"DiagnoseQueryWithOptions": func(ctx context.Context, config connection.ConnectionConfig, dbName, query string, options connection.DiagnoseOptions) connection.QueryResult {
			return a.runDiagnoseQuery(ctx, config, dbName, query, options)
		},

		"DataSyncDatabaseList": func(ctx context.Context, connectionID string) connection.QueryResult {
			return a.dataSyncDatabaseListContext(ctx, connectionID)
		},
		"DataSyncObjectList": func(ctx context.Context, connectionID, database, schema string) connection.QueryResult {
			return a.dataSyncObjectListContext(ctx, connectionID, database, schema)
		},
		"DataSyncFieldList": func(ctx context.Context, connectionID, database, schema, objectName string) connection.QueryResult {
			return a.dataSyncFieldListContext(ctx, connectionID, database, schema, objectName)
		},
		"DataSyncCapabilityResolve": func(ctx context.Context, sourceConnectionID, sourceDatabase, sourceSchema, targetConnectionID, targetDatabase, targetSchema string) connection.QueryResult {
			return a.dataSyncCapabilityResolveContext(ctx, sourceConnectionID, sourceDatabase, sourceSchema, targetConnectionID, targetDatabase, targetSchema)
		},
		"DataSyncCDCProbe": func(ctx context.Context, connectionID, database, schema, mode string) connection.QueryResult {
			return a.dataSyncCDCProbeContext(ctx, connectionID, database, schema, mode)
		},
		"DataSyncJobPreflight": func(ctx context.Context, definition syncjob.JobDefinition) connection.QueryResult {
			return a.dataSyncJobPreflightContext(ctx, definition)
		},
		"DataSyncJobList": func(ctx context.Context) connection.QueryResult { return a.dataSyncJobListContext(ctx) },
		"DataSyncJobGet": func(ctx context.Context, jobID string) connection.QueryResult {
			return a.dataSyncJobGetContext(ctx, jobID)
		},
		"DataSyncRunGet": func(ctx context.Context, runID string) connection.QueryResult {
			return a.dataSyncRunGetContext(ctx, runID)
		},
		"DataSyncRunList": func(ctx context.Context, jobID string, limit int) connection.QueryResult {
			return a.dataSyncRunListContext(ctx, jobID, limit)
		},
		"DataSyncRunPage": func(ctx context.Context, jobID string, beforeCreatedAt int64, beforeID string, limit int) connection.QueryResult {
			return a.dataSyncRunPageContext(ctx, jobID, beforeCreatedAt, beforeID, limit)
		},
		"DataSyncRunEventList": func(ctx context.Context, runID string, afterSequence int64, limit int) connection.QueryResult {
			return a.dataSyncRunEventListContext(ctx, runID, afterSequence, limit)
		},
		"DataSyncErrorRowList": func(ctx context.Context, runID, status string, limit int) connection.QueryResult {
			return a.dataSyncErrorRowListContext(ctx, runID, status, limit)
		},
		"DataSyncErrorRowGet": func(ctx context.Context, errorRowID string) connection.QueryResult {
			return a.dataSyncErrorRowGetContext(ctx, errorRowID)
		},
		"DataSyncCheckpointGet": func(ctx context.Context, jobID string) connection.QueryResult {
			return a.dataSyncCheckpointGetContext(ctx, jobID)
		},
		"DataSync": func(ctx context.Context, config syncengine.SyncConfig) syncengine.SyncResult {
			return a.dataSyncContext(ctx, config)
		},
		"DataSyncAnalyze": func(ctx context.Context, config syncengine.SyncConfig) connection.QueryResult {
			return a.dataSyncAnalyzeContext(ctx, config)
		},
		"DataSyncPreview": func(ctx context.Context, config syncengine.SyncConfig, tableName string, limit int) connection.QueryResult {
			return a.dataSyncPreviewContext(ctx, config, tableName, limit)
		},

		"PreviewImportFile": func(ctx context.Context, filePath string) connection.QueryResult {
			return a.previewImportFileContext(ctx, filePath, ImportFileOptions{})
		},
		"PreviewImportFileWithOptions": func(ctx context.Context, filePath string, options ImportFileOptions) connection.QueryResult {
			return a.previewImportFileContext(ctx, filePath, options)
		},
		"ImportDataWithProgress": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName, filePath string) connection.QueryResult {
			return a.importDataWithProgressContext(ctx, config, dbName, tableName, filePath, ImportFileOptions{})
		},
		"ImportDataWithProgressOptions": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName, filePath string, options ImportFileOptions) connection.QueryResult {
			return a.importDataWithProgressContext(ctx, config, dbName, tableName, filePath, options)
		},
		"InferImportTableSchema": func(ctx context.Context, config connection.ConnectionConfig, dbName, filePath string, options ImportFileOptions) connection.QueryResult {
			return a.inferImportTableSchemaContext(ctx, config, dbName, filePath, options)
		},
		"ImportDatabaseSQL": func(ctx context.Context, config connection.ConnectionConfig, dbName, filePath, jobID string, continueOnError bool) connection.QueryResult {
			return a.importDatabaseSQLContext(ctx, config, dbName, filePath, jobID, continueOnError, "")
		},
		"ImportDatabaseSQLWithOptions": func(ctx context.Context, config connection.ConnectionConfig, dbName, filePath, jobID string, continueOnError bool, mysqlGTIDMode string) connection.QueryResult {
			return a.importDatabaseSQLContext(ctx, config, dbName, filePath, jobID, continueOnError, mysqlGTIDMode)
		},
		"PreflightDatabaseSQLImport": func(ctx context.Context, config connection.ConnectionConfig, dbName, filePath string) connection.QueryResult {
			return a.preflightDatabaseSQLImportContext(ctx, config, dbName, filePath)
		},
		"ExecuteSQLFile": func(ctx context.Context, config connection.ConnectionConfig, dbName, filePath, jobID string) connection.QueryResult {
			return a.executeSQLFileContext(ctx, config, dbName, filePath, jobID)
		},
		"ResumeImportJob": func(ctx context.Context, jobID string) connection.QueryResult {
			return a.resumeImportJobContext(ctx, jobID)
		},
		"RetryImportJobFailedRows": func(ctx context.Context, jobID string) connection.QueryResult {
			return a.retryImportJobFailedRowsContext(ctx, jobID)
		},
		"VerifySQLAuditIntegrity": func(ctx context.Context) connection.QueryResult {
			return a.verifySQLAuditIntegrity(ctx)
		},
		"MockDataInspect": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName, locale string) connection.QueryResult {
			return a.mockDataInspectContext(ctx, config, dbName, tableName, locale)
		},
		"MockDataPreview": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName string, plan mockdata.Plan) connection.QueryResult {
			return a.mockDataPreviewContext(ctx, config, dbName, tableName, plan)
		},
		"MockDataGenerate": func(ctx context.Context, config connection.ConnectionConfig, dbName, tableName string, plan mockdata.Plan, options MockDataRunOptions) connection.QueryResult {
			return a.mockDataGenerateContext(ctx, config, dbName, tableName, plan, options)
		},
		"TestConnectionWithProgress": func(ctx context.Context, config connection.ConnectionConfig, runID string) connection.QueryResult {
			return a.testConnectionWithProgressContext(ctx, config, runID)
		},
		"NacosTestConnectionWithProgress": func(ctx context.Context, config connection.ConnectionConfig, runID string) connection.QueryResult {
			return a.nacosTestConnectionWithProgressContext(ctx, config, runID)
		},
		"GetScriptLibrarySnapshot": func(ctx context.Context) connection.QueryResult {
			return a.getScriptLibrarySnapshotContext(ctx)
		},
		"GetSavedConnections": func(ctx context.Context) ([]connection.SavedConnectionView, error) {
			return a.GetSavedConnectionsContext(ctx)
		},
		"GetSQLAuditEvents": func(ctx context.Context, filter sqlaudit.Filter) connection.QueryResult {
			return a.getSQLAuditEventsContext(ctx, filter)
		},
		"BuildSQLAuditExport": func(ctx context.Context, filter sqlaudit.Filter, format string) connection.QueryResult {
			return a.buildSQLAuditExportResult(ctx, filter, format)
		},
		"SaveScriptLibraryScript": func(ctx context.Context, input scriptlib.SaveScriptInput) connection.QueryResult {
			return a.saveScriptLibraryScriptContext(ctx, input)
		},
		"SaveScriptLibraryFolder": func(ctx context.Context, input scriptlib.SaveFolderInput) connection.QueryResult {
			return a.saveScriptLibraryFolderContext(ctx, input)
		},
		"DeleteScriptLibraryScript": func(ctx context.Context, input scriptlib.DeleteInput) connection.QueryResult {
			return a.deleteScriptLibraryScriptContext(ctx, input)
		},
		"DeleteScriptLibraryFolder": func(ctx context.Context, input scriptlib.DeleteInput) connection.QueryResult {
			return a.deleteScriptLibraryFolderContext(ctx, input)
		},
		"SetScriptLibraryScriptVisibility": func(ctx context.Context, input scriptlib.ShareInput) connection.QueryResult {
			return a.setScriptLibraryScriptVisibilityContext(ctx, input)
		},
		"SetScriptLibraryFolderVisibility": func(ctx context.Context, input scriptlib.ShareInput) connection.QueryResult {
			return a.setScriptLibraryFolderVisibilityContext(ctx, input)
		},
		"RunScriptWorkbench": func(ctx context.Context, request ScriptWorkbenchRunRequest) connection.QueryResult {
			return a.runScriptWorkbenchContext(ctx, request)
		},
		"PrepareScriptWorkbenchWrite": func(ctx context.Context, request ScriptWorkbenchRunRequest) connection.QueryResult {
			return a.prepareScriptWorkbenchWriteContext(ctx, request)
		},
		"ListScriptInputSheets": func(ctx context.Context, input ScriptWorkbenchInput) connection.QueryResult {
			return a.listScriptInputSheetsContext(ctx, input)
		},
		"CancelScriptWorkbenchRun": func(ctx context.Context, runID string) connection.QueryResult {
			return a.cancelScriptWorkbenchRunContext(ctx, runID)
		},
		"GetScriptWorkbenchRun": func(ctx context.Context, runID string) connection.QueryResult {
			return a.getScriptWorkbenchRunContext(ctx, runID)
		},
		"GetScriptWorkbenchOutput": func(ctx context.Context, runID string, outputIndex int, page int, pageSize int) connection.QueryResult {
			return a.getScriptWorkbenchOutputContext(ctx, runID, outputIndex, page, pageSize)
		},
	})))
}

func (a *App) dbQueryContext(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
	return a.dbQueryWithCancel(config, dbName, query, "", dbQueryAuditOptions{
		auditAll: a.webRuntime, auditWrites: true, source: "application_api", executionContext: ctx, synchronousConnectionWait: true,
	})
}

func (a *App) dbQueryApplicationWithCancelContext(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
	return a.dbQueryWithCancel(config, dbName, query, queryID, dbQueryAuditOptions{
		auditAll: a.webRuntime, auditWrites: true, source: "application_api",
		executionContext: ctx, synchronousConnectionWait: true,
	})
}

func (a *App) dbQueryWithCancelContext(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
	explicitQuery := strings.TrimSpace(queryID) != ""
	source := "application_api"
	if explicitQuery {
		source = "query_editor"
	}
	return a.dbQueryWithCancel(config, dbName, query, queryID, dbQueryAuditOptions{
		trackHistory: explicitQuery, auditAll: explicitQuery || a.webRuntime, auditWrites: true, source: source,
		executionContext: ctx, synchronousConnectionWait: true,
	})
}

// dbQueryMultiWithContextOptions runs the shared DBQueryMulti body with the
// request-scoped options that the Web RPC runtime requires.
func (a *App) dbQueryMultiWithContextOptions(
	ctx context.Context,
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
	budgetOptions *db.RowBudgetOptions,
) connection.QueryResult {
	explicitQuery := strings.TrimSpace(queryID) != ""
	source := "query_editor"
	if !explicitQuery {
		source = "application_api"
	}
	return a.dbQueryMulti(config, dbName, query, queryID, dbQueryMultiAuditOptions{
		auditAll: explicitQuery || a.webRuntime, auditWrites: true, source: source,
		executionContext: ctx, synchronousConnectionWait: true, ResultBudget: budgetOptions,
	})
}

// dbQueryMultiWithOptionsContext 为 Web RPC 桌面查询绑定与服务端一致的复合结果预算。
func (a *App) dbQueryMultiWithOptionsContext(
	ctx context.Context,
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
	options QueryResultBudgetOptions,
) connection.QueryResult {
	budget := normalizeQueryResultBudgetOptions(options)
	return a.dbQueryMultiWithContextOptions(ctx, config, dbName, query, queryID, &budget)
}

func (a *App) dbQueryMultiContext(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
	return a.dbQueryMultiWithContextOptions(ctx, config, dbName, query, queryID, nil)
}

// dbQueryMultiCompactContext mirrors dbQueryMultiContext for the compact
// transport: identical audit, cancellation and connection-wait semantics, with
// the result set compacted for the Web RPC payload.
func (a *App) dbQueryMultiCompactContext(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) CompactQueryResult {
	return encodeCompactQueryResult(a.dbQueryMultiWithContextOptions(ctx, config, dbName, query, queryID, nil))
}

// dbQueryMultiWithOptionsCompactContext 是带预算的压缩传输：预算语义与
// dbQueryMultiWithOptionsContext 完全一致，只是结果集同样经过压缩编码。
//
// 「不限」放开行数预算后，未压缩通道会把整份 JSON 内联成一条 JS 字面量；Web 模式
// 下这条路径尤其重要，因为浏览器端一次性 JSON.parse 数百 MB 会直接卡住主线程。
func (a *App) dbQueryMultiWithOptionsCompactContext(
	ctx context.Context,
	config connection.ConnectionConfig,
	dbName string,
	query string,
	queryID string,
	options QueryResultBudgetOptions,
) CompactQueryResult {
	budget := normalizeQueryResultBudgetOptions(options)
	return encodeCompactQueryResult(a.dbQueryMultiWithContextOptions(ctx, config, dbName, query, queryID, &budget))
}

func (a *App) dbQueryAuditedContext(ctx context.Context, config connection.ConnectionConfig, dbName, query, source string) connection.QueryResult {
	return a.dbQueryWithCancel(config, dbName, query, generateQueryID(), dbQueryAuditOptions{
		auditAll: true, auditWrites: true, source: normalizeSQLAuditUserActionSource(source), executionContext: ctx, synchronousConnectionWait: true,
	})
}

func (a *App) dbQueryAIContext(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
	return a.dbQueryWithCancel(config, dbName, query, "", dbQueryAuditOptions{
		auditAll: true, auditWrites: true, source: "ai_action", executionContext: ctx, synchronousConnectionWait: true,
	})
}

func (a *App) mongoDiscoverMembersContext(ctx context.Context, config connection.ConnectionConfig) connection.QueryResult {
	config.Type = "mongodb"
	return a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
		dbInst, err := session.getDatabaseSynchronouslyWithContext(ctx, config, false)
		if err != nil {
			logger.Error(err, "MongoDiscoverMembers 获取连接失败：%s", formatConnSummary(config))
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		session.bindMetadataDatabase(dbInst)
		if pinger, ok := dbInst.(interface{ PingContext(context.Context) error }); ok {
			if err := pinger.PingContext(ctx); err != nil {
				return connection.QueryResult{Success: false, Message: err.Error()}
			}
		} else if pinger, ok := dbInst.(interface{ Ping() error }); ok {
			if err := pinger.Ping(); err != nil {
				return connection.QueryResult{Success: false, Message: err.Error()}
			}
		}
		if err := ctx.Err(); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		discoverable, ok := dbInst.(interface {
			DiscoverMembersContext(context.Context) (string, []connection.MongoMemberInfo, error)
		})
		if !ok {
			legacy, legacyOK := dbInst.(interface {
				DiscoverMembers() (string, []connection.MongoMemberInfo, error)
			})
			if !legacyOK {
				return connection.QueryResult{Success: false, Message: a.appText("db.backend.error.mongo_member_discovery_unsupported", nil)}
			}
			replicaSet, members, err := legacy.DiscoverMembers()
			return buildMongoDiscoveryResult(a, config, replicaSet, members, err)
		}
		replicaSet, members, err := discoverable.DiscoverMembersContext(ctx)
		return buildMongoDiscoveryResult(a, config, replicaSet, members, err)
	})
}

func buildMongoDiscoveryResult(a *App, config connection.ConnectionConfig, replicaSet string, members []connection.MongoMemberInfo, err error) connection.QueryResult {
	if err != nil {
		logger.Error(err, "MongoDiscoverMembers 执行失败：%s", formatConnSummary(config))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("db.backend.message.mongo_members_discovered", map[string]any{"count": len(members)}),
		Data:    map[string]any{"replicaSet": replicaSet, "members": members},
	}
}
