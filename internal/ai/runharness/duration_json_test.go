package runharness

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRunRuntimeConfigUnmarshalAcceptsDurationStringsAndNanoseconds(t *testing.T) {
	var config RunRuntimeConfig
	if err := json.Unmarshal([]byte(`{"controlPollInterval":"375ms","workspaceSnapshotRenewInterval":2000000000,"workspaceSnapshotLeaseDuration":"9s","policyWatchInterval":"750ms"}`), &config); err != nil {
		t.Fatalf("unmarshal mixed duration formats: %v", err)
	}
	want := RunRuntimeConfig{
		ControlPollInterval:            375 * time.Millisecond,
		WorkspaceSnapshotRenewInterval: 2 * time.Second,
		WorkspaceSnapshotLeaseDuration: 9 * time.Second,
		PolicyWatchInterval:            750 * time.Millisecond,
	}
	if config != want {
		t.Fatalf("config = %+v, want %+v", config, want)
	}

	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("marshal runtime config: %v", err)
	}
	if strings.Contains(string(encoded), `"375ms"`) || !strings.Contains(string(encoded), "375000000") {
		t.Fatalf("marshal changed the numeric wire format: %s", encoded)
	}
}

func TestRunRuntimeConfigUnmarshalRejectsInvalidDuration(t *testing.T) {
	for _, input := range []string{
		`{"controlPollInterval":"not-a-duration"}`,
		`{"controlPollInterval":1.5}`,
		`{"controlPollInterval":true}`,
		`{"policyWatchInterval":"not-a-duration"}`,
	} {
		var config RunRuntimeConfig
		if err := json.Unmarshal([]byte(input), &config); err == nil {
			t.Fatalf("unmarshal accepted invalid duration %s", input)
		}
	}
}

func TestRunRuntimeConfigUnmarshalPreservesOmittedFields(t *testing.T) {
	config := RunRuntimeConfig{
		ControlPollInterval:            375 * time.Millisecond,
		WorkspaceSnapshotRenewInterval: 2 * time.Second,
		WorkspaceSnapshotLeaseDuration: 9 * time.Second,
	}
	if err := json.Unmarshal([]byte(`{"controlPollInterval":"500ms"}`), &config); err != nil {
		t.Fatalf("unmarshal partial config: %v", err)
	}
	if config.ControlPollInterval != 500*time.Millisecond || config.WorkspaceSnapshotRenewInterval != 2*time.Second || config.WorkspaceSnapshotLeaseDuration != 9*time.Second {
		t.Fatalf("partial unmarshal changed omitted fields: %+v", config)
	}
}
