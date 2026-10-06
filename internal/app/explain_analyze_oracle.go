package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/sqlaudit"
)

// Oracle 实测：会话开 STATISTICS_LEVEL = ALL，执行查询并读完（边读边丢，内存不随结果集
// 增长），再用 DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST') 取回同一会话上
// 一条语句的实际执行统计。不改写用户的 SQL。
//
// 不开只读事务：Oracle 本就禁止查询里调用的函数做 DML（ORA-14551），而只读事务读
// 几秒内刚改过结构的表会报 ORA-01466。序列 NEXTVAL 由 explainAnalyzeIrreversible 拦截。
// 结束后照常回滚（释放 FOR UPDATE 之类的行锁）；改过的统计级别属于会话状态，用完直接
// 丢弃这条物理连接，不放回连接池。

const oracleDisplayCursorQuery = "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'))"

type explainAnalyzeStreamSession interface {
	StreamQueryContext(ctx context.Context, query string, consumer db.QueryStreamConsumer) error
}

// explainDrainConsumer reads a result to the end and keeps nothing.
type explainDrainConsumer struct {
	rows int64
}

func (consumer *explainDrainConsumer) SetColumns([]string) error { return nil }

func (consumer *explainDrainConsumer) ConsumeRow(map[string]interface{}) error {
	consumer.rows++
	return nil
}

func (a *App) executeOracleExplainAnalyze(
	ctx context.Context,
	dbInst db.Database,
	query string,
	sql string,
	timeout time.Duration,
) (connection.ExplainResult, string, error) {
	text := a.appText
	session, querySession, closeSession, err := openExplainAnalyzeSession(ctx, dbInst, "oracle", text)
	if err != nil {
		return connection.ExplainResult{}, sql, err
	}
	defer closeSession()
	streamer, ok := session.(explainAnalyzeStreamSession)
	if !ok {
		return connection.ExplainResult{}, sql, fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_unsupported", map[string]any{"dbType": "oracle"}))
	}
	defer finishOracleExplainAnalyzeSession(dbInst, session)

	if _, err := session.ExecContext(ctx, "ALTER SESSION SET STATISTICS_LEVEL = ALL"); err != nil {
		return connection.ExplainResult{}, sql, explainAnalyzeError(ctx, "oracle", timeout, err, text)
	}
	if err := streamer.StreamQueryContext(ctx, sql, &explainDrainConsumer{}); err != nil {
		return connection.ExplainResult{}, sql, explainAnalyzeError(ctx, "oracle", timeout, err, text)
	}
	rows, columns, err := querySession.QueryContext(ctx, oracleDisplayCursorQuery)
	if err != nil {
		return connection.ExplainResult{}, sql, explainAnalyzeError(ctx, "oracle", timeout, err, text)
	}

	raw, format, err := collectExplainRawWithText([]connection.ResultSetData{{Rows: rows, Columns: columns}}, connection.ExplainFormatTable, text)
	if err != nil {
		return connection.ExplainResult{}, sql, err
	}
	if strings.Contains(strings.ToLower(raw), "no select privilege") {
		// DBMS_XPLAN reports missing V$ privileges as plan text, not as an error.
		return connection.ExplainResult{}, sql, fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_oracle_privileges", nil))
	}
	result, err := parseExplainRawWithText("oracle", query, raw, format, text)
	if err != nil {
		return connection.ExplainResult{}, sql, err
	}
	if !explainPlanHasActuals(result) {
		// The reason is usually in the Note section at the end of the output.
		logger.Warnf("Oracle 实测未取到实际执行统计：%s", oracleDisplayCursorTail(raw))
		return connection.ExplainResult{}, sql, fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_statistics_missing", nil))
	}
	annotateExplainActuals(&result)
	return result, sql, nil
}

// finishOracleExplainAnalyzeSession ends the transaction and drops
// the connection, so the raised statistics level never reaches the pool.
func finishOracleExplainAnalyzeSession(dbInst db.Database, session db.StatementExecer) {
	if err := runPinnedExplainCleanup(session, "oracle", []string{"ROLLBACK"}); err != nil {
		logger.Warnf("Oracle 实测回滚失败：err=%v", err)
	}
	if discarder, ok := session.(db.StatementExecerDiscarter); ok {
		if err := discarder.Discard(); err == nil {
			return
		}
	}
	cleanupPinnedExplainSession(dbInst, session, "oracle", []string{"ALTER SESSION SET STATISTICS_LEVEL = TYPICAL"})
}

func explainPlanHasActuals(result connection.ExplainResult) bool {
	for _, node := range result.Nodes {
		if node.Loops > 0 {
			return true
		}
	}
	return false
}

// oracleDisplayCursorTail keeps the end of DBMS_XPLAN output for the log,
// literals redacted.
func oracleDisplayCursorTail(raw string) string {
	runes := []rune(strings.TrimSpace(sqlaudit.RedactSQL(raw)))
	const keep = 2000
	if len(runes) <= keep {
		return string(runes)
	}
	return "..." + string(runes[len(runes)-keep:])
}
