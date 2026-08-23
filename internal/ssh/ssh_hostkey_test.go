package ssh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"

	cryptossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestAllSSHClientEntrypointsRequireHostKeyVerification(t *testing.T) {
	useEmptySSHHome(t)
	config := connection.SSHConfig{Host: "127.0.0.1", Port: 1, User: "tester"}
	cases := []struct {
		name string
		run  func() error
	}{
		{
			name: "context dial",
			run: func() error {
				_, err := DialContextThroughSSH(context.Background(), config, "tcp", "127.0.0.1:3306")
				return err
			},
		},
		{
			name: "direct dial",
			run: func() error {
				_, err := DialThroughSSH(config, "tcp", "127.0.0.1:3306")
				return err
			},
		},
		{
			name: "local forwarder",
			run: func() error {
				_, err := NewLocalForwarder(config, "127.0.0.1", 3306)
				return err
			},
		},
		{
			name: "cached local forwarder",
			run: func() error {
				_, err := AcquireLocalForwarder(config, "127.0.0.1", 3306)
				return err
			},
		},
		{
			name: "registered network",
			run: func() error {
				_, err := RegisterSSHNetwork(config)
				return err
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := testCase.run()
			if err == nil {
				t.Fatal("expected missing host key verification to fail")
			}
			if !strings.Contains(err.Error(), "host key verification") {
				t.Fatalf("expected host key verification error, got %q", err)
			}
		})
	}
}

func TestConnectSSHRequiresHostKeyVerification(t *testing.T) {
	useEmptySSHHome(t)
	server := startTestSSHServer(t, newTestHostSigner(t))

	client, err := connectSSH(server.config())
	if client != nil {
		_ = client.Close()
	}
	if err == nil {
		t.Fatal("expected SSH connection without host key verification to fail")
	}
	if !strings.Contains(err.Error(), "host key verification") {
		t.Fatalf("expected host key verification error, got %q", err)
	}
}

func TestConnectSSHRejectsInvalidPinnedHostKeyFingerprint(t *testing.T) {
	_, err := newHostKeyCallback(connection.SSHConfig{
		HostKeyFingerprint: "SHA256:AAAA",
	})
	if err == nil {
		t.Fatal("expected invalid host key fingerprint to be rejected")
	}
	if !strings.Contains(err.Error(), "decoded fingerprint has length") {
		t.Fatalf("expected fingerprint length error, got %q", err)
	}
}

func TestRegisterSSHNetworkRequiresHostKeyVerification(t *testing.T) {
	useEmptySSHHome(t)
	_, err := RegisterSSHNetwork(connection.SSHConfig{
		Host: "127.0.0.1",
		Port: 1,
		User: "tester",
	})
	if err == nil {
		t.Fatal("expected RegisterSSHNetwork to reject missing host key verification")
	}
	if !strings.Contains(err.Error(), "host key verification") {
		t.Fatalf("expected host key verification error, got %q", err)
	}
}

func useEmptySSHHome(t *testing.T) {
	t.Helper()
	emptyHome := t.TempDir()
	t.Setenv("HOME", emptyHome)
	t.Setenv("USERPROFILE", emptyHome)
	// Some SSH entry points initialise the process-wide logger. Keep its open
	// file outside t.TempDir so Windows can remove the temporary home reliably.
	t.Setenv("GONAVI_LOG_DIR", filepath.Join(os.TempDir(), "gonavi-ssh-hostkey-test-logs"))
}

func TestConnectSSHAcceptsPinnedHostKeyFingerprint(t *testing.T) {
	signer := newTestHostSigner(t)
	server := startTestSSHServer(t, signer)
	config := server.config()
	config.HostKeyFingerprint = cryptossh.FingerprintSHA256(signer.PublicKey())

	client, err := connectSSH(config)
	if err != nil {
		t.Fatalf("connectSSH() error = %v", err)
	}
	_ = client.Close()
}

func TestConnectSSHRejectsChangedPinnedHostKey(t *testing.T) {
	server := startTestSSHServer(t, newTestHostSigner(t))
	config := server.config()
	config.HostKeyFingerprint = cryptossh.FingerprintSHA256(newTestHostSigner(t).PublicKey())

	client, err := connectSSH(config)
	if client != nil {
		_ = client.Close()
	}
	if err == nil {
		t.Fatal("expected changed pinned host key to be rejected")
	}
	if !strings.Contains(err.Error(), "host key fingerprint mismatch") {
		t.Fatalf("expected fingerprint mismatch error, got %q", err)
	}
}

func TestConnectSSHAcceptsHashedKnownHostOnNonDefaultPort(t *testing.T) {
	signer := newTestHostSigner(t)
	server := startTestSSHServer(t, signer)
	host := knownhosts.Normalize(server.address)
	line := fmt.Sprintf("%s %s", knownhosts.HashHostname(host), strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(signer.PublicKey()))))
	knownHostsPath := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(knownHostsPath, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("write known_hosts: %v", err)
	}
	config := server.config()
	config.KnownHostsPath = knownHostsPath

	client, err := connectSSH(config)
	if err != nil {
		t.Fatalf("connectSSH() error = %v", err)
	}
	_ = client.Close()
}

func TestConnectSSHRejectsChangedKnownHostKey(t *testing.T) {
	server := startTestSSHServer(t, newTestHostSigner(t))
	knownHostsPath := filepath.Join(t.TempDir(), "known_hosts")
	line := knownhosts.Line([]string{server.address}, newTestHostSigner(t).PublicKey())
	if err := os.WriteFile(knownHostsPath, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("write known_hosts: %v", err)
	}
	config := server.config()
	config.KnownHostsPath = knownHostsPath

	client, err := connectSSH(config)
	if client != nil {
		_ = client.Close()
	}
	if err == nil {
		t.Fatal("expected changed known_hosts key to be rejected")
	}
}

type testSSHServer struct {
	address string
}

func (s testSSHServer) config() connection.SSHConfig {
	host, portText, err := net.SplitHostPort(s.address)
	if err != nil {
		panic(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		panic(err)
	}
	return connection.SSHConfig{Host: host, Port: port, User: "tester"}
}

func startTestSSHServer(t *testing.T, signer cryptossh.Signer) testSSHServer {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	serverConfig := &cryptossh.ServerConfig{NoClientAuth: true}
	serverConfig.AddHostKey(signer)
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				serverConn, channels, requests, handshakeErr := cryptossh.NewServerConn(conn, serverConfig)
				if handshakeErr != nil {
					_ = conn.Close()
					return
				}
				go cryptossh.DiscardRequests(requests)
				for channel := range channels {
					_ = channel.Reject(cryptossh.UnknownChannelType, "unsupported channel")
				}
				_ = serverConn.Close()
			}()
		}
	}()

	return testSSHServer{address: listener.Addr().String()}
}

func newTestHostSigner(t *testing.T) cryptossh.Signer {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := cryptossh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatalf("create host signer: %v", err)
	}
	return signer
}
