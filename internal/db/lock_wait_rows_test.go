package db

import "testing"

func TestNormalizeLockWaitRowsDropsUnusableAndDuplicateEdges(t *testing.T) {
	t.Parallel()

	spec := lockWaitSpec{engine: "mysql"}
	waits := normalizeLockWaitRows(spec, []map[string]interface{}{
		{"WAITING_SESSION_ID": "5", "BLOCKING_SESSION_ID": "3", "LOCK_TYPE": "METADATA", "OBJECT_NAME": "shop.orders", "LOCK_MODE": "EXCLUSIVE", "BLOCKING_LOCK_MODE": "SHARED_READ"},
		// The same holder also holds SHARED_WRITE on the table: one edge only.
		{"WAITING_SESSION_ID": "5", "BLOCKING_SESSION_ID": "3", "LOCK_TYPE": "METADATA", "OBJECT_NAME": "shop.orders", "LOCK_MODE": "EXCLUSIVE", "BLOCKING_LOCK_MODE": "SHARED_WRITE"},
		{"WAITING_SESSION_ID": "5", "BLOCKING_SESSION_ID": "5", "LOCK_TYPE": "METADATA"},
		{"WAITING_SESSION_ID": "", "BLOCKING_SESSION_ID": "3"},
		{"WAITING_SESSION_ID": "6", "BLOCKING_SESSION_ID": "3", "LOCK_TYPE": "RECORD", "OBJECT_NAME": "shop.orders"},
	})
	if len(waits) != 2 {
		t.Fatalf("waits = %+v", waits)
	}
	if waits[0].BlockingLockMode != "SHARED_READ" || waits[1].WaitingSessionID != "6" {
		t.Fatalf("waits = %+v", waits)
	}
	if waits[0].Key == waits[1].Key {
		t.Fatalf("keys must be unique: %q", waits[0].Key)
	}
}

func TestNormalizeLockWaitRowsKeepsRacInstancesApart(t *testing.T) {
	t.Parallel()

	waits := normalizeLockWaitRows(lockWaitSpec{engine: "oracle"}, []map[string]interface{}{{
		"WAITING_INSTANCE_ID": "1", "WAITING_SESSION_ID": "120", "WAITING_SERIAL_NUMBER": "7",
		"BLOCKING_INSTANCE_ID": "2", "BLOCKING_SESSION_ID": "120", "BLOCKING_SERIAL_NUMBER": "44",
		"LOCK_TYPE": "enq: TX - row lock contention", "WAIT_MS": 1500.4,
	}})
	if len(waits) != 1 {
		t.Fatalf("the same SID on another instance is a different session: %+v", waits)
	}
	if waits[0].BlockingSerialNumber != "44" || waits[0].WaitDurationMs != 1500 {
		t.Fatalf("wait = %+v", waits[0])
	}
}

func TestNormalizeLockWaitRowsFiltersCompatiblePostgresModes(t *testing.T) {
	t.Parallel()

	spec := lockWaitSpec{engine: "opengauss", filterCompatibleModes: true}
	waits := normalizeLockWaitRows(spec, []map[string]interface{}{
		// An UPDATE waiting behind ALTER TABLE: a real conflict.
		{"waiting_session_id": "1", "blocking_session_id": "2", "lock_type": "relation", "lock_mode": "RowExclusiveLock", "blocking_lock_mode": "AccessExclusiveLock"},
		// Another writer holding RowExclusiveLock does not block it.
		{"waiting_session_id": "1", "blocking_session_id": "3", "lock_type": "relation", "lock_mode": "RowExclusiveLock", "blocking_lock_mode": "RowExclusiveLock"},
		// Row lock: ShareLock on the blocker's transaction vs its ExclusiveLock.
		{"waiting_session_id": "4", "blocking_session_id": "2", "lock_type": "transactionid", "lock_mode": "ShareLock", "blocking_lock_mode": "ExclusiveLock"},
		// pg_blocking_pids rows carry no holder mode and are always kept.
		{"waiting_session_id": "5", "blocking_session_id": "2", "lock_type": "relation", "lock_mode": "AccessShareLock"},
	})
	got := []string{}
	for _, wait := range waits {
		got = append(got, wait.WaitingSessionID+"<-"+wait.BlockingSessionID)
	}
	want := []string{"1<-2", "4<-2", "5<-2"}
	if len(got) != len(want) {
		t.Fatalf("edges = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("edges = %v, want %v", got, want)
		}
	}
}

func TestPostgresLockModesConflictMatchesDocumentedTable(t *testing.T) {
	t.Parallel()

	tests := []struct {
		requested, held string
		conflict        bool
	}{
		{"AccessShareLock", "AccessShareLock", false},
		{"AccessShareLock", "AccessExclusiveLock", true},
		{"RowShareLock", "ExclusiveLock", true},
		{"RowExclusiveLock", "ShareLock", true},
		{"ShareLock", "ShareLock", false},
		{"ShareUpdateExclusiveLock", "ShareUpdateExclusiveLock", true},
		{"ShareRowExclusiveLock", "RowShareLock", false},
		{"ExclusiveLock", "AccessShareLock", false},
		{"AccessExclusiveLock", "AccessShareLock", true},
		{"SomeFutureLock", "RowShareLock", true},
	}
	for _, test := range tests {
		if got := postgresLockModesConflict(test.requested, test.held); got != test.conflict {
			t.Fatalf("%s vs %s = %v, want %v", test.requested, test.held, got, test.conflict)
		}
		if got := postgresLockModesConflict(test.held, test.requested); got != test.conflict {
			t.Fatalf("conflicts must be symmetric: %s vs %s = %v", test.held, test.requested, got)
		}
	}
}
