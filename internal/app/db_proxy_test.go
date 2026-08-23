package app

import (
	"reflect"
	"testing"

	"GoNavi-Wails/internal/connection"
	proxytunnel "GoNavi-Wails/internal/proxy"
)

func TestResolveDialConfigWithProxy_MongoKeepsTargetAddress(t *testing.T) {
	hosts := []string{"10.20.30.40:27017", "10.20.30.41:27017"}
	raw := connection.ConnectionConfig{
		Type:     "mongodb",
		Host:     "10.20.30.40",
		Port:     27017,
		UseProxy: true,
		Proxy: connection.ProxyConfig{
			Type: "socks5",
			Host: "127.0.0.1",
			Port: 1080,
		},
		Hosts: hosts,
	}

	got, err := resolveDialConfigWithProxy(raw)
	if err != nil {
		t.Fatalf("resolveDialConfigWithProxy returned error: %v", err)
	}
	if got.Host != raw.Host || got.Port != raw.Port {
		t.Fatalf("mongo target address should be kept, got=%s:%d want=%s:%d", got.Host, got.Port, raw.Host, raw.Port)
	}
	if !got.UseProxy {
		t.Fatalf("mongo should keep UseProxy=true for driver-level dialer")
	}
	if !reflect.DeepEqual(got.Hosts, hosts) {
		t.Fatalf("mongo hosts should be kept, got=%v want=%v", got.Hosts, hosts)
	}
}

func TestResolveDialConfigWithProxy_MongoSRVKeepsTargetAddress(t *testing.T) {
	raw := connection.ConnectionConfig{
		Type:     "mongodb",
		Host:     "cluster0.example.com",
		Port:     27017,
		MongoSRV: true,
		UseProxy: true,
		Proxy: connection.ProxyConfig{
			Type: "http",
			Host: "127.0.0.1",
			Port: 7890,
		},
	}

	got, err := resolveDialConfigWithProxy(raw)
	if err != nil {
		t.Fatalf("resolveDialConfigWithProxy returned error: %v", err)
	}
	if got.Host != raw.Host || got.Port != raw.Port {
		t.Fatalf("mongo SRV target address should be kept, got=%s:%d want=%s:%d", got.Host, got.Port, raw.Host, raw.Port)
	}
	if !got.UseProxy {
		t.Fatalf("mongo SRV should keep UseProxy=true for driver-level dialer")
	}
}

func TestDefaultPortByType_NacosProxyTargetUsesDefaultPort(t *testing.T) {
	if got := defaultPortByType("nacos"); got != 8848 {
		t.Fatalf("defaultPortByType(nacos) = %d, want 8848", got)
	}
}

func TestResolveDialConfigWithProxy_NacosKeepsRemoteAuthority(t *testing.T) {
	proxytunnel.CloseAllForwarders()
	t.Cleanup(proxytunnel.CloseAllForwarders)

	tests := []struct {
		name string
		raw  connection.ConnectionConfig
		want connection.ProxyConfig
	}{
		{
			name: "explicit socks5 proxy",
			raw: connection.ConnectionConfig{
				Type:     "nacos",
				Host:     "secure-nacos.internal.test",
				Port:     8848,
				UseProxy: true,
				Proxy: connection.ProxyConfig{
					Type: "socks5h",
					Host: "127.0.0.1",
					Port: 1080,
				},
			},
			want: connection.ProxyConfig{
				Type: "socks5",
				Host: "127.0.0.1",
				Port: 1080,
			},
		},
		{
			name: "HTTP tunnel",
			raw: connection.ConnectionConfig{
				Type:          "nacos",
				Host:          "secure-nacos.internal.test",
				Port:          8848,
				UseHTTPTunnel: true,
				HTTPTunnel: connection.HTTPTunnelConfig{
					Host:     "tunnel.internal.test",
					Port:     8080,
					User:     "tunnel-user",
					Password: "tunnel-password",
				},
			},
			want: connection.ProxyConfig{
				Type:     "http",
				Host:     "tunnel.internal.test",
				Port:     8080,
				User:     "tunnel-user",
				Password: "tunnel-password",
			},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := resolveDialConfigWithProxy(testCase.raw)
			if err != nil {
				t.Fatalf("resolveDialConfigWithProxy: %v", err)
			}
			if got.Host != testCase.raw.Host || got.Port != testCase.raw.Port {
				t.Fatalf(
					"Nacos target authority = %s:%d, want %s:%d",
					got.Host,
					got.Port,
					testCase.raw.Host,
					testCase.raw.Port,
				)
			}
			if !got.UseProxy || got.Proxy != testCase.want {
				t.Fatalf("Nacos proxy = %#v (enabled=%v), want %#v", got.Proxy, got.UseProxy, testCase.want)
			}
			if got.UseHTTPTunnel || got.HTTPTunnel != (connection.HTTPTunnelConfig{}) {
				t.Fatalf("HTTP tunnel was not normalized into proxy config: %#v", got.HTTPTunnel)
			}
		})
	}
}

func TestResolveDialConfigWithProxy_NacosProxyWithSSHForwardsGatewayOnly(t *testing.T) {
	proxytunnel.CloseAllForwarders()
	t.Cleanup(proxytunnel.CloseAllForwarders)

	raw := connection.ConnectionConfig{
		Type:     "nacos",
		Host:     "secure-nacos.internal.test",
		Port:     8848,
		UseProxy: true,
		Proxy: connection.ProxyConfig{
			Type: "socks5",
			Host: "127.0.0.1",
			Port: 1080,
		},
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "ssh-gateway.internal.test",
			Port: 22,
			User: "ssh-user",
		},
	}

	got, err := resolveDialConfigWithProxy(raw)
	if err != nil {
		t.Fatalf("resolveDialConfigWithProxy: %v", err)
	}
	if got.Host != raw.Host || got.Port != raw.Port {
		t.Fatalf("Nacos SSH target = %s:%d, want %s:%d", got.Host, got.Port, raw.Host, raw.Port)
	}
	if !got.UseSSH {
		t.Fatal("Nacos SSH tunnel was disabled")
	}
	if got.SSH.Host == raw.SSH.Host || got.SSH.Port == raw.SSH.Port {
		t.Fatalf("SSH gateway was not replaced by its proxy forwarder: %#v", got.SSH)
	}
	if got.UseProxy || got.Proxy != (connection.ProxyConfig{}) {
		t.Fatalf("proxy should only wrap the SSH gateway, got enabled=%v config=%#v", got.UseProxy, got.Proxy)
	}
}

func TestResolveDialConfigWithProxyRejectsEmptySSHGatewayBeforeForwarding(t *testing.T) {
	_, err := resolveDialConfigWithProxy(connection.ConnectionConfig{
		Type:     "mysql",
		UseProxy: true,
		Proxy: connection.ProxyConfig{
			Type: "socks5",
			Host: "127.0.0.1",
			Port: 1080,
		},
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "   ",
			Port: 22,
		},
	})
	if err == nil {
		t.Fatal("expected empty SSH gateway to be rejected before a proxy forwarder is created")
	}
}

func TestResolveDialConfigWithProxy_RocketMQKeepsDynamicTargets(t *testing.T) {
	tests := []struct {
		name string
		raw  connection.ConnectionConfig
		want connection.ProxyConfig
	}{
		{
			name: "explicit socks5 proxy",
			raw: connection.ConnectionConfig{
				Type:     "rocketmq",
				Host:     "nameserver.internal.test",
				Port:     9876,
				Hosts:    []string{"nameserver-backup.internal.test:9876"},
				UseProxy: true,
				Proxy: connection.ProxyConfig{
					Type: "socks5h",
					Host: "127.0.0.1",
					Port: 1080,
				},
			},
			want: connection.ProxyConfig{
				Type: "socks5",
				Host: "127.0.0.1",
				Port: 1080,
			},
		},
		{
			name: "HTTP tunnel",
			raw: connection.ConnectionConfig{
				Type:          "rocketmq",
				Host:          "nameserver.internal.test",
				Port:          9876,
				UseHTTPTunnel: true,
				HTTPTunnel: connection.HTTPTunnelConfig{
					Host:     "tunnel.internal.test",
					Port:     8080,
					User:     "tunnel-user",
					Password: "tunnel-password",
				},
			},
			want: connection.ProxyConfig{
				Type:     "http",
				Host:     "tunnel.internal.test",
				Port:     8080,
				User:     "tunnel-user",
				Password: "tunnel-password",
			},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := resolveDialConfigWithProxy(testCase.raw)
			if err != nil {
				t.Fatalf("resolveDialConfigWithProxy: %v", err)
			}
			if got.Host != testCase.raw.Host || got.Port != testCase.raw.Port || !reflect.DeepEqual(got.Hosts, testCase.raw.Hosts) {
				t.Fatalf("RocketMQ targets = %s:%d %v, want %s:%d %v", got.Host, got.Port, got.Hosts, testCase.raw.Host, testCase.raw.Port, testCase.raw.Hosts)
			}
			if !got.UseProxy || got.Proxy != testCase.want {
				t.Fatalf("RocketMQ proxy = %#v (enabled=%v), want %#v", got.Proxy, got.UseProxy, testCase.want)
			}
			if got.UseHTTPTunnel || got.HTTPTunnel != (connection.HTTPTunnelConfig{}) {
				t.Fatalf("HTTP tunnel was not normalized into proxy config: %#v", got.HTTPTunnel)
			}
		})
	}
}
