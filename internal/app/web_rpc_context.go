package app

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	syncengine "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

var requiredIssue1098WebRPCContextMethods = []string{
	"DBQuery", "DBQueryWithCancel", "DBQueryMulti", "DBQueryAudited", "DBQueryAI", "DBQueryIsolated", "MySQLQuery",
	"DBGetDatabases", "DBGetTables", "DBGetViews", "DBGetObjects", "DBGetAllColumns", "DBGetColumns", "DBGetIndexes",
	"DBGetForeignKeys", "DBGetDatabaseForeignKeys", "DBGetTriggers", "DBShowCreateTable", "DBTableExists",
	"MySQLGetDatabases", "MySQLGetTables", "MySQLShowCreateTable", "MongoDiscoverMembers", "DBRefreshTableStats", "DiagnoseQuery",
	"DataSyncDatabaseList", "DataSyncObjectList", "DataSyncFieldList", "DataSyncCapabilityResolve", "DataSyncCDCProbe", "DataSyncJobPreflight",
	"DataSyncJobList", "DataSyncJobGet", "DataSyncRunGet", "DataSyncRunList", "DataSyncRunPage", "DataSyncRunEventList",
	"DataSyncErrorRowList", "DataSyncErrorRowGet", "DataSyncCheckpointGet", "DataSync", "DataSyncAnalyze", "DataSyncPreview",
	"PreviewImportFile", "PreviewImportFileWithOptions", "ImportDataWithProgress", "ImportDataWithProgressOptions",
	"ImportDatabaseSQL", "ImportDatabaseSQLWithOptions", "ExecuteSQLFile", "ResumeImportJob", "RetryImportJobFailedRows",
}

// RequiredIssue1098WebRPCContextMethods returns the exact App method set whose
// Web RPC lifetime is request-scoped. Callers receive a copy so the contract
// cannot be mutated after server construction.
func RequiredIssue1098WebRPCContextMethods() []string {
	return append([]string(nil), requiredIssue1098WebRPCContextMethods...)
}

// WebRPCContextHandlers keeps context injection outside App's exported Wails
// method set. Every handler has the original public signature prefixed by a
// context.Context; the Web server validates the complete map at construction.
func WebRPCContextHandlers(a *App) map[string]any {
	return map[string]any{
		"DBQuery": func(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
			return a.dbQueryContext(ctx, config, dbName, query)
		},
		"DBQueryWithCancel": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
			return a.dbQueryWithCancelContext(ctx, config, dbName, query, queryID)
		},
		"DBQueryMulti": func(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
			return a.dbQueryMultiContext(ctx, config, dbName, query, queryID)
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
		"ImportDatabaseSQL": func(ctx context.Context, config connection.ConnectionConfig, dbName, filePath, jobID string, continueOnError bool) connection.QueryResult {
			return a.importDatabaseSQLContext(ctx, config, dbName, filePath, jobID, continueOnError, "")
		},
		"ImportDatabaseSQLWithOptions": func(ctx context.Context, config connection.ConnectionConfig, dbName, filePath, jobID string, continueOnError bool, mysqlGTIDMode string) connection.QueryResult {
			return a.importDatabaseSQLContext(ctx, config, dbName, filePath, jobID, continueOnError, mysqlGTIDMode)
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
	}
}

func (a *App) dbQueryContext(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
	return a.dbQueryWithCancel(config, dbName, query, "", dbQueryAuditOptions{
		auditAll: a.webRuntime, auditWrites: true, source: "application_api", executionContext: ctx, synchronousConnectionWait: true,
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

func (a *App) dbQueryMultiContext(ctx context.Context, config connection.ConnectionConfig, dbName, query, queryID string) connection.QueryResult {
	explicitQuery := strings.TrimSpace(queryID) != ""
	source := "query_editor"
	if !explicitQuery {
		source = "application_api"
	}
	return a.dbQueryMulti(config, dbName, query, queryID, dbQueryMultiAuditOptions{
		auditAll: explicitQuery || a.webRuntime, auditWrites: true, source: source,
		executionContext: ctx, synchronousConnectionWait: true,
	})
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
