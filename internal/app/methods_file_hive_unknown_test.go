package app

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestHiveTransferSQLUnknownFlagStopsWithLiveContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	failure := db.MarkWriteOutcomeUnknown(errors.New("operation finished, CloseOperation cleanup failed"))
	database := &hiveTransferFake{session: &hiveTransferSession{failAt: 1, failure: failure}}
	result, err := executeSQLFileStream(ctx, database, strings.NewReader("INSERT INTO TABLE t SELECT 1; INSERT INTO TABLE t SELECT 2;"), sqlFileExecutionOptions{DBType: "hive", ContinueOnError: true}, nil)
	if ctx.Err() != nil || db.IsAmbiguousWriteResponse(failure) {
		t.Fatal("test must exercise only the unknown flag, not cancellation or transport classification")
	}
	if err == nil || !result.OutcomeUnknown || result.Executed != 0 || result.Failed != 1 || len(database.session.statements) != 1 {
		t.Fatalf("uncertain finished write continued: %#v %v calls=%#v", result, err, database.session.statements)
	}
}

func TestHiveTransferTableImportUnknownCleanupNeverAdvances(t *testing.T) {
	for _, failure := range []error{db.MarkWriteOutcomeUnknown(errors.New("finished write cleanup failed")), io.ErrUnexpectedEOF} {
		database := &hiveTransferFake{applyError: failure}
		writer := newImportDatabaseRowWriter(database, "hive", "t", newImportColumnTypeLookup([]connection.ColumnDefinition{{Name: "id", Type: "INT"}}))
		var progress []importProgressState
		consumer := newImportBatchConsumer(writer, 10, 0, false, true, func(state importProgressState) { progress = append(progress, state) })
		var retryArtifacts int
		consumer.SetRowErrorHandler(func(ImportRowError) error { retryArtifacts++; return nil })
		if err := consumer.SetColumns([]string{"id"}); err != nil {
			t.Fatal(err)
		}
		for _, id := range []int{1, 2} {
			if err := consumer.ConsumeRow(map[string]interface{}{"id": id}); err != nil {
				t.Fatal(err)
			}
		}
		err := consumer.Flush()
		result := consumer.Result()
		if !errors.Is(err, errImportStoppedOnError) || !result.OutcomeUnknown || !result.StoppedOnError || len(database.inserts) != 1 || result.Total != 1 || retryArtifacts != 0 {
			t.Fatalf("unsafe continuation/retry: result=%#v err=%v writes=%#v retryArtifacts=%d", result, err, database.inserts, retryArtifacts)
		}
		for _, state := range progress {
			if state.CheckpointSafe {
				t.Fatal("unknown write produced a safe checkpoint", state)
			}
		}
	}
}

type hiveFinishedWriteCleanupFake struct {
	hiveTransferFake
	calls int
}

func (f *hiveFinishedWriteCleanupFake) ApplyChangesContext(ctx context.Context, table string, changes connection.ChangeSet) error {
	f.calls++
	if len(changes.Inserts) > 0 {
		f.inserts = append(f.inserts, cloneImportRow(changes.Inserts[0]))
	}
	return db.MarkWriteOutcomeUnknown(errors.New("first statement committed but cleanup failed"))
}

func TestHiveTransferApplyDoesNotReplayFinishedWriteCleanupFailure(t *testing.T) {
	database := &hiveFinishedWriteCleanupFake{}
	result := (&App{}).applyHiveChanges(connection.ConnectionConfig{Type: "hive"}, "warehouse", "t", database, connection.ChangeSet{Inserts: []map[string]interface{}{{"id": 1}, {"id": 2}}})
	if result.Success || !result.OutcomeUnknown || database.calls != 1 || len(database.inserts) != 1 {
		t.Fatalf("app replayed uncertain change set: result=%#v calls=%d writes=%#v", result, database.calls, database.inserts)
	}
}
