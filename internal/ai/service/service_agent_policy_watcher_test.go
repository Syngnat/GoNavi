package aiservice

import (
	"fmt"
	"os"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
)

func TestAgentRunPolicyWatcherAppliesExternalRevision(t *testing.T) {
	oldInterval := agentRunPolicyWatchInterval
	agentRunPolicyWatchInterval = 10 * time.Millisecond
	t.Cleanup(func() { agentRunPolicyWatchInterval = oldInterval })

	service, _ := newInitializedAgentHarnessService(t)
	initial, err := service.AIGetRunPolicy()
	if err != nil {
		t.Fatalf("AIGetRunPolicy: %v", err)
	}
	updated := initial
	updated.Revision++
	updated.Policy.SoftToolRoundLimit = 3
	updated.Runtime.ControlPollInterval = 17 * time.Millisecond
	if err := saveServiceRunPolicy(service.agentPolicyPath(), updated); err != nil {
		t.Fatalf("save external policy: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		service.agentMu.RLock()
		harness := service.agentHarness
		service.agentMu.RUnlock()
		if harness != nil && harness.DefaultPolicy().SoftToolRoundLimit == 3 && harness.RuntimeConfig().ControlPollInterval == 17*time.Millisecond {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("external policy revision was not applied: policy=%+v runtime=%+v", harnessDefaultPolicy(service), harnessRuntimeConfig(service))
}

func TestAgentRunPolicyWatcherKeepsLastGoodConfigForInvalidFile(t *testing.T) {
	oldInterval := agentRunPolicyWatchInterval
	agentRunPolicyWatchInterval = 10 * time.Millisecond
	t.Cleanup(func() { agentRunPolicyWatchInterval = oldInterval })

	service, _ := newInitializedAgentHarnessService(t)
	initial, err := service.AIGetRunPolicy()
	if err != nil {
		t.Fatalf("AIGetRunPolicy: %v", err)
	}
	invalid := initial
	invalid.Revision++
	invalid.Policy.SoftToolRoundLimit = -1
	if err := saveInvalidAgentPolicy(service.agentPolicyPath(), invalid); err != nil {
		t.Fatalf("save invalid policy: %v", err)
	}

	time.Sleep(100 * time.Millisecond)
	if got := harnessDefaultPolicy(service); got != initial.Policy {
		t.Fatalf("invalid external policy changed live defaults: got=%+v want=%+v", got, initial.Policy)
	}
	if got := harnessRuntimeConfig(service); got != initial.Runtime {
		t.Fatalf("invalid external policy changed live runtime: got=%+v want=%+v", got, initial.Runtime)
	}
}

func TestAgentRunPolicyWatcherStopsBeforeHarnessDetach(t *testing.T) {
	service, _ := newInitializedAgentHarnessService(t)
	service.agentPolicyWatcherMu.Lock()
	if service.agentPolicyWatcherCancel == nil || service.agentPolicyWatcherDone == nil {
		service.agentPolicyWatcherMu.Unlock()
		t.Fatal("expected policy watcher to be running")
	}
	service.agentPolicyWatcherMu.Unlock()

	service.Shutdown()
	service.agentPolicyWatcherMu.Lock()
	defer service.agentPolicyWatcherMu.Unlock()
	if service.agentPolicyWatcherCancel != nil || service.agentPolicyWatcherDone != nil {
		t.Fatal("policy watcher remained active after shutdown")
	}
}

func TestAgentRunPolicyWatcherReadsConfiguredInterval(t *testing.T) {
	path := t.TempDir() + "/agent_run_policy.json"
	snapshot := runharness.DefaultRunPolicySnapshot()
	snapshot.Runtime.PolicyWatchInterval = 125 * time.Millisecond
	if err := saveServiceRunPolicy(path, snapshot); err != nil {
		t.Fatalf("save policy: %v", err)
	}

	watcher := &agentRunPolicyWatcher{path: path, lastRevision: snapshot.Revision}
	interval := (&Service{}).reloadAgentRunPolicy(watcher)
	if interval != 125*time.Millisecond {
		t.Fatalf("watcher interval = %s, want 125ms", interval)
	}
}

func saveInvalidAgentPolicy(path string, snapshot runharness.RunPolicySnapshot) error {
	// Bypass saveServiceRunPolicy validation to simulate a bad external edit.
	data := []byte(fmt.Sprintf(`{"schemaVersion":%d,"revision":%d,"policy":{"softToolRoundLimit":-1},"runtime":{}}`, snapshot.SchemaVersion, snapshot.Revision))
	return os.WriteFile(path, data, 0o600)
}

func harnessDefaultPolicy(service *Service) runharness.RunPolicy {
	service.agentMu.RLock()
	harness := service.agentHarness
	service.agentMu.RUnlock()
	if harness == nil {
		return runharness.RunPolicy{}
	}
	return harness.DefaultPolicy()
}

func harnessRuntimeConfig(service *Service) runharness.RunRuntimeConfig {
	service.agentMu.RLock()
	harness := service.agentHarness
	service.agentMu.RUnlock()
	if harness == nil {
		return runharness.RunRuntimeConfig{}
	}
	return harness.RuntimeConfig()
}
