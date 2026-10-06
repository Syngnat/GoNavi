package app

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

// 执行计划实测模式：真实执行一次查询，拿到每一步的实际耗时与行数。
//
// 安全边界（查询已通过 isSafeExplainQuery 的单条只读 SELECT/WITH 校验）：
//   - 在固定会话上开只读事务执行，结束后无论成败都回滚，挡住函数里的写入；
//   - 受连接的诊断超时限制；MySQL 系超时后用 KILL QUERY 停掉服务端仍在跑的语句
//     （驱动取消只会断开连接，服务端不会立即停止）；PostgreSQL 驱动取消即发送 cancel 请求。

const explainAnalyzeAuditSource = "sql_analysis"

type explainAnalyzeSpec struct {
	begin   string
	explain string
	format  connection.ExplainFormat
	// mysqlFamily: identify the session so a timed-out statement can be killed,
	// and tell MariaDB servers behind a "mysql" connection apart.
	mysqlFamily bool
}

var (
	mysqlExplainAnalyzeSpec = explainAnalyzeSpec{
		begin:       "START TRANSACTION READ ONLY",
		explain:     "EXPLAIN ANALYZE %s",
		format:      connection.ExplainFormatText,
		mysqlFamily: true,
	}
	mariaDBExplainAnalyzeSpec = explainAnalyzeSpec{
		begin:       "START TRANSACTION READ ONLY",
		explain:     "ANALYZE FORMAT=JSON %s",
		format:      connection.ExplainFormatJSON,
		mysqlFamily: true,
	}
	postgresExplainAnalyzeSpec = explainAnalyzeSpec{
		begin:   "BEGIN READ ONLY",
		explain: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) %s",
		format:  connection.ExplainFormatJSON,
	}
)

func explainAnalyzeSpecFor(dbType string) (explainAnalyzeSpec, bool) {
	switch dbType {
	case "mysql":
		return mysqlExplainAnalyzeSpec, true
	case "mariadb":
		return mariaDBExplainAnalyzeSpec, true
	case "postgres", "kingbase", "highgo", "vastbase":
		return postgresExplainAnalyzeSpec, true
	default:
		return explainAnalyzeSpec{}, false
	}
}

// explainAnalyzeSupported reports whether the measured mode can run on dbType.
// SQL Server and Oracle measure the query itself rather than wrapping it in an
// EXPLAIN statement, see explain_analyze_sqlserver.go / explain_analyze_oracle.go.
func explainAnalyzeSupported(dbType string) bool {
	if _, ok := explainAnalyzeSpecFor(dbType); ok {
		return true
	}
	return dbType == "sqlserver" || dbType == "oracle"
}

// explainAnalyzeSupportedFor also rules out OceanBase's Oracle mode, which the
// plan dialects treat as Oracle but which has no Oracle cursor statistics.
func explainAnalyzeSupportedFor(config connection.ConnectionConfig, dbType string) bool {
	if dbType == "oracle" && !strings.EqualFold(strings.TrimSpace(config.Type), "oracle") {
		return false
	}
	return explainAnalyzeSupported(dbType)
}

// executeExplainAnalyzeContext returns the measured plan and the statement it
// executed (for the audit trail).
func (a *App) executeExplainAnalyzeContext(
	parent context.Context,
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbType string,
	query string,
) (connection.ExplainResult, string, error) {
	text := a.appText
	sql := strings.TrimRight(strings.TrimSpace(query), ";")
	timeout := getDiagnoseTimeout(config)
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	switch dbType {
	case "sqlserver":
		return a.executeSQLServerExplainAnalyze(ctx, dbInst, query, sql, timeout)
	case "oracle":
		return a.executeOracleExplainAnalyze(ctx, dbInst, query, sql, timeout)
	}
	spec, ok := explainAnalyzeSpecFor(dbType)
	if !ok {
		return connection.ExplainResult{}, "", fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_unsupported", map[string]any{"dbType": dbType}))
	}
	statement := fmt.Sprintf(spec.explain, sql)
	session, querySession, closeSession, err := openExplainAnalyzeSession(ctx, dbInst, dbType, text)
	if err != nil {
		return connection.ExplainResult{}, statement, err
	}
	defer closeSession()

	parseType := dbType
	stopKill := func() bool { return true }
	if spec.mysqlFamily {
		connectionID, version := mysqlSessionIdentity(ctx, querySession)
		if dbType == "mysql" && strings.Contains(strings.ToLower(version), "mariadb") {
			spec, parseType = mariaDBExplainAnalyzeSpec, "mariadb"
			statement = fmt.Sprintf(spec.explain, sql)
		}
		if connectionID > 0 {
			stopKill = context.AfterFunc(ctx, func() { killExplainAnalyzeQuery(dbInst, dbType, connectionID) })
		}
	}
	defer stopKill()

	if _, err := session.ExecContext(ctx, spec.begin); err != nil {
		return connection.ExplainResult{}, statement, err
	}
	rows, columns, queryErr := querySession.QueryContext(ctx, statement)
	killed := !stopKill()
	finishExplainAnalyzeSession(dbInst, session, dbType, killed)
	if queryErr != nil {
		return connection.ExplainResult{}, statement, explainAnalyzeError(ctx, dbType, timeout, queryErr, text)
	}

	raw, format, err := collectExplainRawWithText([]connection.ResultSetData{{Rows: rows, Columns: columns}}, spec.format, text)
	if err != nil {
		return connection.ExplainResult{}, statement, err
	}
	result, err := parseExplainRawWithText(parseType, query, raw, format, text)
	if err != nil {
		return connection.ExplainResult{}, statement, err
	}
	annotateExplainActuals(&result)
	return result, statement, nil
}

// openExplainAnalyzeSession pins one physical connection: the measured run, its
// transaction and the statements that read the plan back must share it.
func openExplainAnalyzeSession(
	ctx context.Context,
	dbInst db.Database,
	dbType string,
	text explainText,
) (db.StatementExecer, db.StatementQueryExecer, func(), error) {
	unsupported := fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_unsupported", map[string]any{"dbType": dbType}))
	provider, ok := dbInst.(db.SessionExecerProvider)
	if !ok || !runtimeSupportsSessionExecer(dbInst) {
		return nil, nil, nil, unsupported
	}
	session, err := provider.OpenSessionExecer(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	closeSession := func() {
		if closeErr := session.Close(); closeErr != nil {
			logger.Warnf("实测会话关闭失败：type=%s err=%v", dbType, closeErr)
		}
	}
	querySession, ok := session.(db.StatementQueryExecer)
	if !ok {
		closeSession()
		return nil, nil, nil, unsupported
	}
	return session, querySession, closeSession, nil
}

// mysqlSessionIdentity reads the pinned connection's id (for KILL QUERY) and
// the server version; failures only disable those extras.
func mysqlSessionIdentity(ctx context.Context, session db.StatementQueryExecer) (int64, string) {
	rows, _, err := session.QueryContext(ctx, "SELECT CONNECTION_ID() AS gonavi_connection_id, VERSION() AS gonavi_version")
	if err != nil || len(rows) == 0 {
		return 0, ""
	}
	id, _ := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(rows[0]["gonavi_connection_id"])), 10, 64)
	return id, fmt.Sprint(rows[0]["gonavi_version"])
}

// killExplainAnalyzeQuery stops a timed-out statement on the server from
// another pooled connection.
func killExplainAnalyzeQuery(dbInst db.Database, dbType string, connectionID int64) {
	killCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	statement := fmt.Sprintf("KILL QUERY %d", connectionID)
	var err error
	if execer, ok := dbInst.(interface {
		ExecContext(context.Context, string) (int64, error)
	}); ok {
		_, err = execer.ExecContext(killCtx, statement)
	} else {
		_, err = dbInst.Exec(statement)
	}
	if err != nil {
		logger.Warnf("实测超时后停止服务端语句失败：type=%s id=%d err=%v", dbType, connectionID, err)
		return
	}
	logger.Infof("实测超时，已停止服务端语句：type=%s id=%d", dbType, connectionID)
}

// finishExplainAnalyzeSession rolls the read-only transaction back. A session
// whose statement was killed is never handed back to the pool.
func finishExplainAnalyzeSession(dbInst db.Database, session db.StatementExecer, dbType string, killed bool) {
	if killed {
		if discarder, ok := session.(db.StatementExecerDiscarter); ok {
			if err := discarder.Discard(); err == nil {
				return
			}
		}
	}
	cleanupPinnedExplainSession(dbInst, session, dbType, []string{"ROLLBACK"})
}

func explainAnalyzeError(ctx context.Context, dbType string, timeout time.Duration, err error, text explainText) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_timeout", map[string]any{"seconds": int(timeout.Seconds())}))
	}
	message := err.Error()
	if dbType == "mysql" && strings.Contains(message, "1064") && strings.Contains(strings.ToUpper(message), "ANALYZE") {
		return fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_server_unsupported", nil))
	}
	return fmt.Errorf("%s", text("sql_analysis.backend.error.analyze_failed", map[string]any{"detail": message}))
}
