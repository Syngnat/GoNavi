package db

import (
	"fmt"

	"GoNavi-Wails/internal/connection"
)

// YashanDB keeps Oracle's single-instance session model: V$SESSION with
// SID/SERIAL#, statement text in V$SQL, and both actions addressed as
// 'sid,serial#' (there is no RAC instance to name). Verified on 23.4.

const yashanDBElapsedMs = `ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(%s AS DATE)) * 86400000)`

var yashanDBSessionListQuery = `SELECT s.SID AS session_id, s.SERIAL# AS serial_number,
s.SCHEMANAME AS database_or_tenant, s.USERNAME AS user_name, s.STATUS AS state,
` + fmt.Sprintf(yashanDBElapsedMs, "s.EXEC_START_TIME") + ` AS duration_ms,
NVL((SELECT q.SQL_TEXT FROM V$SQL q WHERE q.SQL_ID = s.SQL_ID AND ROWNUM = 1), '') AS statement
FROM V$SESSION s
WHERE s.TYPE = 'USER' AND s.SID <> SYS_CONTEXT('USERENV', 'SID')
ORDER BY s.EXEC_START_TIME`

func yashanDBSessionSpec() sessionSpec {
	capability := supportedSessionCapability(
		true, connection.SessionActionTargetSessionID,
		true, connection.SessionActionTargetSessionID,
	)
	capability.RequiresSerial = true
	return sessionSpec{
		engine:       "yashandb",
		capability:   capability,
		listQuery:    yashanDBSessionListQuery,
		durationUnit: sessionDurationMilliseconds,
		// The schema column names the session's current schema, not a database.
		rowDatabaseAuthoritative: true,
	}
}

// buildYashanDBSessionAction cancels the running statement or kills the
// session, both addressed by 'sid,serial#' so a reused SID is never hit.
func buildYashanDBSessionAction(request connection.SessionActionRequest) (sessionActionStatement, error) {
	sessionID, err := validatedNumericSessionIdentifier(request.SessionID)
	if err != nil {
		return sessionActionStatement{}, err
	}
	serialNumber, err := validatedNumericSessionIdentifier(request.SerialNumber)
	if err != nil {
		return sessionActionStatement{}, fmt.Errorf("invalid YashanDB serial number: %w", err)
	}
	command := "ALTER SYSTEM KILL SESSION"
	if request.Action == connection.SessionActionCancelQuery {
		command = "ALTER SYSTEM CANCEL SQL"
	}
	return sessionActionStatement{sql: fmt.Sprintf("%s '%s,%s'", command, sessionID, serialNumber)}, nil
}
