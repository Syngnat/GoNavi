package db

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"
)

const (
	defaultRocketMQBrokerPort   = 10911
	maxRocketMQFrameSize        = 64 << 20
	rocketMQBrokerForwarderIdle = 10 * time.Minute
)

var (
	rocketMQTunnelNow             = time.Now
	rocketMQDialContextThroughSSH = ssh.DialContextThroughSSH
	// Preparing a RocketMQ tunnel only starts local listeners. Establish the SSH
	// session before those listeners are returned so host-key confirmation errors
	// reach the caller synchronously instead of being logged by a later
	// forwarder goroutine. GetOrCreateSSHClient caches the verified client, so
	// the dialer below reuses it for NameServer and Broker traffic.
	rocketMQEnsureSSHClient = func(config connection.SSHConfig) error {
		_, err := ssh.GetOrCreateSSHClient(config)
		return err
	}
)

type rocketmqDialContextFunc func(ctx context.Context, network, address string) (net.Conn, error)

type rocketmqTunnelSet struct {
	dialContext rocketmqDialContextFunc

	mu               sync.Mutex
	closed           bool
	forwarders       map[*rocketmqForwarder]struct{}
	brokerForwarders map[string]rocketmqBrokerForwarder
}

type rocketmqBrokerForwarder struct {
	forwarder *rocketmqForwarder
	lastSeen  time.Time
}

type rocketmqForwarder struct {
	listener    net.Listener
	remoteAddr  string
	dialContext rocketmqDialContextFunc
	rewrite     func([]byte) ([]byte, error)
	ctx         context.Context
	cancel      context.CancelFunc

	mu        sync.Mutex
	closed    bool
	active    map[net.Conn]struct{}
	closeOnce sync.Once
	wg        sync.WaitGroup
}

func prepareRocketMQTunnel(config connection.ConnectionConfig) (connection.ConnectionConfig, *rocketmqTunnelSet, error) {
	runConfig, err := normalizeRocketMQTunnelConfig(config)
	if err != nil {
		return connection.ConnectionConfig{}, nil, err
	}
	if !runConfig.UseSSH && !runConfig.UseProxy {
		return runConfig, nil, nil
	}

	var dialContext rocketmqDialContextFunc
	switch {
	case runConfig.UseSSH:
		if err := rocketMQEnsureSSHClient(runConfig.SSH); err != nil {
			return connection.ConnectionConfig{}, nil, fmt.Errorf("建立 RocketMQ SSH 隧道失败：%w", err)
		}
		sshConfig := runConfig.SSH
		dialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			return rocketMQDialContextThroughSSH(ctx, sshConfig, network, address)
		}
	case runConfig.UseProxy:
		proxyConfig := runConfig.Proxy
		dialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			return proxytunnel.DialContext(ctx, proxyConfig, network, address)
		}
	}

	nameservers, err := rocketmqNameServerAddresses(runConfig)
	if err != nil {
		return connection.ConnectionConfig{}, nil, err
	}
	tunnels := newRocketMQTunnelSet(dialContext)
	forwarded := make([]string, 0, len(nameservers))
	for _, nameserver := range nameservers {
		localAddr, forwardErr := tunnels.forwardNameServer(nameserver)
		if forwardErr != nil {
			_ = tunnels.Close()
			return connection.ConnectionConfig{}, nil, fmt.Errorf("创建 RocketMQ NameServer 隧道失败：%w", forwardErr)
		}
		forwarded = append(forwarded, localAddr)
	}

	host, port, ok := parseHostPortWithDefault(forwarded[0], 0)
	if !ok {
		_ = tunnels.Close()
		return connection.ConnectionConfig{}, nil, fmt.Errorf("解析 RocketMQ 本地 NameServer 地址失败：%s", forwarded[0])
	}
	runConfig.Host = host
	runConfig.Port = port
	runConfig.Hosts = append([]string(nil), forwarded[1:]...)
	runConfig.UseSSH = false
	runConfig.SSH = connection.SSHConfig{}
	runConfig.UseProxy = false
	runConfig.Proxy = connection.ProxyConfig{}
	runConfig.UseHTTPTunnel = false
	runConfig.HTTPTunnel = connection.HTTPTunnelConfig{}
	return runConfig, tunnels, nil
}

func normalizeRocketMQTunnelConfig(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
	if config.UseHTTPTunnel {
		if config.UseProxy {
			return connection.ConnectionConfig{}, fmt.Errorf("RocketMQ 不能同时启用代理和 HTTP 隧道")
		}
		host := strings.TrimSpace(config.HTTPTunnel.Host)
		if host == "" {
			return connection.ConnectionConfig{}, fmt.Errorf("RocketMQ HTTP 隧道主机不能为空")
		}
		port := config.HTTPTunnel.Port
		if port <= 0 {
			port = 8080
		}
		if port > 65535 {
			return connection.ConnectionConfig{}, fmt.Errorf("RocketMQ HTTP 隧道端口无效：%d", config.HTTPTunnel.Port)
		}
		config.UseProxy = true
		config.Proxy = connection.ProxyConfig{
			Type:     "http",
			Host:     host,
			Port:     port,
			User:     strings.TrimSpace(config.HTTPTunnel.User),
			Password: config.HTTPTunnel.Password,
		}
		config.UseHTTPTunnel = false
		config.HTTPTunnel = connection.HTTPTunnelConfig{}
	}
	if config.UseSSH && config.SSH.Port <= 0 {
		config.SSH.Port = 22
	}
	if config.UseSSH && config.UseProxy {
		return connection.ConnectionConfig{}, fmt.Errorf("RocketMQ 同时使用 SSH 和代理时，代理只能用于连接 SSH 网关")
	}
	if config.UseProxy {
		proxyConfig, err := proxytunnel.NormalizeConfig(config.Proxy)
		if err != nil {
			return connection.ConnectionConfig{}, err
		}
		config.Proxy = proxyConfig
	}
	return config, nil
}

func newRocketMQTunnelSet(dialContext rocketmqDialContextFunc) *rocketmqTunnelSet {
	return &rocketmqTunnelSet{
		dialContext:      dialContext,
		forwarders:       make(map[*rocketmqForwarder]struct{}),
		brokerForwarders: make(map[string]rocketmqBrokerForwarder),
	}
}

func (t *rocketmqTunnelSet) forwardNameServer(remoteAddr string) (string, error) {
	forwarder, err := newRocketMQForwarder(remoteAddr, t.dialContext, func(frame []byte) ([]byte, error) {
		return rewriteRocketMQRouteFrame(frame, t.forwardBrokerAddress)
	})
	if err != nil {
		return "", err
	}

	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		_ = forwarder.Close()
		return "", fmt.Errorf("RocketMQ 隧道已关闭")
	}
	t.forwarders[forwarder] = struct{}{}
	t.mu.Unlock()
	return forwarder.LocalAddr(), nil
}

func (t *rocketmqTunnelSet) forwardBrokerAddress(remoteAddr string) (string, error) {
	host, port, ok := parseHostPortWithDefault(remoteAddr, defaultRocketMQBrokerPort)
	if !ok {
		return "", fmt.Errorf("解析 RocketMQ Broker 地址失败：%s", remoteAddr)
	}
	canonical := rocketmqFormatHostPort(host, port)
	now := rocketMQTunnelNow()

	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return "", fmt.Errorf("RocketMQ 隧道已关闭")
	}
	if existing, exists := t.brokerForwarders[canonical]; exists {
		existing.lastSeen = now
		t.brokerForwarders[canonical] = existing
		expired := t.collectExpiredBrokerForwardersLocked(now)
		t.mu.Unlock()
		for _, stale := range expired {
			_ = stale.Close()
		}
		return existing.forwarder.LocalAddr(), nil
	}
	forwarder, err := newRocketMQForwarder(canonical, t.dialContext, nil)
	if err != nil {
		t.mu.Unlock()
		return "", err
	}
	t.forwarders[forwarder] = struct{}{}
	t.brokerForwarders[canonical] = rocketmqBrokerForwarder{forwarder: forwarder, lastSeen: now}
	expired := t.collectExpiredBrokerForwardersLocked(now)
	t.mu.Unlock()

	for _, stale := range expired {
		_ = stale.Close()
	}
	logger.Infof("已映射 RocketMQ Broker：本地 %s -> 远端 %s", forwarder.LocalAddr(), canonical)
	return forwarder.LocalAddr(), nil
}

func (t *rocketmqTunnelSet) collectExpiredBrokerForwardersLocked(now time.Time) []*rocketmqForwarder {
	expired := make([]*rocketmqForwarder, 0)
	for address, entry := range t.brokerForwarders {
		if now.Sub(entry.lastSeen) < rocketMQBrokerForwarderIdle || entry.forwarder.HasActiveConnections() {
			continue
		}
		delete(t.brokerForwarders, address)
		delete(t.forwarders, entry.forwarder)
		expired = append(expired, entry.forwarder)
	}
	return expired
}

func (t *rocketmqTunnelSet) Close() error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	forwarders := make([]*rocketmqForwarder, 0, len(t.forwarders))
	for forwarder := range t.forwarders {
		forwarders = append(forwarders, forwarder)
	}
	t.forwarders = nil
	t.brokerForwarders = nil
	t.mu.Unlock()

	var firstErr error
	for _, forwarder := range forwarders {
		if err := forwarder.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func newRocketMQForwarder(remoteAddr string, dialContext rocketmqDialContextFunc, rewrite func([]byte) ([]byte, error)) (*rocketmqForwarder, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	forwarder := &rocketmqForwarder{
		listener:    listener,
		remoteAddr:  remoteAddr,
		dialContext: dialContext,
		rewrite:     rewrite,
		ctx:         ctx,
		cancel:      cancel,
		active:      make(map[net.Conn]struct{}),
	}
	forwarder.wg.Add(1)
	go forwarder.serve()
	return forwarder, nil
}

func (f *rocketmqForwarder) LocalAddr() string {
	return f.listener.Addr().String()
}

func (f *rocketmqForwarder) serve() {
	defer f.wg.Done()
	for {
		localConn, err := f.listener.Accept()
		if err != nil {
			f.mu.Lock()
			closed := f.closed
			f.mu.Unlock()
			if !closed {
				logger.Warnf("接受 RocketMQ 隧道连接失败：%v", err)
			}
			return
		}
		if !f.track(localConn) {
			_ = localConn.Close()
			return
		}
		f.wg.Add(1)
		go f.handle(localConn)
	}
}

func (f *rocketmqForwarder) handle(localConn net.Conn) {
	defer f.wg.Done()
	defer f.untrack(localConn)
	defer localConn.Close()

	remoteConn, err := f.dialContext(f.ctx, "tcp", f.remoteAddr)
	if err != nil {
		logger.Warnf("连接 RocketMQ 隧道远端失败：远端=%s 错误=%v", f.remoteAddr, err)
		return
	}
	if !f.track(remoteConn) {
		_ = remoteConn.Close()
		return
	}
	defer f.untrack(remoteConn)
	defer remoteConn.Close()

	errCh := make(chan error, 2)
	go func() {
		_, copyErr := io.Copy(remoteConn, localConn)
		errCh <- copyErr
	}()
	go func() {
		var copyErr error
		if f.rewrite == nil {
			_, copyErr = io.Copy(localConn, remoteConn)
		} else {
			copyErr = relayRocketMQResponses(localConn, remoteConn, f.rewrite)
		}
		errCh <- copyErr
	}()
	firstErr := <-errCh
	_ = localConn.Close()
	_ = remoteConn.Close()
	secondErr := <-errCh
	if err := rocketmqUnexpectedTunnelError(firstErr, secondErr, f.ctx.Err()); err != nil {
		logger.Warnf("转发 RocketMQ 隧道数据失败：远端=%s 错误=%v", f.remoteAddr, err)
	}
}

func rocketmqUnexpectedTunnelError(errs ...error) error {
	for _, err := range errs {
		if err == nil || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) || errors.Is(err, net.ErrClosed) {
			continue
		}
		if strings.Contains(strings.ToLower(err.Error()), "use of closed network connection") {
			continue
		}
		return err
	}
	return nil
}

func (f *rocketmqForwarder) track(conn net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return false
	}
	f.active[conn] = struct{}{}
	return true
}

func (f *rocketmqForwarder) untrack(conn net.Conn) {
	f.mu.Lock()
	delete(f.active, conn)
	f.mu.Unlock()
}

func (f *rocketmqForwarder) HasActiveConnections() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.active) > 0
}

func (f *rocketmqForwarder) Close() error {
	if f == nil {
		return nil
	}
	var closeErr error
	f.closeOnce.Do(func() {
		f.cancel()
		f.mu.Lock()
		f.closed = true
		connections := make([]net.Conn, 0, len(f.active))
		for conn := range f.active {
			connections = append(connections, conn)
		}
		f.mu.Unlock()
		closeErr = f.listener.Close()
		for _, conn := range connections {
			_ = conn.Close()
		}
		f.wg.Wait()
	})
	return closeErr
}

func relayRocketMQResponses(dst io.Writer, src io.Reader, rewrite func([]byte) ([]byte, error)) error {
	for {
		var sizeBuffer [4]byte
		if _, err := io.ReadFull(src, sizeBuffer[:]); err != nil {
			return err
		}
		frameSize := int(binary.BigEndian.Uint32(sizeBuffer[:]))
		if frameSize < 4 || frameSize > maxRocketMQFrameSize {
			return fmt.Errorf("RocketMQ 响应帧长度无效：%d", frameSize)
		}
		frame := make([]byte, frameSize+4)
		copy(frame[:4], sizeBuffer[:])
		if _, err := io.ReadFull(src, frame[4:]); err != nil {
			return err
		}
		rewritten, err := rewrite(frame)
		if err != nil {
			return err
		}
		if err := writeAll(dst, rewritten); err != nil {
			return err
		}
	}
}

func writeAll(dst io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := dst.Write(payload)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		payload = payload[written:]
	}
	return nil
}

func rewriteRocketMQRouteFrame(frame []byte, mapAddress func(string) (string, error)) ([]byte, error) {
	if len(frame) < 8 {
		return nil, fmt.Errorf("RocketMQ 响应帧过短")
	}
	frameSize := int(binary.BigEndian.Uint32(frame[:4]))
	if frameSize != len(frame)-4 || frameSize < 4 || frameSize > maxRocketMQFrameSize {
		return nil, fmt.Errorf("RocketMQ 响应帧长度无效：%d", frameSize)
	}
	headerLength := int(binary.BigEndian.Uint32(frame[4:8]) & 0x00ffffff)
	bodyOffset := 8 + headerLength
	if bodyOffset > len(frame) {
		return nil, fmt.Errorf("RocketMQ 响应头长度无效：%d", headerLength)
	}
	body, changed, err := rewriteRocketMQRouteBody(frame[bodyOffset:], mapAddress)
	if err != nil || !changed {
		return frame, err
	}

	newFrameSize := 4 + headerLength + len(body)
	rewritten := make([]byte, newFrameSize+4)
	binary.BigEndian.PutUint32(rewritten[:4], uint32(newFrameSize))
	copy(rewritten[4:bodyOffset], frame[4:bodyOffset])
	copy(rewritten[bodyOffset:], body)
	return rewritten, nil
}

func rewriteRocketMQRouteBody(body []byte, mapAddress func(string) (string, error)) ([]byte, bool, error) {
	var payload map[string]json.RawMessage
	if len(body) == 0 || json.Unmarshal(body, &payload) != nil {
		return body, false, nil
	}
	brokerDataJSON, ok := payload["brokerDatas"]
	if !ok {
		return body, false, nil
	}
	var brokerDatas []map[string]json.RawMessage
	if err := json.Unmarshal(brokerDataJSON, &brokerDatas); err != nil {
		return nil, false, fmt.Errorf("解析 RocketMQ Broker 路由失败：%w", err)
	}

	changed := false
	for _, brokerData := range brokerDatas {
		addressesJSON, exists := brokerData["brokerAddrs"]
		if !exists {
			continue
		}
		var addresses map[string]string
		if err := json.Unmarshal(addressesJSON, &addresses); err != nil {
			return nil, false, fmt.Errorf("解析 RocketMQ Broker 地址失败：%w", err)
		}
		brokerChanged := false
		for id, address := range addresses {
			forwarded, err := mapAddress(address)
			if err != nil {
				return nil, false, err
			}
			if forwarded != address {
				addresses[id] = forwarded
				brokerChanged = true
				changed = true
			}
		}
		if brokerChanged {
			rewritten, err := json.Marshal(addresses)
			if err != nil {
				return nil, false, err
			}
			brokerData["brokerAddrs"] = rewritten
		}
	}
	if !changed {
		return body, false, nil
	}
	rewrittenBrokerDatas, err := json.Marshal(brokerDatas)
	if err != nil {
		return nil, false, err
	}
	payload["brokerDatas"] = rewrittenBrokerDatas
	rewrittenBody, err := json.Marshal(payload)
	if err != nil {
		return nil, false, err
	}
	return rewrittenBody, true, nil
}
