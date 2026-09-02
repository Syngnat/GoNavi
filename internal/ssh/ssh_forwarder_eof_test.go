package ssh

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	cryptossh "golang.org/x/crypto/ssh"
)

func TestLocalForwarderPropagatesRemoteEOFWithoutWaitingForClientWriteEOF(t *testing.T) {
	const (
		request  = "request"
		response = "response"
	)

	remoteListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for remote server: %v", err)
	}
	t.Cleanup(func() { _ = remoteListener.Close() })
	remoteDone := make(chan error, 1)
	go func() {
		conn, acceptErr := remoteListener.Accept()
		if acceptErr != nil {
			remoteDone <- acceptErr
			return
		}
		requestBuffer := make([]byte, len(request))
		if _, readErr := io.ReadFull(conn, requestBuffer); readErr != nil {
			_ = conn.Close()
			remoteDone <- fmt.Errorf("read request: %w", readErr)
			return
		}
		if string(requestBuffer) != request {
			_ = conn.Close()
			remoteDone <- fmt.Errorf("request = %q, want %q", requestBuffer, request)
			return
		}
		if _, writeErr := io.WriteString(conn, response); writeErr != nil {
			_ = conn.Close()
			remoteDone <- fmt.Errorf("write response: %w", writeErr)
			return
		}
		remoteDone <- conn.Close()
	}()

	sshServer := startForwardingTestSSHServer(t)
	remoteHost, remotePortText, err := net.SplitHostPort(remoteListener.Addr().String())
	if err != nil {
		t.Fatalf("split remote address: %v", err)
	}
	remotePort, err := strconv.Atoi(remotePortText)
	if err != nil {
		t.Fatalf("parse remote port: %v", err)
	}
	forwarder, err := NewLocalForwarder(sshServer.config(), remoteHost, remotePort)
	if err != nil {
		t.Fatalf("NewLocalForwarder() error = %v", err)
	}
	t.Cleanup(func() {
		_ = forwarder.Close()
		CloseAllSSHClients()
	})

	client, err := net.DialTimeout("tcp", forwarder.LocalAddr, time.Second)
	if err != nil {
		t.Fatalf("dial local forwarder: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if _, err := io.WriteString(client, request); err != nil {
		t.Fatalf("write request without closing client write side: %v", err)
	}
	select {
	case remoteErr := <-remoteDone:
		if remoteErr != nil {
			t.Fatalf("remote server error: %v", remoteErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("remote server did not close after sending its response")
	}

	if err := client.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatalf("set client read deadline: %v", err)
	}
	responseBuffer := make([]byte, len(response))
	if _, err := io.ReadFull(client, responseBuffer); err != nil {
		t.Fatalf("read response: %v", err)
	}
	if string(responseBuffer) != response {
		t.Fatalf("response = %q, want %q", responseBuffer, response)
	}

	oneByte := make([]byte, 1)
	n, err := client.Read(oneByte)
	if n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("read after remote close = (%d, %v), want immediate EOF while client write side remains open", n, err)
	}
}

func TestLocalForwarderPropagatesClientWriteEOFWithoutTruncatingRemoteResponse(t *testing.T) {
	const (
		request  = "request"
		response = "response-after-eof"
	)

	remoteListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for remote server: %v", err)
	}
	t.Cleanup(func() { _ = remoteListener.Close() })
	remoteDone := make(chan error, 1)
	go func() {
		conn, acceptErr := remoteListener.Accept()
		if acceptErr != nil {
			remoteDone <- acceptErr
			return
		}
		requestBuffer, readErr := io.ReadAll(conn)
		if readErr != nil {
			_ = conn.Close()
			remoteDone <- fmt.Errorf("read request through EOF: %w", readErr)
			return
		}
		if string(requestBuffer) != request {
			_ = conn.Close()
			remoteDone <- fmt.Errorf("request = %q, want %q", requestBuffer, request)
			return
		}
		if _, writeErr := io.WriteString(conn, response); writeErr != nil {
			_ = conn.Close()
			remoteDone <- fmt.Errorf("write response after request EOF: %w", writeErr)
			return
		}
		remoteDone <- conn.Close()
	}()

	sshServer := startForwardingTestSSHServer(t)
	remoteHost, remotePortText, err := net.SplitHostPort(remoteListener.Addr().String())
	if err != nil {
		t.Fatalf("split remote address: %v", err)
	}
	remotePort, err := strconv.Atoi(remotePortText)
	if err != nil {
		t.Fatalf("parse remote port: %v", err)
	}
	forwarder, err := NewLocalForwarder(sshServer.config(), remoteHost, remotePort)
	if err != nil {
		t.Fatalf("NewLocalForwarder() error = %v", err)
	}
	t.Cleanup(func() {
		_ = forwarder.Close()
		CloseAllSSHClients()
	})

	conn, err := net.DialTimeout("tcp", forwarder.LocalAddr, time.Second)
	if err != nil {
		t.Fatalf("dial local forwarder: %v", err)
	}
	client, ok := conn.(*net.TCPConn)
	if !ok {
		_ = conn.Close()
		t.Fatalf("local connection type = %T, want *net.TCPConn", conn)
	}
	t.Cleanup(func() { _ = client.Close() })
	if _, err := io.WriteString(client, request); err != nil {
		t.Fatalf("write request: %v", err)
	}
	if err := client.CloseWrite(); err != nil {
		t.Fatalf("close client write side: %v", err)
	}

	if err := client.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set client read deadline: %v", err)
	}
	responseBuffer, err := io.ReadAll(client)
	if err != nil {
		t.Fatalf("read response after closing client write side: %v", err)
	}
	if string(responseBuffer) != response {
		t.Fatalf("response = %q, want %q", responseBuffer, response)
	}
	select {
	case remoteErr := <-remoteDone:
		if remoteErr != nil {
			t.Fatalf("remote server error: %v", remoteErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("remote server did not receive client write EOF")
	}
}

type forwardingTestSSHServer struct {
	address     string
	fingerprint string
}

func (s forwardingTestSSHServer) config() connection.SSHConfig {
	host, portText, err := net.SplitHostPort(s.address)
	if err != nil {
		panic(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		panic(err)
	}
	return connection.SSHConfig{
		Host:               host,
		Port:               port,
		User:               "tester",
		HostKeyFingerprint: s.fingerprint,
	}
}

func startForwardingTestSSHServer(t *testing.T) forwardingTestSSHServer {
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
			go serveForwardingTestSSHConnection(conn, serverConfig)
		}
	}()

	return forwardingTestSSHServer{
		address:     listener.Addr().String(),
		fingerprint: cryptossh.FingerprintSHA256(signer.PublicKey()),
	}
}

func serveForwardingTestSSHConnection(conn net.Conn, config *cryptossh.ServerConfig) {
	serverConn, channels, requests, err := cryptossh.NewServerConn(conn, config)
	if err != nil {
		_ = conn.Close()
		return
	}
	defer serverConn.Close()
	go cryptossh.DiscardRequests(requests)
	for newChannel := range channels {
		go serveForwardingTestSSHChannel(newChannel)
	}
}

func serveForwardingTestSSHChannel(newChannel cryptossh.NewChannel) {
	if newChannel.ChannelType() != "direct-tcpip" {
		_ = newChannel.Reject(cryptossh.UnknownChannelType, "unsupported channel")
		return
	}
	var request struct {
		RemoteHost string
		RemotePort uint32
		OriginHost string
		OriginPort uint32
	}
	if err := cryptossh.Unmarshal(newChannel.ExtraData(), &request); err != nil {
		_ = newChannel.Reject(cryptossh.ConnectionFailed, "invalid direct-tcpip request")
		return
	}
	remoteConn, err := net.Dial("tcp", net.JoinHostPort(request.RemoteHost, strconv.Itoa(int(request.RemotePort))))
	if err != nil {
		_ = newChannel.Reject(cryptossh.ConnectionFailed, err.Error())
		return
	}
	channel, requests, err := newChannel.Accept()
	if err != nil {
		_ = remoteConn.Close()
		return
	}
	go cryptossh.DiscardRequests(requests)

	var copies sync.WaitGroup
	copies.Add(2)
	go func() {
		defer copies.Done()
		_, _ = io.Copy(remoteConn, channel)
		if tcpConn, ok := remoteConn.(*net.TCPConn); ok {
			_ = tcpConn.CloseWrite()
		}
	}()
	go func() {
		defer copies.Done()
		_, _ = io.Copy(channel, remoteConn)
		_ = channel.CloseWrite()
	}()
	copies.Wait()
	_ = channel.Close()
	_ = remoteConn.Close()
}
