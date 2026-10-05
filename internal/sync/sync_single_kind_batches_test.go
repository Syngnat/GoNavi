package sync

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

type recordingChangeSetApplier struct {
	fakeMigrationDB
	calls []connection.ChangeSet
}

func (r *recordingChangeSetApplier) ApplyChanges(_ string, changes connection.ChangeSet) error {
	r.calls = append(r.calls, changes)
	return nil
}

func TestSingleKindBatchTargetsCommitEachKindSeparately(t *testing.T) {
	if !targetNeedsSingleKindBatches(connection.ConnectionConfig{Type: "gbase8a"}) {
		t.Fatal("GBase 8a cannot mix writes to one table inside a transaction")
	}
	if targetNeedsSingleKindBatches(connection.ConnectionConfig{Type: "mysql"}) || targetNeedsSingleKindBatches(connection.ConnectionConfig{Type: "tidb"}) {
		t.Fatal("other targets keep mixed atomic batches")
	}
	changes := connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": 1}, {"id": 2}, {"id": 3}},
		Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"id": 4}, Values: map[string]interface{}{"v": "x"}}},
		Deletes: []map[string]interface{}{{"id": 5}},
	}
	applier := &recordingChangeSetApplier{}
	config := SyncConfig{TargetConfig: connection.ConnectionConfig{Type: "gbase8a"}, BatchSize: 2}
	applied, err := NewSyncEngine(Reporter{}).applySnapshotChangesByPolicy(config, &SyncResult{}, "t", "t", applier, changes, 0)
	if err != nil {
		t.Fatal(err)
	}
	if applied.Inserts != 3 || applied.Updates != 1 || applied.Deletes != 1 {
		t.Fatalf("applied counts %+v", applied)
	}
	if len(applier.calls) != 4 {
		t.Fatalf("expected delete, update and two insert batches, got %d calls", len(applier.calls))
	}
	for i, call := range applier.calls {
		kinds := 0
		for _, count := range []int{len(call.Inserts), len(call.Updates), len(call.Deletes)} {
			if count > 0 {
				kinds++
			}
		}
		if kinds != 1 {
			t.Fatalf("call %d mixes kinds: %+v", i, call)
		}
	}
	if len(applier.calls[0].Deletes) != 1 || len(applier.calls[1].Updates) != 1 || len(applier.calls[2].Inserts) != 2 || len(applier.calls[3].Inserts) != 1 {
		t.Fatalf("unexpected order or sizes: %+v", applier.calls)
	}
}
