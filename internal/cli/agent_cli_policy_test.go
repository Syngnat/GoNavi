package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/appdata"
)

func TestLoadAgentPolicyAcceptsBarePolicyObject(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	data := []byte(`{"maxToolRounds":4,"softToolRoundLimit":2,"defaultDispatchMode":"queue"}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("loadAgentPolicy: %v", err)
	}
	if snapshot.Revision != 1 || snapshot.SchemaVersion != runharness.CurrentSchemaVersion {
		t.Fatalf("bare policy snapshot = %+v, want initial revisioned snapshot", snapshot)
	}
	if snapshot.Policy.MaxToolRounds != 4 || snapshot.Policy.SoftToolRoundLimit != 2 || snapshot.Policy.DefaultDispatchMode != runharness.DispatchQueue {
		t.Fatalf("bare policy was ignored: %+v", snapshot.Policy)
	}
}

func TestLoadAgentPolicyDecodesRuntimeWrapper(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	want := runharness.DefaultRunPolicySnapshot()
	want.Revision = 7
	want.Runtime = runharness.RunRuntimeConfig{
		ControlPollInterval:            375 * time.Millisecond,
		WorkspaceSnapshotRenewInterval: 2 * time.Second,
		WorkspaceSnapshotLeaseDuration: 9 * time.Second,
		PolicyWatchInterval:            runharness.DefaultRunPolicyWatchInterval,
	}
	if err := saveAgentPolicy(path, want); err != nil {
		t.Fatalf("saveAgentPolicy: %v", err)
	}

	got, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("loadAgentPolicy: %v", err)
	}
	if got != want {
		t.Fatalf("loaded snapshot = %+v, want %+v", got, want)
	}
}

func TestRunAgentConfigSetWritesRuntimeOverrides(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{
		"set", "--file", path, "--revision", "1",
		"--set", "control-poll-interval=375ms,workspaceSnapshotRenewInterval=2s,workspace-snapshot-lease-duration=9s,policy-watch-interval=750ms",
	}, &stdout, &stderr)
	if code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var got runharness.RunPolicySnapshot
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("decode config set output: %v; output=%q", err, stdout.String())
	}
	wantRuntime := runharness.RunRuntimeConfig{
		ControlPollInterval:            375 * time.Millisecond,
		WorkspaceSnapshotRenewInterval: 2 * time.Second,
		WorkspaceSnapshotLeaseDuration: 9 * time.Second,
		PolicyWatchInterval:            750 * time.Millisecond,
	}
	if got.Runtime != wantRuntime {
		t.Fatalf("runtime = %+v, want %+v", got.Runtime, wantRuntime)
	}
	stored, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("load stored policy: %v", err)
	}
	if stored.Runtime != wantRuntime || stored.Revision != 2 {
		t.Fatalf("stored snapshot = %+v", stored)
	}
}

func TestRunAgentConfigSetRejectsRenewIntervalAtLease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{
		"set", "--file", path, "--revision", "1",
		"--set", "workspace-snapshot-renew-interval=15s",
	}, &stdout, &stderr)
	if code != ExitUsage || !strings.Contains(stderr.String(), "shorter than lease") {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	loaded, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("load policy after rejected mutation: %v", err)
	}
	defaults := runharness.DefaultRunPolicySnapshot()
	if loaded != defaults {
		t.Fatalf("rejected mutation changed policy: got %+v want %+v", loaded, defaults)
	}
}

func TestAgentPollIntervalUsesRuntimeUnlessExplicitFlag(t *testing.T) {
	runtime := runharness.RunRuntimeConfig{
		ControlPollInterval:            875 * time.Millisecond,
		WorkspaceSnapshotRenewInterval: 2 * time.Second,
		WorkspaceSnapshotLeaseDuration: 9 * time.Second,
	}
	withoutFlag := newFlagSet("agent test")
	poll := withoutFlag.Duration("poll", 0, "poll")
	if err := parseAgentFlags(withoutFlag, nil); err != nil {
		t.Fatal(err)
	}
	if got := agentPollInterval(withoutFlag, *poll, runtime); got != runtime.ControlPollInterval {
		t.Fatalf("configured poll = %s, want %s", got, runtime.ControlPollInterval)
	}

	withFlag := newFlagSet("agent test")
	explicit := withFlag.Duration("poll", 0, "poll")
	if err := parseAgentFlags(withFlag, []string{"--poll", "17ms"}); err != nil {
		t.Fatal(err)
	}
	if got := agentPollInterval(withFlag, *explicit, runtime); got != 17*time.Millisecond {
		t.Fatalf("explicit poll = %s, want 17ms", got)
	}
}

func TestLoadAgentPolicyRejectsMalformedWrapper(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"policy":"broken","maxToolRounds":4}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAgentPolicy(path); err == nil {
		t.Fatal("loadAgentPolicy accepted a malformed policy wrapper")
	}
}

func TestLoadAgentPolicyRejectsNullDocument(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`null`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAgentPolicy(path); err == nil {
		t.Fatal("loadAgentPolicy accepted a null document")
	}
}

func TestRunAgentConfigShowEmitsRunPolicySnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	want := runharness.DefaultRunPolicySnapshot()
	want.Revision = 4
	want.Policy.MaxToolRounds = 20
	if err := saveAgentPolicy(path, want); err != nil {
		t.Fatalf("saveAgentPolicy: %v", err)
	}

	var stdout, stderr bytes.Buffer
	if code := runAgentConfig(context.Background(), []string{"show", "--file", path}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var got runharness.RunPolicySnapshot
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("decode config show output: %v; output=%q", err, stdout.String())
	}
	if got != want {
		t.Fatalf("config show = %+v, want %+v", got, want)
	}
}

func TestRunAgentConfigSetRequiresExpectedRevision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{"set", "--file", path, "--set", "max-tool-rounds=4"}, &stdout, &stderr)
	if code != ExitActionRequired || !strings.Contains(stderr.String(), `"code":"revision_conflict"`) {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config set without revision wrote policy: %v", err)
	}
}

func TestRunAgentConfigSetWritesNextSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{"set", "--file", path, "--revision", "1", "--set", "soft-tool-round-limit=2,max-tool-rounds=4"}, &stdout, &stderr)
	if code != ExitSuccess {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var emitted runharness.RunPolicySnapshot
	if err := json.Unmarshal(stdout.Bytes(), &emitted); err != nil {
		t.Fatalf("decode config set output: %v; output=%q", err, stdout.String())
	}
	if emitted.Revision != 2 || emitted.Policy.SoftToolRoundLimit != 2 || emitted.Policy.MaxToolRounds != 4 {
		t.Fatalf("config set snapshot = %+v", emitted)
	}
	stored, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("loadAgentPolicy: %v", err)
	}
	if stored != emitted {
		t.Fatalf("stored policy = %+v, want emitted %+v", stored, emitted)
	}
}

func TestRunAgentConfigSetRejectsStaleRevision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	seed := runharness.DefaultRunPolicySnapshot()
	seed.Revision = 2
	if err := saveAgentPolicy(path, seed); err != nil {
		t.Fatalf("saveAgentPolicy: %v", err)
	}

	var stdout, stderr bytes.Buffer
	code := runAgentConfig(context.Background(), []string{"set", "--file", path, "--expected-revision", "1", "--set", "max-tool-rounds=4"}, &stdout, &stderr)
	if code != ExitActionRequired || !strings.Contains(stderr.String(), `"code":"revision_conflict"`) {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	loaded, err := loadAgentPolicy(path)
	if err != nil {
		t.Fatalf("loadAgentPolicy: %v", err)
	}
	if loaded != seed {
		t.Fatalf("stale config set changed policy: got %+v want %+v", loaded, seed)
	}
}

func TestMutateAgentPolicyConcurrentCAS(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	start := make(chan struct{})
	type result struct {
		snapshot runharness.RunPolicySnapshot
		err      error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			<-start
			snapshot, err := mutateAgentPolicy(path, 1, "soft-tool-round-limit=2,max-tool-rounds=4")
			results <- result{snapshot: snapshot, err: err}
		}()
	}
	close(start)
	left, right := <-results, <-results

	successes, conflicts := 0, 0
	for _, item := range []result{left, right} {
		if item.err == nil {
			successes++
			if item.snapshot.Revision != 2 {
				t.Fatalf("successful mutation revision=%d, want 2", item.snapshot.Revision)
			}
			continue
		}
		if errors.Is(item.err, runharness.ErrRevisionConflict) && strings.Contains(item.err.Error(), "revision_conflict") {
			conflicts++
			continue
		}
		t.Fatalf("unexpected concurrent mutation error: %v", item.err)
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent mutations: successes=%d conflicts=%d", successes, conflicts)
	}
}

func TestMutateAgentPolicyWaitsForExternalLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create policy directory: %v", err)
	}
	lock, err := appdata.AcquireFileLock(path + ".lock")
	if err != nil {
		t.Fatalf("acquire policy lock: %v", err)
	}

	finished := make(chan error, 1)
	go func() {
		_, mutateErr := mutateAgentPolicy(path, 1, "soft-tool-round-limit=2,max-tool-rounds=4")
		finished <- mutateErr
	}()
	select {
	case mutateErr := <-finished:
		t.Fatalf("policy mutation acquired external lock before release: %v", mutateErr)
	case <-time.After(50 * time.Millisecond):
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("release policy lock: %v", err)
	}
	select {
	case mutateErr := <-finished:
		if mutateErr != nil {
			t.Fatalf("policy mutation after lock release: %v", mutateErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("policy mutation did not acquire external lock after release")
	}
}
