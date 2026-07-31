package ssh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	"github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/ssh"
	"golang.org/x/sync/singleflight"
)

// ViaSSHDialer registers a custom network for MySQL that proxies through SSH
type ViaSSHDialer struct {
	sshClient *ssh.Client
}

func (d *ViaSSHDialer) Dial(ctx context.Context, addr string) (net.Conn, error) {
	return dialContext(ctx, d.sshClient, "tcp", addr)
}

func dialContext(ctx context.Context, client *ssh.Client, network, addr string) (net.Conn, error) {
	type result struct {
		conn net.Conn
		err  error
	}

	ch := make(chan result, 1)
	go func() {
		c, err := client.Dial(network, addr)
		ch <- result{conn: c, err: err}
	}()

	select {
	case <-ctx.Done():
		go func() {
			r := <-ch
			if r.conn != nil {
				_ = r.conn.Close()
			}
		}()
		return nil, ctx.Err()
	case r := <-ch:
		return r.conn, r.err
	}
}

// connectSSH establishes an SSH connection and returns a Dialer
func connectSSH(config connection.SSHConfig) (*ssh.Client, error) {
	logger.Infof("开始建立 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)
	authMethods := []ssh.AuthMethod{}

	if keyPath := strings.TrimSpace(config.KeyPath); keyPath != "" {
		key, err := os.ReadFile(keyPath)
		if err != nil {
			logger.Warnf("读取 SSH 私钥失败：路径=%s，原因：%v", keyPath, err)
			return nil, fmt.Errorf("failed to read SSH private key %s: %w", keyPath, err)
		}
		signer, err := ssh.ParsePrivateKey(key)
		if err != nil {
			logger.Warnf("解析 SSH 私钥失败：路径=%s，原因：%v", keyPath, err)
			var passphraseErr *ssh.PassphraseMissingError
			if errors.As(err, &passphraseErr) {
				return nil, fmt.Errorf("SSH private key %s is encrypted with a passphrase; passphrase-protected keys are not supported", keyPath)
			}
			return nil, fmt.Errorf("failed to parse SSH private key %s: %w", keyPath, err)
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	}

	if config.Password != "" {
		authMethods = append(authMethods, ssh.Password(config.Password))
	}
	if len(authMethods) == 0 {
		logger.Warnf("SSH 未配置认证方式（密码或私钥）")
	}

	sshConfig := &ssh.ClientConfig{
		User:            config.User,
		Auth:            authMethods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // Use strict checking in production!
		Timeout:         5 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)
	client, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		logger.Error(err, "SSH 连接建立失败：地址=%s 用户=%s", addr, config.User)
		return nil, err
	}
	logger.Infof("SSH 连接建立成功：地址=%s 用户=%s", addr, config.User)
	return client, nil
}

// sshNetworkName 按 SSH 目标确定性派生 go-sql-driver 的自定义 network 名。
//
// 必须是确定性的：mysql.RegisterDialContext 写入驱动内一张永不回收的全局 map
// （DeregisterDialContext 在本仓库无任何调用点）。若每次调用都用时间戳生成新名字，
// 每次（重）连接都会新增一条永久条目并钉住其闭包捕获的 ssh.Client，形成随重连线性增长的
// SSH 连接与 goroutine 泄漏。相同目标复用同名注册后，map 大小收敛为 SSH 目标个数。
//
// 用 %q 做字段分隔以保证单射（host/user 里的引号会被转义），并只取短哈希，避免在
// network 名与日志中泄露认证指纹明文。
func sshNetworkName(key sshClientCacheKey) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%q %d %q %q", key.host, key.port, key.user, key.auth)))
	return "ssh_" + hex.EncodeToString(sum[:8])
}

// RegisterSSHNetwork registers a network name for a specific SSH tunnel
// Returns the network name to use in DSN
func RegisterSSHNetwork(sshConfig connection.SSHConfig) (string, error) {
	// 走缓存创建客户端，使其进入 sshClientCache，从而能被 CloseAllSSHClients 统一回收；
	// 直接调 connectSSH 会产出一个既不入缓存、也无人关闭的孤立客户端。
	if _, err := GetOrCreateSSHClient(sshConfig); err != nil {
		return "", err
	}

	netName := sshNetworkName(newSSHClientCacheKey(sshConfig))
	logger.Infof("注册 SSH 网络：%s（地址=%s:%d 用户=%s）", netName, sshConfig.Host, sshConfig.Port, sshConfig.User)

	// 闭包在拨号时才取客户端，不捕获固定实例：GetOrCreateSSHClient 会探测存活并在断开后重建，
	// 因此这条注册项对同一目标可长期复用，也不会把一个已死的 client 永久钉在驱动的全局 map 里。
	mysql.RegisterDialContext(netName, func(ctx context.Context, addr string) (net.Conn, error) {
		client, err := GetOrCreateSSHClient(sshConfig)
		if err != nil {
			return nil, err
		}
		return dialContext(ctx, client, "tcp", addr)
	})

	return netName, nil
}

// DialContextThroughSSH creates a context-aware connection through an SSH tunnel.
func DialContextThroughSSH(ctx context.Context, config connection.SSHConfig, network, address string) (net.Conn, error) {
	client, err := GetOrCreateSSHClient(config)
	if err != nil {
		return nil, fmt.Errorf("failed to establish SSH connection: %w", err)
	}

	conn, err := dialContext(ctx, client, network, address)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to %s through SSH tunnel: %w", address, err)
	}

	logger.Infof("已通过 SSH 隧道连接到：%s", address)
	return conn, nil
}

// sshClientCache stores SSH clients to avoid creating multiple connections
var (
	sshClientCache   = make(map[sshClientCacheKey]*ssh.Client)
	sshClientCacheMu sync.RWMutex
	sshClientFlights singleflight.Group
	connectSSHClient = connectSSH
	localForwarders  = make(map[forwarderCacheKey]*LocalForwarder)
	forwarderMu      sync.RWMutex
)

type sshClientCacheKey struct {
	host string
	port int
	user string
	auth string
}

type forwarderCacheKey struct {
	ssh        sshClientCacheKey
	remoteHost string
	remotePort int
}

func sshAuthFingerprint(config connection.SSHConfig) string {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte(config.Password))
	_, _ = hasher.Write([]byte{0})
	_, _ = hasher.Write([]byte(config.KeyPath))
	if config.KeyPath != "" {
		if st, err := os.Stat(config.KeyPath); err == nil {
			_, _ = hasher.Write([]byte{0})
			_, _ = hasher.Write([]byte(st.ModTime().UTC().Format(time.RFC3339Nano)))
			_, _ = hasher.Write([]byte{0})
			_, _ = hasher.Write([]byte(strconv.FormatInt(st.Size(), 10)))
		} else {
			_, _ = hasher.Write([]byte{0})
			_, _ = hasher.Write([]byte("stat_err"))
		}
	}
	sum := hasher.Sum(nil)
	return hex.EncodeToString(sum[:8])
}

func newSSHClientCacheKey(config connection.SSHConfig) sshClientCacheKey {
	return sshClientCacheKey{
		host: config.Host,
		port: config.Port,
		user: config.User,
		auth: sshAuthFingerprint(config),
	}
}

func formatSSHClientKeyForLog(key sshClientCacheKey) string {
	return fmt.Sprintf("%s:%d 用户=%s", key.host, key.port, key.user)
}

// LocalForwarder represents a local port forwarder through SSH
type LocalForwarder struct {
	LocalAddr  string
	RemoteAddr string
	SSHClient  *ssh.Client
	listener   net.Listener
	closeChan  chan struct{}
	closeOnce  sync.Once
	closed     bool
	closedMu   sync.RWMutex

	// shared/cacheKey identify a lease returned by AcquireLocalForwarder.
	// The cached forwarder itself keeps shared nil and owns the listener.
	shared    *LocalForwarder
	cacheKey  forwarderCacheKey
	leaseOnce sync.Once
	refCount  int // guarded by forwarderMu; meaningful only on the cached forwarder
}

// NewLocalForwarder creates a new local port forwarder
// It listens on a random local port and forwards all connections through SSH tunnel
func NewLocalForwarder(sshConfig connection.SSHConfig, remoteHost string, remotePort int) (*LocalForwarder, error) {
	client, err := GetOrCreateSSHClient(sshConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to establish SSH connection: %w", err)
	}

	// Listen on localhost with a random port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("failed to create local listener: %w", err)
	}

	localAddr := listener.Addr().String()
	remoteAddr := fmt.Sprintf("%s:%d", remoteHost, remotePort)

	forwarder := &LocalForwarder{
		LocalAddr:  localAddr,
		RemoteAddr: remoteAddr,
		SSHClient:  client,
		listener:   listener,
		closeChan:  make(chan struct{}),
	}

	// Start forwarding in background
	go forwarder.forward()

	logger.Infof("已创建 SSH 端口转发：本地 %s -> 远程 %s", localAddr, remoteAddr)
	return forwarder, nil
}

// forward handles the port forwarding
func (f *LocalForwarder) forward() {
	for {
		localConn, err := f.listener.Accept()
		if err != nil {
			// Check if we're shutting down
			select {
			case <-f.closeChan:
				return
			default:
				logger.Warnf("接受本地连接失败：%v", err)
				// listener可能已关闭,退出循环
				return
			}
		}

		go f.handleConnection(localConn)
	}
}

// handleConnection handles a single connection
func (f *LocalForwarder) handleConnection(localConn net.Conn) {
	defer localConn.Close()

	// Connect to remote through SSH with timeout
	remoteConn, err := f.SSHClient.Dial("tcp", f.RemoteAddr)
	if err != nil {
		logger.Warnf("通过 SSH 连接到远程 %s 失败：%v", f.RemoteAddr, err)
		return
	}
	defer remoteConn.Close()

	// Bidirectional copy with error channel
	errc := make(chan error, 2)

	// Copy from local to remote
	go func() {
		_, err := io.Copy(remoteConn, localConn)
		if err != nil {
			logger.Warnf("本地->远程数据复制错误：%v", err)
		}
		errc <- err
	}()

	// Copy from remote to local
	go func() {
		_, err := io.Copy(localConn, remoteConn)
		if err != nil {
			logger.Warnf("远程->本地数据复制错误：%v", err)
		}
		errc <- err
	}()

	// Wait for BOTH goroutines to complete
	<-errc
	<-errc
}

// Close releases a cached lease, or closes a standalone forwarder created by
// NewLocalForwarder. It is thread-safe and can be called multiple times.
func (f *LocalForwarder) Close() error {
	if f == nil {
		return nil
	}
	if f.shared != nil {
		var err error
		f.leaseOnce.Do(func() {
			err = releaseLocalForwarder(f.cacheKey, f.shared)
		})
		return err
	}
	return f.closeUnderlying()
}

// Release releases this acquisition. It is an explicit lifecycle alias for
// callers that obtained the forwarder through AcquireLocalForwarder.
func (f *LocalForwarder) Release() error {
	return f.Close()
}

func (f *LocalForwarder) closeUnderlying() error {
	var err error
	f.closeOnce.Do(func() {
		f.closedMu.Lock()
		f.closed = true
		f.closedMu.Unlock()

		close(f.closeChan)
		err = f.listener.Close()
		if err != nil {
			logger.Warnf("关闭端口转发监听器失败：%v", err)
		}
	})
	return err
}

// IsClosed returns whether the forwarder is closed
func (f *LocalForwarder) IsClosed() bool {
	if f == nil {
		return true
	}
	if f.shared != nil {
		return f.shared.IsClosed()
	}
	f.closedMu.RLock()
	defer f.closedMu.RUnlock()
	return f.closed
}

// AcquireLocalForwarder acquires a lease on a cached forwarder or creates one.
// Each successful call must be paired with Release. The shared listener is
// closed and evicted only after the last lease is released.
func AcquireLocalForwarder(sshConfig connection.SSHConfig, remoteHost string, remotePort int) (*LocalForwarder, error) {
	key := forwarderCacheKey{
		ssh:        newSSHClientCacheKey(sshConfig),
		remoteHost: remoteHost,
		remotePort: remotePort,
	}
	logKey := fmt.Sprintf("%s:%d:%s->%s:%d",
		sshConfig.Host, sshConfig.Port, sshConfig.User, remoteHost, remotePort)

	forwarderMu.Lock()
	if forwarder := localForwarders[key]; forwarder != nil && !forwarder.IsClosed() {
		lease := acquireForwarderLeaseLocked(key, forwarder)
		forwarderMu.Unlock()
		logger.Infof("复用已有端口转发：%s", logKey)
		return lease, nil
	}
	delete(localForwarders, key)
	forwarderMu.Unlock()

	forwarder, err := NewLocalForwarder(sshConfig, remoteHost, remotePort)
	if err != nil {
		return nil, err
	}

	forwarderMu.Lock()
	if existing := localForwarders[key]; existing != nil && !existing.IsClosed() {
		lease := acquireForwarderLeaseLocked(key, existing)
		forwarderMu.Unlock()
		_ = forwarder.closeUnderlying()
		logger.Infof("复用已有端口转发：%s", logKey)
		return lease, nil
	}
	delete(localForwarders, key)
	localForwarders[key] = forwarder
	lease := acquireForwarderLeaseLocked(key, forwarder)
	forwarderMu.Unlock()

	return lease, nil
}

// GetOrCreateLocalForwarder is kept for internal compatibility. New callers
// should use AcquireLocalForwarder so the lease ownership is explicit.
func GetOrCreateLocalForwarder(sshConfig connection.SSHConfig, remoteHost string, remotePort int) (*LocalForwarder, error) {
	return AcquireLocalForwarder(sshConfig, remoteHost, remotePort)
}

func acquireForwarderLeaseLocked(key forwarderCacheKey, shared *LocalForwarder) *LocalForwarder {
	shared.refCount++
	return &LocalForwarder{
		LocalAddr:  shared.LocalAddr,
		RemoteAddr: shared.RemoteAddr,
		SSHClient:  shared.SSHClient,
		shared:     shared,
		cacheKey:   key,
	}
}

func releaseLocalForwarder(key forwarderCacheKey, shared *LocalForwarder) error {
	forwarderMu.Lock()
	if shared.refCount > 0 {
		shared.refCount--
	}
	if shared.refCount > 0 {
		forwarderMu.Unlock()
		return nil
	}
	if localForwarders[key] == shared {
		delete(localForwarders, key)
	}
	forwarderMu.Unlock()

	return shared.closeUnderlying()
}

// CloseAllForwarders force-closes all cached local forwarders regardless of
// active leases.
func CloseAllForwarders() {
	forwarderMu.Lock()
	defer forwarderMu.Unlock()

	for _, forwarder := range localForwarders {
		if forwarder != nil {
			forwarder.refCount = 0
			_ = forwarder.closeUnderlying()
			logger.Infof("已关闭端口转发：本地 %s -> 远程 %s", forwarder.LocalAddr, forwarder.RemoteAddr)
		}
	}
	localForwarders = make(map[forwarderCacheKey]*LocalForwarder)
}

// GetOrCreateSSHClient returns a cached SSH client or creates a new one
func GetOrCreateSSHClient(config connection.SSHConfig) (*ssh.Client, error) {
	key := newSSHClientCacheKey(config)
	value, err, _ := sshClientFlights.Do(sshClientFlightKey(key), func() (interface{}, error) {
		return getOrCreateSSHClient(config, key)
	})
	if err != nil {
		return nil, err
	}
	client, ok := value.(*ssh.Client)
	if !ok || client == nil {
		return nil, fmt.Errorf("SSH client creation returned an invalid result")
	}
	return client, nil
}

func getOrCreateSSHClient(config connection.SSHConfig, key sshClientCacheKey) (*ssh.Client, error) {
	sshClientCacheMu.RLock()
	client, exists := sshClientCache[key]
	sshClientCacheMu.RUnlock()

	if exists && client != nil {
		// Test if connection is still alive by creating a test session
		session, err := client.NewSession()
		if err == nil {
			session.Close()
			logger.Infof("复用已有 SSH 连接：%s", formatSSHClientKeyForLog(key))
			return client, nil
		}
		// Connection is dead, remove from cache
		logger.Warnf("SSH 连接已断开，重新建立：%s (错误: %v)", formatSSHClientKeyForLog(key), err)
		sshClientCacheMu.Lock()
		delete(sshClientCache, key)
		sshClientCacheMu.Unlock()
		// Try to close the dead client
		_ = client.Close()
	}

	// Create new SSH client
	client, err := connectSSHClient(config)
	if err != nil {
		return nil, err
	}

	// Cache the client
	sshClientCacheMu.Lock()
	sshClientCache[key] = client
	sshClientCacheMu.Unlock()

	logger.Infof("已缓存 SSH 连接：%s", formatSSHClientKeyForLog(key))
	return client, nil
}

func sshClientFlightKey(key sshClientCacheKey) string {
	return fmt.Sprintf("%q\x00%d\x00%q\x00%s", key.host, key.port, key.user, key.auth)
}

// DialThroughSSH creates a connection through SSH tunnel
// This is a generic dialer that can be used by any database driver
func DialThroughSSH(config connection.SSHConfig, network, address string) (net.Conn, error) {
	client, err := GetOrCreateSSHClient(config)
	if err != nil {
		return nil, fmt.Errorf("failed to establish SSH connection: %w", err)
	}

	conn, err := client.Dial(network, address)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to %s through SSH tunnel: %w", address, err)
	}

	logger.Infof("已通过 SSH 隧道连接到：%s", address)
	return conn, nil
}

// CloseAllSSHClients closes all cached SSH clients
func CloseAllSSHClients() {
	sshClientCacheMu.Lock()
	defer sshClientCacheMu.Unlock()

	for key, client := range sshClientCache {
		if client != nil {
			_ = client.Close()
			logger.Infof("已关闭 SSH 连接：%s", formatSSHClientKeyForLog(key))
		}
	}
	sshClientCache = make(map[sshClientCacheKey]*ssh.Client)
}
