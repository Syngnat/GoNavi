package sync

import (
	"context"
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type blockingLegacyBatchApplier struct {
	started chan struct{}
	release chan struct{}
}

func (a *blockingLegacyBatchApplier) ApplyChanges(string, connection.ChangeSet) error {
	close(a.started)
	<-a.release
	return nil
}

func TestApplySyncChangesContextMarksLegacyCancellationOutcomeUnknown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	applier := &blockingLegacyBatchApplier{started: make(chan struct{}), release: make(chan struct{})}
	errCh := make(chan error, 1)
	go func() {
		errCh <- applySyncChangesContext(markSyncDriverContext(ctx), applier, "events", connection.ChangeSet{
			Inserts: []map[string]interface{}{{"id": 1}},
		})
	}()

	<-applier.started
	cancel()
	close(applier.release)
	err := <-errCh
	if !db.IsWriteOutcomeUnknown(err) || !errors.Is(err, context.Canceled) {
		t.Fatalf("legacy apply cancellation must be outcome unknown, got %v", err)
	}
}
