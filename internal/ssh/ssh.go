package ssh

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	"github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/ssh"
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

	if config.KeyPath != "" {
		key, err := os.ReadFile(config.KeyPath)
		if err != nil {
			logger.Warnf("读取 SSH 私钥失败：路径=%s，原因：%v", config.KeyPath, err)
		} else {
			signer, err := ssh.ParsePrivateKey(key)
			if err != nil {
				logger.Warnf("解析 SSH 私钥失败：路径=%s，原因：%v", config.KeyPath, err)
			} else {
				authMethods = append(authMethods, ssh.PublicKeys(signer))
			}
		}
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

// RegisterSSHNetwork registers a unique network name for a specific SSH tunnel
// Returns the network name to use in DSN
func RegisterSSHNetwork(sshConfig connection.SSHConfig) (string, error) {
	client, err := connectSSH(sshConfig)
	if err != nil {
		return "", err
	}

	// Generate unique network name
	netName := fmt.Sprintf("ssh_%s_%d", sshConfig.Host, time.Now().UnixNano())
	logger.Infof("注册 SSH 网络：%s（地址=%s:%d 用户=%s）", netName, sshConfig.Host, sshConfig.Port, sshConfig.User)
	
	mysql.RegisterDialContext(netName, func(ctx context.Context, addr string) (net.Conn, error) {
		return dialContext(ctx, client, "tcp", addr)
	})

	return netName, nil
}

// sshClientCache stores SSH clients to avoid creating multiple connections
var (
	sshClientCache   = make(map[string]*ssh.Client)
	sshClientCacheMu sync.RWMutex
	localForwarders  = make(map[string]*LocalForwarder)
	forwarderMu      sync.RWMutex
)

// LocalForwarder represents a local port forwarder through SSH
type LocalForwarder struct {
	LocalAddr  string
	RemoteAddr string
	SSHClient  *ssh.Client
	listener   net.Listener
	closeChan  chan struct{}
	closeOnce  sync.Once // 防止重复关闭
	closed     bool      // 关闭状态标记
	closedMu   sync.RWMutex
}

// NewLocalForwarder creates a new local port forwarder
// It listens on a random local port and forwards all connections through SSH tunnel
func NewLocalForwarder(sshConfig connection.SSHConfig, remoteHost string, remotePort int) (*LocalForwarder, error) {
	client, err := GetOrCreateSSHClient(sshConfig)
	if err != nil {
		return nil, fmt.Errorf("建立 SSH 连接失败：%w", err)
	}

	// Listen on localhost with a random port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("创建本地监听器失败：%w", err)
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

// Close closes the forwarder (thread-safe, can be called multiple times)
func (f *LocalForwarder) Close() error {
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
	f.closedMu.RLock()
	defer f.closedMu.RUnlock()
	return f.closed
}

// GetOrCreateLocalForwarder returns a cached forwarder or creates a new one
func GetOrCreateLocalForwarder(sshConfig connection.SSHConfig, remoteHost string, remotePort int) (*LocalForwarder, error) {
	key := fmt.Sprintf("%s:%d:%s->%s:%d",
		sshConfig.Host, sshConfig.Port, sshConfig.User,
		remoteHost, remotePort)

	forwarderMu.RLock()
	forwarder, exists := localForwarders[key]
	forwarderMu.RUnlock()

	// Check if exists and is still valid
	if exists && forwarder != nil && !forwarder.IsClosed() {
		logger.Infof("复用已有端口转发：%s", key)
		return forwarder, nil
	}

	// Remove stale forwarder from cache
	if exists {
		forwarderMu.Lock()
		delete(localForwarders, key)
		forwarderMu.Unlock()
	}

	forwarder, err := NewLocalForwarder(sshConfig, remoteHost, remotePort)
	if err != nil {
		return nil, err
	}

	forwarderMu.Lock()
	localForwarders[key] = forwarder
	forwarderMu.Unlock()

	return forwarder, nil
}

// CloseAllForwarders closes all local forwarders
func CloseAllForwarders() {
	forwarderMu.Lock()
	defer forwarderMu.Unlock()

	for key, forwarder := range localForwarders {
		if forwarder != nil {
			_ = forwarder.Close()
			logger.Infof("已关闭端口转发：%s", key)
		}
	}
	localForwarders = make(map[string]*LocalForwarder)
}


// getSSHClientCacheKey generates a unique cache key for SSH config
func getSSHClientCacheKey(config connection.SSHConfig) string {
	return fmt.Sprintf("%s:%d:%s", config.Host, config.Port, config.User)
}

// GetOrCreateSSHClient returns a cached SSH client or creates a new one
func GetOrCreateSSHClient(config connection.SSHConfig) (*ssh.Client, error) {
	key := getSSHClientCacheKey(config)

	sshClientCacheMu.RLock()
	client, exists := sshClientCache[key]
	sshClientCacheMu.RUnlock()

	if exists && client != nil {
		// Test if connection is still alive by creating a test session
		session, err := client.NewSession()
		if err == nil {
			session.Close()
			logger.Infof("复用已有 SSH 连接：%s", key)
			return client, nil
		}
		// Connection is dead, remove from cache
		logger.Warnf("SSH 连接已断开，重新建立：%s (错误: %v)", key, err)
		sshClientCacheMu.Lock()
		delete(sshClientCache, key)
		sshClientCacheMu.Unlock()
		// Try to close the dead client
		_ = client.Close()
	}

	// Create new SSH client
	client, err := connectSSH(config)
	if err != nil {
		return nil, err
	}

	// Cache the client
	sshClientCacheMu.Lock()
	sshClientCache[key] = client
	sshClientCacheMu.Unlock()

	logger.Infof("已缓存 SSH 连接：%s", key)
	return client, nil
}

// DialThroughSSH creates a connection through SSH tunnel
// This is a generic dialer that can be used by any database driver
func DialThroughSSH(config connection.SSHConfig, network, address string) (net.Conn, error) {
	client, err := GetOrCreateSSHClient(config)
	if err != nil {
		return nil, fmt.Errorf("建立 SSH 连接失败：%w", err)
	}

	conn, err := client.Dial(network, address)
	if err != nil {
		return nil, fmt.Errorf("通过 SSH 隧道连接到 %s 失败：%w", address, err)
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
			logger.Infof("已关闭 SSH 连接：%s", key)
		}
	}
	sshClientCache = make(map[string]*ssh.Client)
}

