package proxy

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

func TestNormalizeConfigSupportsSocks5hAlias(t *testing.T) {
	cfg, err := NormalizeConfig(connection.ProxyConfig{
		Type: "SOCKS5H",
		Host: "127.0.0.1",
		Port: 1080,
	})
	if err != nil {
		t.Fatalf("NormalizeConfig returned error: %v", err)
	}
	if cfg.Type != "socks5" {
		t.Fatalf("expected normalized proxy type socks5, got %s", cfg.Type)
	}
}

func TestForwarderCacheKeyIncludesCredentialFingerprint(t *testing.T) {
	base := connection.ProxyConfig{
		Type:     "socks5",
		Host:     "127.0.0.1",
		Port:     1080,
		User:     "tester",
		Password: "first-password",
	}
	other := base
	other.Password = "second-password"

	keyA := forwarderCacheKey(base, "db.internal", 3306)
	keyB := forwarderCacheKey(other, "db.internal", 3306)

	if keyA == keyB {
		t.Fatalf("expected different cache key for different credentials")
	}
	if strings.Contains(keyA, base.Password) || strings.Contains(keyB, other.Password) {
		t.Fatalf("cache key should not contain raw password")
	}
}

func TestNormalizeConfigUsesCurrentLanguageForValidationErrors(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	_, err := NormalizeConfig(connection.ProxyConfig{
		Type: "Shadowsocks",
		Host: "127.0.0.1",
		Port: 1080,
	})
	if err == nil {
		t.Fatal("expected NormalizeConfig to reject unsupported proxy type")
	}

	const want = "Unsupported proxy type: Shadowsocks"
	if err.Error() != want {
		t.Fatalf("expected localized validation error %q, got %q", want, err.Error())
	}
}

func TestDialContextUsesCurrentLanguageForHTTPConnectWrapper(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	_, err := DialContext(context.Background(), connection.ProxyConfig{
		Type: "http",
		Host: "127.0.0.1",
		Port: 1,
	}, "tcp", "example.com:443")
	if err == nil {
		t.Fatal("expected DialContext to fail when proxy endpoint is unreachable")
	}
	if !strings.HasPrefix(err.Error(), "Failed to connect to HTTP proxy:") {
		t.Fatalf("expected localized HTTP proxy wrapper, got %q", err.Error())
	}
}

type proxyTimeoutError struct{}

func (proxyTimeoutError) Error() string   { return "i/o timeout" }
func (proxyTimeoutError) Timeout() bool   { return true }
func (proxyTimeoutError) Temporary() bool { return true }

func TestContextErrorForProxyIOMapsDeadlineSocketTimeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	defer cancel()

	err := contextErrorForProxyIO(ctx, proxyTimeoutError{})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("contextErrorForProxyIO error = %v, want context deadline exceeded", err)
	}
	if err := contextErrorForProxyIO(context.Background(), proxyTimeoutError{}); err != nil {
		t.Fatalf("contextErrorForProxyIO without deadline = %v, want nil", err)
	}
}

func TestDialContextCancelsStalledHTTPConnectHandshake(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	accepted := make(chan net.Conn, 1)
	serverClosed := make(chan struct{})
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			close(serverClosed)
			return
		}
		accepted <- conn
		defer close(serverClosed)
		defer conn.Close()
		// Consume the CONNECT request but deliberately never send a response.
		_, _ = io.Copy(io.Discard, conn)
	}()

	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("split proxy address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse proxy port: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		conn, dialErr := DialContext(ctx, connection.ProxyConfig{
			Type: "http",
			Host: "127.0.0.1",
			Port: port,
		}, "tcp", "example.com:443")
		if conn != nil {
			_ = conn.Close()
		}
		result <- dialErr
	}()

	proxyConn := <-accepted
	select {
	case dialErr := <-result:
		if !errors.Is(dialErr, context.DeadlineExceeded) {
			t.Fatalf("DialContext error = %v, want context deadline exceeded", dialErr)
		}
	case <-time.After(750 * time.Millisecond):
		_ = proxyConn.Close()
		<-result
		t.Fatal("DialContext remained blocked after its context deadline")
	}

	select {
	case <-serverClosed:
	case <-time.After(750 * time.Millisecond):
		_ = proxyConn.Close()
		t.Fatal("stalled HTTP proxy socket remained open after cancellation")
	}
}

func TestDialContextKeepsSuccessfulHTTPConnectTunnelOpen(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	serverResult := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverResult <- acceptErr
			return
		}
		defer conn.Close()
		request, readErr := http.ReadRequest(bufio.NewReader(conn))
		if readErr != nil {
			serverResult <- readErr
			return
		}
		_ = request.Body.Close()
		if _, writeErr := io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); writeErr != nil {
			serverResult <- writeErr
			return
		}
		var payload [4]byte
		if _, readErr = io.ReadFull(conn, payload[:]); readErr != nil {
			serverResult <- readErr
			return
		}
		if string(payload[:]) != "ping" {
			serverResult <- errors.New("unexpected tunnel payload")
			return
		}
		_, writeErr := io.WriteString(conn, "pong")
		serverResult <- writeErr
	}()

	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("split proxy address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse proxy port: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := DialContext(ctx, connection.ProxyConfig{
		Type: "http",
		Host: "127.0.0.1",
		Port: port,
	}, "tcp", "example.com:443")
	if err != nil {
		t.Fatalf("DialContext: %v", err)
	}
	defer conn.Close()
	if _, err = io.WriteString(conn, "ping"); err != nil {
		t.Fatalf("write tunnel: %v", err)
	}
	var response [4]byte
	if _, err = io.ReadFull(conn, response[:]); err != nil {
		t.Fatalf("read tunnel: %v", err)
	}
	if string(response[:]) != "pong" {
		t.Fatalf("tunnel response = %q, want pong", response)
	}
	if err = <-serverResult; err != nil {
		t.Fatalf("proxy server: %v", err)
	}
}
