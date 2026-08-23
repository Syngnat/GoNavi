package app

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
	sshbridge "GoNavi-Wails/internal/ssh"
)

func TestManagedSSHHostKeyTrustStoreIsPrivateRuntimeState(t *testing.T) {
	application := NewApp()
	application.configDir = t.TempDir()
	raw := connection.ConnectionConfig{
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "bastion.example.com",
			Port: 2222,
		},
	}

	effective := application.withManagedSSHHostKeyTrustStore(raw)
	wantPath := filepath.Join(application.configDir, "ssh", managedSSHHostKeyTrustStoreFileName)
	if got := effective.SSH.ManagedHostKeyTrustStorePath(); got != wantPath {
		t.Fatalf("managed SSH trust-store path = %q, want %q", got, wantPath)
	}
	encoded, err := json.Marshal(effective)
	if err != nil {
		t.Fatalf("marshal effective config: %v", err)
	}
	if string(encoded) != string(mustMarshalConnectionConfig(t, raw)) {
		t.Fatalf("managed SSH trust-store path leaked into serialized config: %s", encoded)
	}
}

func TestSSHHostKeyTrustRequiredResultExposesConfirmationDetails(t *testing.T) {
	application := NewApp()
	result, ok := application.sshHostKeyTrustRequiredResult(&sshbridge.HostKeyTrustRequiredError{
		Status: sshbridge.HostKeyTrustStatus{
			State:               "changed",
			Source:              "gonavi",
			Host:                "bastion.example.com",
			Port:                22,
			Address:             "bastion.example.com:22",
			KeyType:             "ssh-ed25519",
			Fingerprint:         "SHA256:new",
			PreviousFingerprint: "SHA256:old",
		},
	})
	if !ok || result.Success {
		t.Fatalf("expected confirmation result, got ok=%v result=%+v", ok, result)
	}
	data, ok := result.Data.(map[string]any)
	if !ok {
		t.Fatalf("confirmation data type = %T, want map", result.Data)
	}
	status, ok := data["sshHostKeyTrust"].(sshbridge.HostKeyTrustStatus)
	if !ok {
		t.Fatalf("confirmation trust status type = %T", data["sshHostKeyTrust"])
	}
	if status.State != "changed" || status.Fingerprint != "SHA256:new" || status.PreviousFingerprint != "SHA256:old" {
		t.Fatalf("unexpected confirmation trust status: %#v", status)
	}
	if _, ok := application.sshHostKeyTrustRequiredResult(nil); ok {
		t.Fatal("ordinary errors must not be converted into an SSH trust confirmation")
	}
}

func TestTrustSSHHostKeyForConnectionUsesFullProxyRoute(t *testing.T) {
	application := NewApp()
	application.configDir = t.TempDir()
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() { resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc }()

	var received connection.ConnectionConfig
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		received = config
		routed := config
		logicalHost, logicalPort := routed.SSH.Host, routed.SSH.Port
		routed.SSH = routed.SSH.WithHostKeyIdentity(logicalHost, logicalPort)
		routed.SSH.Host = "127.0.0.1"
		routed.SSH.Port = 1 // fast refusal: the test asserts routing, not a real trust probe
		routed.UseProxy = false
		routed.Proxy = connection.ProxyConfig{}
		return routed, nil
	}

	result := application.TrustSSHHostKeyForConnection(connection.ConnectionConfig{
		Type:     "mysql",
		UseSSH:   true,
		UseProxy: true,
		SSH: connection.SSHConfig{
			Host: "bastion.example.test",
			Port: 2222,
		},
		Proxy: connection.ProxyConfig{
			Type: "socks5",
			Host: "proxy.example.test",
			Port: 1080,
		},
	}, "SHA256:expected")
	if result.Success {
		t.Fatal("expected the deliberate unreachable routed endpoint to fail")
	}
	if !received.UseSSH || !received.UseProxy || received.SSH.Host != "bastion.example.test" || received.SSH.Port != 2222 {
		t.Fatalf("trust operation did not pass the original full SSH/proxy route to the resolver: %#v", received)
	}
	if got := received.SSH.ManagedHostKeyTrustStorePath(); got != application.managedSSHHostKeyTrustStorePath() {
		t.Fatalf("trust route was not attached to GoNavi managed store: %q", got)
	}
}

func mustMarshalConnectionConfig(t *testing.T, config connection.ConnectionConfig) []byte {
	t.Helper()
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("marshal raw config: %v", err)
	}
	return encoded
}
