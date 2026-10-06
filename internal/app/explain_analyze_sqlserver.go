package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// SQL Server 实测：SET STATISTICS XML ON 后直接执行查询，服务端在查询自己的结果集之后
// 多返回一个实际执行计划（每个算子带 ActualRows / ActualExecutions / ActualElapsedms）。
//
//   - 计划排在全部结果行之后，必须读完结果才能拿到；结果行会进内存，所以设了行数与
//     字节上限，超出就提示用户先加 TOP，而不是把内存撑爆；
//   - 在显式事务里执行、结束回滚（查询本身只读，回滚只为不留下锁与会话状态）；
//   - 驱动在 context 取消时发送 attention，服务端随即停止语句，不需要额外 KILL。

const (
	sqlServerAnalyzeMaxRows  = 100_000
	sqlServerAnalyzeMaxBytes = 64 << 20
)

// sqlServerResultSetsSession is the pinned session's way to read every result
// set of one batch: the built-in driver's QueryMultiContext, or the driver
// agent's session call.
type sqlServerResultSetsSession interface {
	QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error)
}

func (a *App) executeSQLServerExplainAnalyze(
	ctx context.Context,
	dbInst db.Database,
	query string,
	sql string,
	timeout time.Duration,
) (connection.ExplainResult, string, error) {
	text := a.appText
	statement := "SET STATISTICS XML ON;\n" + sql
	session, _, closeSession, err := openExplainAnalyzeSession(ctx, dbInst, "sqlserver", text)
	if err != nil {
		return connection.ExplainResult{}, statement, err
	}
	defer closeSession()
	queryResultSets, ok := sqlServerAnalyzeQuerier(session)
	if !ok {
		return connection.ExplainResult{}, statement, fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_unsupported", map[string]any{"dbType": "sqlserver"}))
	}

	// The transaction opens before statistics are switched on, and statistics
	// are switched off before the rollback, so neither statement adds a plan.
	cleanup := []string{"SET STATISTICS XML OFF", "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION"}
	for _, setup := range []string{"BEGIN TRANSACTION", "SET STATISTICS XML ON"} {
		if _, err := session.ExecContext(ctx, setup); err != nil {
			cleanupPinnedExplainSession(dbInst, session, "sqlserver", cleanup)
			return connection.ExplainResult{}, statement, explainAnalyzeError(ctx, "sqlserver", timeout, err, text)
		}
	}
	budget := db.NewRowBudgetWithOptions(db.RowBudgetOptions{MaxTotalRows: sqlServerAnalyzeMaxRows, MaxTotalBytes: sqlServerAnalyzeMaxBytes})
	results, queryErr := queryResultSets(db.ContextWithRowBudget(ctx, budget), sql)
	cleanupPinnedExplainSession(dbInst, session, "sqlserver", cleanup)
	if queryErr != nil {
		return connection.ExplainResult{}, statement, explainAnalyzeError(ctx, "sqlserver", timeout, queryErr, text)
	}

	raw := lastSQLServerShowplan(results)
	if raw == "" {
		if budget.Exhausted() {
			return connection.ExplainResult{}, statement, fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_too_many_rows", map[string]any{"rows": sqlServerAnalyzeMaxRows}))
		}
		return connection.ExplainResult{}, statement, fmt.Errorf("%s", text("sql_analysis.backend.error.explain_result_missing", nil))
	}
	result, err := parseExplainRawWithText("sqlserver", query, raw, connection.ExplainFormatXML, text)
	if err != nil {
		return connection.ExplainResult{}, statement, err
	}
	annotateExplainActuals(&result)
	return result, statement, nil
}

func sqlServerAnalyzeQuerier(session db.StatementExecer) (func(context.Context, string) ([]connection.ResultSetData, error), bool) {
	if agent, ok := session.(db.SessionResultSetsQuerier); ok {
		return agent.QueryResultSetsContext, true
	}
	if builtIn, ok := session.(sqlServerResultSetsSession); ok {
		return builtIn.QueryMultiContext, true
	}
	return nil, false
}

// lastSQLServerShowplan picks the actual plan out of the batch's result sets:
// the single-column set SQL Server names "Microsoft SQL Server 2005 XML Showplan".
func lastSQLServerShowplan(results []connection.ResultSetData) string {
	for index := len(results) - 1; index >= 0; index-- {
		result := results[index]
		if len(result.Columns) != 1 || !strings.Contains(strings.ToLower(result.Columns[0]), "showplan") {
			continue
		}
		for _, row := range result.Rows {
			if value := strings.TrimSpace(fmt.Sprint(row[result.Columns[0]])); strings.Contains(value, "<ShowPlanXML") {
				return value
			}
		}
	}
	return ""
}
