package aiservice

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/appdata"
)

func TestApplyAgentDataDirectoryMigratesReadableLedgerAndKeepsSource(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	source := filepath.Join(t.TempDir(), "data-root")
	if _, err := appdata.SetActiveRoot(source); err != nil {
		t.Fatal(err)
	}
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = source
	service.agentContext = context.Background()
	if err := service.initializeAgentHarness(service.agentContext); err != nil {
		t.Fatal(err)
	}
	defer service.Shutdown()
	if _, err := service.agentLedger.CreateSession(context.Background(), runharness.CreateSessionRequest{
		SessionID: "migrated-session", Title: "kept",
	}); err != nil {
		t.Fatal(err)
	}

	target := filepath.Join(t.TempDir(), "agent-data")
	info, err := service.AIApplyAgentDataDirectory(target, true)
	if err != nil {
		t.Fatalf("AIApplyAgentDataDirectory: %v", err)
	}
	if info.Directory != target || !info.RestartRequired || info.Stats.SessionCount != 1 {
		t.Fatalf("unexpected migrated info: %+v", info)
	}
	if _, err := os.Stat(filepath.Join(source, agentLedgerFileName)); err != nil {
		t.Fatalf("source ledger was not retained: %v", err)
	}
	copyLedger, err := runharness.Open(filepath.Join(target, agentLedgerFileName), runharness.WithKeyFile(filepath.Join(target, agentLedgerKeyFileName)))
	if err != nil {
		t.Fatalf("open migrated ledger: %v", err)
	}
	defer copyLedger.Close()
	projection, err := copyLedger.GetSession(context.Background(), "migrated-session", false)
	if err != nil || projection.Title != "kept" {
		t.Fatalf("migrated session = %+v, %v", projection, err)
	}
}

func TestApplyAgentDataDirectoryFailureKeepsConfiguredSource(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	source := filepath.Join(t.TempDir(), "data-root")
	if _, err := appdata.SetActiveRoot(source); err != nil {
		t.Fatal(err)
	}
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = source
	service.agentContext = context.Background()
	if err := service.initializeAgentHarness(service.agentContext); err != nil {
		t.Fatal(err)
	}
	defer service.Shutdown()

	target := filepath.Join(t.TempDir(), "agent-data")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	blocking := filepath.Join(target, agentLedgerFileName)
	if err := os.WriteFile(blocking, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AIApplyAgentDataDirectory(target, true); err == nil {
		t.Fatal("expected migration into existing agent data to fail")
	}
	configured, err := appdata.ResolveConfiguredAgentDataDirectory()
	if err != nil || configured != "" {
		t.Fatalf("failed migration changed configured directory to %q, %v", configured, err)
	}
	data, err := os.ReadFile(blocking)
	if err != nil || string(data) != "existing" {
		t.Fatalf("failed migration changed target data: %q, %v", data, err)
	}
}

func TestApplyAgentDataDirectoryRejectsMigrationWhileRunIsActive(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	source := filepath.Join(t.TempDir(), "data-root")
	if _, err := appdata.SetActiveRoot(source); err != nil {
		t.Fatal(err)
	}
	service := NewServiceWithSecretStore(newAgentHarnessTestSecretStore())
	service.configDir = source
	service.agentContext = context.Background()
	if err := service.initializeAgentHarness(service.agentContext); err != nil {
		t.Fatal(err)
	}
	defer service.Shutdown()
	if _, err := service.agentLedger.CreateRun(context.Background(), runharness.CreateRunRequest{
		SessionID: "active-session", RequestID: "active-request", Policy: runharness.DefaultRunPolicy(),
	}); err != nil {
		t.Fatal(err)
	}

	target := filepath.Join(t.TempDir(), "agent-data")
	if _, err := service.AIApplyAgentDataDirectory(target, true); err == nil {
		t.Fatal("expected active run to block migration")
	}
	configured, err := appdata.ResolveConfiguredAgentDataDirectory()
	if err != nil || configured != "" {
		t.Fatalf("blocked migration changed configured directory to %q, %v", configured, err)
	}
	if _, err := os.Stat(filepath.Join(target, agentLedgerFileName)); !os.IsNotExist(err) {
		t.Fatalf("blocked migration installed a ledger: %v", err)
	}
}
