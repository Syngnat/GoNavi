package ssh

import (
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestNewSSHClientCacheKey_DiffPassword(t *testing.T) {
	a := newSSHClientCacheKey(connection.SSHConfig{
		Host:     "127.0.0.1",
		Port:     22,
		User:     "root",
		Password: "a",
	})
	b := newSSHClientCacheKey(connection.SSHConfig{
		Host:     "127.0.0.1",
		Port:     22,
		User:     "root",
		Password: "b",
	})
	if a == b {
		t.Fatalf("expected different cache key when password differs")
	}
	if a.host != b.host || a.port != b.port || a.user != b.user {
		t.Fatalf("expected host/port/user to stay identical")
	}
}

func TestNewSSHClientCacheKey_DiffKeyPath(t *testing.T) {
	a := newSSHClientCacheKey(connection.SSHConfig{
		Host:    "127.0.0.1",
		Port:    22,
		User:    "root",
		KeyPath: "/tmp/a.key",
	})
	b := newSSHClientCacheKey(connection.SSHConfig{
		Host:    "127.0.0.1",
		Port:    22,
		User:    "root",
		KeyPath: "/tmp/b.key",
	})
	if a == b {
		t.Fatalf("expected different cache key when keyPath differs")
	}
}

func TestNewSSHClientCacheKey_DiffHostKeyVerification(t *testing.T) {
	a := newSSHClientCacheKey(connection.SSHConfig{
		Host:               "127.0.0.1",
		Port:               22,
		User:               "root",
		KnownHostsPath:     "/tmp/a/known_hosts",
		HostKeyFingerprint: "SHA256:a",
	})
	b := newSSHClientCacheKey(connection.SSHConfig{
		Host:               "127.0.0.1",
		Port:               22,
		User:               "root",
		KnownHostsPath:     "/tmp/b/known_hosts",
		HostKeyFingerprint: "SHA256:b",
	})
	if a == b {
		t.Fatal("expected different cache key when host key verification differs")
	}
}

func TestNewSSHClientCacheKey_DiffLogicalHostIdentityBehindSameProxyEndpoint(t *testing.T) {
	physicalEndpoint := connection.SSHConfig{
		Host:     "127.0.0.1",
		Port:     45123,
		User:     "root",
		Password: "secret",
	}
	a := newSSHClientCacheKey(
		physicalEndpoint.
			WithHostKeyIdentity("bastion-a.example.test", 22).
			WithManagedHostKeyTrustStore(filepath.Join(t.TempDir(), "a.json")),
	)
	b := newSSHClientCacheKey(
		physicalEndpoint.
			WithHostKeyIdentity("bastion-b.example.test", 22).
			WithManagedHostKeyTrustStore(filepath.Join(t.TempDir(), "b.json")),
	)
	if a == b {
		t.Fatal("different logical SSH servers behind one proxy endpoint must not reuse a client")
	}
	if a.host != b.host || a.port != b.port {
		t.Fatalf("test setup expected the same physical dial endpoint: %#v %#v", a, b)
	}
}

func TestSSHDialAddressNormalizesIPv6(t *testing.T) {
	address, port, err := sshDialAddress(connection.SSHConfig{Host: "2001:db8::1", Port: 2222})
	if err != nil {
		t.Fatalf("sshDialAddress() error = %v", err)
	}
	if address != "[2001:db8::1]:2222" || port != 2222 {
		t.Fatalf("sshDialAddress() = %q, %d; want [2001:db8::1]:2222, 2222", address, port)
	}
}
