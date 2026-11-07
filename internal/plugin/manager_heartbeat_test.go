package plugin

import (
	"context"
	"testing"
	"time"
)

// A plugin that is slow but alive must survive the miss budget: the confirmation
// probe absorbs transient stalls instead of persisting a quarantine.
func TestSlowHeartbeatRecoversWithoutQuarantine(t *testing.T) {
	m := testManager(t)
	status := installFixture(t, m, "test.slow-heartbeat", "slow-heartbeat")
	enableFixture(t, m, status.Manifest.ID)
	if err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, status.Manifest.ID, StateRunning)
	// Two seconds span several full miss budgets and their confirmation windows.
	time.Sleep(2 * time.Second)
	state, err := m.loadState()
	if err != nil {
		t.Fatal(err)
	}
	record := state.Records[status.Manifest.ID]
	if record.Quarantined || record.State != StateRunning {
		t.Fatalf("slow plugin was faulted: quarantined=%v state=%s lastError=%q", record.Quarantined, record.State, record.LastError)
	}
}
