package app

import (
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"
	sshbridge "GoNavi-Wails/internal/ssh"
)

const managedSSHHostKeyTrustStoreFileName = "host_keys.json"

// managedSSHHostKeyTrustStorePath is intentionally separate from the user's
// OpenSSH ~/.ssh/known_hosts. GoNavi may read the system file, but only writes
// a key after an explicit confirmation into its own application data.
func (a *App) managedSSHHostKeyTrustStorePath() string {
	root := ""
	if a != nil {
		root = strings.TrimSpace(a.configDir)
	}
	if root == "" {
		root = resolveAppConfigDir()
	}
	return filepath.Join(root, "ssh", managedSSHHostKeyTrustStoreFileName)
}

func (a *App) withManagedSSHHostKeyTrustStore(config connection.ConnectionConfig) connection.ConnectionConfig {
	if !config.UseSSH {
		return config
	}
	config.SSH = config.SSH.WithManagedHostKeyTrustStore(a.managedSSHHostKeyTrustStorePath())
	return config
}

func (a *App) sshHostKeyTrustRequiredResult(err error) (connection.QueryResult, bool) {
	trustStatus, ok := sshbridge.HostKeyTrustStatusFromError(err)
	if !ok {
		return connection.QueryResult{}, false
	}
	return connection.QueryResult{
		Success: false,
		Message: a.appText("connection.modal.network.ssh.hostKeyConfirmationRequired", nil),
		Data:    map[string]any{"sshHostKeyTrust": trustStatus},
	}, true
}

func (a *App) trustSSHHostKey(config connection.SSHConfig, fingerprint string) connection.QueryResult {
	status, err := sshbridge.TrustSSHHostKey(
		config,
		a.managedSSHHostKeyTrustStorePath(),
		fingerprint,
	)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("connection.modal.network.ssh.hostKeyTrustSaved", nil),
		Data: map[string]any{
			"sshHostKeyTrust": status,
		},
	}
}

// TrustSSHHostKeyForConnection reuses the full connection route while probing
// and saving an explicitly approved host key. This is important for an SSH
// bastion reached through a SOCKS/HTTP proxy: the probe dials the local proxy
// forwarder, while the trust record remains keyed by the original bastion.
// It never writes the user's ~/.ssh/known_hosts file.
func (a *App) TrustSSHHostKeyForConnection(config connection.ConnectionConfig, fingerprint string) connection.QueryResult {
	if !config.UseSSH {
		return connection.QueryResult{Success: false, Message: "SSH tunnel is not enabled"}
	}
	effectiveConfig, err := a.resolveEffectiveConnectionConfig(config)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	dialConfig, err := resolveDialConfigWithProxyFunc(effectiveConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return a.trustSSHHostKey(dialConfig.SSH, fingerprint)
}

// TrustSSHHostKey is retained for compatibility with older desktop clients.
// New clients use TrustSSHHostKeyForConnection so proxy routing is preserved.
func (a *App) TrustSSHHostKey(host string, port int, fingerprint string) connection.QueryResult {
	return a.trustSSHHostKey(connection.SSHConfig{Host: host, Port: port}, fingerprint)
}
