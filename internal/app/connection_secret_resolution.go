package app

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
)

func (a *App) resolveConnectionSecrets(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
	if config.HasResolvedSavedSnapshot() {
		return config, nil
	}
	if strings.TrimSpace(config.ID) == "" {
		return config, nil
	}

	repo := newSavedConnectionRepository(a.configDir, a.secretStore)
	view, bundle, err := repo.loadConnectionSnapshot(config.ID)
	if err != nil {
		if shouldFallbackToInlineConnectionSecrets(config, err) {
			base := config
			if strings.TrimSpace(view.ID) != "" && (a.headlessRuntime || connectionMetadataLooksEmpty(base)) {
				base = view.Config
			}
			resolved := mergeInlineConnectionSecrets(base, config)
			if a.headlessRuntime {
				resolved = resolved.WithResolvedSavedSnapshot()
			}
			return resolved, nil
		}
		return config, a.normalizeConnectionSecretResolutionError(config, err)
	}

	base := config
	if a.headlessRuntime {
		// Headless callers resolve a stable saved ID. Always pair the current
		// metadata with the secret bundle captured under the same lock instead
		// of trusting a view that may have been read before a concurrent save.
		base = view.Config
		if config.QueryTimeout > 0 {
			base.QueryTimeout = config.QueryTimeout
		}
	} else if connectionMetadataLooksEmpty(base) {
		base = view.Config
	}
	resolved := mergeConnectionSecretBundleIntoConfig(base, bundle)
	resolved.ID = view.ID
	if a.headlessRuntime {
		resolved = resolved.WithResolvedSavedSnapshot()
	}

	return resolved, nil
}

func shouldFallbackToInlineConnectionSecrets(config connection.ConnectionConfig, err error) bool {
	if err == nil || !connectionConfigCarriesInlineSecrets(config) || secretstore.IsUnavailable(err) {
		return false
	}
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	lower := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(lower, "saved connection not found:")
}

func connectionConfigCarriesInlineSecrets(config connection.ConnectionConfig) bool {
	return strings.TrimSpace(config.Password) != "" ||
		strings.TrimSpace(config.SSH.Password) != "" ||
		strings.TrimSpace(config.Proxy.Password) != "" ||
		strings.TrimSpace(config.HTTPTunnel.Password) != "" ||
		strings.TrimSpace(config.MySQLReplicaPassword) != "" ||
		strings.TrimSpace(config.MongoReplicaPassword) != "" ||
		strings.TrimSpace(config.RedisSentinelPassword) != "" ||
		strings.TrimSpace(config.URI) != "" ||
		strings.TrimSpace(config.DSN) != "" ||
		strings.TrimSpace(config.JVM.JMX.Password) != "" ||
		strings.TrimSpace(config.JVM.Endpoint.APIKey) != "" ||
		strings.TrimSpace(config.JVM.Agent.APIKey) != "" ||
		strings.TrimSpace(config.JVM.Diagnostic.APIKey) != "" ||
		func() bool {
			_, sensitive := partitionConnectionParams(config.ConnectionParams)
			return strings.TrimSpace(sensitive) != ""
		}()
}

func mergeInlineConnectionSecrets(base connection.ConnectionConfig, inline connection.ConnectionConfig) connection.ConnectionConfig {
	merged := base
	if strings.TrimSpace(inline.Password) != "" {
		merged.Password = inline.Password
	}
	if strings.TrimSpace(inline.SSH.Password) != "" {
		merged.SSH.Password = inline.SSH.Password
	}
	if strings.TrimSpace(inline.Proxy.Password) != "" {
		merged.Proxy.Password = inline.Proxy.Password
	}
	if strings.TrimSpace(inline.HTTPTunnel.Password) != "" {
		merged.HTTPTunnel.Password = inline.HTTPTunnel.Password
	}
	if strings.TrimSpace(inline.MySQLReplicaPassword) != "" {
		merged.MySQLReplicaPassword = inline.MySQLReplicaPassword
	}
	if strings.TrimSpace(inline.MongoReplicaPassword) != "" {
		merged.MongoReplicaPassword = inline.MongoReplicaPassword
	}
	if strings.TrimSpace(inline.RedisSentinelPassword) != "" {
		merged.RedisSentinelPassword = inline.RedisSentinelPassword
	}
	if strings.TrimSpace(inline.URI) != "" {
		merged.URI = inline.URI
	}
	if strings.TrimSpace(inline.DSN) != "" {
		merged.DSN = inline.DSN
	}
	if strings.TrimSpace(inline.JVM.JMX.Password) != "" {
		merged.JVM.JMX.Password = inline.JVM.JMX.Password
	}
	if strings.TrimSpace(inline.JVM.Endpoint.APIKey) != "" {
		merged.JVM.Endpoint.APIKey = inline.JVM.Endpoint.APIKey
	}
	if strings.TrimSpace(inline.JVM.Agent.APIKey) != "" {
		merged.JVM.Agent.APIKey = inline.JVM.Agent.APIKey
	}
	if strings.TrimSpace(inline.JVM.Diagnostic.APIKey) != "" {
		merged.JVM.Diagnostic.APIKey = inline.JVM.Diagnostic.APIKey
	}
	publicParams, sensitiveParams := partitionConnectionParams(inline.ConnectionParams)
	if strings.TrimSpace(sensitiveParams) != "" {
		merged.ConnectionParams = mergeConnectionParams(merged.ConnectionParams, sensitiveParams)
	} else if strings.TrimSpace(merged.ConnectionParams) == "" {
		merged.ConnectionParams = publicParams
	}
	return merged
}

func (a *App) normalizeConnectionSecretResolutionError(config connection.ConnectionConfig, err error) error {
	if err == nil {
		return nil
	}

	lower := strings.ToLower(strings.TrimSpace(err.Error()))
	switch {
	case strings.Contains(lower, "saved connection not found:"):
		if connectionMetadataLooksEmpty(config) {
			return fmt.Errorf("%s", a.appText("connection_modal.secret.error.saved_connection_deleted", nil))
		}
		return fmt.Errorf("%s", a.appText("connection_modal.secret.error.saved_connection_missing", nil))
	case errors.Is(err, os.ErrNotExist):
		return fmt.Errorf("%s", a.appText("connection_modal.secret.error.saved_connection_missing", nil))
	case strings.Contains(lower, "secret store unavailable"):
		return fmt.Errorf("%s", a.appText("connection_modal.secret.error.store_unavailable", nil))
	default:
		return err
	}
}

func connectionMetadataLooksEmpty(config connection.ConnectionConfig) bool {
	return strings.TrimSpace(config.Type) == "" &&
		strings.TrimSpace(config.Host) == "" &&
		config.Port == 0 &&
		strings.TrimSpace(config.User) == "" &&
		strings.TrimSpace(config.Database) == "" &&
		strings.TrimSpace(config.DSN) == "" &&
		strings.TrimSpace(config.URI) == "" &&
		len(config.Hosts) == 0
}

func mergeConnectionSecretBundleIntoConfig(config connection.ConnectionConfig, bundle connectionSecretBundle) connection.ConnectionConfig {
	merged := config
	if strings.TrimSpace(merged.Password) == "" {
		merged.Password = bundle.Password
	}
	if strings.TrimSpace(merged.SSH.Password) == "" {
		merged.SSH.Password = bundle.SSHPassword
	}
	if strings.TrimSpace(merged.Proxy.Password) == "" {
		merged.Proxy.Password = bundle.ProxyPassword
	}
	if strings.TrimSpace(merged.HTTPTunnel.Password) == "" {
		merged.HTTPTunnel.Password = bundle.HTTPTunnelPassword
	}
	if strings.TrimSpace(merged.MySQLReplicaPassword) == "" {
		merged.MySQLReplicaPassword = bundle.MySQLReplicaPassword
	}
	if strings.TrimSpace(merged.MongoReplicaPassword) == "" {
		merged.MongoReplicaPassword = bundle.MongoReplicaPassword
	}
	if strings.TrimSpace(merged.RedisSentinelPassword) == "" {
		merged.RedisSentinelPassword = bundle.RedisSentinelPassword
	}
	if strings.TrimSpace(merged.URI) == "" {
		merged.URI = bundle.OpaqueURI
	}
	if strings.TrimSpace(merged.DSN) == "" {
		merged.DSN = bundle.OpaqueDSN
	}
	if strings.TrimSpace(merged.JVM.JMX.Password) == "" {
		merged.JVM.JMX.Password = bundle.JVMJMXPassword
	}
	if strings.TrimSpace(merged.JVM.Endpoint.APIKey) == "" {
		merged.JVM.Endpoint.APIKey = bundle.JVMEndpointAPIKey
	}
	if strings.TrimSpace(merged.JVM.Agent.APIKey) == "" {
		merged.JVM.Agent.APIKey = bundle.JVMAgentAPIKey
	}
	if strings.TrimSpace(merged.JVM.Diagnostic.APIKey) == "" {
		merged.JVM.Diagnostic.APIKey = bundle.JVMDiagnosticAPIKey
	}
	merged.ConnectionParams = mergeConnectionParams(merged.ConnectionParams, bundle.SensitiveParams)
	return merged
}
