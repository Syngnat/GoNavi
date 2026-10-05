//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"

	"GoNavi-Wails/internal/connection"

	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
)

func (c *ClickHouseDB) buildClickHouseOptions(config connection.ConnectionConfig) (*clickhouse.Options, error) {
	return c.buildClickHouseOptionsWithHTTPCompatibility(config, false)
}

func (c *ClickHouseDB) buildClickHouseOptionsWithHTTPCompatibility(config connection.ConnectionConfig, stripHTTPClientProtocolVersion bool) (*clickhouse.Options, error) {
	connectTimeout := getConnectTimeout(config)
	protocol := detectClickHouseProtocol(config)
	opts := &clickhouse.Options{
		Protocol: protocol,
		Addr: []string{
			net.JoinHostPort(config.Host, strconv.Itoa(config.Port)),
		},
		Auth: clickhouse.Auth{
			Database: strings.TrimSpace(config.Database),
			Username: strings.TrimSpace(config.User),
			Password: config.Password,
		},
		DialTimeout: connectTimeout,
		ReadTimeout: clickHouseNoAutomaticReadTimeout,
	}
	tlsConfig, err := resolveGenericTLSConfig(config)
	if err != nil {
		return nil, err
	}
	if tlsConfig != nil {
		opts.TLS = tlsConfig
	}
	applyClickHouseConnectionParams(opts, config)
	if stripHTTPClientProtocolVersion && protocol == clickhouse.HTTP {
		installClickHouseHTTPClientProtocolVersionStripper(opts)
	}
	return opts, nil
}

type clickHouseHTTPClientProtocolVersionStripper struct {
	next http.RoundTripper
	// serverHelloRewritten 保证只对每个连接的首个握手探测请求改写一次，
	// 避免连接建立之后误改写恰好相同的用户查询（clickhouse-go 的 queryHello
	// 始终是连接上的第一个 HTTP 请求）。
	serverHelloRewritten *atomic.Bool
}

func (rt clickHouseHTTPClientProtocolVersionStripper) RoundTrip(req *http.Request) (*http.Response, error) {
	next := rt.next
	if next == nil {
		next = http.DefaultTransport
	}
	if req == nil || req.URL == nil {
		return next.RoundTrip(req)
	}

	query := req.URL.Query()
	stripParam := false
	if _, ok := query["client_protocol_version"]; ok {
		stripParam = true
	}

	var (
		rewrittenBody      []byte
		hadServerInfoQuery bool
		err                error
	)
	// 仅在握手阶段（首个匹配请求）改写探测查询；后续用户查询一律放行。
	if rt.serverHelloRewritten == nil || !rt.serverHelloRewritten.Load() {
		rewrittenBody, hadServerInfoQuery, err = rewriteClickHouseServerHelloRequestBody(req)
		if err != nil {
			return nil, err
		}
		if hadServerInfoQuery && rt.serverHelloRewritten != nil {
			rt.serverHelloRewritten.Store(true)
		}
	}

	if !stripParam && !hadServerInfoQuery {
		return next.RoundTrip(req)
	}

	cloned := req.Clone(req.Context())
	if stripParam {
		clonedURL := *req.URL
		query.Del("client_protocol_version")
		clonedURL.RawQuery = query.Encode()
		cloned.URL = &clonedURL
	}
	if hadServerInfoQuery {
		cloned.Body = io.NopCloser(bytes.NewReader(rewrittenBody))
		cloned.ContentLength = int64(len(rewrittenBody))
		cloned.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(rewrittenBody)), nil
		}
	}
	return next.RoundTrip(cloned)
}

// clickHouseServerHelloQuery 是 clickhouse-go HTTP 驱动在握手阶段发送的服务端信息探测语句。
// 旧版本服务端（如 ClickHouse 22.8）没有 displayName() 函数，会直接返回 UNKNOWN_FUNCTION。
const clickHouseServerHelloQuery = "SELECT displayName(), version(), revision(), timezone()"

// clickHouseServerHelloCompatQuery 使用 hostName() 替换不存在的 displayName()。
// hostName() 在所有受支持的 ClickHouse 版本上都可用，并返回服务端主机名，
// 足以填充驱动握手所需的显示名称字段，其余 version()/revision()/timezone() 保持不变。
const clickHouseServerHelloCompatQuery = "SELECT hostName(), version(), revision(), timezone()"

// rewriteClickHouseServerHelloRequestBody 检测并改写握手探测请求体，将 displayName() 替换为
// hostName()。仅当请求体恰好是驱动的握手探测语句时才改写，其它请求体一律原样放行。
func rewriteClickHouseServerHelloRequestBody(req *http.Request) ([]byte, bool, error) {
	if req == nil || req.Body == nil || req.Body == http.NoBody {
		return nil, false, nil
	}
	body, err := io.ReadAll(req.Body)
	closeErr := req.Body.Close()
	if err != nil {
		return nil, false, err
	}
	if closeErr != nil {
		return nil, false, closeErr
	}
	// 恢复原始请求体，保证非握手请求不受影响。
	req.Body = io.NopCloser(bytes.NewReader(body))
	if strings.TrimSpace(string(body)) != clickHouseServerHelloQuery {
		return nil, false, nil
	}
	return []byte(clickHouseServerHelloCompatQuery), true, nil
}

func installClickHouseHTTPClientProtocolVersionStripper(opts *clickhouse.Options) {
	if opts == nil {
		return
	}
	previous := opts.TransportFunc
	opts.TransportFunc = func(base *http.Transport) (http.RoundTripper, error) {
		next := http.RoundTripper(base)
		if previous != nil {
			wrapped, err := previous(base)
			if err != nil {
				return nil, err
			}
			if wrapped != nil {
				next = wrapped
			}
		}
		return clickHouseHTTPClientProtocolVersionStripper{
			next:                 next,
			serverHelloRewritten: &atomic.Bool{},
		}, nil
	}
}
