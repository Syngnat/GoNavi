package db

import (
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"
)

const (
	sessionReasonNotApplicable = "not_applicable"
	sessionReasonUnsupported   = "unsupported"
)

type sessionDurationUnit int64

const (
	sessionDurationMilliseconds sessionDurationUnit = 1
	sessionDurationSeconds      sessionDurationUnit = 1000
)

type sessionSpec struct {
	engine       string
	capability   connection.SessionCapability
	listQuery    string
	durationUnit sessionDurationUnit
	// rowDatabaseAuthoritative marks engines whose list query reports each
	// session's own database. An empty value then means "no database selected"
	// and must stay empty instead of borrowing the connection's default
	// database, which would present the session as belonging to it.
	rowDatabaseAuthoritative bool
}

// SessionCapabilityFor returns the normalized engine name and its server-side
// session workbench contract without opening a database connection.
func SessionCapabilityFor(config connection.ConnectionConfig) (string, connection.SessionCapability) {
	spec := sessionSpecFor(config)
	return spec.engine, spec.capability
}

func sessionSpecFor(config connection.ConnectionConfig) sessionSpec {
	engine := normalizeSessionEngine(config)
	switch engine {
	case "mysql", "mariadb", "goldendb", "oceanbase-mysql":
		return mysqlSessionSpec(engine)
	case "doris", "starrocks":
		return mysqlCompatibleAnalyticsSessionSpec(engine)
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return postgresSessionSpec(engine)
	case "oracle":
		return oracleSessionSpec()
	case "oceanbase-oracle":
		return oceanBaseOracleSessionSpec()
	case "sqlserver":
		return sqlServerSessionSpec()
	case "dameng":
		return damengSessionSpec()
	case "clickhouse":
		return clickHouseSessionSpec()
	case "trino":
		return trinoSessionSpec()
	case "tdengine", "iotdb":
		// The product spec puts these engines behind a probe. Keep the SQL
		// builders below as an implementation seam, but do not expose a live
		// listing/action contract until a real server probe has passed.
		return unsupportedSessionSpec(engine, sessionReasonUnsupported)
	case "mongodb", "elasticsearch", "iris", "sphinx":
		return unsupportedSessionSpec(engine, sessionReasonUnsupported)
	default:
		return unsupportedSessionSpec(engine, sessionReasonNotApplicable)
	}
}

func supportedSessionCapability(
	cancel bool,
	cancelTarget connection.SessionActionTarget,
	terminate bool,
	terminateTarget connection.SessionActionTarget,
) connection.SessionCapability {
	return connection.SessionCapability{
		Supported:           true,
		CanCancelQuery:      cancel,
		CanTerminateSession: terminate,
		CancelTarget:        cancelTarget,
		TerminateTarget:     terminateTarget,
	}
}

func mysqlSessionSpec(engine string) sessionSpec {
	return sessionSpec{
		engine:     engine,
		capability: supportedSessionCapability(true, connection.SessionActionTargetSessionID, true, connection.SessionActionTargetSessionID),
		listQuery: `SELECT ID AS session_id, DB AS database_or_tenant,
USER AS user_name, COMMAND AS state, TIME * 1000 AS duration_ms, INFO AS statement
FROM INFORMATION_SCHEMA.PROCESSLIST
WHERE ID <> CONNECTION_ID()
ORDER BY TIME DESC`,
		durationUnit:             sessionDurationMilliseconds,
		rowDatabaseAuthoritative: true,
	}
}

func mysqlCompatibleAnalyticsSessionSpec(engine string) sessionSpec {
	return sessionSpec{
		engine:       engine,
		capability:   supportedSessionCapability(true, connection.SessionActionTargetQueryID, true, connection.SessionActionTargetSessionID),
		listQuery:    "SHOW FULL PROCESSLIST",
		durationUnit: sessionDurationSeconds,
		// SHOW FULL PROCESSLIST reports Db per session.
		rowDatabaseAuthoritative: true,
	}
}

// postgresDurationAnchor picks the timestamp the "duration" column counts
// from. A session that is still working is interesting for how long its
// current statement has been running, so the anchor is query_start. An idle
// session has no running statement at all: query_start still points at the
// statement it finished, sometimes days ago, which made idle rows read as
// "36 d 15 h" and buried the genuinely stuck ones. For those, state_change
// (when the session last left the running state) is the meaningful value.
const postgresDurationAnchor = `CASE
	WHEN COALESCE(state, '') IN ('active', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call') THEN COALESCE(query_start, state_change, backend_start)
	WHEN COALESCE(state, '') = 'idle' THEN COALESCE(state_change, query_start, backend_start)
	ELSE COALESCE(query_start, state_change, backend_start)
END`

func postgresSessionSpec(engine string) sessionSpec {
	return sessionSpec{
		engine:     engine,
		capability: supportedSessionCapability(true, connection.SessionActionTargetSessionID, true, connection.SessionActionTargetSessionID),
		listQuery: `SELECT pid AS session_id, datname AS database_or_tenant,
usename AS user_name, COALESCE(state, '') AS state,
GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - ` + postgresDurationAnchor + `)) * 1000)::bigint AS duration_ms,
COALESCE(query, '') AS statement
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()` + postgresClientOnlyFilter(engine) + `
ORDER BY state_change NULLS LAST`,
		durationUnit:             sessionDurationMilliseconds,
		rowDatabaseAuthoritative: true,
	}
}

// postgresClientOnlyFilter hides server processes (checkpointer, autovacuum,
// scheduler workers, ...). pg_stat_activity lists them next to client
// sessions, but they have no client socket (client_port IS NULL; a Unix-socket
// client reports -1) and are not sessions a user can meaningfully cancel or
// terminate: the server answers false/ignores the request.
// Only PostgreSQL-lineage engines get the filter: openGauss-derived engines
// keep their own pg_stat_activity shape, so they stay unfiltered rather than
// risk an empty list.
func postgresClientOnlyFilter(engine string) string {
	switch engine {
	case "postgres", "kingbase", "highgo":
		return "\nAND client_port IS NOT NULL"
	default:
		return ""
	}
}

func oracleSessionSpec() sessionSpec {
	return oracleCompatibleSessionSpec("oracle")
}

func oceanBaseOracleSessionSpec() sessionSpec {
	return oracleCompatibleSessionSpec("oceanbase-oracle")
}

func oracleCompatibleSessionSpec(engine string) sessionSpec {
	capability := supportedSessionCapability(false, "", true, connection.SessionActionTargetSessionID)
	capability.TerminateRequiresInstanceAndSerial = true
	return sessionSpec{
		engine:     engine,
		capability: capability,
		listQuery: `SELECT s.inst_id AS instance_id, s.sid AS session_id,
s.serial# AS serial_number, s.service_name AS database_or_tenant,
s.username AS user_name, s.status AS state, s.sql_id AS query_id,
s.last_call_et * 1000 AS duration_ms, NVL(q.sql_text, '') AS statement
FROM gv$session s
LEFT JOIN gv$sql q ON q.inst_id = s.inst_id AND q.sql_id = s.sql_id AND q.child_number = 0
WHERE s.type = 'USER' AND s.sid <> SYS_CONTEXT('USERENV', 'SID')
ORDER BY s.last_call_et DESC`,
		durationUnit: sessionDurationMilliseconds,
	}
}

func sqlServerSessionSpec() sessionSpec {
	return sessionSpec{
		engine:     "sqlserver",
		capability: supportedSessionCapability(false, "", true, connection.SessionActionTargetSessionID),
		listQuery: `SELECT s.session_id AS session_id,
DB_NAME(r.database_id) AS database_or_tenant, s.login_name AS user_name,
COALESCE(r.status, s.status) AS state,
COALESCE(r.total_elapsed_time, 0) AS duration_ms,
COALESCE(t.text, '') AS statement
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1 AND s.session_id <> @@SPID
ORDER BY COALESCE(r.total_elapsed_time, 0) DESC`,
		durationUnit:             sessionDurationMilliseconds,
		rowDatabaseAuthoritative: true,
	}
}

func damengSessionSpec() sessionSpec {
	return sessionSpec{
		engine:     "dameng",
		capability: supportedSessionCapability(false, "", true, connection.SessionActionTargetSessionID),
		listQuery: `SELECT SESS_ID AS session_id, USER_NAME AS user_name,
STATE AS state, SQL_TEXT AS statement
FROM V$SESSIONS`,
		durationUnit: sessionDurationMilliseconds,
	}
}

func clickHouseSessionSpec() sessionSpec {
	return sessionSpec{
		engine:     "clickhouse",
		capability: supportedSessionCapability(true, connection.SessionActionTargetQueryID, false, ""),
		listQuery: `SELECT query_id, database AS database_or_tenant, user AS user_name,
'running' AS state, toInt64(elapsed * 1000) AS duration_ms, query AS statement
FROM system.processes
WHERE query_id != currentQueryID()
ORDER BY elapsed DESC`,
		durationUnit:             sessionDurationMilliseconds,
		rowDatabaseAuthoritative: true,
	}
}

func trinoSessionSpec() sessionSpec {
	return sessionSpec{
		engine:     "trino",
		capability: supportedSessionCapability(true, connection.SessionActionTargetQueryID, false, ""),
		// system.runtime.queries does not expose a catalog column. Fall back to
		// the selected catalog/schema from ConnectionConfig during row
		// normalization instead of issuing a query that fails on every Trino
		// server. Completed queries are excluded because this workbench lists
		// live server-side work only.
		listQuery: `SELECT query_id, '' AS database_or_tenant, user AS user_name,
state, CAST(date_diff('millisecond', created, current_timestamp) AS bigint) AS duration_ms,
query AS statement
FROM system.runtime.queries
WHERE "end" IS NULL
ORDER BY created DESC`,
		durationUnit: sessionDurationMilliseconds,
	}
}

func tdengineSessionSpec() sessionSpec {
	return sessionSpec{
		engine:     "tdengine",
		capability: supportedSessionCapability(true, connection.SessionActionTargetQueryID, true, connection.SessionActionTargetSessionID),
		listQuery: `SELECT kill_id AS query_id, conn_id AS session_id, user AS user_name,
db AS database_or_tenant, exec_usec / 1000 AS duration_ms, sql AS statement,
phase_state AS state
FROM performance_schema.perf_queries`,
		durationUnit: sessionDurationMilliseconds,
	}
}

func iotdbSessionSpec() sessionSpec {
	return sessionSpec{
		engine:       "iotdb",
		capability:   supportedSessionCapability(true, connection.SessionActionTargetQueryID, false, ""),
		listQuery:    "SHOW QUERIES",
		durationUnit: sessionDurationSeconds,
	}
}

func unsupportedSessionSpec(engine, reason string) sessionSpec {
	return sessionSpec{engine: engine, capability: connection.SessionCapability{ReasonCode: reason}}
}

func normalizeSessionEngine(config connection.ConnectionConfig) string {
	// Keep session capability routing aligned with the runtime driver factory.
	// In particular, aliases such as dm8, kingbasees, and apache-iotdb must not
	// silently fall through to a generic N/A state when the selected driver has
	// a session adapter.
	rawType := normalizeRuntimeDriverType(config.Type)
	if rawType == "custom" {
		rawType = normalizeRuntimeDriverType(config.Driver)
	}
	switch rawType {
	case "diros":
		return "doris"
	case "oceanbase":
		if resolveSessionOceanBaseProtocol(config) == "oracle" {
			return "oceanbase-oracle"
		}
		return "oceanbase-mysql"
	case "postgresql":
		return "postgres"
	case "mssql", "sql_server", "sql-server":
		return "sqlserver"
	case "greatdb", "gdb":
		return "goldendb"
	default:
		return rawType
	}
}

func resolveSessionOceanBaseProtocol(config connection.ConnectionConfig) string {
	if protocol := normalizeSessionProtocol(config.OceanBaseProtocol); protocol != "" {
		return protocol
	}
	for _, raw := range []string{config.ConnectionParams, config.URI} {
		text := strings.TrimSpace(raw)
		if index := strings.Index(text, "?"); index >= 0 {
			text = text[index+1:]
		}
		values, err := url.ParseQuery(strings.TrimLeft(text, "?&"))
		if err != nil {
			continue
		}
		for _, key := range []string{"protocol", "oceanBaseProtocol", "oceanbaseProtocol", "tenantMode", "compatMode", "mode"} {
			if protocol := normalizeSessionProtocol(values.Get(key)); protocol != "" {
				return protocol
			}
		}
	}
	return "mysql"
}

func normalizeSessionProtocol(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "oracle", "oracle-mode", "oracle_mode", "oboracle":
		return "oracle"
	case "mysql", "mysql-compatible", "mysql_compatible", "mysql-mode", "mysql_mode", "obmysql":
		return "mysql"
	default:
		return ""
	}
}
