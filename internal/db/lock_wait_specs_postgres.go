package db

import (
	"fmt"
	"slices"
)

// pg_blocking_pids (PostgreSQL 9.6+) asks the server who blocks whom, which
// accounts for the lock queue order and parallel workers. Older servers and
// the openGauss lineage only have pg_locks, where holders and waiters are
// paired on the lock tag; that pairing also matches holders of compatible
// modes, so those specs drop edges whose modes cannot conflict.

const postgresWaitDuration = `GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(w.query_start, w.state_change, w.backend_start))) * 1000)::bigint`

// A row lock wait is a wait on the blocker's transaction ID and names no
// relation; the first waiter on a row holds the tuple lock of that row, which
// does.
const postgresWaitObjectName = `COALESCE(
	CASE WHEN %[1]s.relation IS NOT NULL THEN %[1]s.relation::regclass::text END,
	(SELECT t.relation::regclass::text FROM pg_locks t WHERE t.pid = w.pid AND t.locktype = 'tuple' AND t.granted LIMIT 1)
)`

const postgresBlockerDuration = `GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(b.xact_start, b.query_start, b.backend_start))) * 1000)::bigint`

var postgresBlockingPidsLockWaitQuery = `SELECT w.pid AS waiting_session_id, w.usename AS waiting_user,
COALESCE(w.query, '') AS waiting_statement, ` + postgresWaitDuration + ` AS wait_ms,
b.pid AS blocking_session_id, b.usename AS blocking_user,
COALESCE(b.state, '') AS blocking_state, COALESCE(b.query, '') AS blocking_statement,
` + postgresBlockerDuration + ` AS blocking_ms,
w.datname AS database_or_tenant,
` + fmt.Sprintf(postgresWaitObjectName, "l") + ` AS object_name,
l.locktype AS lock_type, l.mode AS lock_mode
FROM pg_stat_activity w
CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS blocker(pid)
JOIN pg_stat_activity b ON b.pid = blocker.pid
LEFT JOIN pg_locks l ON l.pid = w.pid AND NOT l.granted
WHERE w.pid <> pg_backend_pid()
ORDER BY wait_ms DESC`

var postgresLockTagLockWaitQuery = `SELECT wl.pid AS waiting_session_id, w.usename AS waiting_user,
COALESCE(w.query, '') AS waiting_statement, ` + postgresWaitDuration + ` AS wait_ms,
bl.pid AS blocking_session_id, b.usename AS blocking_user,
COALESCE(b.state, '') AS blocking_state, COALESCE(b.query, '') AS blocking_statement,
` + postgresBlockerDuration + ` AS blocking_ms,
w.datname AS database_or_tenant,
` + fmt.Sprintf(postgresWaitObjectName, "wl") + ` AS object_name,
wl.locktype AS lock_type, wl.mode AS lock_mode, bl.mode AS blocking_lock_mode
FROM pg_locks wl
JOIN pg_stat_activity w ON w.pid = wl.pid
JOIN pg_locks bl ON bl.granted AND bl.pid <> wl.pid
	AND bl.locktype = wl.locktype
	AND bl.database IS NOT DISTINCT FROM wl.database
	AND bl.relation IS NOT DISTINCT FROM wl.relation
	AND bl.page IS NOT DISTINCT FROM wl.page
	AND bl.tuple IS NOT DISTINCT FROM wl.tuple
	AND bl.virtualxid IS NOT DISTINCT FROM wl.virtualxid
	AND bl.transactionid IS NOT DISTINCT FROM wl.transactionid
	AND bl.classid IS NOT DISTINCT FROM wl.classid
	AND bl.objid IS NOT DISTINCT FROM wl.objid
	AND bl.objsubid IS NOT DISTINCT FROM wl.objsubid
JOIN pg_stat_activity b ON b.pid = bl.pid
WHERE NOT wl.granted
ORDER BY wait_ms DESC`

func postgresLockWaitSpec(engine string) lockWaitSpec {
	spec := supportedLockWaitSpec(engine,
		requiredLockWaitSource(postgresBlockingPidsLockWaitQuery, postgresLockTagLockWaitQuery),
	)
	spec.filterCompatibleModes = true
	return spec
}

func openGaussLockWaitSpec(engine string) lockWaitSpec {
	spec := supportedLockWaitSpec(engine, requiredLockWaitSource(postgresLockTagLockWaitQuery))
	spec.filterCompatibleModes = true
	return spec
}

// postgresLockModeLevels orders the eight table-level lock modes; the
// conflict table below is indexed by these levels.
var postgresLockModeLevels = map[string]int{
	"accesssharelock":          1,
	"rowsharelock":             2,
	"rowexclusivelock":         3,
	"shareupdateexclusivelock": 4,
	"sharelock":                5,
	"sharerowexclusivelock":    6,
	"exclusivelock":            7,
	"accessexclusivelock":      8,
}

// postgresLockConflicts[level] lists the levels that mode conflicts with, as
// documented in "Conflicting Lock Modes". The relation is symmetric.
var postgresLockConflicts = map[int][]int{
	1: {8},
	2: {7, 8},
	3: {5, 6, 7, 8},
	4: {4, 5, 6, 7, 8},
	5: {3, 4, 6, 7, 8},
	6: {3, 4, 5, 6, 7, 8},
	7: {2, 3, 4, 5, 6, 7, 8},
	8: {1, 2, 3, 4, 5, 6, 7, 8},
}

// postgresLockModesConflict reports false only when both modes are known and
// compatible, so an unrecognized mode never hides a real blocker.
func postgresLockModesConflict(requested, held string) bool {
	requestedLevel, okRequested := postgresLockModeLevels[normalizeSessionColumnName(requested)]
	heldLevel, okHeld := postgresLockModeLevels[normalizeSessionColumnName(held)]
	if !okRequested || !okHeld {
		return true
	}
	return slices.Contains(postgresLockConflicts[requestedLevel], heldLevel)
}
