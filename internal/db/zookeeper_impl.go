//go:build gonavi_full_drivers || gonavi_zookeeper_driver

package db

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"

	"github.com/go-zookeeper/zk"
)

const (
	defaultZooKeeperPort = 2181
	// zookeeperSessionTimeout 是向服务端申请的会话超时；服务端会把它限制在 2～20 倍 tickTime 之间。
	zookeeperSessionTimeout = 30 * time.Second
)

// ZooKeeperDB 通过原生协议（go-zookeeper/zk）访问 ZooKeeper。znode 树呈现为库（chroot 下的顶层节点）与
// 表（库本身与下一级节点，表名是完整路径），网格行是表路径下整棵子树的节点；控制台用 zkCli 风格命令。
type ZooKeeperDB struct {
	driverVariantState
	conn *zk.Conn
	// servers 是会话可用的地址（经 SSH 转发时是本地地址），serverNames 记录转发地址对应的原主机名供 TLS 校验。
	servers     []string
	serverNames map[string]string
	proxy       *connection.ProxyConfig
	tlsConfig   *tls.Config
	// scope 是 chroot：库列表从这一层往下列，"/" 表示整棵树。
	scope      string
	acl        []zk.ACL
	forwarders []*ssh.LocalForwarder
	timeout    time.Duration
	cache      zookeeperWalkCache

	// failure 记录后台连接循环最近一次失败（拨号或会话握手），连接超时时作为原因展示。
	failureMu sync.Mutex
	failure   zookeeperConnectFailure
}

type zookeeperConnectFailure struct {
	handshake bool
	detail    string
}

var (
	_ Database              = (*ZooKeeperDB)(nil)
	_ QueryContexter        = (*ZooKeeperDB)(nil)
	_ ExecContexter         = (*ZooKeeperDB)(nil)
	_ BatchApplierContext   = (*ZooKeeperDB)(nil)
	_ DriverVariantReporter = (*ZooKeeperDB)(nil)
)

func (z *ZooKeeperDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = z.Close()
	defer func() {
		if err != nil {
			_ = z.Close()
		}
	}()

	target := resolveZooKeeperTarget(config)
	z.timeout = getConnectTimeout(config)
	z.scope = target.chroot
	if z.acl, err = parseZooKeeperACL(firstNonEmptyParam(target.params, "acl", "createAcl", "create_acl")); err != nil {
		return err
	}
	if len(z.acl) == 0 {
		z.acl = zk.WorldACL(zk.PermAll)
	}
	if config.UseProxy {
		proxy := config.Proxy
		z.proxy = &proxy
	}
	z.servers, z.serverNames = target.servers, map[string]string{}
	if config.UseSSH {
		if err := z.forwardServers(config); err != nil {
			return err
		}
	}
	if config.UseSSL {
		sslConfig := config
		if strings.TrimSpace(sslConfig.SSLMode) == "" {
			sslConfig.SSLMode = "required"
		}
		if z.tlsConfig, err = resolveGenericTLSConfig(sslConfig); err != nil {
			return err
		}
	}

	conn, events, err := zk.Connect(z.servers, zookeeperSessionTimeout,
		zk.WithDialer(z.dial), zk.WithHostProvider(&zookeeperHostProvider{}),
		zk.WithLogger(zookeeperConnLogger{z}), zk.WithLogInfo(false))
	if err != nil {
		return err
	}
	z.conn = conn
	if err := z.awaitSession(events); err != nil {
		return err
	}
	if user := strings.TrimSpace(target.user); user != "" {
		if err := conn.AddAuth("digest", []byte(user+":"+target.password)); err != nil {
			return zookeeperError(err, "")
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), z.timeout)
	defer cancel()
	version, probed := z.detectVersion(ctx)
	if err := z.resolve("zookeeper", config, version); err != nil {
		return err
	}
	if probed {
		// 四字命令被禁用时只能按特性推断档位，不把推断值当作服务端版本展示。
		z.serverVersion = ""
	}
	if exists, _, err := conn.Exists(z.scope); err != nil {
		return zookeeperError(err, z.scope)
	} else if !exists {
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_chroot_missing", map[string]any{"path": z.scope})
	}
	return nil
}

// awaitSession 等待会话建立：go-zookeeper 在后台轮询各地址，地址都不可用时会一直重试，这里按连接超时截断。
func (z *ZooKeeperDB) awaitSession(events <-chan zk.Event) error {
	timer := time.NewTimer(z.timeout)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return z.connectError()
			}
			switch event.State {
			case zk.StateHasSession:
				return nil
			case zk.StateAuthFailed:
				return localizedDatabaseRuntimeError("db.backend.error.zookeeper_auth_failed", nil)
			}
		case <-timer.C:
			return z.connectError()
		}
	}
}

func (z *ZooKeeperDB) connectError() error {
	z.failureMu.Lock()
	failure := z.failure
	z.failureMu.Unlock()
	params := map[string]any{"servers": strings.Join(z.servers, ","), "detail": failure.detail}
	switch {
	case failure.handshake:
		// TCP 已连通但会话握手失败：常见于端口与 SSL 设置不匹配（加密端口未开 SSL，或反过来）。
		return localizedDatabaseRuntimeError("db.backend.error.zookeeper_handshake_failed", params)
	case failure.detail == "":
		params["detail"] = "timeout"
	}
	return localizedDatabaseRuntimeError("db.backend.error.zookeeper_connect_failed", params)
}

func (z *ZooKeeperDB) recordFailure(handshake bool, detail string) {
	z.failureMu.Lock()
	z.failure = zookeeperConnectFailure{handshake: handshake, detail: detail}
	z.failureMu.Unlock()
}

// dial 是 go-zookeeper 的拨号函数：忽略库内置的 1 秒超时，按连接配置的超时拨号。
func (z *ZooKeeperDB) dial(_, address string, _ time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), z.timeout)
	defer cancel()
	conn, err := z.dialContext(ctx, address)
	if err != nil {
		z.recordFailure(false, err.Error())
	}
	return conn, err
}

// dialContext 建立到单个节点的连接：按需经驱动侧代理，开启 SSL 时完成 TLS 握手（四字命令共用）。
func (z *ZooKeeperDB) dialContext(ctx context.Context, address string) (net.Conn, error) {
	var (
		conn net.Conn
		err  error
	)
	if z.proxy != nil {
		conn, err = proxytunnel.DialContext(ctx, *z.proxy, "tcp", address)
	} else {
		conn, err = (&net.Dialer{KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", address)
	}
	if err != nil || z.tlsConfig == nil {
		return conn, err
	}
	tlsConfig := z.tlsConfig.Clone()
	if tlsConfig.ServerName == "" || len(z.servers) > 1 {
		host, _, _ := net.SplitHostPort(address)
		if original, ok := z.serverNames[address]; ok {
			host = original
		}
		tlsConfig.ServerName = host
	}
	tlsConn := tls.Client(conn, tlsConfig)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return tlsConn, nil
}

// forwardServers 为每个节点建立 SSH 本地转发。
func (z *ZooKeeperDB) forwardServers(config connection.ConnectionConfig) error {
	forwarded := make([]string, 0, len(z.servers))
	for _, server := range z.servers {
		host, portText, _ := net.SplitHostPort(server)
		port, _ := strconv.Atoi(portText)
		target := config
		target.Host, target.Port = host, port
		local, forwarder, err := forwardRegistryHTTPThroughSSH(target, "ZooKeeper")
		if err != nil {
			return err
		}
		z.forwarders = append(z.forwarders, forwarder)
		address := net.JoinHostPort(local.Host, strconv.Itoa(local.Port))
		z.serverNames[address] = host
		forwarded = append(forwarded, address)
	}
	z.servers = forwarded
	return nil
}

var zookeeperVersionPattern = regexp.MustCompile(`(?i)zookeeper version:\s*([0-9]+(?:\.[0-9]+)*)`)

// detectVersion 用四字命令 srvr 读服务端版本（3.5.3 起默认白名单只有 srvr）；被禁用时按 3.5 起才有的
// /zookeeper/config 节点推断档位，probed 为 true。
func (z *ZooKeeperDB) detectVersion(ctx context.Context) (string, bool) {
	if text, err := z.fourLetterWord(ctx, "srvr"); err == nil {
		if match := zookeeperVersionPattern.FindStringSubmatch(text); match != nil {
			return match[1], false
		}
	}
	if exists, _, err := z.conn.Exists(zookeeperConfigNode); err == nil && exists {
		return "3.5", true
	}
	return "3.4", true
}

func (z *ZooKeeperDB) Close() error {
	if z.conn != nil {
		z.conn.Close()
		z.conn = nil
	}
	for _, forwarder := range z.forwarders {
		releaseRegistryHTTPForwarder(forwarder, "ZooKeeper")
	}
	z.forwarders = nil
	z.cache.clear()
	return nil
}

func (z *ZooKeeperDB) Ping() error {
	if z.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	_, _, err := z.conn.Exists("/")
	return zookeeperError(err, "/")
}

func (z *ZooKeeperDB) requestContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(metadataContextFor(z), 2*time.Minute)
}

// zookeeperTarget 是解析后的连接目标。
type zookeeperTarget struct {
	servers        []string
	chroot         string
	user, password string
	params         url.Values
}

// resolveZooKeeperTarget 合并连接串与表单字段：连接串支持 zookeeper:// / zk:// 与原生写法
// host1:2181,host2:2181/chroot；表单的其他节点写在 servers 参数里，chroot 取默认库或 chroot 参数。
func resolveZooKeeperTarget(config connection.ConnectionConfig) zookeeperTarget {
	target := zookeeperTarget{user: config.User, password: config.Password, params: url.Values{}}
	uriServers, uriChroot := parseZooKeeperConnectString(config.URI, &target)
	mergeConnectionParamValues(target.params, connectionParamsFromText(config.ConnectionParams))
	port := config.Port
	if port <= 0 {
		port = defaultZooKeeperPort
	}
	candidates := uriServers
	if len(candidates) == 0 {
		host := strings.TrimSpace(config.Host)
		if host == "" {
			host = "localhost"
		}
		candidates = append([]string{net.JoinHostPort(host, strconv.Itoa(port))}, config.Hosts...)
	}
	candidates = append(candidates, strings.Split(firstNonEmptyParam(target.params, "servers", "hosts", "endpoints"), ",")...)
	seen := map[string]struct{}{}
	for _, raw := range candidates {
		server := normalizeZooKeeperServer(raw, port)
		if _, ok := seen[server]; server != "" && !ok {
			seen[server] = struct{}{}
			target.servers = append(target.servers, server)
		}
	}
	chroot := strings.TrimSpace(config.Database)
	if chroot == "" {
		chroot = firstNonEmptyParam(target.params, "chroot", "prefix", "root")
	}
	if chroot == "" {
		chroot = uriChroot
	}
	target.chroot = normalizeZooKeeperPath(chroot)
	if target.chroot == "" {
		target.chroot = "/"
	}
	return target
}

// parseZooKeeperConnectString 解析连接串，返回其中的节点与 chroot；用户信息只在表单未填写时采用。
func parseZooKeeperConnectString(text string, target *zookeeperTarget) ([]string, string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, ""
	}
	if scheme, rest, ok := strings.Cut(text, "://"); ok {
		switch strings.ToLower(scheme) {
		case "zookeeper", "zk":
			text = rest
		default:
			return nil, ""
		}
	}
	text, query, _ := strings.Cut(text, "?")
	if values, err := url.ParseQuery(query); err == nil {
		mergeConnectionParamValues(target.params, values)
	}
	authority, chroot, _ := strings.Cut(text, "/")
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		userInfo := authority[:at]
		authority = authority[at+1:]
		user, password, _ := strings.Cut(userInfo, ":")
		if decoded, err := url.PathUnescape(user); err == nil && target.user == "" {
			target.user = decoded
		}
		if decoded, err := url.PathUnescape(password); err == nil && target.password == "" {
			target.password = decoded
		}
	}
	if decoded, err := url.PathUnescape(chroot); err == nil {
		chroot = decoded
	}
	var servers []string
	for _, server := range strings.Split(authority, ",") {
		if server = strings.TrimSpace(server); server != "" {
			servers = append(servers, server)
		}
	}
	return servers, chroot
}

func normalizeZooKeeperServer(raw string, defaultPort int) string {
	raw = strings.TrimSpace(raw)
	if index := strings.Index(raw, "://"); index >= 0 {
		raw = raw[index+3:]
	}
	raw = strings.TrimSuffix(raw, "/")
	if raw == "" {
		return ""
	}
	if host, port, err := net.SplitHostPort(raw); err == nil {
		return net.JoinHostPort(host, port)
	}
	return net.JoinHostPort(strings.Trim(raw, "[]"), strconv.Itoa(defaultPort))
}

// normalizeZooKeeperPath 规范化 znode 路径：补前导 /，去掉结尾 /（根节点除外）。空串原样返回。
func normalizeZooKeeperPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if len(path) > 1 {
		path = strings.TrimRight(path, "/")
		if path == "" {
			return "/"
		}
	}
	return path
}

// zookeeperHostProvider 按给定顺序轮询地址，不做本地 DNS 解析（经代理时主机名只能由代理解析）。
type zookeeperHostProvider struct {
	mu      sync.Mutex
	servers []string
	current int
	last    int
}

func (p *zookeeperHostProvider) Init(servers []string) error {
	if len(servers) == 0 {
		return errors.New("zk: server list must not be empty")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.servers, p.current, p.last = append([]string(nil), servers...), -1, -1
	return nil
}

func (p *zookeeperHostProvider) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.servers)
}

func (p *zookeeperHostProvider) Next() (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.current = (p.current + 1) % len(p.servers)
	retryStart := p.current == p.last
	if p.last == -1 {
		p.last = 0
	}
	return p.servers[p.current], retryStart
}

func (p *zookeeperHostProvider) Connected() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.last = p.current
}

// zookeeperConnLogger 接收 go-zookeeper 的日志：只记录会话握手失败（"authentication failed: …"），其余丢弃。
type zookeeperConnLogger struct {
	z *ZooKeeperDB
}

func (l zookeeperConnLogger) Printf(format string, args ...interface{}) {
	if message := fmt.Sprintf(format, args...); strings.HasPrefix(message, "authentication failed") {
		l.z.recordFailure(true, message)
	}
}
