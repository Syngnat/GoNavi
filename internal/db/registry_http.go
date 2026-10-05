package db

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/internal/ssh"
)

// 描述表里走 HTTP 的驱动（Weaviate、InfluxDB 等）共用的连接配置、HTTP 客户端与 SSH 转发。
// 用到这些函数的驱动要在 sourcePrefixes 里加 registry，修订号才会随这里的改动变化。

// normalizeRegistryHTTPConfig 解析 http(s):// 连接串（schemeAliases 是数据源专属 scheme，如 weaviate、influxdb），
// 补默认主机与端口；https 打开 SSL。
func normalizeRegistryHTTPConfig(config connection.ConnectionConfig, defaultPort int, schemeAliases ...string) connection.ConnectionConfig {
	runConfig := applyRegistryHTTPURI(rewriteURIScheme(config, "http", schemeAliases...))
	if strings.TrimSpace(runConfig.Host) == "" {
		runConfig.Host = "localhost"
	}
	if runConfig.Port <= 0 {
		runConfig.Port = defaultPort
	}
	if strings.TrimSpace(runConfig.SSLMode) == "" && runConfig.UseSSL {
		runConfig.SSLMode = "required"
	}
	return runConfig
}

func applyRegistryHTTPURI(config connection.ConnectionConfig) connection.ConnectionConfig {
	text := strings.TrimSpace(config.URI)
	if text == "" {
		return config
	}
	// JDBC 连接串（jdbc:presto://…）改写 scheme 后仍带 jdbc: 前缀，解析前去掉。
	if len(text) > len("jdbc:") && strings.EqualFold(text[:len("jdbc:")], "jdbc:") {
		text = text[len("jdbc:"):]
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return config
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return config
	}
	if scheme == "https" {
		config.UseSSL = true
	}
	if parsed.User != nil {
		if user := parsed.User.Username(); user != "" && config.User == "" {
			config.User = user
		}
		if pass, ok := parsed.User.Password(); ok && config.Password == "" {
			config.Password = pass
		}
	}
	if host := parsed.Hostname(); host != "" {
		config.Host = host
		config.Port = 0
		if port, err := strconv.Atoi(parsed.Port()); err == nil && port > 0 {
			config.Port = port
		} else if scheme == "https" && parsed.Port() == "" {
			config.Port = 443
		}
	}
	return config
}

func registryHTTPBaseURL(config connection.ConnectionConfig) string {
	scheme := "http"
	if config.UseSSL {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s", scheme, net.JoinHostPort(strings.TrimSpace(config.Host), strconv.Itoa(config.Port)))
}

// registryHTTPConnectionParams 合并连接串查询参数与连接参数文本，后者优先。
func registryHTTPConnectionParams(config connection.ConnectionConfig, schemes ...string) url.Values {
	params := url.Values{}
	mergeConnectionParamValues(params, connectionParamsFromURI(config.URI, append([]string{"http", "https"}, schemes...)...))
	mergeConnectionParamValues(params, connectionParamsFromText(config.ConnectionParams))
	return params
}

// registryHTTPHeaderParams 取出 header.<名称>=<值> 形式的自定义请求头参数。
func registryHTTPHeaderParams(params url.Values) map[string]string {
	headers := make(map[string]string)
	for name, values := range params {
		if len(name) <= len("header.") || !strings.EqualFold(name[:len("header.")], "header.") || len(values) == 0 {
			continue
		}
		headerName := strings.TrimSpace(name[len("header."):])
		if value := strings.TrimSpace(values[0]); value != "" && isSafeConnectionParamKey(headerName) && !strings.Contains(headerName, " ") {
			headers[headerName] = value
		}
	}
	return headers
}

// firstNonEmptyParam 按顺序取第一个非空的参数值（同一参数常有多种拼写，如 accessToken / access_token）。
func firstNonEmptyParam(params map[string][]string, names ...string) string {
	for _, name := range names {
		if values := params[name]; len(values) > 0 && strings.TrimSpace(values[0]) != "" {
			return values[0]
		}
	}
	return ""
}

func buildRegistryHTTPClient(config connection.ConnectionConfig) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	dialTimeout := getConnectTimeout(config)
	transport.DialContext = (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext
	if tlsConfig, err := resolveGenericTLSConfig(config); err == nil && tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	if config.UseProxy {
		proxyCfg := config.Proxy
		transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
			defer cancel()
			return proxytunnel.DialContext(dialCtx, proxyCfg, network, addr)
		}
	}
	return &http.Client{Transport: transport}
}

// forwardRegistryHTTPThroughSSH 建立 SSH 本地转发，返回转发器与改写为本地地址的配置。
func forwardRegistryHTTPThroughSSH(config connection.ConnectionConfig, label string) (connection.ConnectionConfig, *ssh.LocalForwarder, error) {
	forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
	if err != nil {
		return config, nil, localizedDatabaseRuntimeError("db.backend.error.ssh_tunnel_create_failed", map[string]any{"detail": err.Error()})
	}
	host, portText, splitErr := net.SplitHostPort(forwarder.LocalAddr)
	port, convErr := strconv.Atoi(portText)
	if splitErr != nil || convErr != nil {
		_ = forwarder.Release()
		return config, nil, localizedDatabaseRuntimeError("db.backend.error.ssh_local_forward_addr_invalid", map[string]any{"address": forwarder.LocalAddr})
	}
	logger.Infof("%s 通过本地端口转发连接：%s -> %s:%d", label, forwarder.LocalAddr, config.Host, config.Port)
	config.Host, config.Port, config.UseSSH = host, port, false
	return config, forwarder, nil
}

// releaseRegistryHTTPForwarder 关闭 SSH 转发并记录失败。
func releaseRegistryHTTPForwarder(forwarder *ssh.LocalForwarder, label string) {
	if forwarder == nil {
		return
	}
	if err := forwarder.Release(); err != nil {
		logger.Warnf("关闭 %s SSH 端口转发失败：%v", label, err)
	}
}
