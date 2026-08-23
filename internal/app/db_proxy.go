package app

import (
	"fmt"
	"net"
	"strconv"
	"strings"

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
		forwardedSSH, err := buildProxyForwardAddress(normalizedProxy, sshHost, sshPort)
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

	normalizedType := strings.ToLower(strings.TrimSpace(config.Type))
	if normalizedType == "nacos" {
		// Nacos is HTTP-based and must keep its remote authority for the Host
		// header and TLS SNI/certificate verification. Its transport dials the
		// normalized proxy directly instead of using a local TCP forwarder.
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
	if normalizedType == "mongodb" {
		// MongoDB 统一由驱动侧 Dialer 处理代理，保留原始目标地址，避免将连接目标改写为本地转发地址。
		return config, nil
	}

	targetPort := config.Port
	if targetPort <= 0 {
		targetPort = defaultPortByType(normalizedType)
	}
	forwardedPrimary, err := buildProxyForwardAddress(normalizedProxy, strings.TrimSpace(config.Host), targetPort)
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
			forwarded, forwardErr := buildProxyForwardAddress(normalizedProxy, targetHost, targetPort)
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

type hostPort struct {
	host string
	port int
}

func buildProxyForwardAddress(proxyConfig connection.ProxyConfig, targetHost string, targetPort int) (hostPort, error) {
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

	forwarder, err := proxytunnel.GetOrCreateLocalForwarder(proxyConfig, host, port)
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
	switch strings.ToLower(strings.TrimSpace(driverType)) {
	case "mysql", "mariadb":
		return 3306
	case "goldendb", "greatdb", "gdb":
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
	case "iris":
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
		return 0
	}
}
