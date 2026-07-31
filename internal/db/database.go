package db

import (
	"GoNavi-Wails/internal/connection"
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
)

// Database 定义了统一的数据源访问接口。
// 所有数据库驱动（MySQL、PostgreSQL、Oracle 等）均需实现此接口。
// 方法调用方可通过 NewDatabase 工厂函数获取对应驱动的实例。
type Database interface {
	// Connect 根据连接配置建立数据库连接。
	Connect(config connection.ConnectionConfig) error
	// Close 关闭数据库连接并释放底层资源。
	Close() error
	// Ping 测试连接是否仍然可用。
	Ping() error
	// Query 执行查询语句，返回结果行（列名→值映射）和列名列表。
	Query(query string) ([]map[string]interface{}, []string, error)
	// Exec 执行非查询语句（INSERT/UPDATE/DELETE 等），返回受影响行数。
	Exec(query string) (int64, error)
	// GetDatabases 返回当前连接可访问的数据库列表。
	GetDatabases() ([]string, error)
	// GetTables 返回指定数据库下的表列表。
	GetTables(dbName string) ([]string, error)
	// GetCreateStatement 返回指定表的建表 DDL 语句。
	GetCreateStatement(dbName, tableName string) (string, error)
	// GetColumns 返回指定表的列定义列表。
	GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error)
	// GetAllColumns 返回指定数据库下所有表的列定义（含表名标识）。
	GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error)
	// GetIndexes 返回指定表的索引定义列表。
	GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error)
	// GetForeignKeys 返回指定表的外键定义列表。
	GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error)
	// GetTriggers 返回指定表的触发器定义列表。
	GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error)
}

// DatabaseForeignKeyProvider is an optional metadata interface for drivers that
// can load a database-wide foreign-key snapshot more efficiently than one table
// at a time.
type DatabaseForeignKeyProvider interface {
	GetDatabaseForeignKeys(dbName string) (map[string][]connection.ForeignKeyDefinition, error)
}

// TableRowCounter is an optional metadata interface for drivers that can
// provide exact table row counts alongside a table list.
type TableRowCounter interface {
	GetTableRowCounts(dbName string, tables []string) (map[string]int64, error)
}

// TableStorageStatsProvider is an optional metadata interface for drivers that
// can report per-table data and index storage usage in bytes.
type TableStorageStatsProvider interface {
	GetTableStorageStats(dbName string, tables []string) (map[string]TableStorageStats, error)
}

type TableStorageStats struct {
	DataLength  int64
	IndexLength int64
}

func getSQLiteTableRowCounts(query func(string) ([]map[string]interface{}, []string, error), tables []string) (map[string]int64, error) {
	counts := make(map[string]int64, len(tables))
	var firstErr error
	for _, rawTableName := range tables {
		tableName := strings.TrimSpace(rawTableName)
		if tableName == "" {
			continue
		}
		escapedTableName := strings.ReplaceAll(tableName, `"`, `""`)
		data, _, err := query(fmt.Sprintf(`SELECT COUNT(*) AS table_rows FROM "%s"`, escapedTableName))
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("读取 SQLite 表 %q 行数失败: %w", tableName, err)
			}
			continue
		}
		if len(data) == 0 {
			continue
		}
		rawCount, ok := data[0]["table_rows"]
		if !ok {
			if firstErr == nil {
				firstErr = fmt.Errorf("读取 SQLite 表 %q 行数失败: 查询结果缺少 table_rows", tableName)
			}
			continue
		}
		count, err := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(rawCount)), 10, 64)
		if err != nil || count < 0 {
			if firstErr == nil {
				firstErr = fmt.Errorf("读取 SQLite 表 %q 行数失败: 无效行数 %v", tableName, rawCount)
			}
			continue
		}
		counts[tableName] = count
	}
	return counts, firstErr
}

func getSQLiteTableStorageStats(query func(string) ([]map[string]interface{}, []string, error), tables []string) (map[string]TableStorageStats, error) {
	requestedTables := make(map[string]struct{}, len(tables))
	for _, rawTableName := range tables {
		tableName := strings.TrimSpace(rawTableName)
		if tableName != "" {
			requestedTables[tableName] = struct{}{}
		}
	}
	if len(requestedTables) == 0 {
		return map[string]TableStorageStats{}, nil
	}

	data, _, err := query(`
WITH object_sizes AS (
    SELECT name, SUM(pgsize) AS bytes
    FROM dbstat
    GROUP BY name
), index_sizes AS (
    SELECT idx.tbl_name AS table_name, SUM(object_sizes.bytes) AS bytes
    FROM sqlite_master AS idx
    JOIN object_sizes ON object_sizes.name = idx.name
    WHERE idx.type = 'index'
    GROUP BY idx.tbl_name
)
SELECT
    tbl.name AS table_name,
    COALESCE(table_sizes.bytes, 0) AS data_length,
    COALESCE(index_sizes.bytes, 0) AS index_length
FROM sqlite_master AS tbl
LEFT JOIN object_sizes AS table_sizes ON table_sizes.name = tbl.name
LEFT JOIN index_sizes ON index_sizes.table_name = tbl.name
WHERE tbl.type = 'table'`)
	if err != nil {
		return map[string]TableStorageStats{}, fmt.Errorf("读取 SQLite 表存储大小失败: %w", err)
	}

	stats := make(map[string]TableStorageStats, len(data))
	for _, row := range data {
		tableName := strings.TrimSpace(fmt.Sprint(metadataRowValue(row, "table_name")))
		if tableName == "" {
			continue
		}
		if len(requestedTables) > 0 {
			if _, ok := requestedTables[tableName]; !ok {
				continue
			}
		}
		dataLength, dataErr := metadataInt64(row, "data_length")
		indexLength, indexErr := metadataInt64(row, "index_length")
		if dataErr != nil || indexErr != nil || dataLength < 0 || indexLength < 0 {
			return map[string]TableStorageStats{}, fmt.Errorf("读取 SQLite 表 %q 存储大小失败: data_length=%v index_length=%v", tableName, metadataRowValue(row, "data_length"), metadataRowValue(row, "index_length"))
		}
		stats[tableName] = TableStorageStats{DataLength: dataLength, IndexLength: indexLength}
	}
	return stats, nil
}

func metadataRowValue(row map[string]interface{}, key string) interface{} {
	for rowKey, value := range row {
		if strings.EqualFold(strings.TrimSpace(rowKey), key) {
			return value
		}
	}
	return nil
}

func metadataInt64(row map[string]interface{}, key string) (int64, error) {
	value := metadataRowValue(row, key)
	if value == nil {
		return 0, fmt.Errorf("查询结果缺少 %s", key)
	}
	return strconv.ParseInt(strings.TrimSpace(fmt.Sprint(value)), 10, 64)
}

// MultiResultQuerier 是可选接口，支持多结果集的驱动实现此接口。
// 执行可能包含多条 SQL 语句的查询，返回所有结果集。
type MultiResultQuerier interface {
	QueryMulti(query string) ([]connection.ResultSetData, error)
}

// MultiResultQuerierContext 是带 context 的多结果集查询接口。
type MultiResultQuerierContext interface {
	QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error)
}

// BatchWriteExecer 是可选接口，支持将多条写语句一次性批量发送执行。
// 驱动的底层连接需支持多语句协议（如 MySQL multiStatements=true、PostgreSQL 原生多语句）。
// 实现此接口可大幅减少批量 INSERT/UPDATE/DELETE 的网络往返次数。
type BatchWriteExecer interface {
	ExecBatchContext(ctx context.Context, query string) (int64, error)
}

// StatementExecer is a single-session SQL execution handle.
// It is used by long-running import jobs that must preserve session-scoped
// settings across multiple statements.
type StatementExecer interface {
	Exec(query string) (int64, error)
	ExecContext(ctx context.Context, query string) (int64, error)
	Close() error
}

// StatementExecerDiscarter permanently removes a pinned physical connection
// from its pool. Session-scoped commands use it when cleanup fails, so leaked
// state cannot affect a later business query.
type StatementExecerDiscarter interface {
	Discard() error
}

// StatementQueryExecer can run queries on a pinned session/connection.
// Drivers that return sqlConnStatementExecer automatically satisfy it.
type StatementQueryExecer interface {
	StatementExecer
	Query(query string) ([]map[string]interface{}, []string, error)
	QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error)
}

// QueryStreamConsumer receives query metadata and rows incrementally.
// Implementations can stream rows directly to files to avoid buffering entire result sets in memory.
type QueryStreamConsumer interface {
	SetColumns(columns []string) error
	ConsumeRow(row map[string]interface{}) error
}

// QueryStreamValueConsumer is an optional fast path for stream consumers that
// can consume normalized row values in column order without requiring a
// map[string]interface{} allocation per row.
type QueryStreamValueConsumer interface {
	SetColumns(columns []string) error
	ConsumeRowValues(values []interface{}) error
}

// StreamQueryExecer is an optional interface for drivers or pinned sessions that can
// stream query rows incrementally instead of materializing []map rows in memory.
type StreamQueryExecer interface {
	StreamQuery(query string, consumer QueryStreamConsumer) error
	StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error
}

// ExplainExecer is an optional interface for drivers that can run EXPLAIN and
// return the dialect-native output (JSON text, table rows as JSON, or XML).
//
// Drivers that implement this interface own the full EXPLAIN lifecycle:
//   - MySQL: prefer EXPLAIN FORMAT=JSON, fallback to vanilla EXPLAIN on 5.7
//   - PostgreSQL: EXPLAIN (FORMAT JSON)
//   - Oracle: EXPLAIN PLAN SET STATEMENT_ID ... + DBMS_XPLAN.DISPLAY + cleanup
//   - SQLServer: SET SHOWPLAN_XML ON + sql + SET OFF (defer cleanup mandatory)
//   - SQLite: EXPLAIN QUERY PLAN
//   - ClickHouse: EXPLAIN JSON
//
// The driver decides which format to use and returns the raw payload plus the
// detected format tag; the app layer parses via the corresponding parser. This
// default interface MUST NOT execute the source query (for example via ANALYZE);
// an explicit, confirmed runtime-analysis API is required for that behavior.
//
// Drivers that do NOT implement this interface fall back to the generic path
// in app.DiagnoseQuery: wrap the SQL as "EXPLAIN <sql>" and run via QueryMulti.
type ExplainExecer interface {
	Explain(ctx context.Context, query string) (raw string, format connection.ExplainFormat, err error)
}

// StatementQueryMessageExecer can run queries on a pinned session and return
// extra server messages/notices alongside rows.
type StatementQueryMessageExecer interface {
	StatementQueryExecer
	QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error)
	QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error)
}

// StatementMultiResultQueryExecer can run multi-result queries on a pinned session/connection.
type StatementMultiResultQueryExecer interface {
	StatementExecer
	QueryMulti(query string) ([]connection.ResultSetData, error)
	QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error)
}

// StatementMultiResultQueryMessageExecer can run multi-result queries on a
// pinned session/connection and return server messages/notices.
type StatementMultiResultQueryMessageExecer interface {
	StatementMultiResultQueryExecer
	QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error)
	QueryMultiContextWithMessages(ctx context.Context, query string) ([]connection.ResultSetData, []string, error)
}

// QueryMessageExecer is an optional database-level interface for returning
// informational server messages alongside one result set.
type QueryMessageExecer interface {
	QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error)
	QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error)
}

// MultiResultQueryMessageExecer is an optional database-level interface for
// returning informational server messages alongside multi-result queries.
type MultiResultQueryMessageExecer interface {
	QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error)
	QueryMultiContextWithMessages(ctx context.Context, query string) ([]connection.ResultSetData, []string, error)
}

// SessionExecerProvider is implemented by database/sql based drivers that can
// pin a long-running job to one physical connection.
type SessionExecerProvider interface {
	OpenSessionExecer(ctx context.Context) (StatementExecer, error)
}

// TransactionExecer is a single transaction handle backed by the database
// driver. It is required for dialects where textual BEGIN/COMMIT is not a
// valid transaction-control statement, such as Oracle.
type TransactionExecer interface {
	StatementExecer
	Commit() error
	Rollback() error
}

// TransactionExecerProvider is implemented by drivers that can expose a
// long-running SQL editor managed transaction.
type TransactionExecerProvider interface {
	OpenTransactionExecer(ctx context.Context) (TransactionExecer, error)
}

type sqlConnStatementExecer struct {
	conn        *sql.Conn
	scanDialect string
}

func NewSQLConnStatementExecer(conn *sql.Conn) StatementExecer {
	return NewSQLConnStatementExecerWithDialect(conn, "")
}

func NewSQLConnStatementExecerWithDialect(conn *sql.Conn, scanDialect string) StatementExecer {
	return &sqlConnStatementExecer{conn: conn, scanDialect: scanDialect}
}

func localizedDatabaseRuntimeError(key string, params map[string]any) error {
	return fmt.Errorf("%s", localizedDriverRuntimeText(key, params))
}

func wrapDatabaseConnectionOpenError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s%w", localizedDriverRuntimeText("db.backend.error.connection_open_failed_prefix", nil), err)
}

func wrapDatabaseConnectionVerifyError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s%w", localizedDriverRuntimeText("db.backend.error.connection_verify_failed_prefix", nil), err)
}

func (e *sqlConnStatementExecer) ExecContext(ctx context.Context, query string) (int64, error) {
	if e == nil || e.conn == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	res, err := e.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (e *sqlConnStatementExecer) Exec(query string) (int64, error) {
	return e.ExecContext(context.Background(), query)
}

func (e *sqlConnStatementExecer) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if e == nil || e.conn == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	rows, err := e.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, e.scanDialect)
}

func (e *sqlConnStatementExecer) Query(query string) ([]map[string]interface{}, []string, error) {
	return e.QueryContext(context.Background(), query)
}

func (e *sqlConnStatementExecer) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if e == nil || e.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	rows, err := e.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRowsForDialect(rows, e.scanDialect, consumer)
}

func (e *sqlConnStatementExecer) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return e.StreamQueryContext(context.Background(), query, consumer)
}

func (e *sqlConnStatementExecer) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if e == nil || e.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	rows, err := e.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialect(rows, e.scanDialect)
}

func (e *sqlConnStatementExecer) QueryMulti(query string) ([]connection.ResultSetData, error) {
	return e.QueryMultiContext(context.Background(), query)
}

func (e *sqlConnStatementExecer) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	return e.ExecContext(ctx, query)
}

func (e *sqlConnStatementExecer) Close() error {
	if e == nil || e.conn == nil {
		return nil
	}
	return e.conn.Close()
}

func discardSQLConn(connRef **sql.Conn) error {
	if connRef == nil || *connRef == nil {
		return nil
	}
	conn := *connRef
	err := conn.Raw(func(any) error { return driver.ErrBadConn })
	if errors.Is(err, driver.ErrBadConn) {
		// Raw returning ErrBadConn makes database/sql permanently evict the
		// physical connection instead of returning it to the idle pool. Clear
		// the wrapper reference so a deferred Close cannot touch it again.
		*connRef = nil
		return nil
	}
	return err
}

func (e *sqlConnStatementExecer) Discard() error {
	if e == nil {
		return nil
	}
	return discardSQLConn(&e.conn)
}

type sqlConnTransactionExecer struct {
	mu          sync.Mutex
	conn        *sql.Conn
	done        bool
	commitSQL   string
	rollbackSQL string
	scanDialect string
}

func NewSQLConnTransactionExecer(conn *sql.Conn, commitSQL string, rollbackSQL string) TransactionExecer {
	return NewSQLConnTransactionExecerWithDialect(conn, commitSQL, rollbackSQL, "")
}

func NewSQLConnTransactionExecerWithDialect(conn *sql.Conn, commitSQL string, rollbackSQL string, scanDialect string) TransactionExecer {
	return &sqlConnTransactionExecer{
		conn:        conn,
		commitSQL:   strings.TrimSpace(commitSQL),
		rollbackSQL: strings.TrimSpace(rollbackSQL),
		scanDialect: scanDialect,
	}
}

func (e *sqlConnTransactionExecer) activeConn() (*sql.Conn, error) {
	if e == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	if e.done {
		return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_already_finished", nil)
	}
	return e.conn, nil
}

func (e *sqlConnTransactionExecer) ExecContext(ctx context.Context, query string) (int64, error) {
	conn, err := e.activeConn()
	if err != nil {
		return 0, err
	}
	res, err := conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (e *sqlConnTransactionExecer) Exec(query string) (int64, error) {
	return e.ExecContext(context.Background(), query)
}

func (e *sqlConnTransactionExecer) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	conn, err := e.activeConn()
	if err != nil {
		return nil, nil, err
	}
	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialect(rows, e.scanDialect)
}

func (e *sqlConnTransactionExecer) Query(query string) ([]map[string]interface{}, []string, error) {
	return e.QueryContext(context.Background(), query)
}

func (e *sqlConnTransactionExecer) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	conn, err := e.activeConn()
	if err != nil {
		return err
	}
	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRowsForDialect(rows, e.scanDialect, consumer)
}

func (e *sqlConnTransactionExecer) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return e.StreamQueryContext(context.Background(), query, consumer)
}

func (e *sqlConnTransactionExecer) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	conn, err := e.activeConn()
	if err != nil {
		return nil, err
	}
	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialect(rows, e.scanDialect)
}

func (e *sqlConnTransactionExecer) QueryMulti(query string) ([]connection.ResultSetData, error) {
	return e.QueryMultiContext(context.Background(), query)
}

func (e *sqlConnTransactionExecer) finish(sqlText string) error {
	if e == nil {
		return nil
	}
	e.mu.Lock()
	if e.conn == nil || e.done {
		e.mu.Unlock()
		return nil
	}
	conn := e.conn
	e.done = true
	e.mu.Unlock()
	if strings.TrimSpace(sqlText) == "" {
		return nil
	}
	_, err := conn.ExecContext(context.Background(), sqlText)
	return err
}

func (e *sqlConnTransactionExecer) Commit() error {
	return e.finish(e.commitSQL)
}

func (e *sqlConnTransactionExecer) Rollback() error {
	return e.finish(e.rollbackSQL)
}

func (e *sqlConnTransactionExecer) Close() error {
	if e == nil {
		return nil
	}
	e.mu.Lock()
	if e.conn == nil {
		e.mu.Unlock()
		return nil
	}
	conn := e.conn
	shouldRollback := !e.done && e.rollbackSQL != ""
	rollbackSQL := e.rollbackSQL
	e.conn = nil
	e.done = true
	e.mu.Unlock()

	var rollbackErr error
	if shouldRollback {
		_, rollbackErr = conn.ExecContext(context.Background(), rollbackSQL)
	}
	closeErr := conn.Close()
	if rollbackErr != nil {
		return rollbackErr
	}
	return closeErr
}

type sqlTxStatementExecer struct {
	mu   sync.Mutex
	tx   *sql.Tx
	done bool
}

func NewSQLTxStatementExecer(tx *sql.Tx) TransactionExecer {
	return &sqlTxStatementExecer{tx: tx}
}

func (e *sqlTxStatementExecer) activeTx() (*sql.Tx, error) {
	if e == nil || e.tx == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_not_open", nil)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.done {
		return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_already_finished", nil)
	}
	return e.tx, nil
}

func (e *sqlTxStatementExecer) ExecContext(ctx context.Context, query string) (int64, error) {
	tx, err := e.activeTx()
	if err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (e *sqlTxStatementExecer) Exec(query string) (int64, error) {
	return e.ExecContext(context.Background(), query)
}

func (e *sqlTxStatementExecer) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	tx, err := e.activeTx()
	if err != nil {
		return nil, nil, err
	}
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (e *sqlTxStatementExecer) Query(query string) ([]map[string]interface{}, []string, error) {
	return e.QueryContext(context.Background(), query)
}

func (e *sqlTxStatementExecer) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	tx, err := e.activeTx()
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRows(rows, consumer)
}

func (e *sqlTxStatementExecer) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return e.StreamQueryContext(context.Background(), query, consumer)
}

func (e *sqlTxStatementExecer) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	tx, err := e.activeTx()
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRows(rows)
}

func (e *sqlTxStatementExecer) QueryMulti(query string) ([]connection.ResultSetData, error) {
	return e.QueryMultiContext(context.Background(), query)
}

func (e *sqlTxStatementExecer) finish(action func(*sql.Tx) error) error {
	if e == nil || e.tx == nil {
		return nil
	}
	e.mu.Lock()
	if e.done {
		e.mu.Unlock()
		return nil
	}
	tx := e.tx
	e.done = true
	e.mu.Unlock()
	return action(tx)
}

func (e *sqlTxStatementExecer) Commit() error {
	return e.finish(func(tx *sql.Tx) error {
		return tx.Commit()
	})
}

func (e *sqlTxStatementExecer) Rollback() error {
	return e.finish(func(tx *sql.Tx) error {
		return tx.Rollback()
	})
}

func (e *sqlTxStatementExecer) Close() error {
	return e.Rollback()
}

// BatchApplier 定义了批量变更提交接口。
// 支持批量编辑的驱动实现此接口，用于一次性提交前端 DataGrid 中的增删改操作。
type BatchApplier interface {
	// ApplyChanges 将一组变更（新增、修改、删除）批量提交到指定表。
	ApplyChanges(tableName string, changes connection.ChangeSet) error
}

// ChangePreviewer 是可选的变更预览接口。
// 驱动可实现此接口提供自定义 SQL 预览格式；若未实现，调用方回退到 GenerateChangePreview。
type ChangePreviewer interface {
	PreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string)
}

type rowMutationAction string

const (
	rowMutationActionDelete rowMutationAction = "delete"
	rowMutationActionUpdate rowMutationAction = "update"
)

func localizedRowMutationAction(action rowMutationAction) string {
	switch action {
	case rowMutationActionDelete:
		return localizedDriverRuntimeText("db.backend.action.delete", nil)
	case rowMutationActionUpdate:
		return localizedDriverRuntimeText("db.backend.action.update", nil)
	default:
		return strings.TrimSpace(string(action))
	}
}

func requireSingleRowAffected(result sql.Result, action rowMutationAction) error {
	actionLabel := localizedRowMutationAction(action)
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("%s", localizedDriverRuntimeText("db.backend.error.row_action_not_effective_rows_affected_unknown", map[string]any{
			"action": actionLabel,
			"detail": err.Error(),
		}))
	}
	if affected == 0 {
		return fmt.Errorf("%s", localizedDriverRuntimeText("db.backend.error.row_action_not_effective_no_rows_matched", map[string]any{
			"action": actionLabel,
		}))
	}
	if affected != 1 {
		return fmt.Errorf("%s", localizedDriverRuntimeText("db.backend.error.row_action_not_effective_multiple_rows", map[string]any{
			"action": actionLabel,
			"count":  affected,
		}))
	}
	return nil
}

type databaseFactory func() Database

var databaseFactories = map[string]databaseFactory{
	"mysql": func() Database {
		return &MySQLDB{}
	},
	"goldendb": func() Database {
		return &MySQLDB{}
	},
	"postgres": func() Database {
		return &PostgresDB{}
	},
	"oracle": func() Database {
		return &OracleDB{}
	},
	"custom": func() Database {
		return &CustomDB{}
	},
	"chroma": func() Database {
		return &ChromaDB{}
	},
	"qdrant": func() Database {
		return &QdrantDB{}
	},
	"milvus": func() Database {
		return &MilvusDB{}
	},
	"rocketmq": func() Database {
		return &RocketMQDB{}
	},
	"mqtt": func() Database {
		return &MQTTDB{}
	},
	"kafka": func() Database {
		return &KafkaDB{}
	},
	"rabbitmq": func() Database {
		return &RabbitMQDB{}
	},
}

func init() {
	registerOptionalDatabaseFactories()
}

func registerDatabaseFactory(factory databaseFactory, dbTypes ...string) {
	if factory == nil || len(dbTypes) == 0 {
		return
	}
	for _, dbType := range dbTypes {
		normalized := normalizeDatabaseType(dbType)
		if normalized == "" {
			continue
		}
		databaseFactories[normalized] = factory
	}
}

func normalizeDatabaseType(dbType string) string {
	normalized := strings.ToLower(strings.TrimSpace(dbType))
	switch normalized {
	case "doris":
		return "diros"
	case "postgresql":
		return "postgres"
	case "kingbase8", "kingbasees", "kingbasev8":
		return "kingbase"
	case "opengauss", "open_gauss", "open-gauss":
		return "opengauss"
	case "gaussdb", "gauss_db", "gauss-db":
		return "gaussdb"
	case "goldendb", "greatdb", "gdb":
		return "goldendb"
	case "intersystems", "intersystemsiris", "inter-systems-iris", "inter-systems":
		return "iris"
	case "chromadb", "chroma-db":
		return "chroma"
	case "qdrantdb", "qdrant-db":
		return "qdrant"
	case "milvusdb", "milvus-db":
		return "milvus"
	case "rocketmq", "rocket-mq", "rocket_mq", "apache-rocketmq", "apache_rocketmq", "rmq":
		return "rocketmq"
	case "mqtt", "mqtts":
		return "mqtt"
	case "kafka", "apache-kafka", "apache_kafka":
		return "kafka"
	case "rabbitmq", "rabbit-mq", "rabbit_mq":
		return "rabbitmq"
	default:
		return normalized
	}
}

// NewDatabase 根据数据库类型创建对应的 Database 实例。
// dbType 为数据库类型标识（如 "mysql"、"postgres"、"oracle" 等），大小写不敏感。
// 如果指定类型未注册，返回错误。
func NewDatabase(dbType string) (Database, error) {
	normalized := normalizeDatabaseType(dbType)
	if normalized == "" {
		normalized = "mysql"
	}
	factory, ok := databaseFactories[normalized]
	if !ok {
		return nil, localizedDatabaseRuntimeError("db.backend.error.unsupported_database_type", map[string]any{"dbType": dbType})
	}
	return factory(), nil
}
