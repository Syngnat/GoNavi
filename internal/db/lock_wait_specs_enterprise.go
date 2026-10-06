package db

// Oracle reports the blocker of every waiting session directly in
// gv$session.blocking_session (cross-instance on RAC). The blocker's current
// statement is empty once it goes idle, so its previous statement is used.
const oracleLockWaitQuery = `SELECT w.inst_id AS waiting_instance_id, w.sid AS waiting_session_id,
w.serial# AS waiting_serial_number, w.username AS waiting_user,
NVL(wq.sql_text, '') AS waiting_statement, ROUND(w.wait_time_micro / 1000) AS wait_ms,
b.inst_id AS blocking_instance_id, b.sid AS blocking_session_id,
b.serial# AS blocking_serial_number, b.username AS blocking_user,
b.status AS blocking_state, NVL(bq.sql_text, '') AS blocking_statement,
b.last_call_et * 1000 AS blocking_ms, w.service_name AS database_or_tenant,
CASE WHEN o.object_name IS NOT NULL THEN o.owner || '.' || o.object_name END AS object_name,
w.event AS lock_type
FROM gv$session w
JOIN gv$session b ON b.inst_id = w.blocking_instance AND b.sid = w.blocking_session
LEFT JOIN gv$sql wq ON wq.inst_id = w.inst_id AND wq.sql_id = w.sql_id AND wq.child_number = 0
LEFT JOIN gv$sql bq ON bq.inst_id = b.inst_id AND bq.sql_id = NVL(b.sql_id, b.prev_sql_id) AND bq.child_number = 0
LEFT JOIN all_objects o ON o.object_id = w.row_wait_obj#
WHERE w.blocking_session IS NOT NULL AND w.blocking_session_status = 'VALID'
ORDER BY w.wait_time_micro DESC`

// SQL Server reports blocking_session_id per request. An idle blocker has no
// request, so its last batch comes from the connection's most recent handle.
// Object names come only from OBJECT_NAME/OBJECT_SCHEMA_NAME, which never
// block: catalog views such as sys.partitions take schema-stability locks and
// would queue this very query behind a pending ALTER TABLE. A key/page/row wait
// names the table through the waiter's own object lock, preferring the object
// the blocker also locks; the raw wait resource is the fallback.
const sqlServerLockWaitQuery = `SELECT r.session_id AS waiting_session_id, ws.login_name AS waiting_user,
COALESCE(wt.text, '') AS waiting_statement, CAST(r.wait_time AS BIGINT) AS wait_ms,
r.blocking_session_id AS blocking_session_id, bs.login_name AS blocking_user,
COALESCE(br.status, bs.status) AS blocking_state, COALESCE(bt.text, '') AS blocking_statement,
CAST(DATEDIFF(SECOND, COALESCE(bx.transaction_begin_time, bs.last_request_start_time), SYSDATETIME()) AS BIGINT) * 1000 AS blocking_ms,
DB_NAME(r.database_id) AS database_or_tenant,
CASE WHEN wl.resource_type = 'OBJECT'
	THEN OBJECT_SCHEMA_NAME(wl.resource_associated_entity_id, wl.resource_database_id) + '.' + OBJECT_NAME(wl.resource_associated_entity_id, wl.resource_database_id)
	WHEN wo.object_id IS NOT NULL
	THEN OBJECT_SCHEMA_NAME(wo.object_id, wl.resource_database_id) + '.' + OBJECT_NAME(wo.object_id, wl.resource_database_id)
	ELSE r.wait_resource END AS object_name,
COALESCE(wl.resource_type, r.wait_type) AS lock_type, wl.request_mode AS lock_mode
FROM sys.dm_exec_requests r
JOIN sys.dm_exec_sessions ws ON ws.session_id = r.session_id
LEFT JOIN sys.dm_exec_sessions bs ON bs.session_id = r.blocking_session_id
LEFT JOIN sys.dm_exec_requests br ON br.session_id = r.blocking_session_id
LEFT JOIN sys.dm_exec_connections bc ON bc.session_id = r.blocking_session_id
OUTER APPLY (
	SELECT TOP 1 tx.transaction_begin_time
	FROM sys.dm_tran_session_transactions st
	JOIN sys.dm_tran_active_transactions tx ON tx.transaction_id = st.transaction_id
	WHERE st.session_id = r.blocking_session_id
	ORDER BY tx.transaction_begin_time
) bx
OUTER APPLY (
	SELECT TOP 1 tl.resource_type, tl.request_mode, tl.resource_associated_entity_id, tl.resource_database_id
	FROM sys.dm_tran_locks tl
	WHERE tl.request_session_id = r.session_id AND tl.request_status = 'WAIT'
) wl
OUTER APPLY (
	SELECT TOP 1 ol.resource_associated_entity_id AS object_id
	FROM sys.dm_tran_locks ol
	WHERE wl.resource_type IN ('KEY', 'PAGE', 'RID', 'HOBT')
	AND ol.request_session_id = r.session_id AND ol.resource_type = 'OBJECT'
	AND ol.resource_database_id = wl.resource_database_id
	ORDER BY CASE WHEN EXISTS (
		SELECT 1 FROM sys.dm_tran_locks bl
		WHERE bl.request_session_id = r.blocking_session_id AND bl.resource_type = 'OBJECT'
		AND bl.resource_database_id = ol.resource_database_id
		AND bl.resource_associated_entity_id = ol.resource_associated_entity_id
	) THEN 0 ELSE 1 END
) wo
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) wt
OUTER APPLY sys.dm_exec_sql_text(COALESCE(br.sql_handle, bc.most_recent_sql_handle)) bt
WHERE r.blocking_session_id > 0 AND r.session_id <> @@SPID
ORDER BY r.wait_time DESC`

func oracleLockWaitSpec() lockWaitSpec {
	return supportedLockWaitSpec("oracle", requiredLockWaitSource(oracleLockWaitQuery))
}

func sqlServerLockWaitSpec() lockWaitSpec {
	return supportedLockWaitSpec("sqlserver", requiredLockWaitSource(sqlServerLockWaitQuery))
}
