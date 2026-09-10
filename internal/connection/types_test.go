package connection

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestSSHRuntimeSnapshotCarriesOnlyAgentSafeState(t *testing.T) {
	progressCalls := 0
	config := SSHConfig{
		Host: "127.0.0.1",
		Port: 37167,
	}.WithProgressReporter(func(SSHProgressEvent) { progressCalls++ }).
		WithManagedHostKeyTrustStore("/private/gonavi/ssh/host_keys.json").
		WithHostKeyIdentity("bastion.example.test", 37167)

	snapshot := config.RuntimeSnapshot()
	if snapshot == nil {
		t.Fatal("expected SSH runtime snapshot")
	}
	if snapshot.ManagedHostKeyTrustStorePath != "/private/gonavi/ssh/host_keys.json" {
		t.Fatalf("managed trust-store path = %q", snapshot.ManagedHostKeyTrustStorePath)
	}
	if snapshot.HostKeyIdentityHost != "bastion.example.test" || snapshot.HostKeyIdentityPort != 37167 {
		t.Fatalf("logical host-key identity = %#v", snapshot)
	}

	restored := SSHConfig{Host: "127.0.0.1", Port: 1}.WithRuntimeSnapshot(snapshot)
	if got := restored.ManagedHostKeyTrustStorePath(); got != snapshot.ManagedHostKeyTrustStorePath {
		t.Fatalf("restored managed trust-store path = %q", got)
	}
	if host, port := restored.HostKeyIdentity(); host != snapshot.HostKeyIdentityHost || port != snapshot.HostKeyIdentityPort {
		t.Fatalf("restored logical host-key identity = %q:%d", host, port)
	}

	restored.ReportProgress("tcp_connected", "success")
	if progressCalls != 0 {
		t.Fatalf("agent runtime snapshot must not carry progress callbacks, got %d calls", progressCalls)
	}

	encoded, err := json.Marshal(restored)
	if err != nil {
		t.Fatalf("marshal restored SSH config: %v", err)
	}
	if string(encoded) != `{"host":"127.0.0.1","port":1,"user":"","password":"","keyPath":""}` {
		t.Fatalf("SSH runtime snapshot leaked into persisted config: %s", encoded)
	}
}

func TestConnectionConfigRuntimeOracleCurrentSchemaIsNotSerialized(t *testing.T) {
	config := ConnectionConfig{
		Type:     "oracle",
		Host:     "oracle.local",
		Port:     1521,
		User:     "TEST",
		Database: "ORCLPDB1",
	}.WithRuntimeOracleCurrentSchema("PRO")

	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("marshal Oracle config: %v", err)
	}
	if len(encoded) == 0 || !json.Valid(encoded) {
		t.Fatalf("invalid serialized Oracle config: %s", encoded)
	}
	if bytes.Contains(encoded, []byte(`"PRO"`)) {
		t.Fatalf("runtime Oracle schema leaked into serialized config: %s", encoded)
	}

	var decoded ConnectionConfig
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal Oracle config: %v", err)
	}
	if decoded.RuntimeOracleCurrentSchema() != "" {
		t.Fatalf("runtime Oracle schema should not survive JSON, got %q", decoded.RuntimeOracleCurrentSchema())
	}
}
