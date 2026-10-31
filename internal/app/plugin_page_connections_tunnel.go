package app

import (
	"fmt"
	"net"
	"strconv"
	"sync"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/ssh"
)

// Plugin pages and windows run out of process and can only dial a direct TCP
// endpoint, so transports the host owns (today: SSH) are converted into an
// equivalent local endpoint before the config leaves the host. The plugin never
// receives SSH credentials and does not need an SSH client.
type pluginTunnelLease struct {
	key       string
	forwarder *ssh.LocalForwarder
}

var (
	pluginTunnelMu     sync.Mutex
	pluginTunnelLeases = map[string]pluginTunnelLease{}
)

// pluginConnectionConfigForPlugin returns the config a plugin may dial.
func (a *App) pluginConnectionConfigForPlugin(config connection.ConnectionConfig) (connection.ConnectionConfig, string) {
	if !config.UseSSH {
		return config, ""
	}
	forwarder, err := acquirePluginTunnel(config)
	if err != nil {
		// Never log the SSH secret material: the connection name is enough to act on.
		logger.Errorf("插件复用 SSH 隧道失败：%s：%v", config.ID, err)
		return connection.ConnectionConfig{}, "tunnel_unavailable"
	}
	rewritten, err := rewritePluginTunnelConfig(config, forwarder.LocalAddr)
	if err != nil {
		logger.Errorf("插件 SSH 隧道地址无效：%s：%v", config.ID, err)
		return connection.ConnectionConfig{}, "tunnel_unavailable"
	}
	return rewritten, ""
}

// rewritePluginTunnelConfig swaps the remote endpoint for the local forward and
// drops every transport field the plugin cannot honour.
func rewritePluginTunnelConfig(config connection.ConnectionConfig, localAddr string) (connection.ConnectionConfig, error) {
	host, portText, err := net.SplitHostPort(localAddr)
	if err != nil {
		return connection.ConnectionConfig{}, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 {
		return connection.ConnectionConfig{}, fmt.Errorf("invalid local forward port %q", portText)
	}
	rewritten := config
	rewritten.Host = host
	rewritten.Port = port
	rewritten.UseSSH = false
	rewritten.SSH = connection.SSHConfig{}
	return rewritten, nil
}

// acquirePluginTunnel keeps one forwarder lease per saved connection. Leases are
// refcounted by internal/ssh, so reusing the endpoint for later sessions costs
// nothing while the SSH session stays warm.
func acquirePluginTunnel(config connection.ConnectionConfig) (*ssh.LocalForwarder, error) {
	key := fmt.Sprintf("%s:%d|%s|%s:%d", config.SSH.Host, config.SSH.Port, config.SSH.User, config.Host, config.Port)
	pluginTunnelMu.Lock()
	if lease, ok := pluginTunnelLeases[config.ID]; ok && lease.key == key && !lease.forwarder.IsClosed() {
		pluginTunnelMu.Unlock()
		return lease.forwarder, nil
	}
	pluginTunnelMu.Unlock()

	forwarder, err := ssh.AcquireLocalForwarder(config.SSH, config.Host, config.Port)
	if err != nil {
		return nil, err
	}

	pluginTunnelMu.Lock()
	previous, had := pluginTunnelLeases[config.ID]
	pluginTunnelLeases[config.ID] = pluginTunnelLease{key: key, forwarder: forwarder}
	pluginTunnelMu.Unlock()
	if had {
		_ = previous.forwarder.Release()
	}
	return forwarder, nil
}

// releasePluginTunnels drops every lease; call it when the app shuts down so the
// SSH sessions do not outlive the process.
func releasePluginTunnels() {
	pluginTunnelMu.Lock()
	leases := pluginTunnelLeases
	pluginTunnelLeases = map[string]pluginTunnelLease{}
	pluginTunnelMu.Unlock()
	for _, lease := range leases {
		_ = lease.forwarder.Release()
	}
}
