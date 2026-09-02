package ssh

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	"github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
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

func connectSSH(config connection.SSHConfig) (*ssh.Client, error) {
	logger.Infof("开始建立 SSH 连接：地址=%s:%d 用户=%s", config.Host, config.Port, config.User)
	authMethods := []ssh.AuthMethod{}

	if keyPath := strings.TrimSpace(config.KeyPath); keyPath != "" {
		key, err := os.ReadFile(keyPath)
		if err != nil {
			config.ReportProgress("failed", "error")
			logger.Warnf("读取 SSH 私钥失败：路径=%s，原因：%v", keyPath, err)
			return nil, fmt.Errorf("failed to read SSH private key %s: %w", keyPath, err)
		}
		signer, err := ssh.ParsePrivateKey(key)
		if err != nil {
			config.ReportProgress("failed", "error")
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

	hostKeyCallback, err := newHostKeyCallback(config)
	if err != nil {
		config.ReportProgress("failed", "error")
		return nil, err
	}
	sshConfig := &ssh.ClientConfig{
		User:            config.User,
		Auth:            authMethods,
		HostKeyCallback: hostKeyCallback,
		Timeout:         5 * time.Second,
	}

	addr, _, err := sshDialAddress(config)
	if err != nil {
		config.ReportProgress("tcp_connecting", "error")
		return nil, err
	}
	config.ReportProgress("tcp_connecting", "running")
	tcpConn, err := net.DialTimeout("tcp", addr, sshConfig.Timeout)
	if err != nil {
		config.ReportProgress("tcp_connecting", "error")
		logger.Error(err, "SSH 连接建立失败：地址=%s 用户=%s", addr, config.User)
		return nil, err
	}
	config.ReportProgress("tcp_connected", "success")
	// net.DialTimeout only bounds the TCP connection. Keep the same deadline on
	// the socket while SSH exchanges its banner and host key so a peer that
	// accepts TCP but never completes SSH cannot leave the UI waiting forever.
	if err := tcpConn.SetDeadline(time.Now().Add(sshConfig.Timeout)); err != nil {
		_ = tcpConn.Close()
		config.ReportProgress("failed", "error")
		return nil, fmt.Errorf("set SSH handshake deadline: %w", err)
	}
	clientConn, channels, requests, err := ssh.NewClientConn(tcpConn, addr, sshConfig)
	if err != nil {
		_ = tcpConn.Close()
		config.ReportProgress("failed", "error")
		logger.Error(err, "SSH 连接建立失败：地址=%s 用户=%s", addr, config.User)
		return nil, err
	}
	_ = tcpConn.SetDeadline(time.Time{})
	client := ssh.NewClient(clientConn, channels, requests)
	config.ReportProgress("authenticated", "success")
	logger.Infof("SSH 连接建立成功：地址=%s 用户=%s", addr, config.User)
	return client, nil
}

func newHostKeyCallback(config connection.SSHConfig) (ssh.HostKeyCallback, error) {
	// An explicit known_hosts path is a user-selected verification policy. It
	// must take precedence over a legacy fingerprint that may coexist in an old
	// saved connection; otherwise a managed migration could silently bypass a
	// revoked or changed record in that file.
	if strings.TrimSpace(config.KnownHostsPath) != "" {
		return newKnownHostsOrManagedHostKeyCallback(config)
	}
	fingerprint := strings.TrimSpace(config.HostKeyFingerprint)
	if fingerprint != "" {
		const prefix = "SHA256:"
		if !strings.HasPrefix(fingerprint, prefix) {
			return nil, fmt.Errorf("invalid SSH host key fingerprint %q: expected SHA256:<base64>", fingerprint)
		}
		encoded := strings.TrimPrefix(fingerprint, prefix)
		decoded, err := base64.RawStdEncoding.DecodeString(encoded)
		if err != nil || len(decoded) != sha256.Size {
			if err == nil {
				err = fmt.Errorf("decoded fingerprint has length %d, want %d", len(decoded), sha256.Size)
			}
			return nil, fmt.Errorf("invalid SSH host key fingerprint %q: %w", fingerprint, err)
		}
		return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			config.ReportProgress("host_key_verifying", "running")
			actual := ssh.FingerprintSHA256(key)
			if actual != fingerprint {
				config.ReportProgress("host_key_verifying", "error")
				if strings.TrimSpace(config.ManagedHostKeyTrustStorePath()) != "" {
					// Existing connections can carry a legacy manual pin even though
					// the simplified UI no longer exposes that field. Surface a
					// structured change request so the user can explicitly replace
					// it with a GoNavi-managed record instead of being stranded by a
					// generic mismatch error.
					return newHostKeyTrustRequiredError(config, key, "changed", "legacy", fingerprint)
				}
				identity := hostname
				if address, _, err := sshHostKeyAddress(config); err == nil {
					identity = address
				}
				return fmt.Errorf("SSH host key fingerprint mismatch for %s: expected %s, got %s", identity, fingerprint, actual)
			}
			config.ReportProgress("host_key_verified", "success")
			config.ReportProgress("authenticating", "running")
			return nil
		}, nil
	}

	return newKnownHostsOrManagedHostKeyCallback(config)
}

func newKnownHostsOrManagedHostKeyCallback(config connection.SSHConfig) (ssh.HostKeyCallback, error) {
	knownHostsPath, usingDefaultKnownHosts := resolveKnownHostsPath(config.KnownHostsPath)
	managedTrustStorePath := config.ManagedHostKeyTrustStorePath()
	var knownHostsCallback ssh.HostKeyCallback
	if knownHostsPath != "" {
		callback, err := knownhosts.New(knownHostsPath)
		if err != nil {
			return nil, fmt.Errorf("failed to load SSH known_hosts file %s: %w", knownHostsPath, err)
		}
		knownHostsCallback = callback
	}
	if knownHostsCallback == nil && strings.TrimSpace(managedTrustStorePath) == "" {
		return nil, fmt.Errorf("SSH host key verification is required: configure hostKeyFingerprint or knownHostsPath")
	}

	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		identity, _, identityErr := sshHostKeyAddress(config)
		if identityErr != nil {
			config.ReportProgress("host_key_verifying", "error")
			return identityErr
		}
		if usingDefaultKnownHosts {
			config.ReportProgress("known_hosts_default", "running")
		}
		config.ReportProgress("host_key_verifying", "running")
		if knownHostsCallback != nil && !usingDefaultKnownHosts {
			// A path carried by an existing connection is an explicit user policy.
			// Do not let GoNavi's convenience store bypass a mismatch or revocation
			// in that file; only the auto-discovered default file may fall back to
			// the managed confirmation flow below.
			if err := knownHostsCallback(identity, remote, key); err != nil {
				config.ReportProgress("host_key_verifying", "error")
				return err
			}
			config.ReportProgress("host_key_verified", "success")
			config.ReportProgress("authenticating", "running")
			return nil
		}
		if knownHostsCallback != nil && usingDefaultKnownHosts {
			// A managed record is a convenience trust decision, never an override
			// for a security validation failure from OpenSSH. The only error that
			// may continue to GoNavi's managed confirmation flow is KeyError,
			// which represents an ordinary unknown or changed key. Certificate,
			// revocation, CA, principal, and validity errors must fail closed.
			if err := knownHostsCallback(identity, remote, key); err != nil {
				var keyErr *knownhosts.KeyError
				if !errors.As(err, &keyErr) {
					config.ReportProgress("host_key_verifying", "error")
					return err
				}
			}
		}

		if matched, trustRequired, err := managedHostKeyMatches(config, key); err != nil {
			config.ReportProgress("host_key_verifying", "error")
			return err
		} else if trustRequired != nil {
			config.ReportProgress("host_key_verifying", "error")
			return trustRequired
		} else if matched {
			config.ReportProgress("host_key_verified", "success")
			config.ReportProgress("authenticating", "running")
			return nil
		}

		if knownHostsCallback != nil {
			if err := knownHostsCallback(identity, remote, key); err == nil {
				config.ReportProgress("host_key_verified", "success")
				config.ReportProgress("authenticating", "running")
				return nil
			} else {
				var keyErr *knownhosts.KeyError
				if strings.TrimSpace(managedTrustStorePath) == "" || !errors.As(err, &keyErr) {
					config.ReportProgress("host_key_verifying", "error")
					return err
				}
				state := "unknown"
				previousFingerprint := ""
				if len(keyErr.Want) > 0 {
					state = "changed"
					previousFingerprint = ssh.FingerprintSHA256(keyErr.Want[0].Key)
				}
				config.ReportProgress("host_key_verifying", "error")
				return newHostKeyTrustRequiredError(config, key, state, "system", previousFingerprint)
			}
		}

		config.ReportProgress("host_key_verifying", "error")
		return newHostKeyTrustRequiredError(config, key, "unknown", "discovered", "")
	}, nil
}

// resolveKnownHostsPath leaves an explicitly selected file untouched. When the
// form is left empty, it uses the standard local OpenSSH file if one exists so
// ordinary SSH users do not have to retype ~/.ssh/known_hosts for every
// database connection. It never creates or writes this file.
func resolveKnownHostsPath(configuredPath string) (path string, usingDefault bool) {
	if path = strings.TrimSpace(configuredPath); path != "" {
		return path, false
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", false
	}
	candidate := filepath.Join(home, ".ssh", "known_hosts")
	info, err := os.Stat(candidate)
	if err != nil || info.IsDir() {
		return "", false
	}
	return candidate, true
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
	sshConfig.ReportProgress("tunnel_ready", "success")

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
	config.ReportProgress("tunnel_ready", "success")
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
	_, _ = hasher.Write([]byte{0})
	knownHostsPath, _ := resolveKnownHostsPath(config.KnownHostsPath)
	_, _ = hasher.Write([]byte(knownHostsPath))
	_, _ = hasher.Write([]byte{0})
	_, _ = hasher.Write([]byte(strings.TrimSpace(config.HostKeyFingerprint)))
	_, _ = hasher.Write([]byte{0})
	if identity, _, err := sshHostKeyAddress(config); err == nil {
		// The physical dial endpoint may be a short-lived localhost proxy. The
		// cache must nevertheless remain scoped to the real server identity that
		// supplied the host key.
		_, _ = hasher.Write([]byte(identity))
	}
	_, _ = hasher.Write([]byte{0})
	managedTrustStorePath := strings.TrimSpace(config.ManagedHostKeyTrustStorePath())
	_, _ = hasher.Write([]byte(managedTrustStorePath))
	if managedTrustStorePath != "" {
		_, _ = hasher.Write([]byte{0})
		if contents, err := os.ReadFile(managedTrustStorePath); err == nil {
			contentsDigest := sha256.Sum256(contents)
			_, _ = hasher.Write(contentsDigest[:])
		} else {
			_, _ = hasher.Write([]byte("managed_store_read_error"))
		}
	}
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
	if knownHostsPath != "" {
		if st, err := os.Stat(knownHostsPath); err == nil {
			_, _ = hasher.Write([]byte{0})
			_, _ = hasher.Write([]byte(st.ModTime().UTC().Format(time.RFC3339Nano)))
			_, _ = hasher.Write([]byte{0})
			_, _ = hasher.Write([]byte(strconv.FormatInt(st.Size(), 10)))
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

	// remoteDialFailure is the latest failed attempt made by the jump host to
	// reach RemoteAddr. Callers compare OccurredAt with their verification
	// start time, so concurrent leases do not clear or consume each other's
	// diagnostics.
	remoteDialFailure   *RemoteDialFailure
	remoteDialFailureMu sync.RWMutex

	// shared/cacheKey identify a lease returned by AcquireLocalForwarder.
	// The cached forwarder itself keeps shared nil and owns the listener.
	shared    *LocalForwarder
	cacheKey  forwarderCacheKey
	leaseOnce sync.Once
	refCount  int // guarded by forwarderMu; meaningful only on the cached forwarder
}

// RemoteDialFailure describes a failed connection from the SSH jump host to
// the configured remote endpoint. The local listener can only report a reset
// to its client, so retaining this detail makes tunnel verification errors
// actionable to database drivers.
type RemoteDialFailure struct {
	RemoteAddr string
	Err        error
	OccurredAt time.Time
}

func (f *LocalForwarder) diagnosticOwner() *LocalForwarder {
	if f == nil {
		return nil
	}
	if f.shared != nil {
		return f.shared
	}
	return f
}

// LastRemoteDialFailure returns the latest failed remote dial in the current
// diagnostic window, if one occurred.
func (f *LocalForwarder) LastRemoteDialFailure() (RemoteDialFailure, bool) {
	return f.RemoteDialFailureSince(time.Time{})
}

// RemoteDialFailureSince returns the latest remote dial failure after since.
// A zero since value returns the latest retained failure.
func (f *LocalForwarder) RemoteDialFailureSince(since time.Time) (RemoteDialFailure, bool) {
	owner := f.diagnosticOwner()
	if owner == nil {
		return RemoteDialFailure{}, false
	}
	owner.remoteDialFailureMu.RLock()
	failure := owner.remoteDialFailure
	owner.remoteDialFailureMu.RUnlock()
	if failure == nil || failure.Err == nil {
		return RemoteDialFailure{}, false
	}
	if !since.IsZero() && !failure.OccurredAt.After(since) {
		return RemoteDialFailure{}, false
	}
	return *failure, true
}

func (f *LocalForwarder) recordRemoteDialFailure(err error) {
	if f == nil || err == nil {
		return
	}
	owner := f.diagnosticOwner()
	if owner == nil {
		return
	}
	owner.remoteDialFailureMu.Lock()
	owner.remoteDialFailure = &RemoteDialFailure{RemoteAddr: owner.RemoteAddr, Err: err, OccurredAt: time.Now()}
	owner.remoteDialFailureMu.Unlock()
}

// NewLocalForwarder creates a new local port forwarder
// It listens on a random local port and forwards all connections through SSH tunnel
func NewLocalForwarder(sshConfig connection.SSHConfig, remoteHost string, remotePort int) (*LocalForwarder, error) {
	client, err := GetOrCreateSSHClient(sshConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to establish SSH connection: %w", err)
	}

	// Listen on localhost with a random port
	sshConfig.ReportProgress("tunnel_creating", "running")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		sshConfig.ReportProgress("tunnel_creating", "error")
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
	sshConfig.ReportProgress("tunnel_ready", "success")
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
		f.recordRemoteDialFailure(err)
		logger.Warnf("通过 SSH 连接到远程 %s 失败：%v", f.RemoteAddr, err)
		return
	}
	defer remoteConn.Close()

	// Bidirectional copy with error channel
	errc := make(chan error, 2)

	// Half-close each destination after its source reaches EOF. This propagates
	// EOF promptly without truncating data that is still flowing in reverse.
	// Copy from local to remote
	go func() {
		_, err := io.Copy(remoteConn, localConn)
		if err != nil {
			logger.Warnf("本地->远程数据复制错误：%v", err)
		}
		if closeWriter, ok := remoteConn.(interface{ CloseWrite() error }); ok {
			if closeErr := closeWriter.CloseWrite(); closeErr != nil {
				logger.Warnf("关闭远程连接写入方向失败：%v", closeErr)
			}
		}
		errc <- err
	}()

	// Copy from remote to local
	go func() {
		_, err := io.Copy(localConn, remoteConn)
		if err != nil {
			logger.Warnf("远程->本地数据复制错误：%v", err)
		}
		if closeWriter, ok := localConn.(interface{ CloseWrite() error }); ok {
			if closeErr := closeWriter.CloseWrite(); closeErr != nil {
				logger.Warnf("关闭本地连接写入方向失败：%v", closeErr)
			}
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
		sshConfig.ReportProgress("tunnel_ready", "success")
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
		sshConfig.ReportProgress("tunnel_ready", "success")
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
			config.ReportProgress("ssh_session_reused", "success")
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
	config.ReportProgress("tunnel_ready", "success")
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
