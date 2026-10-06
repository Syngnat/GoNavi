package db

// MySQL-family lock waits come from two places:
//   - InnoDB row/table locks: performance_schema.data_lock_waits (8.0+), or
//     information_schema.INNODB_LOCK_WAITS on 5.7 and MariaDB;
//   - metadata locks (DDL stuck behind an open transaction and every query
//     queued behind that DDL): performance_schema.metadata_locks.
//
// The blocker's own statement is NULL in INNODB_TRX once it goes idle inside an
// open transaction, which is the most common culprit. On 8.0 the last
// statement it ran is read from events_statements_current instead.

const mysql8InnoDBLockWaitQuery = `SELECT r.trx_mysql_thread_id AS waiting_session_id,
rp.USER AS waiting_user, r.trx_query AS waiting_statement,
TIMESTAMPDIFF(MICROSECOND, r.trx_wait_started, NOW(6)) DIV 1000 AS wait_ms,
b.trx_mysql_thread_id AS blocking_session_id, bp.USER AS blocking_user,
bp.COMMAND AS blocking_state,
COALESCE(b.trx_query, (
	SELECT s.SQL_TEXT FROM performance_schema.events_statements_current s
	JOIN performance_schema.threads t ON t.THREAD_ID = s.THREAD_ID
	WHERE t.PROCESSLIST_ID = b.trx_mysql_thread_id
	ORDER BY s.EVENT_ID DESC LIMIT 1
)) AS blocking_statement,
TIMESTAMPDIFF(MICROSECOND, b.trx_started, NOW(6)) DIV 1000 AS blocking_ms,
rl.OBJECT_SCHEMA AS database_or_tenant,
CONCAT(rl.OBJECT_SCHEMA, '.', rl.OBJECT_NAME) AS object_name,
rl.INDEX_NAME AS index_name, rl.LOCK_TYPE AS lock_type,
rl.LOCK_MODE AS lock_mode, bl.LOCK_MODE AS blocking_lock_mode
FROM performance_schema.data_lock_waits w
JOIN information_schema.INNODB_TRX r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
JOIN information_schema.INNODB_TRX b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
LEFT JOIN performance_schema.data_locks rl ON rl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
LEFT JOIN performance_schema.data_locks bl ON bl.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
LEFT JOIN information_schema.PROCESSLIST rp ON rp.ID = r.trx_mysql_thread_id
LEFT JOIN information_schema.PROCESSLIST bp ON bp.ID = b.trx_mysql_thread_id
ORDER BY wait_ms DESC`

// lock_table is reported as `schema`.`table`; the row normalizer strips the
// identifier quotes.
const mysqlLegacyInnoDBLockWaitQuery = `SELECT r.trx_mysql_thread_id AS waiting_session_id,
rp.USER AS waiting_user, r.trx_query AS waiting_statement,
TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) * 1000 AS wait_ms,
b.trx_mysql_thread_id AS blocking_session_id, bp.USER AS blocking_user,
bp.COMMAND AS blocking_state, b.trx_query AS blocking_statement,
TIMESTAMPDIFF(SECOND, b.trx_started, NOW()) * 1000 AS blocking_ms,
rl.lock_table AS object_name, rl.lock_index AS index_name,
rl.lock_type AS lock_type, rl.lock_mode AS lock_mode, bl.lock_mode AS blocking_lock_mode
FROM information_schema.INNODB_LOCK_WAITS w
JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id
JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id
LEFT JOIN information_schema.INNODB_LOCKS rl ON rl.lock_id = w.requested_lock_id
LEFT JOIN information_schema.INNODB_LOCKS bl ON bl.lock_id = w.blocking_lock_id
LEFT JOIN information_schema.PROCESSLIST rp ON rp.ID = r.trx_mysql_thread_id
LEFT JOIN information_schema.PROCESSLIST bp ON bp.ID = b.trx_mysql_thread_id
ORDER BY wait_ms DESC`

// Metadata locks have no waits-for table. Like sys.schema_table_lock_waits,
// every session holding a granted lock on the same table is reported as a
// blocker of each pending request on it.
const mysqlMetadataLockWaitQuery = `SELECT wt.PROCESSLIST_ID AS waiting_session_id,
wt.PROCESSLIST_USER AS waiting_user, wt.PROCESSLIST_INFO AS waiting_statement,
wt.PROCESSLIST_TIME * 1000 AS wait_ms,
bt.PROCESSLIST_ID AS blocking_session_id, bt.PROCESSLIST_USER AS blocking_user,
bt.PROCESSLIST_COMMAND AS blocking_state,
COALESCE(bt.PROCESSLIST_INFO, (
	SELECT s.SQL_TEXT FROM performance_schema.events_statements_current s
	WHERE s.THREAD_ID = bt.THREAD_ID
	ORDER BY s.EVENT_ID DESC LIMIT 1
)) AS blocking_statement,
(
	SELECT TIMESTAMPDIFF(MICROSECOND, x.trx_started, NOW(6)) DIV 1000
	FROM information_schema.INNODB_TRX x
	WHERE x.trx_mysql_thread_id = bt.PROCESSLIST_ID
	LIMIT 1
) AS blocking_ms,
w.OBJECT_SCHEMA AS database_or_tenant,
CONCAT(w.OBJECT_SCHEMA, '.', w.OBJECT_NAME) AS object_name,
'METADATA' AS lock_type, w.LOCK_TYPE AS lock_mode, g.LOCK_TYPE AS blocking_lock_mode
FROM performance_schema.metadata_locks w
JOIN performance_schema.metadata_locks g
	ON g.OBJECT_TYPE = w.OBJECT_TYPE AND g.OBJECT_SCHEMA = w.OBJECT_SCHEMA
	AND g.OBJECT_NAME = w.OBJECT_NAME AND g.LOCK_STATUS = 'GRANTED'
	AND g.OWNER_THREAD_ID <> w.OWNER_THREAD_ID
JOIN performance_schema.threads wt ON wt.THREAD_ID = w.OWNER_THREAD_ID
JOIN performance_schema.threads bt ON bt.THREAD_ID = g.OWNER_THREAD_ID
WHERE w.LOCK_STATUS = 'PENDING' AND w.OBJECT_TYPE = 'TABLE'
AND wt.PROCESSLIST_ID IS NOT NULL AND bt.PROCESSLIST_ID IS NOT NULL
ORDER BY wait_ms DESC`

func mysqlLockWaitSpec() lockWaitSpec {
	return supportedLockWaitSpec("mysql",
		requiredLockWaitSource(mysql8InnoDBLockWaitQuery, mysqlLegacyInnoDBLockWaitQuery),
		// Needs performance_schema with MDL instrumentation (on by default
		// since 8.0); without it only row-lock waits are shown.
		optionalLockWaitSource(mysqlMetadataLockWaitQuery),
	)
}

// MariaDB keeps the InnoDB information_schema tables that MySQL 8.0 removed.
func mariaDBLockWaitSpec() lockWaitSpec {
	return supportedLockWaitSpec("mariadb",
		requiredLockWaitSource(mysqlLegacyInnoDBLockWaitQuery),
		optionalLockWaitSource(mysqlMetadataLockWaitQuery),
	)
}
