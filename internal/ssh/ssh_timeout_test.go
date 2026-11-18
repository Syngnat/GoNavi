package ssh

import (
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestResolveSSHConnectTimeout(t *testing.T) {
	if got := resolveSSHConnectTimeout(connection.SSHConfig{}); got != 5*time.Second {
		t.Fatalf("default SSH timeout = %s, want 5s", got)
	}
	if got := resolveSSHConnectTimeout(connection.SSHConfig{ConnectTimeout: 30}); got != 30*time.Second {
		t.Fatalf("configured SSH timeout = %s, want 30s", got)
	}
}
