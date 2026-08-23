package db

import (
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
)

func TestMySQLDSN_UseSSH_ShouldFailWhenSSHInvalid(t *testing.T) {
	m := &MySQLDB{}
	_, err := m.getDSN(connection.ConnectionConfig{
		Host:   "127.0.0.1",
		Port:   3306,
		User:   "root",
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host:     "127.0.0.1",
			Port:     0, // invalid port, should fail immediately
			User:     "bad",
			Password: "bad",
		},
	})
	if err == nil {
		t.Fatalf("expected error when UseSSH=true and SSH config invalid")
	}
}

func TestMySQLConnectPreservesSSHHostKeyTrustError(t *testing.T) {
	want := &ssh.HostKeyTrustRequiredError{Status: ssh.HostKeyTrustStatus{
		State:       "unknown",
		Host:        "bastion.example.test",
		Port:        22,
		Address:     "bastion.example.test:22",
		Fingerprint: "SHA256:untrusted-key",
	}}
	database := &MySQLDB{
		sshNetworkRegistrar: func(config connection.SSHConfig) (string, error) {
			if config.Host != "bastion.example.test" {
				t.Fatalf("unexpected SSH config: %#v", config)
			}
			return "", want
		},
	}
	err := database.Connect(connection.ConnectionConfig{
		Type:   "mysql",
		Host:   "mysql.example.test",
		Port:   3306,
		User:   "root",
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
	if !errors.As(err, &got) {
		t.Fatalf("expected HostKeyTrustRequiredError to remain unwrapable, got %T: %v", err, err)
	}
	if got != want {
		t.Fatalf("unexpected SSH host-key trust error: got %#v, want %#v", got, want)
	}
}
