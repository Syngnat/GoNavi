package ssh

import (
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	cryptossh "golang.org/x/crypto/ssh"
)

// resetStaleSessionStateForTest isolates the package-level SSH session caches
// without closing the placeholder clients some tests install.
func resetStaleSessionStateForTest(t *testing.T) {
	t.Helper()
	clear := func() {
		sshClientCacheMu.Lock()
		sshClientCache = make(map[sshClientCacheKey]*cryptossh.Client)
		sshClientBornAt = make(map[*cryptossh.Client]time.Time)
		retiredSSHClients = nil
		sshClientCacheMu.Unlock()
	}
	clear()
	t.Cleanup(clear)
}

func TestIsChannelRejected(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil", err: nil, want: false},
		{name: "administratively prohibited", err: &cryptossh.OpenChannelError{Reason: cryptossh.Prohibited}, want: true},
		{name: "wrapped prohibited", err: fmt.Errorf("dial: %w", &cryptossh.OpenChannelError{Reason: cryptossh.Prohibited}), want: true},
		{name: "connect failed is not a policy denial", err: &cryptossh.OpenChannelError{Reason: cryptossh.ConnectionFailed}, want: false},
		{name: "unrelated error", err: io.EOF, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isChannelRejected(tt.err); got != tt.want {
				t.Fatalf("isChannelRejected(%v) = %t, want %t", tt.err, got, tt.want)
			}
		})
	}
}

func TestRetireIfChannelRejected(t *testing.T) {
	prohibited := &cryptossh.OpenChannelError{Reason: cryptossh.Prohibited}
	key := sshClientCacheKey{host: "jump.example.test", port: 22, user: "tester", auth: "fingerprint"}

	tests := []struct {
		name        string
		err         error
		bornAgo     time.Duration // negative means the client has no recorded birth time
		wantRetired bool
	}{
		{name: "stale session refused by policy is retired", err: prohibited, bornAgo: time.Minute, wantRetired: true},
		{name: "unknown age is treated as stale", err: prohibited, bornAgo: -1, wantRetired: true},
		{name: "fresh session refusal is a real denial", err: prohibited, bornAgo: time.Second, wantRetired: false},
		{name: "connect failure keeps the session", err: &cryptossh.OpenChannelError{Reason: cryptossh.ConnectionFailed}, bornAgo: time.Minute, wantRetired: false},
		{name: "non channel error keeps the session", err: io.EOF, bornAgo: time.Minute, wantRetired: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetStaleSessionStateForTest(t)
			client := &cryptossh.Client{}
			sshClientCacheMu.Lock()
			sshClientCache[key] = client
			if tt.bornAgo >= 0 {
				sshClientBornAt[client] = time.Now().Add(-tt.bornAgo)
			}
			sshClientCacheMu.Unlock()

			if got := retireIfChannelRejected(client, tt.err); got != tt.wantRetired {
				t.Fatalf("retireIfChannelRejected() = %t, want %t", got, tt.wantRetired)
			}

			sshClientCacheMu.RLock()
			defer sshClientCacheMu.RUnlock()
			_, cached := sshClientCache[key]
			if cached == tt.wantRetired {
				t.Fatalf("client cached = %t after retirement=%t", cached, tt.wantRetired)
			}
			if tt.wantRetired && (len(retiredSSHClients) != 1 || retiredSSHClients[0] != client) {
				t.Fatalf("retired clients = %v, want the rejected client kept for later close", retiredSSHClients)
			}
			if !tt.wantRetired && len(retiredSSHClients) != 0 {
				t.Fatalf("retired clients = %v, want none", retiredSSHClients)
			}
		})
	}
}

func TestRetireIfChannelRejectedIgnoresUncachedAndNilClients(t *testing.T) {
	resetStaleSessionStateForTest(t)
	prohibited := &cryptossh.OpenChannelError{Reason: cryptossh.Prohibited}

	if retireIfChannelRejected(nil, prohibited) {
		t.Fatal("nil client must not be retired")
	}
	if retireIfChannelRejected(&cryptossh.Client{}, prohibited) {
		t.Fatal("a client that is not cached must not be retired")
	}
}

func TestLocalForwarderRetiresStaleSessionWhenServerRefusesForward(t *testing.T) {
	resetStaleSessionStateForTest(t)
	server := startRejectingForwardTestSSHServer(t)
	config := server.config()
	t.Cleanup(CloseAllSSHClients)

	lease, err := AcquireLocalForwarder(config, "127.0.0.1", 18848)
	if err != nil {
		t.Fatalf("AcquireLocalForwarder() error = %v", err)
	}
	t.Cleanup(func() { _ = lease.Release() })
	staleClient := lease.SSHClient
	ageSSHClientForTest(staleClient, time.Minute)

	refuseThroughLocalListener(t, lease.LocalAddr)
	failure := waitForRemoteDialFailure(t, lease)
	if !isChannelRejected(failure.Err) {
		t.Fatalf("recorded failure = %v, want a policy rejection", failure.Err)
	}

	if !lease.IsClosed() {
		t.Fatal("forwarder bound to the retired session must be closed so it is not handed out again")
	}
	fresh, err := GetOrCreateSSHClient(config)
	if err != nil {
		t.Fatalf("GetOrCreateSSHClient() after rejection error = %v", err)
	}
	if fresh == staleClient {
		t.Fatal("the rejected session was reused instead of authenticating again")
	}
	next, err := AcquireLocalForwarder(config, "127.0.0.1", 18848)
	if err != nil {
		t.Fatalf("AcquireLocalForwarder() after rejection error = %v", err)
	}
	t.Cleanup(func() { _ = next.Release() })
	if next.IsClosed() || next.SSHClient != fresh {
		t.Fatalf("new forwarder closed=%t sameFreshClient=%t, want an open forwarder on the fresh session", next.IsClosed(), next.SSHClient == fresh)
	}
}

func TestLocalForwarderKeepsFreshSessionWhenServerRefusesForward(t *testing.T) {
	resetStaleSessionStateForTest(t)
	server := startRejectingForwardTestSSHServer(t)
	config := server.config()
	t.Cleanup(CloseAllSSHClients)

	lease, err := AcquireLocalForwarder(config, "127.0.0.1", 18848)
	if err != nil {
		t.Fatalf("AcquireLocalForwarder() error = %v", err)
	}
	t.Cleanup(func() { _ = lease.Release() })

	refuseThroughLocalListener(t, lease.LocalAddr)
	waitForRemoteDialFailure(t, lease)

	if lease.IsClosed() {
		t.Fatal("a refusal on a just-authenticated session is a real denial and must not tear the forwarder down")
	}
	cached, err := GetOrCreateSSHClient(config)
	if err != nil {
		t.Fatalf("GetOrCreateSSHClient() error = %v", err)
	}
	if cached != lease.SSHClient {
		t.Fatal("fresh session was replaced although the refusal cannot be caused by stale policy")
	}
}

func ageSSHClientForTest(client *cryptossh.Client, age time.Duration) {
	sshClientCacheMu.Lock()
	defer sshClientCacheMu.Unlock()
	sshClientBornAt[client] = time.Now().Add(-age)
}

// refuseThroughLocalListener opens one connection to the forwarder and waits
// for it to be closed, which is how the jump host's refusal surfaces locally.
func refuseThroughLocalListener(t *testing.T, localAddr string) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", localAddr, time.Second)
	if err != nil {
		t.Fatalf("dial local forwarder: %v", err)
	}
	defer conn.Close()
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	if _, err := io.ReadAll(conn); err != nil {
		t.Logf("local connection ended with %v", err)
	}
}

func waitForRemoteDialFailure(t *testing.T, forwarder *LocalForwarder) RemoteDialFailure {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if failure, ok := forwarder.LastRemoteDialFailure(); ok {
			return failure
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no remote dial failure was recorded")
	return RemoteDialFailure{}
}

// startRejectingForwardTestSSHServer accepts logins but refuses every
// direct-tcpip channel the way sshd does for a target outside PermitOpen.
func startRejectingForwardTestSSHServer(t *testing.T) forwardingTestSSHServer {
	t.Helper()

	signer := newTestHostSigner(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for SSH server: %v", err)
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
				defer serverConn.Close()
				go cryptossh.DiscardRequests(requests)
				for newChannel := range channels {
					if newChannel.ChannelType() != "session" {
						_ = newChannel.Reject(cryptossh.Prohibited, "open failed")
						continue
					}
					// sshd keeps session channels open under ForceCommand, and the
					// client's liveness probe depends on that.
					_, sessionRequests, acceptErr := newChannel.Accept()
					if acceptErr == nil {
						go cryptossh.DiscardRequests(sessionRequests)
					}
				}
			}()
		}
	}()

	return forwardingTestSSHServer{
		address:     listener.Addr().String(),
		fingerprint: cryptossh.FingerprintSHA256(signer.PublicKey()),
	}
}
