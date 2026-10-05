package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (b connectionSecretBundle) hasAny() bool {
	return strings.TrimSpace(b.Password) != "" ||
		strings.TrimSpace(b.SSHPassword) != "" ||
		strings.TrimSpace(b.ProxyPassword) != "" ||
		strings.TrimSpace(b.HTTPTunnelPassword) != "" ||
		strings.TrimSpace(b.MySQLReplicaPassword) != "" ||
		strings.TrimSpace(b.MongoReplicaPassword) != "" ||
		strings.TrimSpace(b.RedisSentinelPassword) != "" ||
		strings.TrimSpace(b.OpaqueURI) != "" ||
		strings.TrimSpace(b.OpaqueDSN) != "" ||
		strings.TrimSpace(b.JVMJMXPassword) != "" ||
		strings.TrimSpace(b.JVMEndpointAPIKey) != "" ||
		strings.TrimSpace(b.JVMAgentAPIKey) != "" ||
		strings.TrimSpace(b.JVMDiagnosticAPIKey) != "" ||
		strings.TrimSpace(b.SensitiveParams) != ""
}

func mergeConnectionSecretBundles(base, overlay connectionSecretBundle) connectionSecretBundle {
	merged := base
	if strings.TrimSpace(overlay.Password) != "" {
		merged.Password = overlay.Password
	}
	if strings.TrimSpace(overlay.SSHPassword) != "" {
		merged.SSHPassword = overlay.SSHPassword
	}
	if strings.TrimSpace(overlay.ProxyPassword) != "" {
		merged.ProxyPassword = overlay.ProxyPassword
	}
	if strings.TrimSpace(overlay.HTTPTunnelPassword) != "" {
		merged.HTTPTunnelPassword = overlay.HTTPTunnelPassword
	}
	if strings.TrimSpace(overlay.MySQLReplicaPassword) != "" {
		merged.MySQLReplicaPassword = overlay.MySQLReplicaPassword
	}
	if strings.TrimSpace(overlay.MongoReplicaPassword) != "" {
		merged.MongoReplicaPassword = overlay.MongoReplicaPassword
	}
	if strings.TrimSpace(overlay.RedisSentinelPassword) != "" {
		merged.RedisSentinelPassword = overlay.RedisSentinelPassword
	}
	if strings.TrimSpace(overlay.OpaqueURI) != "" {
		merged.OpaqueURI = overlay.OpaqueURI
	}
	if strings.TrimSpace(overlay.OpaqueDSN) != "" {
		merged.OpaqueDSN = overlay.OpaqueDSN
	}
	if strings.TrimSpace(overlay.JVMJMXPassword) != "" {
		merged.JVMJMXPassword = overlay.JVMJMXPassword
	}
	if strings.TrimSpace(overlay.JVMEndpointAPIKey) != "" {
		merged.JVMEndpointAPIKey = overlay.JVMEndpointAPIKey
	}
	if strings.TrimSpace(overlay.JVMAgentAPIKey) != "" {
		merged.JVMAgentAPIKey = overlay.JVMAgentAPIKey
	}
	if strings.TrimSpace(overlay.JVMDiagnosticAPIKey) != "" {
		merged.JVMDiagnosticAPIKey = overlay.JVMDiagnosticAPIKey
	}
	if strings.TrimSpace(overlay.SensitiveParams) != "" {
		merged.SensitiveParams = overlay.SensitiveParams
	}
	return merged
}

func applyConnectionSecretClears(bundle connectionSecretBundle, input connection.SavedConnectionInput) connectionSecretBundle {
	cleared := bundle
	if input.ClearPrimaryPassword {
		cleared.Password = ""
	}
	if input.ClearSSHPassword {
		cleared.SSHPassword = ""
	}
	if input.ClearProxyPassword {
		cleared.ProxyPassword = ""
	}
	if input.ClearHTTPTunnelPassword {
		cleared.HTTPTunnelPassword = ""
	}
	if input.ClearMySQLReplicaPassword {
		cleared.MySQLReplicaPassword = ""
	}
	if input.ClearMongoReplicaPassword {
		cleared.MongoReplicaPassword = ""
	}
	if input.ClearRedisSentinelPassword {
		cleared.RedisSentinelPassword = ""
	}
	if input.ClearOpaqueURI {
		cleared.OpaqueURI = ""
	}
	if input.ClearOpaqueDSN {
		cleared.OpaqueDSN = ""
	}
	if input.ClearJVMJMXPassword {
		cleared.JVMJMXPassword = ""
	}
	if input.ClearJVMEndpointAPIKey {
		cleared.JVMEndpointAPIKey = ""
	}
	if input.ClearJVMAgentAPIKey {
		cleared.JVMAgentAPIKey = ""
	}
	if input.ClearJVMDiagnosticAPIKey {
		cleared.JVMDiagnosticAPIKey = ""
	}
	if input.ClearSensitiveParams {
		cleared.SensitiveParams = ""
	}
	return cleared
}

func splitConnectionSecrets(input connection.SavedConnectionInput) (connection.SavedConnectionView, connectionSecretBundle) {
	id := strings.TrimSpace(input.ID)
	if id == "" {
		id = strings.TrimSpace(input.Config.ID)
	}

	meta := input.Config
	meta.ID = id
	meta.SavePassword = false

	bundle := extractConnectionSecretBundle(meta)
	meta = stripConnectionSecretFields(meta)

	view := connection.SavedConnectionView{
		ID:                      id,
		Name:                    strings.TrimSpace(input.Name),
		CreatedAt:               input.CreatedAt,
		EnvironmentType:         normalizeConnectionEnvironmentType(input.EnvironmentType),
		Config:                  meta,
		IncludeDatabases:        cloneStringSlice(input.IncludeDatabases),
		IncludeDatabasePatterns: sanitizeDatabasePatterns(input.IncludeDatabasePatterns),
		ExcludeDatabasePatterns: sanitizeDatabasePatterns(input.ExcludeDatabasePatterns),
		IncludeRedisDatabases:   cloneIntSlice(input.IncludeRedisDatabases),
		SchemaVisibilityByDatabase: sanitizeSchemaVisibilityByDatabase(
			input.SchemaVisibilityByDatabase,
			schemaVisibilityIdentifiersCaseSensitive(input.Config),
		),
		IconType:                 strings.TrimSpace(input.IconType),
		IconColor:                strings.TrimSpace(input.IconColor),
		HasPrimaryPassword:       strings.TrimSpace(bundle.Password) != "",
		HasSSHPassword:           strings.TrimSpace(bundle.SSHPassword) != "",
		HasProxyPassword:         strings.TrimSpace(bundle.ProxyPassword) != "",
		HasHTTPTunnelPassword:    strings.TrimSpace(bundle.HTTPTunnelPassword) != "",
		HasMySQLReplicaPassword:  strings.TrimSpace(bundle.MySQLReplicaPassword) != "",
		HasMongoReplicaPassword:  strings.TrimSpace(bundle.MongoReplicaPassword) != "",
		HasRedisSentinelPassword: strings.TrimSpace(bundle.RedisSentinelPassword) != "",
		HasOpaqueURI:             strings.TrimSpace(bundle.OpaqueURI) != "",
		HasOpaqueDSN:             strings.TrimSpace(bundle.OpaqueDSN) != "",
		HasJVMJMXPassword:        strings.TrimSpace(bundle.JVMJMXPassword) != "",
		HasJVMEndpointAPIKey:     strings.TrimSpace(bundle.JVMEndpointAPIKey) != "",
		HasJVMAgentAPIKey:        strings.TrimSpace(bundle.JVMAgentAPIKey) != "",
		HasJVMDiagnosticAPIKey:   strings.TrimSpace(bundle.JVMDiagnosticAPIKey) != "",
		HasSensitiveParams:       strings.TrimSpace(bundle.SensitiveParams) != "",
	}
	return view, bundle
}
