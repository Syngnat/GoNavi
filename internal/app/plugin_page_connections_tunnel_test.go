package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestRewritePluginTunnelConfigSwapsEndpointForLocalForward(t *testing.T) {
	config := connection.ConnectionConfig{
		ID:       "conn-1",
		Type:     "mongodb",
		Host:     "10.0.0.9",
		Port:     27017,
		User:     "reader",
		Password: "secret",
		UseSSH:   true,
		SSH:      connection.SSHConfig{Host: "jump.local", Port: 22, User: "ops", Password: "ssh-secret"},
	}

	rewritten, err := rewritePluginTunnelConfig(config, "127.0.0.1:54321")
	if err != nil {
		t.Fatalf("rewrite failed: %v", err)
	}
	if rewritten.Host != "127.0.0.1" || rewritten.Port != 54321 {
		t.Fatalf("endpoint not rewritten: %s:%d", rewritten.Host, rewritten.Port)
	}
	if rewritten.UseSSH || rewritten.SSH.Host != "" {
		t.Fatalf("SSH transport leaked into the plugin config: %+v", rewritten.SSH)
	}
	// Database credentials still belong to the plugin; only SSH material is stripped.
	if rewritten.User != "reader" || rewritten.Password != "secret" {
		t.Fatalf("database credentials were dropped: %+v", rewritten)
	}
	if config.Host != "10.0.0.9" || !config.UseSSH {
		t.Fatal("input config must stay untouched")
	}
}

func TestRewritePluginTunnelConfigRejectsBadForwardAddress(t *testing.T) {
	if _, err := rewritePluginTunnelConfig(connection.ConnectionConfig{}, "not-an-endpoint"); err == nil {
		t.Fatal("expected an error for an address without a port")
	}
}
