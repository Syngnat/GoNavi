package app

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
)

func isFileDatabaseType(driverType string) bool {
	switch strings.ToLower(strings.TrimSpace(driverType)) {
	case "sqlite", "duckdb":
		return true
	default:
		return false
	}
}

func resolveDialConfigWithProxy(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
	config := raw
	if config.UseHTTPTunnel {
		if config.UseProxy {
			return connection.ConnectionConfig{}, fmt.Errorf("%s", defaultAppText("db.backend.error.http_tunnel_proxy_conflict", nil))
		}
		tunnelHost := strings.TrimSpace(config.HTTPTunnel.Host)
		if tunnelHost == "" {
			return connection.ConnectionConfig{}, fmt.Errorf("%s", defaultAppText("db.backend.error.http_tunnel_host_required", nil))
		}
		if isNavicatHTTPTunnelURL(tunnelHost) {
			if !supportsNavicatMySQLTunnel(config) {
				return connection.ConnectionConfig{}, fmt.Errorf("Navicat HTTP 隧道当前仅支持 MySQL 兼容连接")
			}
			if config.UseSSH {
				return connection.ConnectionConfig{}, fmt.Errorf("Navicat HTTP 隧道不能与 SSH 隧道同时启用")
			}
			config.HTTPTunnel.Host = tunnelHost
			config.UseProxy = false
			config.Proxy = connection.ProxyConfig{}
			return config, nil
		}
		tunnelPort := config.HTTPTunnel.Port
		if tunnelPort <= 0 {
			tunnelPort = 8080
		}
		if tunnelPort > 65535 {
			return connection.ConnectionConfig{}, fmt.Errorf("%s", defaultAppText("db.backend.error.http_tunnel_port_invalid", map[string]any{
				"port": config.HTTPTunnel.Port,
			}))
		}

		config.UseProxy = true
		config.Proxy = connection.ProxyConfig{
			Type:     "http",
			Host:     tunnelHost,
			Port:     tunnelPort,
			User:     strings.TrimSpace(config.HTTPTunnel.User),
			Password: config.HTTPTunnel.Password,
		}
	}
	if !config.UseProxy {
		config.Proxy = connection.ProxyConfig{}
		config.UseHTTPTunnel = false
		config.HTTPTunnel = connection.HTTPTunnelConfig{}
		return config, nil
	}

	normalizedProxy, err := proxytunnel.NormalizeConfig(config.Proxy)
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	config.Proxy = normalizedProxy
	config.UseHTTPTunnel = false
	config.HTTPTunnel = connection.HTTPTunnelConfig{}

	if config.UseSSH {
		sshHost := strings.TrimSpace(config.SSH.Host)
		if sshHost == "" {
			return connection.ConnectionConfig{}, fmt.Errorf("%s", defaultAppText("connection_modal.validation.ssh_host_required", nil))
		}
		sshPort := config.SSH.Port
		if sshPort <= 0 {
			sshPort = 22
		}
		// The proxy needs a local, ephemeral dial endpoint, but host-key trust
		// must remain bound to the real bastion address the user configured.
		config.SSH = config.SSH.WithHostKeyIdentity(sshHost, sshPort)
		forwardedSSH, err := buildProxyForwardAddress(normalizedProxy, sshHost, sshPort, appConnectTimeout(config))
		if err != nil {
			return connection.ConnectionConfig{}, fmt.Errorf("%s", defaultAppText("db.backend.error.proxy_ssh_gateway_connect_failed", map[string]any{
				"detail": err.Error(),
			}))
		}
		config.SSH.Host = forwardedSSH.host
		config.SSH.Port = forwardedSSH.port
		config.UseProxy = false
		config.Proxy = connection.ProxyConfig{}
		return config, nil
	}

	normalizedType := normalizeDriverType(config.Type)
	if normalizedType == "nacos" || normalizedType == "pulsar" || normalizedType == "xxljob" {
		// Nacos needs the original authority for its proxy-aware HTTP transport.
		// Pulsar discovers brokers and cannot reuse one forwarded endpoint;
		// preserve the setting so its driver rejects the unsupported route.
		// XXL-JOB is likewise a single HTTP endpoint reached directly, and its
		// transport resolves the SSH or proxy hop itself.
		return config, nil
	}
	if normalizedType == "rocketmq" || normalizedType == "rocket-mq" || normalizedType == "rocket_mq" || normalizedType == "apache-rocketmq" || normalizedType == "apache_rocketmq" || normalizedType == "rmq" {
		// RocketMQ discovers broker addresses from NameServer responses. Its
		// driver must keep the proxy so it can forward both address layers.
		return config, nil
	}
	if normalizedType == "sqlite" || normalizedType == "duckdb" || normalizedType == "custom" {
		// 文件型/自定义 DSN 类型不走标准 host:port，不在此层改写。
		return config, nil
	}
	if normalizedType == "mongodb" || registryUsesDriverProxy(normalizedType) {
		// MongoDB 与描述表声明 proxyMode=driver 的类型由驱动侧处理代理，保留原始目标地址：
		// HTTPS 云服务需要原始主机名做 SNI/证书校验，集群发现型驱动不能只转发一个地址。
		return config, nil
	}

	target, err := resolveProxyTarget(config, normalizedType)
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	if config.UseSSL {
		config.TLSServerName = target.host
	}
	forwardedPrimary, err := buildProxyForwardAddress(normalizedProxy, target.host, target.port, appConnectTimeout(config))
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	config.Host = forwardedPrimary.host
	config.Port = forwardedPrimary.port

	if len(config.Hosts) > 0 {
		rewritten := make([]string, 0, len(config.Hosts))
		seen := make(map[string]struct{}, len(config.Hosts))
		for _, rawEntry := range config.Hosts {
			targetHost, targetPort, ok := parseAddressWithDefaultPort(rawEntry, defaultPortByType(normalizedType))
			if !ok {
				continue
			}
			forwarded, forwardErr := buildProxyForwardAddress(normalizedProxy, targetHost, targetPort, appConnectTimeout(config))
			if forwardErr != nil {
				return connection.ConnectionConfig{}, forwardErr
			}
			rewrittenAddress := formatHostPort(forwarded.host, forwarded.port)
			if _, exists := seen[rewrittenAddress]; exists {
				continue
			}
			seen[rewrittenAddress] = struct{}{}
			rewritten = append(rewritten, rewrittenAddress)
		}
		config.Hosts = rewritten
	}

	config.UseProxy = false
	config.Proxy = connection.ProxyConfig{}
	return config, nil
}

func isNavicatHTTPTunnelURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "http") || strings.EqualFold(parsed.Scheme, "https")
}

func supportsNavicatMySQLTunnel(config connection.ConnectionConfig) bool {
	switch strings.ToLower(strings.TrimSpace(config.Type)) {
	case "", "mysql", "goldendb", "greatdb", "gdb":
		return true
	default:
		return false
	}
}

type hostPort struct {
	host string
	port int
}

func buildProxyForwardAddress(proxyConfig connection.ProxyConfig, targetHost string, targetPort int, timeouts ...time.Duration) (hostPort, error) {
	host := strings.TrimSpace(targetHost)
	if host == "" {
		host = "localhost"
	}
	port := targetPort
	if port <= 0 {
		return hostPort{}, fmt.Errorf("%s", defaultAppText("db.backend.error.proxy_target_port_invalid", map[string]any{
			"port": targetPort,
		}))
	}

	timeout := time.Duration(0)
	if len(timeouts) > 0 {
		timeout = timeouts[0]
	}
	forwarder, err := proxytunnel.GetOrCreateLocalForwarderWithTimeout(proxyConfig, host, port, timeout)
	if err != nil {
		return hostPort{}, err
	}
	localHost, localPort, splitOK := parseAddressWithDefaultPort(forwarder.LocalAddr, 0)
	if !splitOK || localPort <= 0 {
		return hostPort{}, fmt.Errorf("%s", defaultAppText("db.backend.error.proxy_local_forward_addr_parse_failed", map[string]any{
			"address": forwarder.LocalAddr,
		}))
	}
	return hostPort{host: localHost, port: localPort}, nil
}

func appConnectTimeout(config connection.ConnectionConfig) time.Duration {
	seconds := config.Timeout
	if seconds <= 0 {
		seconds = 30
	}
	return time.Duration(seconds) * time.Second
}

func resolveProxyTarget(config connection.ConnectionConfig, normalizedType string) (hostPort, error) {
	defaultPort := defaultPortByType(normalizedType)
	host := strings.TrimSpace(config.Host)
	port := config.Port
	if host != "" && port <= 0 {
		if parsedHost, parsedPort, ok := parseAddressWithDefaultPort(host, defaultPort); ok {
			host, port = parsedHost, parsedPort
		}
	}
	if host == "" && len(config.Hosts) > 0 {
		if parsedHost, parsedPort, ok := parseAddressWithDefaultPort(config.Hosts[0], defaultPort); ok {
			host, port = parsedHost, parsedPort
		}
	}
	if host == "" && strings.TrimSpace(config.URI) != "" {
		if parsed, ok := parseProxyURIAddress(config.URI, defaultPort); ok {
			host, port = parsed.host, parsed.port
		}
	}
	if host == "" {
		return hostPort{}, fmt.Errorf("%s", defaultAppText("proxy.backend.error.remote_addr_invalid", map[string]any{"address": "(empty)"}))
	}
	if port <= 0 {
		port = defaultPort
	}
	if port <= 0 || port > 65535 {
		return hostPort{}, fmt.Errorf("%s", defaultAppText("db.backend.error.proxy_target_port_invalid", map[string]any{"port": port}))
	}
	return hostPort{host: host, port: port}, nil
}

func parseProxyURIAddress(raw string, defaultPort int) (hostPort, bool) {
	text := strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(text), "jdbc:") {
		text = strings.TrimSpace(text[len("jdbc:"):])
	}
	parsed, err := url.Parse(text)
	if err != nil || strings.TrimSpace(parsed.Host) == "" {
		return hostPort{}, false
	}
	hostText := parsed.Host
	if comma := strings.Index(hostText, ","); comma >= 0 {
		hostText = hostText[:comma]
	}
	host := parsed.Hostname()
	port := defaultPort
	if portText := parsed.Port(); portText != "" {
		parsedPort, err := strconv.Atoi(portText)
		if err != nil || parsedPort <= 0 || parsedPort > 65535 {
			return hostPort{}, false
		}
		port = parsedPort
	}
	if host == "" {
		host, _, err = net.SplitHostPort(hostText)
		if err != nil {
			return hostPort{}, false
		}
	}
	if host == "" {
		return hostPort{}, false
	}
	return hostPort{host: host, port: port}, true
}

func parseAddressWithDefaultPort(raw string, defaultPort int) (string, int, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", 0, false
	}

	if strings.HasPrefix(text, "[") {
		if host, portText, err := net.SplitHostPort(text); err == nil {
			if port, convErr := strconv.Atoi(portText); convErr == nil && port > 0 && port <= 65535 {
				return strings.TrimSpace(host), port, true
			}
			return "", 0, false
		}
		trimmed := strings.Trim(strings.TrimPrefix(text, "["), "]")
		if trimmed != "" && defaultPort > 0 {
			return trimmed, defaultPort, true
		}
		return "", 0, false
	}

	if strings.Count(text, ":") == 0 {
		if defaultPort <= 0 {
			return "", 0, false
		}
		return text, defaultPort, true
	}

	if strings.Count(text, ":") == 1 {
		host, portText, err := net.SplitHostPort(text)
		if err == nil {
			port, convErr := strconv.Atoi(portText)
			if convErr == nil && port > 0 && port <= 65535 {
				return strings.TrimSpace(host), port, true
			}
			return "", 0, false
		}
		if defaultPort > 0 {
			return strings.TrimSpace(text), defaultPort, true
		}
		return "", 0, false
	}

	// IPv6 地址未带端口，使用默认端口。
	if defaultPort > 0 {
		return text, defaultPort, true
	}
	return "", 0, false
}

func formatHostPort(host string, port int) string {
	h := strings.TrimSpace(host)
	if strings.Contains(h, ":") && !strings.HasPrefix(h, "[") {
		return fmt.Sprintf("[%s]:%d", h, port)
	}
	return fmt.Sprintf("%s:%d", h, port)
}

func defaultPortByType(driverType string) int {
	switch normalizeDriverType(driverType) {
	case "mysql", "mariadb":
		return 3306
	case "goldendb":
		return 1523
	case "oceanbase":
		return 2881
	case "diros":
		return 9030
	case "starrocks":
		return 9030
	case "sphinx":
		return 9306
	case "postgres", "vastbase", "opengauss", "gaussdb":
		return 5432
	case "redis":
		return 6379
	case "tdengine":
		return 6041
	case "iotdb":
		return 6667
	case "oracle":
		return 1521
	case "dameng":
		return 5236
	case "kingbase":
		return 54321
	case "sqlserver":
		return 1433
	case "mongodb":
		return 27017
	case "clickhouse":
		return 9000
	case "trino":
		return 8080
	case "highgo":
		return 5866
	case "iris", "cache":
		return 1972
	case "chroma":
		return 8000
	case "qdrant":
		return 6333
	case "milvus":
		return 19530
	case "kafka":
		return 9092
	case "nacos":
		return 8848
	default:
		port, _ := registryDefaultPort(driverType)
		return port
	}
}
