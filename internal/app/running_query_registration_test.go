package app

import (
	"context"
	"testing"
)

func TestRegisterExclusiveRunningQueryRejectsDuplicateWithoutReplacingOwner(t *testing.T) {
	app := NewApp()
	queryID := "exclusive-import-job"

	firstCtx, firstCancel := context.WithCancel(context.Background())
	defer firstCancel()
	cleanupFirst, registered := app.registerExclusiveRunningQuery(queryID, firstCancel, true)
	if !registered {
		t.Fatal("first exclusive registration should succeed")
	}
	defer cleanupFirst()

	secondCtx, secondCancel := context.WithCancel(context.Background())
	defer secondCancel()
	cleanupSecond, registered := app.registerExclusiveRunningQuery(queryID, secondCancel, true)
	if registered {
		cleanupSecond()
		t.Fatal("duplicate exclusive registration should be rejected")
	}

	if result := app.CancelQuery(queryID); !result.Success {
		t.Fatalf("registered owner should remain cancellable: %s", result.Message)
	}
	select {
	case <-firstCtx.Done():
	default:
		t.Fatal("cancellation should reach the original registration")
	}
	select {
	case <-secondCtx.Done():
		t.Fatal("rejected duplicate must not replace or receive cancellation")
	default:
	}

	app.queryMu.RLock()
	_, retained := app.runningQueries[queryID]
	app.queryMu.RUnlock()
	if !retained {
		t.Fatal("retainUntilDone registration must remain until owner cleanup")
	}
}
