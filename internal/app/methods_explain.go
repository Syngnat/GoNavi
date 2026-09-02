package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/shared/i18n"
)

// SQL 诊断工作台后端入口。
//
// 数据流：
//   用户 SQL
//     → DiagnoseQuery（白名单校验 + 调度）
//     → executeExplain（决定走 ExplainExecer 还是 fallback 包装）
//     → buildExplainQuery（方言特定的 EXPLAIN 语句构造）
//     → dbInst.QueryMultiContextWithMessages（实际执行）
//     → collectExplainRaw（合并结果集为原文）
//     → parseExplainRaw（路由到方言解析器）
//     → ExplainResult（归一化节点树 + Stats）
//
// 解析器实现在 explain_parse_<dbtype>.go。

// explainSupportedDBTypes 是一期支持的 EXPLAIN 数据源白名单。
// 不在白名单内的数据源（MongoDB/Redis/TDengine 等）调用 DiagnoseQuery 时直接返回不支持。
var explainSupportedDBTypes = map[string]bool{
	"mysql":      true,
	"mariadb":    true,
	"diros":      true, // Doris 走 MySQL 协议，EXPLAIN 语法兼容
	"starrocks":  true, // 同上
	"postgres":   true,
	"gaussdb":    true,
	"opengauss":  true,
	"kingbase":   true,
	"highgo":     true,
	"vastbase":   true,
	"sqlite":     true,
	"clickhouse": true,
	"oracle":     true, // 含 OceanBase Oracle 协议（resolveDDLDBType 已归一化）
	"sqlserver":  true,
	"oceanbase":  true, // MySQL 协议走 MySQL 语法
}

// defaultExplainStatementTimeout 是未配置连接超时时的诊断上限。
// 默认诊断只生成计划、不实际执行原查询，因此无需沿用长查询执行超时。
const defaultExplainStatementTimeout = time.Minute

func defaultExplainBackendText(key string, params map[string]any) string {
	localizer, err := i18n.NewLocalizer(i18n.LanguageZhCN)
	if err != nil {
		return key
	}
	return localizer.T(key, params)
}

// DiagnoseQuery 是 SQL 诊断工作台对外暴露的入口。
// 输入用户 SQL（仅允许 SELECT/WITH），返回执行计划归一化结果。
// PR1 仅返回 ExplainResult；索引建议（Suggestions）在 PR2 规则引擎接入后填充。
//
// Wails 绑定：前端通过 DiagnoseQuery(config, dbName, sql) 调用，返回 QueryResult.Data 为 DiagnoseReport。
func (a *App) DiagnoseQuery(config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
	return a.diagnoseQueryContext(context.Background(), config, dbName, query)
}

func (a *App) diagnoseQueryContext(ctx context.Context, config connection.ConnectionConfig, dbName, query string) connection.QueryResult {
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
	dbType := resolveDDLDBType(runConfig)
	if !isSafeExplainQuery(dbType, query) {
		return connection.QueryResult{Success: false, Message: a.appText("sql_analysis.backend.error.select_only", nil)}
	}
	if !explainSupportedDBTypes[dbType] {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("sql_analysis.backend.error.unsupported_db_type", map[string]any{"dbType": dbType}),
		}
	}

	dbInst, err := a.getDatabaseSynchronouslyWithContext(ctx, runConfig, false)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	plan, err := a.executeExplainContext(ctx, dbInst, runConfig, dbType, query)
	if err != nil {
		logger.Warnf("DiagnoseQuery 执行 EXPLAIN 失败：type=%s err=%v sql=%q", dbType, err, sqlSnippet(query))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	suggestions := runExplainRules(plan)
	report := connection.DiagnoseReport{Plan: plan, Suggestions: suggestions}
	logger.Infof("DiagnoseQuery 完成：type=%s nodes=%d suggestions=%d", dbType, len(plan.Nodes), len(suggestions))
	return connection.QueryResult{Success: true, Message: a.appText("sql_analysis.backend.message.completed", nil), Data: report}
}

// isSafeExplainQuery 只允许单条只读 SELECT/WITH。
// 除了阻止数据修改 CTE 和 SELECT INTO，也避免在 EXPLAIN 包装后拼入第二条语句。
func isSafeExplainQuery(dbType, query string) bool {
	if hasExecutableSQLComment(dbType, query) || !hasSafeExplainStatementDelimiter(dbType, query) {
		return false
	}
	statements := splitSQLStatementsForDialect(dbType, query)
	statement := ""
	for _, candidate := range statements {
		trimmed := strings.TrimSpace(trimLeadingSQLComments(candidate))
		if trimmed == "" {
			continue
		}
		if statement != "" {
			return false
		}
		statement = trimmed
	}
	if statement == "" {
		return false
	}
	return looksLikeSelectOrWith(statement) && isReadOnlySQLQuery(dbType, statement)
}

// hasSafeExplainStatementDelimiter is a defense-in-depth boundary around the
// dialect tokenizer. A diagnostic query may contain no semicolon, or one final
// delimiter followed only by dialect-valid comments/whitespace. Semicolons in
// literals/comments intentionally fail closed because server modes such as
// MySQL NO_BACKSLASH_ESCAPES and PostgreSQL standard_conforming_strings can
// change how an otherwise plausible client-side tokenizer sees quote endings.
func hasSafeExplainStatementDelimiter(dbType, query string) bool {
	asciiCount := strings.Count(query, ";")
	fullWidthCount := strings.Count(query, "；")
	if asciiCount+fullWidthCount == 0 {
		return true
	}
	if asciiCount+fullWidthCount != 1 {
		return false
	}

	if asciiCount == 1 {
		index := strings.IndexByte(query, ';')
		return containsOnlyTrailingExplainTrivia(dbType, query[index+1:])
	}
	index := strings.Index(query, "；")
	return containsOnlyTrailingExplainTrivia(dbType, query[index+len("；"):])
}

func containsOnlyTrailingExplainTrivia(dbType, text string) bool {
	for index := 0; index < len(text); {
		switch {
		case isExplainWhitespace(text[index]):
			index++
		case strings.HasPrefix(text[index:], "--") && isSQLDashLineCommentStart(dbType, text, index):
			index = skipMySQLLineComment(text, index+2)
		case text[index] == '#' && supportsSQLHashLineComment(dbType):
			index = skipMySQLLineComment(text, index+1)
		case strings.HasPrefix(text[index:], "/*"):
			end := strings.Index(text[index+2:], "*/")
			if end < 0 {
				return false
			}
			index += end + 4
		default:
			return false
		}
	}
	return true
}

func isExplainWhitespace(ch byte) bool {
	switch ch {
	case ' ', '\t', '\n', '\r', '\f', '\v':
		return true
	default:
		return false
	}
}

// hasExecutableSQLComment detects MySQL/MariaDB version comments. Unlike ordinary
// block comments, servers may execute their contents, so the generic SQL parser
// must not discard them while deciding whether a diagnostic query is read-only.
func hasExecutableSQLComment(dbType, query string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks":
	default:
		return false
	}

	for index := 0; index < len(query); {
		remaining := query[index:]
		if strings.HasPrefix(remaining, "/*!") ||
			(len(remaining) >= 4 && strings.EqualFold(remaining[:4], "/*m!")) {
			return true
		}
		switch {
		case query[index] == '\'' || query[index] == '"' || query[index] == '`':
			index = skipMySQLQuotedText(query, index, query[index])
		case query[index] == '#':
			index = skipMySQLLineComment(query, index+1)
		case strings.HasPrefix(remaining, "--") && isMySQLDashCommentStart(query, index):
			index = skipMySQLLineComment(query, index+2)
		case strings.HasPrefix(remaining, "/*"):
			if end := strings.Index(remaining[2:], "*/"); end >= 0 {
				index += end + 4
			} else {
				index = len(query)
			}
		default:
			index++
		}
	}
	return false
}

func isMySQLDashCommentStart(query string, index int) bool {
	third := index + 2
	return third >= len(query) || query[third] <= ' '
}

func skipMySQLLineComment(query string, index int) int {
	for index < len(query) && query[index] != '\n' && query[index] != '\r' {
		index++
	}
	return index
}

func skipMySQLQuotedText(query string, start int, quote byte) int {
	for index := start + 1; index < len(query); index++ {
		if query[index] == '\\' && index+1 < len(query) {
			index++
			continue
		}
		if query[index] != quote {
			continue
		}
		if index+1 < len(query) && query[index+1] == quote {
			index++
			continue
		}
		return index + 1
	}
	return len(query)
}

// executeExplain 决定走哪条 EXPLAIN 执行路径：
//  1. 若 dbInst 实现 ExplainExecer（driver-agent 在 PR2 接入），优先用驱动原生实现
//  2. 否则走 app 层 fallback：buildExplainQuery 构造 EXPLAIN 语句，通过 QueryMulti 执行
func (a *App) executeExplain(dbInst db.Database, config connection.ConnectionConfig, dbType, query string) (connection.ExplainResult, error) {
	return a.executeExplainContext(context.Background(), dbInst, config, dbType, query)
}

func (a *App) executeExplainContext(parent context.Context, dbInst db.Database, config connection.ConnectionConfig, dbType, query string) (connection.ExplainResult, error) {
	text := a.appText
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	if timeout := getDiagnoseTimeout(config); timeout > 0 {
		var cancelFn context.CancelFunc
		ctx, cancelFn = context.WithTimeout(parent, timeout)
		defer cancelFn()
	}

	// 优先：驱动自带 Explain（OceanBase driver-agent 走此路径）
	if explainer, ok := dbInst.(db.ExplainExecer); ok {
		logger.Infof("DiagnoseQuery 走 ExplainExecer 路径：type=%s", dbType)
		raw, format, err := explainer.Explain(ctx, query)
		if err != nil {
			return connection.ExplainResult{}, fmt.Errorf("%s", text("sql_analysis.backend.error.driver_explain_failed", map[string]any{"detail": err.Error()}))
		}
		return parseExplainRawWithText(dbType, query, raw, format, text)
	}

	// Oracle 的 PLAN_TABLE 与 SQL Server 的 SHOWPLAN_XML 都依赖会话状态，
	// 必须在同一物理连接上分批执行，不能拼成一个 batch 或回到连接池执行清理。
	if requiresPinnedExplainSession(dbType) {
		raw, format, err := executePinnedExplainStatements(ctx, dbInst, dbType, query, text)
		if err != nil {
			return connection.ExplainResult{}, fmt.Errorf("%s", text("sql_analysis.backend.error.explain_execution_failed", map[string]any{"detail": err.Error()}))
		}
		return parseExplainRawWithText(dbType, query, raw, format, text)
	}

	// Fallback：app 层构造 EXPLAIN 语句
	wrappedSQL, postQueries, preferFormat, cleanupQueries, err := buildExplainQueryWithText(dbType, query, text)
	if err != nil {
		return connection.ExplainResult{}, err
	}
	defer runExplainCleanup(dbInst, cleanupQueries)

	raw, actualFormat, execErr := executeExplainStatementsWithText(ctx, dbInst, dbType, wrappedSQL, postQueries, preferFormat, text)
	if execErr != nil {
		return connection.ExplainResult{}, fmt.Errorf("%s", text("sql_analysis.backend.error.explain_execution_failed", map[string]any{"detail": execErr.Error()}))
	}
	return parseExplainRawWithText(dbType, query, raw, actualFormat, text)
}

func requiresPinnedExplainSession(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "oracle", "sqlserver":
		return true
	default:
		return false
	}
}

// executePinnedExplainStatements executes session-scoped plan commands one batch
// at a time. SQL Server requires SHOWPLAN_XML ON/OFF to be the only statement in
// their batches; Oracle must read and clean the same PLAN_TABLE transaction.
func executePinnedExplainStatements(
	ctx context.Context,
	dbInst db.Database,
	dbType string,
	query string,
	text func(string, map[string]any) string,
) (string, connection.ExplainFormat, error) {
	if text == nil {
		text = defaultExplainBackendText
	}
	provider, ok := dbInst.(db.SessionExecerProvider)
	if !ok {
		return "", "", fmt.Errorf("%s", text("sql_analysis.backend.error.explain_query_not_implemented", map[string]any{"dbType": dbType}))
	}
	session, err := provider.OpenSessionExecer(ctx)
	if err != nil {
		return "", "", err
	}
	defer func() {
		if closeErr := session.Close(); closeErr != nil {
			logger.Warnf("EXPLAIN 会话关闭失败：type=%s err=%v", dbType, closeErr)
		}
	}()

	querySession, ok := session.(db.StatementQueryExecer)
	if !ok {
		return "", "", fmt.Errorf("%s", text("sql_analysis.backend.error.explain_query_not_implemented", map[string]any{"dbType": dbType}))
	}

	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "sqlserver":
		if _, err := session.ExecContext(ctx, "SET SHOWPLAN_XML ON"); err != nil {
			return "", "", err
		}
		defer cleanupPinnedExplainSession(dbInst, session, dbType, []string{"SET SHOWPLAN_XML OFF"})
		rows, columns, err := querySession.QueryContext(ctx, strings.TrimRight(strings.TrimSpace(query), ";"))
		if err != nil {
			return "", "", err
		}
		return collectExplainRawWithText(
			[]connection.ResultSetData{{Rows: rows, Columns: columns}},
			connection.ExplainFormatXML,
			text,
		)

	case "oracle":
		wrappedSQL, postQueries, preferFormat, cleanupQueries, err := buildExplainQueryWithText(dbType, query, text)
		if err != nil {
			return "", "", err
		}
		defer cleanupPinnedExplainSession(dbInst, session, dbType, cleanupQueries)
		if _, err := session.ExecContext(ctx, wrappedSQL); err != nil {
			return "", "", err
		}
		results := make([]connection.ResultSetData, 0, len(postQueries))
		for _, postQuery := range postQueries {
			rows, columns, err := querySession.QueryContext(ctx, postQuery)
			if err != nil {
				return "", "", err
			}
			results = append(results, connection.ResultSetData{Rows: rows, Columns: columns})
		}
		return collectExplainRawWithText(results, preferFormat, text)
	default:
		return "", "", fmt.Errorf("%s", text("sql_analysis.backend.error.explain_query_not_implemented", map[string]any{"dbType": dbType}))
	}
}

func cleanupPinnedExplainSession(dbInst db.Database, session db.StatementExecer, dbType string, queries []string) {
	if err := runPinnedExplainCleanup(session, dbType, queries); err == nil {
		return
	}
	if discarder, ok := session.(db.StatementExecerDiscarter); ok {
		if err := discarder.Discard(); err == nil {
			return
		} else {
			logger.Warnf("EXPLAIN 污染会话淘汰失败：type=%s err=%v", dbType, err)
		}
	}
	// Unknown session wrappers may return a physical connection to the pool on
	// Close. Closing the owning pool is the only safe fallback after cleanup
	// failure; the app connection cache will recreate it on the next query.
	if err := dbInst.Close(); err != nil {
		logger.Warnf("EXPLAIN 清理失败后关闭连接池失败：type=%s err=%v", dbType, err)
	}
}

func runPinnedExplainCleanup(session db.StatementExecer, dbType string, queries []string) error {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var firstErr error
	for _, query := range queries {
		if strings.TrimSpace(query) == "" {
			continue
		}
		if _, err := session.ExecContext(cleanupCtx, query); err != nil {
			logger.Warnf("EXPLAIN 会话清理失败：type=%s sql=%q err=%v", dbType, sqlSnippet(query), err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// runExplainCleanup 执行清理语句（如 Oracle DELETE FROM plan_table），失败仅记日志不阻塞主流程。
// 在 defer 中调用，确保主 EXPLAIN 失败时也能尝试清理。

func runExplainCleanup(dbInst db.Database, cleanupQueries []string) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, q := range cleanupQueries {
		if strings.TrimSpace(q) == "" {
			continue
		}
		var err error
		if execer, ok := dbInst.(interface {
			ExecContext(context.Context, string) (int64, error)
		}); ok {
			_, err = execer.ExecContext(cleanupCtx, q)
		} else {
			_, err = dbInst.Exec(q)
		}
		if err != nil {
			logger.Warnf("EXPLAIN 清理失败（可忽略）：sql=%q err=%v", sqlSnippet(q), err)
		}
	}
}

// executeExplainStatements 执行 EXPLAIN 主语句和后置查询（Oracle 的 DBMS_XPLAN.DISPLAY）。
// 返回拼接后的原文 + 实际格式（可能与 preferFormat 不同，比如 MySQL 5.7 不支持 FORMAT=JSON 时降级）。
func executeExplainStatements(ctx context.Context, dbInst db.Database, dbType, wrappedSQL string, postQueries []string, preferFormat connection.ExplainFormat) (string, connection.ExplainFormat, error) {
	return executeExplainStatementsWithText(ctx, dbInst, dbType, wrappedSQL, postQueries, preferFormat, defaultExplainBackendText)
}

func executeExplainStatementsWithText(ctx context.Context, dbInst db.Database, dbType, wrappedSQL string, postQueries []string, preferFormat connection.ExplainFormat, text func(string, map[string]any) string) (string, connection.ExplainFormat, error) {
	statements := []string{wrappedSQL}
	statements = append(statements, postQueries...)
	fullSQL := strings.Join(statements, ";\n")

	// 优先使用带 context 的多结果接口，便于取消
	if multi, ok := dbInst.(db.MultiResultQueryMessageExecer); ok {
		results, _, err := multi.QueryMultiContextWithMessages(ctx, fullSQL)
		if err != nil {
			return "", preferFormat, err
		}
		return collectExplainRawWithText(results, preferFormat, text)
	}
	if multi, ok := dbInst.(db.MultiResultQuerierContext); ok {
		results, err := multi.QueryMultiContext(ctx, fullSQL)
		if err != nil {
			return "", preferFormat, err
		}
		return collectExplainRawWithText(results, preferFormat, text)
	}
	if multi, ok := dbInst.(db.MultiResultQuerier); ok {
		if err := ctx.Err(); err != nil {
			return "", preferFormat, err
		}
		results, err := multi.QueryMulti(fullSQL)
		if err != nil {
			return "", preferFormat, err
		}
		if err := ctx.Err(); err != nil {
			return "", preferFormat, err
		}
		return collectExplainRawWithText(results, preferFormat, text)
	}

	// 单结果 fallback：只执行第一条 EXPLAIN，忽略 postQueries（不适合 Oracle/SQLServer）。
	// 优先走 context 接口，确保连接配置的诊断超时在单结果驱动上同样生效。
	var (
		data    []map[string]interface{}
		columns []string
		err     error
	)
	if queryWithMessages, ok := dbInst.(db.QueryMessageExecer); ok {
		data, columns, _, err = queryWithMessages.QueryContextWithMessages(ctx, wrappedSQL)
	} else if queryWithContext, ok := dbInst.(interface {
		QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
	}); ok {
		data, columns, err = queryWithContext.QueryContext(ctx, wrappedSQL)
	} else {
		if err := ctx.Err(); err != nil {
			return "", preferFormat, err
		}
		data, columns, err = dbInst.Query(wrappedSQL)
		if err == nil {
			err = ctx.Err()
		}
	}
	if err != nil {
		return "", preferFormat, err
	}
	return collectExplainRawWithText([]connection.ResultSetData{{Rows: data, Columns: columns}}, preferFormat, text)
}

// collectExplainRaw 把多个结果集合并为单个原文，并探测实际格式。
// MySQL FORMAT=JSON 返回 1 行 1 列包含完整 JSON 文本；表格模式返回多行多列。
func collectExplainRaw(results []connection.ResultSetData, preferFormat connection.ExplainFormat) (string, connection.ExplainFormat, error) {
	return collectExplainRawWithText(results, preferFormat, defaultExplainBackendText)
}

func collectExplainRawWithText(results []connection.ResultSetData, preferFormat connection.ExplainFormat, text func(string, map[string]any) string) (string, connection.ExplainFormat, error) {
	if text == nil {
		text = defaultExplainBackendText
	}
	if len(results) == 0 {
		return "", preferFormat, fmt.Errorf("%s", text("sql_analysis.backend.error.explain_result_missing", nil))
	}

	// 大多数方言只有 1 个结果集；Oracle 有 2 个（EXPLAIN PLAN 影响 + DBMS_XPLAN.DISPLAY 查询）
	// 取最后一个非空结果集作为 EXPLAIN 输出（DISPLAY 在 post 查询中）
	last := pickLastNonEmptyResult(results)
	if last == nil {
		return "", preferFormat, fmt.Errorf("%s", text("sql_analysis.backend.error.explain_result_empty", nil))
	}

	// 单列单行 + 值是 JSON/XML 字符串 → 直接当原文
	if len(last.Columns) == 1 && len(last.Rows) == 1 {
		for _, v := range last.Rows[0] {
			text := strings.TrimSpace(fmt.Sprintf("%v", v))
			if text != "" && text != "<nil>" {
				return text, detectExplainFormat(text, preferFormat), nil
			}
		}
	}

	// 表格模式：把行重组成 TSV，解析器按列定位
	var builder strings.Builder
	builder.WriteString(strings.Join(last.Columns, "\t"))
	builder.WriteByte('\n')
	for _, row := range last.Rows {
		values := make([]string, 0, len(last.Columns))
		for _, col := range last.Columns {
			val := row[col]
			if val == nil {
				values = append(values, "")
				continue
			}
			values = append(values, fmt.Sprintf("%v", val))
		}
		builder.WriteString(strings.Join(values, "\t"))
		builder.WriteByte('\n')
	}
	return builder.String(), connection.ExplainFormatTable, nil
}

// pickLastNonEmptyResult 找最后一个有行数据的结果集（Oracle 的 EXPLAIN PLAN 影响 0 行，DISPLAY 才有数据）。
func pickLastNonEmptyResult(results []connection.ResultSetData) *connection.ResultSetData {
	for i := len(results) - 1; i >= 0; i-- {
		r := results[i]
		if len(r.Rows) > 0 {
			return &r
		}
	}
	return nil
}

// detectExplainFormat 探测原文实际格式（当驱动返回的是单字符串时）。
// 优先信任 preferFormat；不可识别时按内容启发式判断。
func detectExplainFormat(text string, preferFormat connection.ExplainFormat) connection.ExplainFormat {
	trimmed := strings.TrimLeft(text, " \t\r\n")
	switch {
	case strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "["):
		return connection.ExplainFormatJSON
	case strings.HasPrefix(trimmed, "<?xml") || strings.HasPrefix(trimmed, "<"):
		return connection.ExplainFormatXML
	case preferFormat != "":
		return preferFormat
	default:
		return connection.ExplainFormatText
	}
}

// parseExplainRaw 是方言解析器的总路由。
// 每方言在 explain_parse_<dbtype>.go 中实现 parseXxxExplain，这里按 dbType 分发。
// 未实现的方言返回原文 + 警告，保证主流程不阻塞。
func parseExplainRaw(dbType, sourceSQL, raw string, format connection.ExplainFormat) (connection.ExplainResult, error) {
	return parseExplainRawWithText(dbType, sourceSQL, raw, format, defaultExplainBackendText)
}

func parseExplainRawWithText(dbType, sourceSQL, raw string, format connection.ExplainFormat, text func(string, map[string]any) string) (connection.ExplainResult, error) {
	if text == nil {
		text = defaultExplainBackendText
	}
	switch dbType {
	case "mysql", "mariadb", "oceanbase":
		return parseMySQLExplain(dbType, sourceSQL, raw, format)
	case "diros", "starrocks":
		return parseDistributedMySQLTextExplain(dbType, sourceSQL, raw, format), nil
	case "postgres", "gaussdb", "opengauss", "kingbase", "highgo", "vastbase":
		return parsePostgresExplain(dbType, sourceSQL, raw, format)
	case "sqlite":
		return parseSQLiteExplain(sourceSQL, raw, format)
	case "clickhouse":
		return parseClickHouseExplain(sourceSQL, raw, format)
	case "oracle":
		return parseOracleExplain(sourceSQL, raw, format)
	case "sqlserver":
		return parseSQLServerExplain(sourceSQL, raw, format)
	default:
		return connection.ExplainResult{}, fmt.Errorf("%s", text("sql_analysis.backend.error.explain_dialect_unsupported", map[string]any{"dbType": dbType}))
	}
}

// getDiagnoseTimeout 取诊断超时：尊重连接配置，否则使用安全的默认上限。
func getDiagnoseTimeout(config connection.ConnectionConfig) time.Duration {
	if config.Timeout > 0 {
		return time.Duration(config.Timeout) * time.Second
	}
	return defaultExplainStatementTimeout
}

// buildExplainQuery 按方言构造 EXPLAIN 语句。
// 返回：
//   - wrappedSQL：主 EXPLAIN 语句（可能含 prelude 如 SQLServer 的 SET SHOWPLAN_XML ON）
//   - postQueries：后置查询（如 Oracle 的 SELECT ... FROM DBMS_XPLAN.DISPLAY）
//   - preferFormat：期望的输出格式（用于解析器调度；实际格式由 collectExplainRaw 探测后确定）
//   - cleanupQueries：清理语句（Oracle DELETE FROM plan_table），defer 中执行
//   - err：方言不支持时返回
//
// 参考现有风格：buildListViewQueries (methods_file.go:3102) 的 switch-case 模式。
func buildExplainQuery(dbType, query string) (wrappedSQL string, postQueries []string, preferFormat connection.ExplainFormat, cleanupQueries []string, err error) {
	return buildExplainQueryWithText(dbType, query, defaultExplainBackendText)
}

func buildExplainQueryWithText(dbType, query string, text func(string, map[string]any) string) (wrappedSQL string, postQueries []string, preferFormat connection.ExplainFormat, cleanupQueries []string, err error) {
	if text == nil {
		text = defaultExplainBackendText
	}
	sql := strings.TrimRight(strings.TrimSpace(query), ";")
	switch dbType {
	case "mysql", "mariadb", "oceanbase":
		// MySQL 8.0+ 和 OceanBase 都支持 FORMAT=JSON
		// 5.7 在 collectExplainRaw 阶段会拿到语法错误，由调用方降级处理（PR2 加重试逻辑）
		return fmt.Sprintf("EXPLAIN FORMAT=JSON %s", sql), nil, connection.ExplainFormatJSON, nil, nil
	case "diros", "starrocks":
		// Doris/StarRocks 不支持 FORMAT=JSON，使用原生 EXPLAIN（返回表格 + 一些文本块）
		return fmt.Sprintf("EXPLAIN %s", sql), nil, connection.ExplainFormatTable, nil, nil
	case "postgres", "gaussdb", "opengauss", "kingbase", "highgo", "vastbase":
		// 默认仅生成估算计划。ANALYZE 会真实执行原查询，不适合作为一次点击即可触发的默认行为。
		return fmt.Sprintf("EXPLAIN (FORMAT JSON) %s", sql), nil, connection.ExplainFormatJSON, nil, nil
	case "sqlite":
		return fmt.Sprintf("EXPLAIN QUERY PLAN %s", sql), nil, connection.ExplainFormatTable, nil, nil
	case "clickhouse":
		// indexes=1 让 JSON 计划携带实际使用的索引及 parts/granules 裁剪信息，
		// 避免仅凭节点类型把正常的 MergeTree 读取误判为全表扫描。
		return fmt.Sprintf("EXPLAIN PLAN json = 1, description = 1, indexes = 1 %s", sql), nil, connection.ExplainFormatJSON, nil, nil
	case "oracle":
		// OceanBase Oracle 协议也走此分支（resolveDDLDBType 已归一化）
		// 用 STATEMENT_ID 隔离，避免多用户共享 plan_table 时互相覆盖
		stmtID := fmt.Sprintf("gonavi_%d", time.Now().UnixNano())
		wrapped := fmt.Sprintf("EXPLAIN PLAN SET STATEMENT_ID = '%s' FOR %s", stmtID, sql)
		post := []string{
			fmt.Sprintf("SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, '%s', 'ALL'))", stmtID),
		}
		cleanup := []string{
			fmt.Sprintf("DELETE FROM plan_table WHERE statement_id = '%s'", stmtID),
		}
		return wrapped, post, connection.ExplainFormatTable, cleanup, nil
	case "sqlserver":
		// SET SHOWPLAN_XML ON 后整个会话只返回计划不执行；必须 SET OFF 清理，否则连接污染
		wrapped := fmt.Sprintf("SET SHOWPLAN_XML ON;\n%s", sql)
		post := []string{"SET SHOWPLAN_XML OFF;"}
		return wrapped, post, connection.ExplainFormatXML, nil, nil
	default:
		return "", nil, "", nil, fmt.Errorf("%s", text("sql_analysis.backend.error.explain_query_not_implemented", map[string]any{"dbType": dbType}))
	}
}
