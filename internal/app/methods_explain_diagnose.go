package app

import (
	"context"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

// DiagnoseQueryWithOptions 与 DiagnoseQuery 相同，另可用实测模式（options.Analyze）
// 真实执行查询，返回每一步的实际耗时与行数。实测在只读事务内执行并回滚，受连接的诊断超时限制，
// 并写入 SQL 审计（来源 sql_analysis）。
func (a *App) DiagnoseQueryWithOptions(
	config connection.ConnectionConfig,
	dbName string,
	query string,
	options connection.DiagnoseOptions,
) connection.QueryResult {
	return a.runDiagnoseQuery(context.Background(), config, dbName, query, options)
}

func (a *App) runDiagnoseQuery(
	ctx context.Context,
	config connection.ConnectionConfig,
	dbName string,
	query string,
	options connection.DiagnoseOptions,
) connection.QueryResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return connection.QueryResult{Success: false, Message: a.appText("sql_analysis.backend.error.query_required", nil)}
	}

	runConfig := normalizeRunConfig(config, dbName)
	dbType := resolveExplainDBType(runConfig)
	if !isSafeExplainQuery(dbType, query) {
		return connection.QueryResult{Success: false, Message: a.appText("sql_analysis.backend.error.select_only", nil)}
	}
	if !explainSupportedDBTypes[dbType] && !isRegistryExplainDialect(dbType) {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("sql_analysis.backend.error.unsupported_db_type", map[string]any{"dbType": dbType}),
		}
	}
	analyzeSupported := explainAnalyzeSupportedFor(runConfig, dbType)
	if options.Analyze && !analyzeSupported {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("sql_analysis.backend.error.analyze_unsupported", map[string]any{"dbType": dbType}),
		}
	}
	if options.Analyze {
		if construct := explainAnalyzeIrreversible(dbType, query); construct != "" {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("sql_analysis.backend.error.analyze_irreversible", map[string]any{"construct": construct}),
			}
		}
	}

	dbInst, err := a.getDatabaseSynchronouslyWithContext(ctx, runConfig, false)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	var plan connection.ExplainResult
	if options.Analyze {
		plan, err = a.executeAuditedExplainAnalyze(ctx, dbInst, runConfig, dbName, dbType, query)
	} else {
		plan, err = a.executeExplainContext(ctx, dbInst, runConfig, dbType, query)
	}
	if err != nil {
		logger.Warnf("DiagnoseQuery 执行失败：type=%s analyze=%t err=%v sql=%q", dbType, options.Analyze, err, sqlSnippet(query))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	suggestions := runExplainRules(plan)
	report := connection.DiagnoseReport{Plan: plan, Suggestions: suggestions, AnalyzeSupported: analyzeSupported}
	logger.Infof("DiagnoseQuery 完成：type=%s analyze=%t nodes=%d suggestions=%d", dbType, options.Analyze, len(plan.Nodes), len(suggestions))
	return connection.QueryResult{Success: true, Message: a.appText("sql_analysis.backend.message.completed", nil), Data: report}
}

// executeAuditedExplainAnalyze runs the measured plan and records it in the
// SQL audit: unlike a plain EXPLAIN, it executes the user's query.
func (a *App) executeAuditedExplainAnalyze(
	ctx context.Context,
	dbInst db.Database,
	runConfig connection.ConnectionConfig,
	dbName string,
	dbType string,
	query string,
) (connection.ExplainResult, error) {
	startedAt := time.Now()
	plan, statement, err := a.executeExplainAnalyzeContext(ctx, dbInst, runConfig, dbType, query)
	auditResult := connection.QueryResult{Success: err == nil}
	if err != nil {
		auditResult.Message = err.Error()
	}
	a.recordSQLAuditQuery(sqlAuditQueryInput{
		Config:         runConfig,
		Database:       dbName,
		DBType:         dbType,
		QueryID:        generateQueryID(),
		SQL:            statement,
		Source:         explainAnalyzeAuditSource,
		CommitMode:     "auto",
		Duration:       time.Since(startedAt),
		StatementCount: 1,
		Result:         auditResult,
	})
	return plan, err
}
