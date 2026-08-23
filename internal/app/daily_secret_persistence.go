package app

import (
	stdRuntime "runtime"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dailysecret"
)

var runtimeGOOS = func() string {
	return stdRuntime.GOOS
}

func extractConnectionSecretBundle(config connection.ConnectionConfig) connectionSecretBundle {
	_, sensitiveParams := partitionConnectionParams(config.ConnectionParams)
	return connectionSecretBundle{
		Password:              config.Password,
		SSHPassword:           config.SSH.Password,
		ProxyPassword:         config.Proxy.Password,
		HTTPTunnelPassword:    config.HTTPTunnel.Password,
		MySQLReplicaPassword:  config.MySQLReplicaPassword,
		MongoReplicaPassword:  config.MongoReplicaPassword,
		RedisSentinelPassword: config.RedisSentinelPassword,
		OpaqueURI:             config.URI,
		OpaqueDSN:             config.DSN,
		JVMJMXPassword:        config.JVM.JMX.Password,
		JVMEndpointAPIKey:     config.JVM.Endpoint.APIKey,
		JVMAgentAPIKey:        config.JVM.Agent.APIKey,
		JVMDiagnosticAPIKey:   config.JVM.Diagnostic.APIKey,
		SensitiveParams:       sensitiveParams,
	}
}

func toDailyConnectionBundle(bundle connectionSecretBundle) dailysecret.ConnectionBundle {
	return dailysecret.ConnectionBundle{
		Password:              bundle.Password,
		SSHPassword:           bundle.SSHPassword,
		ProxyPassword:         bundle.ProxyPassword,
		HTTPTunnelPassword:    bundle.HTTPTunnelPassword,
		MySQLReplicaPassword:  bundle.MySQLReplicaPassword,
		MongoReplicaPassword:  bundle.MongoReplicaPassword,
		RedisSentinelPassword: bundle.RedisSentinelPassword,
		OpaqueURI:             bundle.OpaqueURI,
		OpaqueDSN:             bundle.OpaqueDSN,
		JVMJMXPassword:        bundle.JVMJMXPassword,
		JVMEndpointAPIKey:     bundle.JVMEndpointAPIKey,
		JVMAgentAPIKey:        bundle.JVMAgentAPIKey,
		JVMDiagnosticAPIKey:   bundle.JVMDiagnosticAPIKey,
		SensitiveParams:       bundle.SensitiveParams,
	}
}

func fromDailyConnectionBundle(bundle dailysecret.ConnectionBundle) connectionSecretBundle {
	return connectionSecretBundle{
		Password:              bundle.Password,
		SSHPassword:           bundle.SSHPassword,
		ProxyPassword:         bundle.ProxyPassword,
		HTTPTunnelPassword:    bundle.HTTPTunnelPassword,
		MySQLReplicaPassword:  bundle.MySQLReplicaPassword,
		MongoReplicaPassword:  bundle.MongoReplicaPassword,
		RedisSentinelPassword: bundle.RedisSentinelPassword,
		OpaqueURI:             bundle.OpaqueURI,
		OpaqueDSN:             bundle.OpaqueDSN,
		JVMJMXPassword:        bundle.JVMJMXPassword,
		JVMEndpointAPIKey:     bundle.JVMEndpointAPIKey,
		JVMAgentAPIKey:        bundle.JVMAgentAPIKey,
		JVMDiagnosticAPIKey:   bundle.JVMDiagnosticAPIKey,
		SensitiveParams:       bundle.SensitiveParams,
	}
}

func stripConnectionSecretFields(config connection.ConnectionConfig) connection.ConnectionConfig {
	stripped := config
	stripped.Password = ""
	stripped.SSH.Password = ""
	stripped.Proxy.Password = ""
	stripped.HTTPTunnel.Password = ""
	stripped.MySQLReplicaPassword = ""
	stripped.MongoReplicaPassword = ""
	stripped.RedisSentinelPassword = ""
	stripped.URI = ""
	stripped.DSN = ""
	stripped.JVM.JMX.Password = ""
	stripped.JVM.Endpoint.APIKey = ""
	stripped.JVM.Agent.APIKey = ""
	stripped.JVM.Diagnostic.APIKey = ""
	stripped.ConnectionParams, _ = partitionConnectionParams(stripped.ConnectionParams)
	return stripped
}

func sanitizeSavedConnectionView(view connection.SavedConnectionView) connection.SavedConnectionView {
	view.EnvironmentType = normalizeConnectionEnvironmentType(view.EnvironmentType)
	view.Config = stripConnectionSecretFields(view.Config)
	return view
}

func sanitizeSavedConnectionViews(items []connection.SavedConnectionView) []connection.SavedConnectionView {
	if len(items) == 0 {
		return items
	}
	result := make([]connection.SavedConnectionView, 0, len(items))
	for _, item := range items {
		result = append(result, sanitizeSavedConnectionView(item))
	}
	return result
}

func extractGlobalProxySecretBundle(view connection.GlobalProxyView) globalProxySecretBundle {
	return globalProxySecretBundle{
		Password: view.Password,
	}
}

func toDailyGlobalProxyBundle(bundle globalProxySecretBundle) dailysecret.GlobalProxyBundle {
	return dailysecret.GlobalProxyBundle{Password: bundle.Password}
}

func fromDailyGlobalProxyBundle(bundle dailysecret.GlobalProxyBundle) globalProxySecretBundle {
	return globalProxySecretBundle{Password: bundle.Password}
}

func sanitizeGlobalProxyView(view connection.GlobalProxyView) connection.GlobalProxyView {
	view.Password = ""
	return view
}

func shouldReadLegacySecretStoreForDailySecrets() bool {
	return runtimeGOOS() != "darwin"
}

func (a *App) dailySecretStore() *dailysecret.Store {
	return dailysecret.NewStore(a.configDir)
}
