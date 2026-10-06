package db

import "GoNavi-Wails/internal/connection"

// OceanBase exposes the same session view in both tenant modes: GV$OB_PROCESSLIST
// (V4.0+) lists the sessions of every OBServer node in the tenant, which the
// per-node INFORMATION_SCHEMA.PROCESSLIST / SHOW PROCESSLIST cannot. Oracle
// tenants do not provide Oracle's gv$session / gv$sql, and both modes kill a
// session by its client session ID with the MySQL-style KILL statement, so
// neither the RAC instance nor serial# applies.

// oceanBaseMySQLSessionSpec lists MySQL tenant sessions cluster-wide and keeps
// the plain MySQL query for V3.x servers that predate GV$OB_PROCESSLIST.
func oceanBaseMySQLSessionSpec() sessionSpec {
	spec := mysqlSessionSpec("oceanbase-mysql")
	spec.listQuery = `SELECT ID AS session_id, DB AS database_or_tenant,
USER AS user_name, COMMAND AS state, TIME * 1000 AS duration_ms, INFO AS statement
FROM oceanbase.GV$OB_PROCESSLIST
WHERE ID <> CONNECTION_ID()
ORDER BY TIME DESC`
	spec.fallbackListQueries = []string{mysqlSessionSpec("oceanbase-mysql").listQuery}
	return spec
}

// oceanBaseOracleSessionSpec lists Oracle tenant sessions. USER is quoted
// because the bare word is Oracle's USER function. SHOW FULL PROCESSLIST is the
// fallback for servers without the view; its Time column is in seconds, which
// is why the duration unit is seconds while the primary query reports
// duration_ms directly.
func oceanBaseOracleSessionSpec() sessionSpec {
	return sessionSpec{
		engine: "oceanbase-oracle",
		capability: supportedSessionCapability(
			true, connection.SessionActionTargetSessionID,
			true, connection.SessionActionTargetSessionID,
		),
		listQuery: `SELECT ID AS session_id, DB AS database_or_tenant,
"USER" AS user_name, COMMAND AS state, TIME * 1000 AS duration_ms, INFO AS statement
FROM SYS.GV$OB_PROCESSLIST
WHERE ID <> TO_NUMBER(SYS_CONTEXT('USERENV', 'SID'))
ORDER BY TIME DESC`,
		fallbackListQueries:      []string{"SHOW FULL PROCESSLIST"},
		durationUnit:             sessionDurationSeconds,
		rowDatabaseAuthoritative: true,
	}
}
