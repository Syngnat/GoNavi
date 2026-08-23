package db

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	sshbridge "GoNavi-Wails/internal/ssh"
)

func TestRewriteRocketMQRouteFrameMapsBrokerAddresses(t *testing.T) {
	body := []byte(`{"brokerDatas":[{"brokerName":"broker-a","brokerAddrs":{"0":"10.0.0.10:10911","1":"10.0.0.11:10911"}}],"queueDatas":[]}`)
	frame := rocketmqTestFrame([]byte(`{"code":0}`), body)
	mapped := map[string]string{
		"10.0.0.10:10911": "127.0.0.1:31001",
		"10.0.0.11:10911": "127.0.0.1:31002",
	}
	calls := make([]string, 0, len(mapped))

	rewritten, err := rewriteRocketMQRouteFrame(frame, func(address string) (string, error) {
		calls = append(calls, address)
		return mapped[address], nil
	})
	if err != nil {
		t.Fatalf("rewriteRocketMQRouteFrame: %v", err)
	}
	if got := int(binary.BigEndian.Uint32(rewritten[:4])); got != len(rewritten)-4 {
		t.Fatalf("frame size = %d, want %d", got, len(rewritten)-4)
	}
	if got := int(binary.BigEndian.Uint32(rewritten[4:8]) & 0x00ffffff); got != len(`{"code":0}`) {
		t.Fatalf("header size = %d, want %d", got, len(`{"code":0}`))
	}

	bodyOffset := 8 + len(`{"code":0}`)
	var payload struct {
		BrokerDatas []struct {
			BrokerAddrs map[string]string `json:"brokerAddrs"`
		} `json:"brokerDatas"`
	}
	if err := json.Unmarshal(rewritten[bodyOffset:], &payload); err != nil {
		t.Fatalf("decode rewritten route body: %v", err)
	}
	wantAddresses := map[string]string{"0": "127.0.0.1:31001", "1": "127.0.0.1:31002"}
	if len(payload.BrokerDatas) != 1 || !reflect.DeepEqual(payload.BrokerDatas[0].BrokerAddrs, wantAddresses) {
		t.Fatalf("rewritten broker addresses = %#v, want %#v", payload.BrokerDatas, wantAddresses)
	}
	if len(calls) != 2 {
		t.Fatalf("broker mapper calls = %v, want both addresses", calls)
	}
}

func TestRewriteRocketMQRouteFrameKeepsNonRouteResponse(t *testing.T) {
	frame := rocketmqTestFrame([]byte(`{"code":0}`), []byte(`{"topicList":["orders.events"]}`))
	rewritten, err := rewriteRocketMQRouteFrame(frame, func(address string) (string, error) {
		t.Fatalf("broker mapper called for non-route response: %s", address)
		return "", nil
	})
	if err != nil {
		t.Fatalf("rewriteRocketMQRouteFrame: %v", err)
	}
	if !reflect.DeepEqual(rewritten, frame) {
		t.Fatalf("non-route response changed: got=%q want=%q", rewritten, frame)
	}
}

func TestNormalizeRocketMQTunnelConfigDefaultsSSHPort(t *testing.T) {
	config, err := normalizeRocketMQTunnelConfig(connection.ConnectionConfig{
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "ssh.internal.test",
			User: "ssh-user",
		},
	})
	if err != nil {
		t.Fatalf("normalizeRocketMQTunnelConfig: %v", err)
	}
	if config.SSH.Port != 22 {
		t.Fatalf("SSH port = %d, want 22", config.SSH.Port)
	}
}

func TestPrepareRocketMQTunnelReturnsHostKeyTrustRequirementSynchronously(t *testing.T) {
	originalEnsure := rocketMQEnsureSSHClient
	originalDial := rocketMQDialContextThroughSSH
	required := &sshbridge.HostKeyTrustRequiredError{
		Status: sshbridge.HostKeyTrustStatus{
			State:       "unknown",
			Host:        "ssh.internal.test",
			Port:        22,
			Fingerprint: "SHA256:test-host-key",
		},
	}
	ensureCalls := 0
	rocketMQEnsureSSHClient = func(config connection.SSHConfig) error {
		ensureCalls++
		if config.Host != "ssh.internal.test" || config.Port != 22 {
			t.Fatalf("SSH config = %#v, want normalized SSH endpoint", config)
		}
		return required
	}
	rocketMQDialContextThroughSSH = func(context.Context, connection.SSHConfig, string, string) (net.Conn, error) {
		t.Fatal("SSH dial must not start when host-key confirmation is required")
		return nil, nil
	}
	t.Cleanup(func() {
		rocketMQEnsureSSHClient = originalEnsure
		rocketMQDialContextThroughSSH = originalDial
	})

	_, tunnels, err := prepareRocketMQTunnel(connection.ConnectionConfig{
		Type:   "rocketmq",
		Host:   "nameserver.internal.test",
		Port:   9876,
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "ssh.internal.test",
			User: "ssh-user",
		},
	})
	if err == nil {
		t.Fatal("prepareRocketMQTunnel succeeded, want host-key trust requirement")
	}
	if tunnels != nil {
		t.Fatalf("tunnels = %#v, want nil when SSH verification fails", tunnels)
	}
	if ensureCalls != 1 {
		t.Fatalf("SSH client preparation calls = %d, want 1", ensureCalls)
	}
	var got *sshbridge.HostKeyTrustRequiredError
	if !errors.As(err, &got) {
		t.Fatalf("prepareRocketMQTunnel error = %T %v, want wrapped HostKeyTrustRequiredError", err, err)
	}
	if got != required {
		t.Fatalf("unwrapped host-key error = %#v, want %#v", got, required)
	}
}

func TestRelayRocketMQResponsesHandlesShortWrites(t *testing.T) {
	frame := rocketmqTestFrame([]byte(`{"code":0}`), []byte(`{"topicList":["orders.events"]}`))
	writer := &rocketmqShortWriter{max: 3}
	err := relayRocketMQResponses(writer, bytes.NewReader(frame), func(payload []byte) ([]byte, error) {
		return payload, nil
	})
	if !errors.Is(err, io.EOF) {
		t.Fatalf("relayRocketMQResponses error = %v, want EOF", err)
	}
	if !bytes.Equal(writer.payload, frame) {
		t.Fatalf("relayed frame = %q, want %q", writer.payload, frame)
	}
}

func TestRocketMQForwarderCloseCancelsInFlightDial(t *testing.T) {
	dialStarted := make(chan struct{})
	dialCanceled := make(chan struct{})
	forwarder, err := newRocketMQForwarder("nameserver.internal.test:9876", func(ctx context.Context, network, address string) (net.Conn, error) {
		close(dialStarted)
		<-ctx.Done()
		close(dialCanceled)
		return nil, ctx.Err()
	}, nil)
	if err != nil {
		t.Fatalf("newRocketMQForwarder: %v", err)
	}

	client, err := net.DialTimeout("tcp", forwarder.LocalAddr(), time.Second)
	if err != nil {
		t.Fatalf("dial local forwarder: %v", err)
	}
	defer client.Close()
	select {
	case <-dialStarted:
	case <-time.After(time.Second):
		t.Fatal("forwarder dial did not start")
	}

	closed := make(chan error, 1)
	go func() { closed <- forwarder.Close() }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("Close: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close remained blocked while dial was in flight")
	}
	select {
	case <-dialCanceled:
	case <-time.After(time.Second):
		t.Fatal("in-flight dial did not observe cancellation")
	}
}

func TestRocketMQTunnelEvictsIdleBrokerForwarders(t *testing.T) {
	originalNow := rocketMQTunnelNow
	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	rocketMQTunnelNow = func() time.Time { return now }
	t.Cleanup(func() { rocketMQTunnelNow = originalNow })

	tunnels := newRocketMQTunnelSet((&net.Dialer{}).DialContext)
	t.Cleanup(func() { _ = tunnels.Close() })
	firstLocal, err := tunnels.forwardBrokerAddress("127.0.0.1:10911")
	if err != nil {
		t.Fatalf("forward first broker: %v", err)
	}
	now = now.Add(5 * time.Minute)
	staleLocal, err := tunnels.forwardBrokerAddress("127.0.0.1:10912")
	if err != nil {
		t.Fatalf("forward stale broker: %v", err)
	}
	now = now.Add(11 * time.Minute)
	firstLocalAgain, err := tunnels.forwardBrokerAddress("127.0.0.1:10911")
	if err != nil {
		t.Fatalf("refresh first broker: %v", err)
	}
	if firstLocalAgain != firstLocal {
		t.Fatalf("active broker forwarder changed: got=%s want=%s", firstLocalAgain, firstLocal)
	}
	if conn, dialErr := net.DialTimeout("tcp", staleLocal, 50*time.Millisecond); dialErr == nil {
		_ = conn.Close()
		t.Fatalf("idle broker forwarder still accepts connections: %s", staleLocal)
	}
}

func TestRocketMQTunnelRewritesFragmentedNameServerRoutesAndForwardsBroker(t *testing.T) {
	broker := startRocketMQEchoServer(t, "broker-ping", "broker-pong")
	nameserver := startRocketMQNameServerStub(t, broker.Addr().String())
	proxy := startRocketMQHTTPConnectProxy(t)

	proxyHost, proxyPort := rocketmqTestHostPort(t, proxy.Addr().String())
	nameserverHost, nameserverPort := rocketmqTestHostPort(t, nameserver.Addr().String())
	config, tunnels, err := prepareRocketMQTunnel(connection.ConnectionConfig{
		Type:     "rocketmq",
		Host:     nameserverHost,
		Port:     nameserverPort,
		UseProxy: true,
		Proxy: connection.ProxyConfig{
			Type: "http",
			Host: proxyHost,
			Port: proxyPort,
		},
	})
	if err != nil {
		t.Fatalf("prepareRocketMQTunnel: %v", err)
	}
	t.Cleanup(func() { _ = tunnels.Close() })

	exerciseRocketMQForwardedRoute(t, config, broker.Addr().String())
	targets := proxy.Targets()
	if !containsString(targets, nameserver.Addr().String()) || !containsString(targets, broker.Addr().String()) {
		t.Fatalf("HTTP CONNECT targets = %v, want NameServer and Broker", targets)
	}
}

func TestRocketMQSSHTunnelForwardsNameServerAndBroker(t *testing.T) {
	broker := startRocketMQEchoServer(t, "broker-ping", "broker-pong")
	nameserver := startRocketMQNameServerStub(t, broker.Addr().String())
	originalDial := rocketMQDialContextThroughSSH
	originalEnsure := rocketMQEnsureSSHClient
	var mu sync.Mutex
	var targets []string
	var sshConfigs []connection.SSHConfig
	ensureCalls := 0
	rocketMQEnsureSSHClient = func(config connection.SSHConfig) error {
		ensureCalls++
		if config.Host != "ssh.internal.test" || config.Port != 22 {
			t.Fatalf("prepared SSH config = %#v, want normalized SSH endpoint", config)
		}
		return nil
	}
	rocketMQDialContextThroughSSH = func(ctx context.Context, config connection.SSHConfig, network, address string) (net.Conn, error) {
		mu.Lock()
		targets = append(targets, address)
		sshConfigs = append(sshConfigs, config)
		mu.Unlock()
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	t.Cleanup(func() {
		rocketMQEnsureSSHClient = originalEnsure
		rocketMQDialContextThroughSSH = originalDial
	})

	nameserverHost, nameserverPort := rocketmqTestHostPort(t, nameserver.Addr().String())
	config, tunnels, err := prepareRocketMQTunnel(connection.ConnectionConfig{
		Type:   "rocketmq",
		Host:   nameserverHost,
		Port:   nameserverPort,
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "ssh.internal.test",
			User: "ssh-user",
		},
	})
	if err != nil {
		t.Fatalf("prepareRocketMQTunnel: %v", err)
	}
	t.Cleanup(func() { _ = tunnels.Close() })

	exerciseRocketMQForwardedRoute(t, config, broker.Addr().String())
	mu.Lock()
	defer mu.Unlock()
	if !containsString(targets, nameserver.Addr().String()) || !containsString(targets, broker.Addr().String()) {
		t.Fatalf("SSH targets = %v, want NameServer and Broker", targets)
	}
	if ensureCalls != 1 {
		t.Fatalf("SSH client preparation calls = %d, want 1", ensureCalls)
	}
	for _, sshConfig := range sshConfigs {
		if sshConfig.Port != 22 {
			t.Fatalf("SSH port = %d, want normalized port 22", sshConfig.Port)
		}
	}
}

func exerciseRocketMQForwardedRoute(t *testing.T, config connection.ConnectionConfig, originalBroker string) {
	t.Helper()
	nameServerConn, err := net.DialTimeout("tcp", rocketmqFormatHostPort(config.Host, config.Port), time.Second)
	if err != nil {
		t.Fatalf("dial forwarded NameServer: %v", err)
	}
	if err := writeAll(nameServerConn, rocketmqTestFrame([]byte(`{"code":105}`), nil)); err != nil {
		t.Fatalf("write NameServer request: %v", err)
	}
	firstFrame, err := readRocketMQTestFrame(nameServerConn)
	if err != nil {
		t.Fatalf("read first NameServer response: %v", err)
	}
	if !strings.Contains(string(rocketmqTestFrameBody(t, firstFrame)), "topicList") {
		t.Fatalf("first response was not preserved: %q", firstFrame)
	}
	secondFrame, err := readRocketMQTestFrame(nameServerConn)
	if err != nil {
		t.Fatalf("read route response: %v", err)
	}
	_ = nameServerConn.Close()

	var route struct {
		BrokerDatas []struct {
			BrokerAddrs map[string]string `json:"brokerAddrs"`
		} `json:"brokerDatas"`
	}
	if err := json.Unmarshal(rocketmqTestFrameBody(t, secondFrame), &route); err != nil {
		t.Fatalf("decode rewritten route: %v", err)
	}
	if len(route.BrokerDatas) != 1 {
		t.Fatalf("rewritten route brokers = %#v", route.BrokerDatas)
	}
	forwardedBroker := route.BrokerDatas[0].BrokerAddrs["0"]
	if forwardedBroker == "" || forwardedBroker == originalBroker {
		t.Fatalf("broker address was not rewritten: %q", forwardedBroker)
	}
	brokerConn, err := net.DialTimeout("tcp", forwardedBroker, time.Second)
	if err != nil {
		t.Fatalf("dial forwarded Broker: %v", err)
	}
	if err := writeAll(brokerConn, []byte("broker-ping")); err != nil {
		t.Fatalf("write Broker payload: %v", err)
	}
	response := make([]byte, len("broker-pong"))
	if _, err := io.ReadFull(brokerConn, response); err != nil {
		t.Fatalf("read Broker response: %v", err)
	}
	_ = brokerConn.Close()
	if string(response) != "broker-pong" {
		t.Fatalf("Broker response = %q, want broker-pong", response)
	}
}

func rocketmqTestFrame(header []byte, body []byte) []byte {
	frameSize := 4 + len(header) + len(body)
	frame := make([]byte, frameSize+4)
	binary.BigEndian.PutUint32(frame[:4], uint32(frameSize))
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(header)))
	copy(frame[8:], header)
	copy(frame[8+len(header):], body)
	return frame
}

func readRocketMQTestFrame(reader io.Reader) ([]byte, error) {
	var sizeBuffer [4]byte
	if _, err := io.ReadFull(reader, sizeBuffer[:]); err != nil {
		return nil, err
	}
	frameSize := int(binary.BigEndian.Uint32(sizeBuffer[:]))
	frame := make([]byte, frameSize+4)
	copy(frame[:4], sizeBuffer[:])
	_, err := io.ReadFull(reader, frame[4:])
	return frame, err
}

func rocketmqTestFrameBody(t *testing.T, frame []byte) []byte {
	t.Helper()
	if len(frame) < 8 {
		t.Fatalf("RocketMQ test frame too short: %d", len(frame))
	}
	headerLength := int(binary.BigEndian.Uint32(frame[4:8]) & 0x00ffffff)
	bodyOffset := 8 + headerLength
	if bodyOffset > len(frame) {
		t.Fatalf("RocketMQ test frame header length = %d, frame length = %d", headerLength, len(frame))
	}
	return frame[bodyOffset:]
}

func rocketmqTestHostPort(t *testing.T, address string) (string, int) {
	t.Helper()
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatalf("split address %q: %v", address, err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse port %q: %v", portText, err)
	}
	return host, port
}

func startRocketMQEchoServer(t *testing.T, request string, response string) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for Broker stub: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		payload := make([]byte, len(request))
		if _, readErr := io.ReadFull(conn, payload); readErr != nil || string(payload) != request {
			return
		}
		_, _ = io.WriteString(conn, response)
	}()
	return listener
}

func startRocketMQNameServerStub(t *testing.T, brokerAddress string) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for NameServer stub: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		if _, readErr := readRocketMQTestFrame(conn); readErr != nil {
			return
		}
		frames := append(
			rocketmqTestFrame([]byte(`{"code":0}`), []byte(`{"topicList":["orders.events"]}`)),
			rocketmqTestFrame(
				[]byte(`{"code":0}`),
				[]byte(fmt.Sprintf(`{"brokerDatas":[{"brokerName":"broker-a","brokerAddrs":{"0":%q}}],"queueDatas":[]}`, brokerAddress)),
			)...,
		)
		for _, value := range frames {
			if _, writeErr := conn.Write([]byte{value}); writeErr != nil {
				return
			}
		}
	}()
	return listener
}

type rocketmqShortWriter struct {
	max     int
	payload []byte
}

func (w *rocketmqShortWriter) Write(payload []byte) (int, error) {
	written := len(payload)
	if written > w.max {
		written = w.max
	}
	w.payload = append(w.payload, payload[:written]...)
	return written, nil
}

type rocketmqHTTPConnectProxy struct {
	listener net.Listener
	mu       sync.Mutex
	targets  []string
}

func startRocketMQHTTPConnectProxy(t *testing.T) *rocketmqHTTPConnectProxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for HTTP CONNECT proxy: %v", err)
	}
	proxy := &rocketmqHTTPConnectProxy{listener: listener}
	t.Cleanup(func() { _ = listener.Close() })
	go proxy.serve()
	return proxy
}

func (p *rocketmqHTTPConnectProxy) Addr() net.Addr {
	return p.listener.Addr()
}

func (p *rocketmqHTTPConnectProxy) Targets() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.targets...)
}

func (p *rocketmqHTTPConnectProxy) serve() {
	for {
		conn, err := p.listener.Accept()
		if err != nil {
			return
		}
		go p.handle(conn)
	}
}

func (p *rocketmqHTTPConnectProxy) handle(client net.Conn) {
	defer client.Close()
	request, err := http.ReadRequest(bufio.NewReader(client))
	if err != nil {
		return
	}
	_ = request.Body.Close()
	target := request.Host
	if request.Method != http.MethodConnect || target == "" {
		return
	}
	p.mu.Lock()
	p.targets = append(p.targets, target)
	p.mu.Unlock()

	upstream, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", target)
	if err != nil {
		return
	}
	defer upstream.Close()
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	errCh := make(chan error, 2)
	go func() {
		_, copyErr := io.Copy(upstream, client)
		errCh <- copyErr
	}()
	go func() {
		_, copyErr := io.Copy(client, upstream)
		errCh <- copyErr
	}()
	<-errCh
	_ = client.Close()
	_ = upstream.Close()
	<-errCh
}
