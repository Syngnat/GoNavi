package db

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const (
	maxRemoteJSONResponseBytes           = 32 << 20
	maxElasticsearchConsoleResponseBytes = maxRemoteJSONResponseBytes
)

// ElasticsearchConsoleBodyKind identifies how an Elasticsearch REST request
// body must be encoded on the wire.
type ElasticsearchConsoleBodyKind string

const (
	ElasticsearchConsoleBodyKindNone   ElasticsearchConsoleBodyKind = "none"
	ElasticsearchConsoleBodyKindJSON   ElasticsearchConsoleBodyKind = "json"
	ElasticsearchConsoleBodyKindNDJSON ElasticsearchConsoleBodyKind = "ndjson"
)

// ElasticsearchConsoleRequest is the driver-facing representation of one
// already parsed and classified Elasticsearch Console request.
type ElasticsearchConsoleRequest struct {
	Method   string                       `json:"method"`
	Path     string                       `json:"path"`
	Body     string                       `json:"body,omitempty"`
	BodyKind ElasticsearchConsoleBodyKind `json:"bodyKind"`
}

// ElasticsearchConsoleResponse preserves the raw Elasticsearch HTTP response
// so callers can render both successful and structured error payloads.
type ElasticsearchConsoleResponse struct {
	StatusCode  int    `json:"statusCode"`
	ContentType string `json:"contentType,omitempty"`
	RawBody     string `json:"rawBody"`
	ServerMajor int    `json:"serverMajor,omitempty"`
}

// ElasticsearchConsoleExecutor is implemented by drivers that can execute a
// validated Elasticsearch REST request without converting it into tabular SQL
// results.
type ElasticsearchConsoleExecutor interface {
	ExecuteElasticsearchConsoleRequest(context.Context, ElasticsearchConsoleRequest) (ElasticsearchConsoleResponse, error)
}

// ElasticsearchConsoleTransportHealth reports whether an executor can safely
// remain cached after a transport-level console error. Direct HTTP clients
// normally remain reusable after cancellation; a force-terminated optional
// driver agent does not.
type ElasticsearchConsoleTransportHealth interface {
	ElasticsearchConsoleTransportUsable() bool
}

// ElasticsearchServerVersionProvider exposes the major version discovered
// when the driver connected. A zero value means the version is unknown.
type ElasticsearchServerVersionProvider interface {
	ElasticsearchServerMajor() int
}

// DatabaseForeignKeyProvider is an optional metadata interface for drivers that
// can load a database-wide foreign-key snapshot more efficiently than one table
// at a time.
type DatabaseForeignKeyProvider interface {
	GetDatabaseForeignKeys(dbName string) (map[string][]connection.ForeignKeyDefinition, error)
}

// TableCommentProvider is an optional metadata interface for drivers that can
// load a table-level comment for schema/backup DDL generation.
type TableCommentProvider interface {
	GetTableComment(dbName, tableName string) (string, error)
}

// TableExistsChecker is an optional point lookup for a table's canonical
// metadata identity. Callers must pass the exact name returned by driver
// metadata; this interface does not parse arbitrary SQL identifiers.
type TableExistsChecker interface {
	TableExists(dbName, tableName string) (bool, error)
}

// TableColumnsBatcher is an optional bulk read of column metadata for several
// tables of one schema in a single round trip.
//
// 动机：逐表读字段在大库上是预检的主要成本 —— N 张表就是 N 次往返，每次都要
// 走一遍字典视图与注释/主键连接。批量版把同 schema 的表合并成一条查询。
//
// 契约：
//   - 返回的 map 以调用方传入的表名为键（原样，不做大小写改写），未命中的表
//     直接缺席，而不是给一个空切片 —— 缺席让调用方能够区分「确实是空表」与
//     「这个驱动/查询没找到它」，从而决定是否回退到逐表查询。
//   - 驱动可以假设所有表名属于同一个 schema；跨 schema 的批量请求由调用方分组。
type TableColumnsBatcher interface {
	GetColumnsBatch(dbName string, tableNames []string) (map[string][]connection.ColumnDefinition, error)
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

// QueryContexter is the optional cancellation-capable query contract.
// Callers must not assume Database.Query can be interrupted without it.
type QueryContexter interface {
	QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error)
}

// ColumnDefinitionContexter is an optional same-session metadata extension.
// It is used when opening a second database instance would change connection-
// scoped semantics, such as an in-memory SQLite or DuckDB database.
type ColumnDefinitionContexter interface {
	GetColumnsContext(ctx context.Context, dbName, tableName string) ([]connection.ColumnDefinition, error)
}

// ExecContexter is the optional cancellation-capable write contract.
// Callers must not assume Database.Exec can be interrupted without it.
type ExecContexter interface {
	ExecContext(ctx context.Context, query string) (int64, error)
}

// MultiResultQuerierContext 是带 context 的多结果集查询接口。
type MultiResultQuerierContext interface {
	QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error)
}

// StatementBatchMultiResultQuerierContext is an optional protocol-native
// contract for transports that accept an ordered SQL array in one request.
// Navicat's ntunnel_mysql.php uses repeated q[] form fields and keeps one
// database connection for that request, so callers must not degrade it into
// independent HTTP requests when session-scoped SQL is present.
type StatementBatchMultiResultQuerierContext interface {
	SupportsStatementBatchMultiResult() bool
	QueryStatementsMultiContext(ctx context.Context, statements []string) ([]connection.ResultSetData, error)
}

// BatchWriteExecer 是可选接口，支持将多条写语句一次性批量发送执行。
// 驱动的底层连接需支持多语句协议（如 MySQL multiStatements=true、PostgreSQL 原生多语句）。
// 实现此接口可大幅减少批量 INSERT/UPDATE/DELETE 的网络往返次数。
type BatchWriteExecer interface {
	ExecBatchContext(ctx context.Context, query string) (int64, error)
}

// BatchWriteCapability lets a driver that conditionally supports the
// multi-statement protocol opt out at runtime. MySQL uses this when the
// connection had to fall back to multiStatements=false.
type BatchWriteCapability interface {
	SupportsBatchWrites() bool
}

// BatchApplyCapability lets a driver whose BatchApplier implementation is
// conditionally unavailable opt out at runtime. This is distinct from plain
// Exec support: a data grid change set promises an atomic batch.
type BatchApplyCapability interface {
	SupportsBatchApply() bool
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

// SessionExecerCapability lets a database/sql implementation report that its
// current transport cannot preserve a physical session. HTTP script tunnels
// create a database connection per request even though the concrete Go type
// also supports pinned sessions for normal TCP connections.
type SessionExecerCapability interface {
	SupportsSessionExecer() bool
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
