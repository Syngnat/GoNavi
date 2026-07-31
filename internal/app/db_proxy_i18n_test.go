package app

import (
	"strings"
	"testing"
	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
	"GoNavi-Wails/shared/i18n"
)

func TestDBProxyResolveDialConfigWithProxyUsesCurrentLanguageForHTTPTunnelValidationErrors(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	cases := []struct {
		name   string
		config connection.ConnectionConfig
		want   string
		avoid  string
	}{
		{
			name: "http tunnel conflicts with proxy",
			config: connection.ConnectionConfig{
				UseHTTPTunnel: true,
				UseProxy:      true,
				HTTPTunnel: connection.HTTPTunnelConfig{
					Host: "tunnel.local",
					Port: 8080,
				},
				Proxy: connection.ProxyConfig{
					Type: "http",
					Host: "proxy.local",
					Port: 7890,
				},
			},
			want:  "HTTP Tunnel cannot be enabled together with a regular proxy",
			avoid: "HTTP 隧道与普通代理不能同时启用",
		},
		{
			name: "http tunnel host required",
			config: connection.ConnectionConfig{
				UseHTTPTunnel: true,
				HTTPTunnel: connection.HTTPTunnelConfig{
					Host: "   ",
				},
			},
			want:  "HTTP Tunnel host is required",
			avoid: "HTTP 隧道主机不能为空",
		},
		{
			name: "http tunnel port invalid",
			config: connection.ConnectionConfig{
				UseHTTPTunnel: true,
				HTTPTunnel: connection.HTTPTunnelConfig{
					Host: "tunnel.local",
					Port: 70000,
				},
			},
			want:  "HTTP Tunnel port is invalid: 70000",
			avoid: "HTTP 隧道端口无效：70000",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := resolveDialConfigWithProxy(tc.config)
			if err == nil {
				t.Fatal("expected HTTP Tunnel validation error")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected English HTTP Tunnel validation message %q, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), tc.avoid) {
				t.Fatalf("expected no Chinese HTTP Tunnel validation message in en-US mode, got %q", err.Error())
			}
		})
	}
}

func TestDBProxyHTTPTunnelValidationCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.http_tunnel_proxy_conflict",
		"db.backend.error.http_tunnel_host_required",
		"db.backend.error.http_tunnel_port_invalid",
		"db.backend.error.proxy_ssh_gateway_connect_failed",
		"db.backend.error.proxy_target_port_invalid",
		"db.backend.error.proxy_local_forward_addr_parse_failed",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing DB proxy HTTP Tunnel key %q", language, key)
			}
		}
	}
}


func TestDBProxyBuildProxyForwardAddressUsesCurrentLanguageForTargetPortValidationError(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		app.SetLanguage(string(i18n.LanguageZhCN))
	})

	_, err := buildProxyForwardAddress(connection.ProxyConfig{
		Type: "http",
		Host: "proxy.local",
		Port: 7890,
	}, "db.internal", 0)
	if err == nil {
		t.Fatal("expected target port validation error")
	}

	const want = "Target port is invalid: 0"
	if err.Error() != want {
		t.Fatalf("expected English target-port validation message %q, got %q", want, err.Error())
	}
	if strings.Contains(err.Error(), "目标端口无效") {
		t.Fatalf("expected no Chinese target-port validation message in en-US mode, got %q", err.Error())
	}
}

func TestDBProxyResolveDialConfigWithProxyUsesCurrentLanguageForSSHGatewayWrapperError(t *testing.T) {
	app := NewApp()
	app.SetLanguage(string(i18n.LanguageEnUS))
	t.Cleanup(func() {
		proxytunnel.CloseAllForwarders()
		app.SetLanguage(string(i18n.LanguageZhCN))
	})
	proxytunnel.CloseAllForwarders()

	proxyConfig := connection.ProxyConfig{
		Type: "http",
		Host: "proxy.local",
		Port: 7890,
	}
	forwarder, err := proxytunnel.GetOrCreateLocalForwarder(proxyConfig, "ssh.gateway.local", 22)
	if err != nil {
		t.Fatalf("GetOrCreateLocalForwarder() error = %v", err)
	}
	forwarder.LocalAddr = "broken-local-forward"

	_, err = resolveDialConfigWithProxy(connection.ConnectionConfig{
		Type:     "mysql",
		UseProxy: true,
		Proxy:    proxyConfig,
		UseSSH:   true,
		SSH: connection.SSHConfig{
			Host: "ssh.gateway.local",
			Port: 22,
		},
	})
	if err == nil {
		t.Fatal("expected SSH gateway wrapper error")
	}

	const want = "Failed to connect to the SSH gateway through the proxy: Failed to parse the local proxy forward address: broken-local-forward"
	if err.Error() != want {
		t.Fatalf("expected localized SSH gateway wrapper error %q, got %q", want, err.Error())
	}
	if strings.Contains(err.Error(), "代理连接 SSH 网关失败") || strings.Contains(err.Error(), "解析代理本地转发地址失败") {
		t.Fatalf("expected no Chinese SSH proxy wrapper message in en-US mode, got %q", err.Error())
	}
}
