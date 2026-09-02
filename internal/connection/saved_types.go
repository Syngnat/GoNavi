package connection

// SchemaVisibilityRule defines how schemas are displayed for one database in a
// saved connection. Mode is interpreted by the client (for example, "include"
// or "exclude") and Schemas contains the affected schema names.
type SchemaVisibilityRule struct {
	Mode    string   `json:"mode"`
	Schemas []string `json:"schemas,omitempty"`
}

type SavedConnectionInput struct {
	ID                         string                          `json:"id,omitempty"`
	Name                       string                          `json:"name"`
	CreatedAt                  int64                           `json:"createdAt,omitempty"`
	EnvironmentType            string                          `json:"environmentType,omitempty"`
	Config                     ConnectionConfig                `json:"config"`
	IncludeDatabases           []string                        `json:"includeDatabases,omitempty"`
	IncludeDatabasePatterns    []string                        `json:"includeDatabasePatterns,omitempty"`
	ExcludeDatabasePatterns    []string                        `json:"excludeDatabasePatterns,omitempty"`
	IncludeRedisDatabases      []int                           `json:"includeRedisDatabases,omitempty"`
	SchemaVisibilityByDatabase map[string]SchemaVisibilityRule `json:"schemaVisibilityByDatabase,omitempty"`
	IconType                   string                          `json:"iconType,omitempty"`
	IconColor                  string                          `json:"iconColor,omitempty"`
	ClearPrimaryPassword       bool                            `json:"clearPrimaryPassword,omitempty"`
	ClearSSHPassword           bool                            `json:"clearSSHPassword,omitempty"`
	ClearProxyPassword         bool                            `json:"clearProxyPassword,omitempty"`
	ClearHTTPTunnelPassword    bool                            `json:"clearHttpTunnelPassword,omitempty"`
	ClearMySQLReplicaPassword  bool                            `json:"clearMySQLReplicaPassword,omitempty"`
	ClearMongoReplicaPassword  bool                            `json:"clearMongoReplicaPassword,omitempty"`
	ClearRedisSentinelPassword bool                            `json:"clearRedisSentinelPassword,omitempty"`
	ClearOpaqueURI             bool                            `json:"clearOpaqueURI,omitempty"`
	ClearOpaqueDSN             bool                            `json:"clearOpaqueDSN,omitempty"`
	ClearJVMJMXPassword        bool                            `json:"clearJVMJMXPassword,omitempty"`
	ClearJVMEndpointAPIKey     bool                            `json:"clearJVMEndpointAPIKey,omitempty"`
	ClearJVMAgentAPIKey        bool                            `json:"clearJVMAgentAPIKey,omitempty"`
	ClearJVMDiagnosticAPIKey   bool                            `json:"clearJVMDiagnosticAPIKey,omitempty"`
	ClearSensitiveParams       bool                            `json:"clearSensitiveConnectionParams,omitempty"`
}

// ConnectionVisibilityInput updates only the database and schema visibility
// metadata of an existing saved connection.
type ConnectionVisibilityInput struct {
	ID                         string                          `json:"id"`
	IncludeDatabases           []string                        `json:"includeDatabases,omitempty"`
	IncludeDatabasePatterns    []string                        `json:"includeDatabasePatterns,omitempty"`
	ExcludeDatabasePatterns    []string                        `json:"excludeDatabasePatterns,omitempty"`
	IncludeRedisDatabases      []int                           `json:"includeRedisDatabases,omitempty"`
	SchemaVisibilityByDatabase map[string]SchemaVisibilityRule `json:"schemaVisibilityByDatabase,omitempty"`
}

type SavedConnectionView struct {
	ID                         string                          `json:"id"`
	Name                       string                          `json:"name"`
	CreatedAt                  int64                           `json:"createdAt,omitempty"`
	EnvironmentType            string                          `json:"environmentType,omitempty"`
	Config                     ConnectionConfig                `json:"config"`
	IncludeDatabases           []string                        `json:"includeDatabases,omitempty"`
	IncludeDatabasePatterns    []string                        `json:"includeDatabasePatterns,omitempty"`
	ExcludeDatabasePatterns    []string                        `json:"excludeDatabasePatterns,omitempty"`
	IncludeRedisDatabases      []int                           `json:"includeRedisDatabases,omitempty"`
	SchemaVisibilityByDatabase map[string]SchemaVisibilityRule `json:"schemaVisibilityByDatabase,omitempty"`
	IconType                   string                          `json:"iconType,omitempty"`
	IconColor                  string                          `json:"iconColor,omitempty"`
	SecretRef                  string                          `json:"secretRef,omitempty"`
	HasPrimaryPassword         bool                            `json:"hasPrimaryPassword,omitempty"`
	HasSSHPassword             bool                            `json:"hasSSHPassword,omitempty"`
	HasProxyPassword           bool                            `json:"hasProxyPassword,omitempty"`
	HasHTTPTunnelPassword      bool                            `json:"hasHttpTunnelPassword,omitempty"`
	HasMySQLReplicaPassword    bool                            `json:"hasMySQLReplicaPassword,omitempty"`
	HasMongoReplicaPassword    bool                            `json:"hasMongoReplicaPassword,omitempty"`
	HasRedisSentinelPassword   bool                            `json:"hasRedisSentinelPassword,omitempty"`
	HasOpaqueURI               bool                            `json:"hasOpaqueURI,omitempty"`
	HasOpaqueDSN               bool                            `json:"hasOpaqueDSN,omitempty"`
	HasJVMJMXPassword          bool                            `json:"hasJVMJMXPassword,omitempty"`
	HasJVMEndpointAPIKey       bool                            `json:"hasJVMEndpointAPIKey,omitempty"`
	HasJVMAgentAPIKey          bool                            `json:"hasJVMAgentAPIKey,omitempty"`
	HasJVMDiagnosticAPIKey     bool                            `json:"hasJVMDiagnosticAPIKey,omitempty"`
	HasSensitiveParams         bool                            `json:"hasSensitiveConnectionParams,omitempty"`
}

type LegacySavedConnection = SavedConnectionInput

type SaveGlobalProxyInput struct {
	Enabled       bool   `json:"enabled"`
	Type          string `json:"type"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	User          string `json:"user,omitempty"`
	Password      string `json:"password,omitempty"`
	ClearPassword bool   `json:"clearPassword,omitempty"`
}

type TestGlobalProxyInput struct {
	Proxy          SaveGlobalProxyInput `json:"proxy"`
	URL            string               `json:"url"`
	TimeoutSeconds int                  `json:"timeoutSeconds,omitempty"`
}

type GlobalProxyTestResult struct {
	URL        string `json:"url"`
	FinalURL   string `json:"finalUrl,omitempty"`
	StatusCode int    `json:"statusCode,omitempty"`
	Status     string `json:"status,omitempty"`
	DurationMs int64  `json:"durationMs"`
	ViaProxy   bool   `json:"viaProxy"`
}

type GlobalProxyView struct {
	Enabled     bool   `json:"enabled"`
	Type        string `json:"type"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user,omitempty"`
	Password    string `json:"password,omitempty"`
	HasPassword bool   `json:"hasPassword,omitempty"`
	SecretRef   string `json:"secretRef,omitempty"`
}

type LegacyGlobalProxyInput = SaveGlobalProxyInput
