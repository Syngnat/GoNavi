package db

import "fmt"

// Open-transaction queries. Every query reports the transaction's age as
// duration_ms and, where the engine knows it, the statement that is running or
// (for an idle transaction) the last one it ran.

// INNODB_TRX lists every InnoDB transaction, including a long SELECT inside an
// open transaction, which pins old row versions just the same. MySQL 8.0 also
// reads an idle transaction's last statement from performance_schema.
const mysql8LongTransactionQuery = `SELECT t.trx_mysql_thread_id AS session_id, p.USER AS user_name,
p.DB AS database_or_tenant, p.COMMAND AS state,
TIMESTAMPDIFF(MICROSECOND, t.trx_started, NOW(6)) DIV 1000 AS duration_ms,
COALESCE(t.trx_query, (
	SELECT s.SQL_TEXT FROM performance_schema.events_statements_current s
	JOIN performance_schema.threads th ON th.THREAD_ID = s.THREAD_ID
	WHERE th.PROCESSLIST_ID = t.trx_mysql_thread_id
	ORDER BY s.EVENT_ID DESC LIMIT 1
), '') AS statement
FROM information_schema.INNODB_TRX t
LEFT JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id
WHERE t.trx_mysql_thread_id <> CONNECTION_ID()
ORDER BY t.trx_started`

const mysqlLongTransactionQuery = `SELECT t.trx_mysql_thread_id AS session_id, p.USER AS user_name,
p.DB AS database_or_tenant, p.COMMAND AS state,
TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) * 1000 AS duration_ms,
COALESCE(t.trx_query, '') AS statement
FROM information_schema.INNODB_TRX t
LEFT JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id
WHERE t.trx_mysql_thread_id <> CONNECTION_ID()
ORDER BY t.trx_started`

// Background workers (autovacuum and friends) also have an xact_start but no
// client socket; only client sessions can be acted on.
const postgresLongTransactionQuery = `SELECT pid AS session_id, usename AS user_name,
datname AS database_or_tenant, COALESCE(state, '') AS state,
GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000)::bigint AS duration_ms,
COALESCE(query, '') AS statement
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND client_port IS NOT NULL AND pid <> pg_backend_pid()
ORDER BY xact_start`

const oracleLongTransactionQuery = `SELECT s.inst_id AS instance_id, s.sid AS session_id,
s.serial# AS serial_number, s.username AS user_name, s.status AS state,
s.service_name AS database_or_tenant,
ROUND((SYSDATE - t.start_date) * 86400000) AS duration_ms,
NVL(q.sql_text, '') AS statement
FROM gv$transaction t
JOIN gv$session s ON s.inst_id = t.inst_id AND s.taddr = t.addr
LEFT JOIN gv$sql q ON q.inst_id = s.inst_id AND q.sql_id = NVL(s.sql_id, s.prev_sql_id) AND q.child_number = 0
WHERE s.sid <> SYS_CONTEXT('USERENV', 'SID')
ORDER BY t.start_date`

const sqlServerLongTransactionQuery = `SELECT st.session_id AS session_id, s.login_name AS user_name,
DB_NAME(s.database_id) AS database_or_tenant, COALESCE(r.status, s.status) AS state,
CAST(DATEDIFF(SECOND, tx.transaction_begin_time, SYSDATETIME()) AS BIGINT) * 1000 AS duration_ms,
COALESCE(q.text, '') AS statement
FROM sys.dm_tran_session_transactions st
JOIN sys.dm_tran_active_transactions tx ON tx.transaction_id = st.transaction_id
JOIN sys.dm_exec_sessions s ON s.session_id = st.session_id
LEFT JOIN sys.dm_exec_requests r ON r.session_id = st.session_id
LEFT JOIN sys.dm_exec_connections c ON c.session_id = st.session_id
OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) q
WHERE s.is_user_process = 1 AND st.session_id <> @@SPID
ORDER BY tx.transaction_begin_time`

var yashanDBLongTransactionQuery = `SELECT s.SID AS session_id, s.SERIAL# AS serial_number,
s.USERNAME AS user_name, s.STATUS AS state, s.SCHEMANAME AS database_or_tenant,
` + fmt.Sprintf(yashanDBElapsedMs, "t.START_DATE") + ` AS duration_ms,
NVL((SELECT q.SQL_TEXT FROM V$SQL q WHERE q.SQL_ID = NVL(s.SQL_ID, s.PREV_SQL_ID) AND ROWNUM = 1), '') AS statement
FROM V$TRANSACTION t
JOIN V$SESSION s ON s.SID = t.SID
WHERE s.SID <> SYS_CONTEXT('USERENV', 'SID')
ORDER BY t.START_DATE`

// OceanBase lists a transaction once per participant node; the oldest
// context is the transaction's start.
const oceanBaseMySQLLongTransactionQuery = `SELECT t.SESSION_ID AS session_id, p.USER AS user_name,
p.DB AS database_or_tenant, p.COMMAND AS state,
TIMESTAMPDIFF(MICROSECOND, MIN(t.CTX_CREATE_TIME), NOW(6)) DIV 1000 AS duration_ms,
COALESCE(p.INFO, '') AS statement
FROM oceanbase.GV$OB_TRANSACTION_PARTICIPANTS t
LEFT JOIN oceanbase.GV$OB_PROCESSLIST p ON p.ID = t.SESSION_ID
WHERE t.SESSION_ID <> CONNECTION_ID()
GROUP BY t.SESSION_ID, p.USER, p.DB, p.COMMAND, p.INFO
ORDER BY duration_ms DESC`
