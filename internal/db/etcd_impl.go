//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/datasource"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"

	"go.etcd.io/etcd/api/v3/v3rpc/rpctypes"
	clientv3 "go.etcd.io/etcd/client/v3"
	"go.uber.org/zap"
	"google.golang.org/grpc"
)

const (
	defaultEtcdPort      = 2379
	defaultEtcdDelimiter = "/"
)

// EtcdDB 通过 v3 gRPC API（clientv3）或 v2 HTTP keys API 访问 etcd。键空间按分隔符（默认 /）呈现为
// 库（顶层前缀）与表（下一级前缀，表名是完整路径），网格行是前缀下的键；控制台用 etcdctl 风格命令。
type EtcdDB struct {
	driverVariantState
	v3         *clientv3.Client
	v2         *etcdV2Client
	httpClient *http.Client
	scheme     string
	endpoints  []string
	delimiter  string
	// scope 是连接配置的键前缀（Database 或 prefix 参数）：库列表从这一层往下列。
	scope      string
	forwarders []*ssh.LocalForwarder
	timeout    time.Duration
}

var (
	_ Database              = (*EtcdDB)(nil)
	_ QueryContexter        = (*EtcdDB)(nil)
	_ ExecContexter         = (*EtcdDB)(nil)
	_ BatchApplierContext   = (*EtcdDB)(nil)
	_ DriverVariantReporter = (*EtcdDB)(nil)
)

func (e *EtcdDB) Connect(config connection.ConnectionConfig) (err error) {
	_ = e.Close()
	defer func() {
		if err != nil {
			_ = e.Close()
		}
	}()

	runConfig := normalizeRegistryHTTPConfig(config, defaultEtcdPort, "etcd")
	params := registryHTTPConnectionParams(runConfig, "etcd")
	e.timeout = getConnectTimeout(runConfig)
	e.delimiter = firstNonEmptyParam(params, "delimiter", "separator")
	if e.delimiter == "" {
		e.delimiter = defaultEtcdDelimiter
	}
	e.scope = strings.TrimSpace(runConfig.Database)
	if e.scope == "" {
		e.scope = strings.TrimSpace(firstNonEmptyParam(params, "prefix", "namespace"))
	}
	e.scheme = "http"
	if runConfig.UseSSL {
		e.scheme = "https"
	}

	endpoints := etcdEndpoints(runConfig, firstNonEmptyParam(params, "endpoints"))
	serverName := strings.TrimSpace(runConfig.Host)
	if runConfig.UseSSH {
		if endpoints, err = e.forwardEndpoints(runConfig, endpoints); err != nil {
			return err
		}
	}
	e.endpoints = endpoints
	tlsConfig, err := etcdTLSConfig(runConfig, serverName, len(e.forwarders) > 0)
	if err != nil {
		return err
	}
	e.httpClient = buildRegistryHTTPClient(runConfig)
	if transport, ok := e.httpClient.Transport.(*http.Transport); ok && tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}

	ctx, cancel := context.WithTimeout(context.Background(), e.timeout)
	defer cancel()
	spec, _ := datasource.Lookup("etcd")
	requested := spec.RequestedVariant(runConfig.DriverVariant)
	version := e.httpVersion(ctx)
	if requested != "v2" && (version == "" || datasource.CompareServerVersions(version, "3.0") >= 0) {
		if err := e.connectV3(runConfig, tlsConfig); err != nil {
			return etcdAuthError(err)
		}
		if version == "" {
			if status, statusErr := e.v3.Status(ctx, e.endpoints[0]); statusErr == nil {
				version = status.Version
			}
		}
	}
	if err := e.resolve("etcd", config, version); err != nil {
		return err
	}
	if e.variant.ID == "v2" {
		if e.v3 != nil {
			_ = e.v3.Close()
			e.v3 = nil
		}
		e.v2 = &etcdV2Client{http: e.httpClient, scheme: e.scheme, endpoints: e.endpoints, user: runConfig.User, password: runConfig.Password}
		_, err := e.v2.get(ctx, "/", false)
		return err
	}
	return etcdAuthError(e.verifyV3(ctx))
}

// etcdAuthError 把服务端的认证错误换成可操作的提示：开启了认证却没填用户，或用户名 / 密码不对。
func etcdAuthError(err error) error {
	switch {
	case errors.Is(err, rpctypes.ErrUserEmpty):
		return localizedDatabaseRuntimeError("db.backend.error.etcd_auth_required", nil)
	case errors.Is(err, rpctypes.ErrAuthFailed):
		return localizedDatabaseRuntimeError("db.backend.error.etcd_auth_failed", nil)
	}
	return err
}

// verifyV3 用一次只取计数的读确认连接、TLS 与认证可用（clientv3 在第一次请求时才真正连接）。
// 有前缀范围时读范围内；已认证但没有该键权限（只授权了部分前缀）不算连接失败，浏览时再提示设置 prefix。
func (e *EtcdDB) verifyV3(ctx context.Context) error {
	key, options := "\x00", []clientv3.OpOption{clientv3.WithCountOnly()}
	if prefix := e.databasePrefix(); prefix != "" {
		key, options = prefix, append(options, clientv3.WithPrefix())
	}
	_, err := e.v3.Get(ctx, key, options...)
	if errors.Is(err, rpctypes.ErrPermissionDenied) {
		return nil
	}
	return err
}

func (e *EtcdDB) connectV3(config connection.ConnectionConfig, tlsConfig *tls.Config) error {
	var dialOptions []grpc.DialOption
	if config.UseProxy {
		proxy := config.Proxy
		dialOptions = append(dialOptions, grpc.WithContextDialer(func(ctx context.Context, address string) (net.Conn, error) {
			return proxytunnel.DialContext(ctx, proxy, "tcp", address)
		}))
	}
	client, err := clientv3.New(clientv3.Config{
		Endpoints:            e.endpoints,
		DialTimeout:          e.timeout,
		DialKeepAliveTime:    30 * time.Second,
		DialKeepAliveTimeout: 10 * time.Second,
		TLS:                  tlsConfig,
		Username:             strings.TrimSpace(config.User),
		Password:             config.Password,
		DialOptions:          dialOptions,
		Logger:               zap.NewNop(),
	})
	if err != nil {
		return err
	}
	e.v3 = client
	return nil
}

// etcdEndpoints 收集主机与端口：主地址、连接里的其他地址与 endpoints 参数（逗号分隔，集群的多个节点）。
func etcdEndpoints(config connection.ConnectionConfig, extra string) []string {
	endpoints := []string{net.JoinHostPort(strings.TrimSpace(config.Host), strconv.Itoa(config.Port))}
	seen := map[string]struct{}{endpoints[0]: {}}
	candidates := append([]string{}, config.Hosts...)
	for _, raw := range strings.Split(extra, ",") {
		raw = strings.TrimSpace(raw)
		if index := strings.Index(raw, "://"); index >= 0 {
			raw = raw[index+3:]
		}
		candidates = append(candidates, strings.TrimSuffix(raw, "/"))
	}
	for _, raw := range candidates {
		host, port, err := net.SplitHostPort(strings.TrimSpace(raw))
		if err != nil {
			host, port = strings.TrimSpace(raw), strconv.Itoa(config.Port)
		}
		if host == "" {
			continue
		}
		endpoint := net.JoinHostPort(host, port)
		if _, ok := seen[endpoint]; !ok {
			seen[endpoint] = struct{}{}
			endpoints = append(endpoints, endpoint)
		}
	}
	return endpoints
}

// forwardEndpoints 为每个节点建立 SSH 本地转发。
func (e *EtcdDB) forwardEndpoints(config connection.ConnectionConfig, endpoints []string) ([]string, error) {
	forwarded := make([]string, 0, len(endpoints))
	for _, endpoint := range endpoints {
		host, portText, _ := net.SplitHostPort(endpoint)
		port, _ := strconv.Atoi(portText)
		target := config
		target.Host, target.Port = host, port
		local, forwarder, err := forwardRegistryHTTPThroughSSH(target, "etcd")
		if err != nil {
			return nil, err
		}
		e.forwarders = append(e.forwarders, forwarder)
		forwarded = append(forwarded, net.JoinHostPort(local.Host, strconv.Itoa(local.Port)))
	}
	return forwarded, nil
}

// etcdTLSConfig 构造 TLS 配置；经 SSH 转发时地址变成本机端口，证书仍按原主机名校验。
func etcdTLSConfig(config connection.ConnectionConfig, serverName string, forwarded bool) (*tls.Config, error) {
	if !config.UseSSL {
		return nil, nil
	}
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil || tlsConfig == nil {
		return tlsConfig, err
	}
	if forwarded && serverName != "" {
		tlsConfig.ServerName = serverName
	}
	return tlsConfig, nil
}

// httpVersion 读 /version（2.x 与 3.x 都提供，且不需要认证）；读不到时返回空串。
func (e *EtcdDB) httpVersion(ctx context.Context) string {
	for _, endpoint := range e.endpoints {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.scheme+"://"+endpoint+"/version", nil)
		if err != nil {
			continue
		}
		res, err := e.httpClient.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		_ = res.Body.Close()
		var payload struct {
			Server string `json:"etcdserver"`
		}
		if res.StatusCode == http.StatusOK && json.Unmarshal(body, &payload) == nil && payload.Server != "" {
			return strings.TrimSpace(payload.Server)
		}
	}
	return ""
}

func (e *EtcdDB) Close() error {
	if e.v3 != nil {
		_ = e.v3.Close()
		e.v3 = nil
	}
	e.v2 = nil
	for _, forwarder := range e.forwarders {
		releaseRegistryHTTPForwarder(forwarder, "etcd")
	}
	e.forwarders = nil
	return nil
}

func (e *EtcdDB) Ping() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	switch {
	case e.v3 != nil:
		return e.verifyV3(ctx)
	case e.v2 != nil:
		_, err := e.v2.get(ctx, "/", false)
		return err
	}
	return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
}

// databasePrefix 是库列表所在层的前缀：没有范围时是整个键空间，否则是 范围+分隔符。
func (e *EtcdDB) databasePrefix() string {
	scope := strings.TrimSuffix(e.scope, e.delimiter)
	if scope == "" {
		return ""
	}
	return scope + e.delimiter
}

func (e *EtcdDB) requestContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(metadataContextFor(e), 2*time.Minute)
}

// etcdV2Path 规范化 v2 键路径：以 / 开头，转义每一段。
func etcdV2Path(key string) string {
	segments := strings.Split(strings.Trim(key, "/"), "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return "/" + strings.Join(segments, "/")
}
