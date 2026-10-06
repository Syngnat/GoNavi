package db

import "fmt"

// OceanBase (V4.2+) records a waiting transaction in GV$OB_LOCKS with
// BLOCK = 1: its TX row names the holding transaction in ID1, and its TR row
// names the tablet it waits on in ID1. GV$OB_PROCESSLIST.TRANS_ID maps both
// transactions to sessions. This follows the "查询行锁" troubleshooting guide;
// CTIME is in microseconds.

// oceanBaseMySQLLockWaitQuery takes optional tablet-name and transaction-age
// lookups; the plain variant drops them for servers that hide those views.
func oceanBaseMySQLLockWaitQuery(withLookups bool) string {
	objectName := "NULL"
	blockingAge := "NULL"
	if withLookups {
		objectName = `(SELECT CONCAT(l.DATABASE_NAME, '.', l.TABLE_NAME) FROM oceanbase.DBA_OB_TABLE_LOCATIONS l
	WHERE l.TABLET_ID = r.ID1 LIMIT 1)`
		blockingAge = `(SELECT TIMESTAMPDIFF(MICROSECOND, MIN(p.CTX_CREATE_TIME), NOW(6)) DIV 1000
	FROM oceanbase.GV$OB_TRANSACTION_PARTICIPANTS p WHERE p.TX_ID = w.ID1)`
	}
	return `SELECT wp.ID AS waiting_session_id, wp.USER AS waiting_user, wp.INFO AS waiting_statement,
ROUND(w.CTIME / 1000) AS wait_ms,
bp.ID AS blocking_session_id, bp.USER AS blocking_user, bp.COMMAND AS blocking_state,
bp.INFO AS blocking_statement, ` + blockingAge + ` AS blocking_ms,
wp.DB AS database_or_tenant,
COALESCE(` + objectName + `, CONCAT('tablet ', r.ID1)) AS object_name,
COALESCE(r.TYPE, w.TYPE) AS lock_type, w.REQUEST AS lock_mode
FROM oceanbase.GV$OB_LOCKS w
JOIN oceanbase.GV$OB_PROCESSLIST wp ON wp.TRANS_ID = w.TRANS_ID
JOIN oceanbase.GV$OB_PROCESSLIST bp ON bp.TRANS_ID = w.ID1
LEFT JOIN oceanbase.GV$OB_LOCKS r ON r.TRANS_ID = w.TRANS_ID AND r.TYPE = 'TR' AND r.BLOCK = 1
WHERE w.TYPE = 'TX' AND w.BLOCK = 1
ORDER BY wait_ms DESC`
}

// The Oracle tenant has the same views under SYS. USER is quoted because the
// bare word is the USER function; the tablet is named by id only, since the
// table-location view's Oracle-mode columns differ between releases.
const oceanBaseOracleLockWaitQuery = `SELECT wp.ID AS waiting_session_id, wp."USER" AS waiting_user,
wp.INFO AS waiting_statement, ROUND(w.CTIME / 1000) AS wait_ms,
bp.ID AS blocking_session_id, bp."USER" AS blocking_user, bp.COMMAND AS blocking_state,
bp.INFO AS blocking_statement, wp.DB AS database_or_tenant,
CASE WHEN r.ID1 IS NOT NULL THEN 'tablet ' || r.ID1 END AS object_name,
NVL(r.TYPE, w.TYPE) AS lock_type, w.REQUEST AS lock_mode
FROM SYS.GV$OB_LOCKS w
JOIN SYS.GV$OB_PROCESSLIST wp ON wp.TRANS_ID = w.TRANS_ID
JOIN SYS.GV$OB_PROCESSLIST bp ON bp.TRANS_ID = w.ID1
LEFT JOIN SYS.GV$OB_LOCKS r ON r.TRANS_ID = w.TRANS_ID AND r.TYPE = 'TR' AND r.BLOCK = 1
WHERE w.TYPE = 'TX' AND w.BLOCK = 1
ORDER BY w.CTIME DESC`

func oceanBaseMySQLLockWaitSpec() lockWaitSpec {
	return supportedLockWaitSpec("oceanbase-mysql",
		requiredLockWaitSource(oceanBaseMySQLLockWaitQuery(true), oceanBaseMySQLLockWaitQuery(false)),
	)
}

func oceanBaseOracleLockWaitSpec() lockWaitSpec {
	return supportedLockWaitSpec("oceanbase-oracle", requiredLockWaitSource(oceanBaseOracleLockWaitQuery))
}

// Dameng reports waits in V$TRXWAIT (waiting transaction ID, the transaction it
// waits for, WAIT_TIME in milliseconds); V$SESSIONS.TRX_ID maps both to
// sessions and V$LOCK.BLOCKED marks the lock being waited for.
func damengLockWaitQuery(withObject bool) string {
	objectName := "NULL"
	if withObject {
		objectName = `(SELECT sch.NAME || '.' || o.NAME FROM V$LOCK l
	JOIN SYSOBJECTS o ON o.ID = l.TABLE_ID JOIN SYSOBJECTS sch ON sch.ID = o.SCHID
	WHERE l.TRX_ID = w.ID AND l.BLOCKED = 1 AND ROWNUM = 1)`
	}
	return `SELECT ws.SESS_ID AS waiting_session_id, ws.USER_NAME AS waiting_user,
ws.SQL_TEXT AS waiting_statement, w.WAIT_TIME AS wait_ms,
bs.SESS_ID AS blocking_session_id, bs.USER_NAME AS blocking_user, bs.STATE AS blocking_state,
bs.SQL_TEXT AS blocking_statement, ws.CURR_SCH AS database_or_tenant,
` + objectName + ` AS object_name,
(SELECT l.LTYPE FROM V$LOCK l WHERE l.TRX_ID = w.ID AND l.BLOCKED = 1 AND ROWNUM = 1) AS lock_type,
(SELECT l.LMODE FROM V$LOCK l WHERE l.TRX_ID = w.ID AND l.BLOCKED = 1 AND ROWNUM = 1) AS lock_mode
FROM V$TRXWAIT w
JOIN V$SESSIONS ws ON ws.TRX_ID = w.ID
JOIN V$SESSIONS bs ON bs.TRX_ID = w.WAIT_FOR_ID
ORDER BY w.WAIT_TIME DESC`
}

func damengLockWaitSpec() lockWaitSpec {
	return supportedLockWaitSpec("dameng", requiredLockWaitSource(damengLockWaitQuery(true), damengLockWaitQuery(false)))
}

// YashanDB puts the holder's transaction ID in the waiter's V$SESSION.LOCKWAIT
// (the holder's V$SESSION.XID). The waiter's table lock that the holder also
// holds names the table; an idle holder's previous statement is the one that
// took the lock. Verified on 23.4.
var yashanDBLockWaitQuery = `SELECT w.SID AS waiting_session_id, w.SERIAL# AS waiting_serial_number,
w.USERNAME AS waiting_user,
NVL((SELECT q.SQL_TEXT FROM V$SQL q WHERE q.SQL_ID = w.SQL_ID AND ROWNUM = 1), '') AS waiting_statement,
` + fmt.Sprintf(yashanDBElapsedMs, "w.EXEC_START_TIME") + ` AS wait_ms,
b.SID AS blocking_session_id, b.SERIAL# AS blocking_serial_number, b.USERNAME AS blocking_user,
b.STATUS AS blocking_state,
NVL((SELECT q.SQL_TEXT FROM V$SQL q WHERE q.SQL_ID = NVL(b.SQL_ID, b.PREV_SQL_ID) AND ROWNUM = 1), '') AS blocking_statement,
` + fmt.Sprintf(yashanDBElapsedMs, "t.START_DATE") + ` AS blocking_ms,
w.SCHEMANAME AS database_or_tenant,
(SELECT o.OWNER || '.' || o.OBJECT_NAME FROM V$LOCK l JOIN ALL_OBJECTS o ON o.OBJECT_ID = l.ID1
	WHERE l.SID = w.SID AND EXISTS (SELECT 1 FROM V$LOCK h WHERE h.SID = b.SID AND h.ID1 = l.ID1)
	AND ROWNUM = 1) AS object_name,
w.WAIT_EVENT AS lock_type
FROM V$SESSION w
JOIN V$SESSION b ON b.XID = w.LOCKWAIT
LEFT JOIN V$TRANSACTION t ON t.XID = b.XID
WHERE w.LOCKWAIT IS NOT NULL
ORDER BY w.EXEC_START_TIME`

func yashanDBLockWaitSpec() lockWaitSpec {
	return supportedLockWaitSpec("yashandb", requiredLockWaitSource(yashanDBLockWaitQuery))
}
