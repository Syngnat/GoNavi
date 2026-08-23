//go:build gonavi_full_drivers || gonavi_starrocks_driver

package db

import (
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

func TestStarRocksConnectPreservesSSHHostKeyTrustError(t *testing.T) {
	want := &ssh.HostKeyTrustRequiredError{Status: ssh.HostKeyTrustStatus{
		State:       "unknown",
		Host:        "bastion.example.test",
		Port:        22,
		Address:     "bastion.example.test:22",
		Fingerprint: "SHA256:untrusted-key",
	}}
	database := &StarRocksDB{MySQLDB: MySQLDB{
		sshNetworkRegistrar: func(connection.SSHConfig) (string, error) { return "", want },
	}}
	err := database.Connect(connection.ConnectionConfig{
		Type:   "starrocks",
		Host:   "starrocks.example.test",
		Port:   9030,
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "bastion.example.test",
			Port: 22,
		},
	})
	if err == nil {
		t.Fatal("expected SSH host-key trust error")
	}
	var got *ssh.HostKeyTrustRequiredError
	if !errors.As(err, &got) || got != want {
		t.Fatalf("HostKeyTrustRequiredError was not retained: %T %v", err, err)
	}
}
