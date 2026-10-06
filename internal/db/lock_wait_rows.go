package db

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

// normalizeLockWaitRows maps the aliased columns of every lock-wait query onto
// the shared edge type. Rows without both session IDs cannot be acted on and
// are dropped, as are duplicates (a metadata-lock holder with several granted
// modes on one table yields one row per mode).
func normalizeLockWaitRows(spec lockWaitSpec, rows []map[string]interface{}) []connection.DatabaseLockWait {
	waits := make([]connection.DatabaseLockWait, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		wait, ok := normalizeLockWaitRow(spec, normalizedSessionRow(row))
		if !ok {
			continue
		}
		if _, duplicate := seen[wait.Key]; duplicate {
			continue
		}
		seen[wait.Key] = struct{}{}
		waits = append(waits, wait)
	}
	return waits
}

func normalizeLockWaitRow(spec lockWaitSpec, values map[string]interface{}) (connection.DatabaseLockWait, bool) {
	wait := connection.DatabaseLockWait{
		WaitingSessionID:     sessionString(values, "waitingsessionid"),
		WaitingInstanceID:    sessionString(values, "waitinginstanceid"),
		WaitingSerialNumber:  sessionString(values, "waitingserialnumber"),
		WaitingUser:          sessionString(values, "waitinguser"),
		WaitingStatement:     sessionString(values, "waitingstatement"),
		BlockingSessionID:    sessionString(values, "blockingsessionid"),
		BlockingInstanceID:   sessionString(values, "blockinginstanceid"),
		BlockingSerialNumber: sessionString(values, "blockingserialnumber"),
		BlockingUser:         sessionString(values, "blockinguser"),
		BlockingState:        sessionString(values, "blockingstate"),
		BlockingStatement:    sessionString(values, "blockingstatement"),
		DatabaseOrTenant:     sessionString(values, "databaseortenant"),
		ObjectName:           unquoteLockObjectName(sessionString(values, "objectname")),
		IndexName:            sessionString(values, "indexname"),
		LockType:             sessionString(values, "locktype"),
		LockMode:             sessionString(values, "lockmode"),
		BlockingLockMode:     sessionString(values, "blockinglockmode"),
	}
	if wait.WaitingSessionID == "" || wait.BlockingSessionID == "" {
		return wait, false
	}
	if wait.WaitingSessionID == wait.BlockingSessionID && wait.WaitingInstanceID == wait.BlockingInstanceID {
		return wait, false
	}
	if spec.filterCompatibleModes && !postgresLockModesConflict(wait.LockMode, wait.BlockingLockMode) {
		return wait, false
	}
	if duration, ok := sessionInt64(values, "waitms"); ok {
		wait.WaitDurationMs = maxSessionDuration(duration)
	}
	if duration, ok := sessionInt64(values, "blockingms"); ok {
		wait.BlockingDurationMs = maxSessionDuration(duration)
	}
	wait.Key = buildLockWaitKey(spec.engine, wait)
	return wait, true
}

// unquoteLockObjectName turns InnoDB's `schema`.`table` into schema.table.
func unquoteLockObjectName(name string) string {
	if !strings.Contains(name, "`") {
		return name
	}
	return strings.ReplaceAll(name, "`", "")
}

func buildLockWaitKey(engine string, wait connection.DatabaseLockWait) string {
	return strings.Join([]string{
		strings.TrimSpace(engine),
		wait.WaitingInstanceID,
		wait.WaitingSessionID,
		wait.BlockingInstanceID,
		wait.BlockingSessionID,
		wait.LockType,
		wait.ObjectName,
	}, ":")
}
