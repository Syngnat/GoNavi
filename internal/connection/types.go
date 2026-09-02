package connection

import "strings"

// SSHProgressEvent describes a non-sensitive phase in establishing an SSH
// connection. It intentionally contains no host, credential, or error text:
// callers already know the target and failures continue through the normal
// connection-result path where redaction rules apply.
type SSHProgressEvent struct {
	Stage  string `json:"stage"`
	Status string `json:"status"`
}

// SSHProgressReporter receives best-effort SSH connection phase updates. It is
// runtime-only and is never serialized with a saved connection.
type SSHProgressReporter func(SSHProgressEvent)

type sshRuntime struct {
	report                       SSHProgressReporter
	managedHostKeyTrustStorePath string
	hostKeyIdentityHost          string
	hostKeyIdentityPort          int
}

func (r sshRuntime) hasState() bool {
	return r.report != nil ||
		r.managedHostKeyTrustStorePath != "" ||
		r.hostKeyIdentityHost != "" ||
		r.hostKeyIdentityPort != 0
}

// SSHRuntimeSnapshot contains the runtime-only SSH state that a local
// driver-agent needs to perform host-key verification. It intentionally
// excludes progress callbacks and is transported separately from saved
// connection JSON.
type SSHRuntimeSnapshot struct {
	ManagedHostKeyTrustStorePath string `json:"managedHostKeyTrustStorePath,omitempty"`
	HostKeyIdentityHost          string `json:"hostKeyIdentityHost,omitempty"`
	HostKeyIdentityPort          int    `json:"hostKeyIdentityPort,omitempty"`
}

// SSHConfig 存储 SSH 隧道连接配置。
type SSHConfig struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	User               string `json:"user"`
	Password           string `json:"password"`
	KeyPath            string `json:"keyPath"`
	KnownHostsPath     string `json:"knownHostsPath,omitempty"`
	HostKeyFingerprint string `json:"hostKeyFingerprint,omitempty"`
	runtime            *sshRuntime
}

// WithProgressReporter attaches a transient observer to this config. Keeping
// it behind an unexported pointer preserves the public JSON contract and
// keeps SSHConfig comparable for existing cache keys.
func (c SSHConfig) WithProgressReporter(reporter SSHProgressReporter) SSHConfig {
	runtime := sshRuntime{}
	if c.runtime != nil {
		runtime = *c.runtime
	}
	runtime.report = reporter
	if !runtime.hasState() {
		c.runtime = nil
		return c
	}
	c.runtime = &runtime
	return c
}

// WithManagedHostKeyTrustStore attaches GoNavi's private host-key trust
// store for this runtime connection. The path is deliberately transient: it
// is never sent to the frontend or persisted with a saved data source.
func (c SSHConfig) WithManagedHostKeyTrustStore(path string) SSHConfig {
	runtime := sshRuntime{}
	if c.runtime != nil {
		runtime = *c.runtime
	}
	runtime.managedHostKeyTrustStorePath = strings.TrimSpace(path)
	if !runtime.hasState() {
		c.runtime = nil
		return c
	}
	c.runtime = &runtime
	return c
}

// ManagedHostKeyTrustStorePath returns the private GoNavi trust-store path
// attached to this runtime connection, if any.
func (c SSHConfig) ManagedHostKeyTrustStorePath() string {
	if c.runtime == nil {
		return ""
	}
	return c.runtime.managedHostKeyTrustStorePath
}

// RuntimeSnapshot returns the agent-safe subset of transient SSH state. The
// returned value can cross the local driver-agent IPC boundary without changing
// the persisted SSHConfig JSON contract.
func (c SSHConfig) RuntimeSnapshot() *SSHRuntimeSnapshot {
	if c.runtime == nil {
		return nil
	}

	snapshot := &SSHRuntimeSnapshot{
		ManagedHostKeyTrustStorePath: c.runtime.managedHostKeyTrustStorePath,
		HostKeyIdentityHost:          c.runtime.hostKeyIdentityHost,
		HostKeyIdentityPort:          c.runtime.hostKeyIdentityPort,
	}
	if snapshot.ManagedHostKeyTrustStorePath == "" && snapshot.HostKeyIdentityHost == "" {
		return nil
	}
	if snapshot.HostKeyIdentityHost != "" && snapshot.HostKeyIdentityPort <= 0 {
		snapshot.HostKeyIdentityPort = 22
	}
	return snapshot
}

// WithRuntimeSnapshot restores the agent-safe transient SSH state. A progress
// reporter already attached in this process is retained, but snapshots never
// carry callbacks from another process.
func (c SSHConfig) WithRuntimeSnapshot(snapshot *SSHRuntimeSnapshot) SSHConfig {
	if snapshot == nil {
		return c
	}

	runtime := sshRuntime{}
	if c.runtime != nil {
		runtime.report = c.runtime.report
	}
	runtime.managedHostKeyTrustStorePath = strings.TrimSpace(snapshot.ManagedHostKeyTrustStorePath)
	runtime.hostKeyIdentityHost = strings.TrimSpace(snapshot.HostKeyIdentityHost)
	if runtime.hostKeyIdentityHost != "" {
		runtime.hostKeyIdentityPort = snapshot.HostKeyIdentityPort
		if runtime.hostKeyIdentityPort <= 0 {
			runtime.hostKeyIdentityPort = 22
		}
	}
	if !runtime.hasState() {
		c.runtime = nil
		return c
	}
	c.runtime = &runtime
	return c
}

// WithHostKeyIdentity preserves the logical SSH server identity while a
// proxy rewrites Host/Port to a local forwarding endpoint. The identity is
// runtime-only so trusted-host records never depend on an ephemeral localhost
// port and are not serialized into saved connection settings.
func (c SSHConfig) WithHostKeyIdentity(host string, port int) SSHConfig {
	host = strings.TrimSpace(host)
	if host == "" {
		return c
	}
	if port <= 0 {
		port = 22
	}
	runtime := sshRuntime{}
	if c.runtime != nil {
		runtime = *c.runtime
	}
	runtime.hostKeyIdentityHost = host
	runtime.hostKeyIdentityPort = port
	c.runtime = &runtime
	return c
}

// HostKeyIdentity returns the logical server address used for host-key
// verification. Without a proxy rewrite it is simply the configured SSH
// host and port.
func (c SSHConfig) HostKeyIdentity() (string, int) {
	if c.runtime != nil && c.runtime.hostKeyIdentityHost != "" {
		return c.runtime.hostKeyIdentityHost, c.runtime.hostKeyIdentityPort
	}
	return c.Host, c.Port
}

// ReportProgress publishes a best-effort SSH phase update when this config is
// being used by an interactive connection test.
func (c SSHConfig) ReportProgress(stage string, status string) {
	if c.runtime == nil || c.runtime.report == nil {
		return
	}
	c.runtime.report(SSHProgressEvent{Stage: stage, Status: status})
}

// ProxyConfig 存储代理连接配置。
type ProxyConfig struct {
	Type     string `json:"type"` // socks5 | http
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user,omitempty"`
	Password string `json:"password,omitempty"`
}

// HTTPTunnelConfig 存储 HTTP CONNECT 隧道配置。
type HTTPTunnelConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user,omitempty"`
	Password string `json:"password,omitempty"`
}

// JVMJMXConfig 存储 JVM JMX 连接配置。
type JVMJMXConfig struct {
	Enabled         bool     `json:"enabled,omitempty"`
	Host            string   `json:"host,omitempty"`
	Port            int      `json:"port,omitempty"`
	Username        string   `json:"username,omitempty"`
	Password        string   `json:"password,omitempty"`
	DomainAllowlist []string `json:"domainAllowlist,omitempty"`
}

// JVMEndpointConfig 存储 JVM Management Endpoint 连接配置。
type JVMEndpointConfig struct {
	Enabled        bool   `json:"enabled,omitempty"`
	BaseURL        string `json:"baseUrl,omitempty"`
	APIKey         string `json:"apiKey,omitempty"`
	TimeoutSeconds int    `json:"timeoutSeconds,omitempty"`
}

// JVMAgentConfig 存储 JVM Agent 管理端点配置。
type JVMAgentConfig struct {
	Enabled        bool   `json:"enabled,omitempty"`
	BaseURL        string `json:"baseUrl,omitempty"`
	APIKey         string `json:"apiKey,omitempty"`
	TimeoutSeconds int    `json:"timeoutSeconds,omitempty"`
}

// JVMDiagnosticConfig 存储 JVM 诊断增强模式配置。
type JVMDiagnosticConfig struct {
	Enabled               bool   `json:"enabled,omitempty"`
	Transport             string `json:"transport,omitempty"`
	BaseURL               string `json:"baseUrl,omitempty"`
	TargetID              string `json:"targetId,omitempty"`
	APIKey                string `json:"apiKey,omitempty"`
	AllowObserveCommands  bool   `json:"allowObserveCommands,omitempty"`
	AllowTraceCommands    bool   `json:"allowTraceCommands,omitempty"`
	AllowMutatingCommands bool   `json:"allowMutatingCommands,omitempty"`
	TimeoutSeconds        int    `json:"timeoutSeconds,omitempty"`
}

// JVMConfig 存储 JVM 连接的协议与能力偏好配置。
type JVMConfig struct {
	Environment   string              `json:"environment,omitempty"`
	ReadOnly      *bool               `json:"readOnly,omitempty"`
	AllowedModes  []string            `json:"allowedModes,omitempty"`
	PreferredMode string              `json:"preferredMode,omitempty"`
	JMX           JVMJMXConfig        `json:"jmx,omitempty"`
	Endpoint      JVMEndpointConfig   `json:"endpoint,omitempty"`
	Agent         JVMAgentConfig      `json:"agent,omitempty"`
	Diagnostic    JVMDiagnosticConfig `json:"diagnostic,omitempty"`
}

// ConnectionProtectionConfig 存储生产连接保护的细粒度限制项。
type ConnectionProtectionConfig struct {
	RestrictDataEdit        bool `json:"restrictDataEdit,omitempty"`
	RestrictStructureEdit   bool `json:"restrictStructureEdit,omitempty"`
	RestrictScriptExecution bool `json:"restrictScriptExecution,omitempty"`
	RestrictDataImport      bool `json:"restrictDataImport,omitempty"`
}

// ConnectionConfig 存储数据库连接的完整配置，包括 SSH、代理、SSL 等网络层设置。
type ConnectionConfig struct {
	ID                       string                     `json:"id,omitempty"`
	Type                     string                     `json:"type"`
	Host                     string                     `json:"host"`
	Port                     int                        `json:"port"`
	User                     string                     `json:"user"`
	Password                 string                     `json:"password"`
	SavePassword             bool                       `json:"savePassword,omitempty"` // Persist password in saved connection
	Database                 string                     `json:"database"`
	ReadOnly                 bool                       `json:"readOnly,omitempty"` // Legacy production guard compatibility flag. Prefer Protection for new logic.
	Protection               ConnectionProtectionConfig `json:"protection,omitempty"`
	UseSSL                   bool                       `json:"useSSL,omitempty"`      // MySQL-like SSL/TLS switch
	SSLMode                  string                     `json:"sslMode,omitempty"`     // preferred | required | skip-verify | disable
	SSLCAPath                string                     `json:"sslCAPath,omitempty"`   // TLS root CA / server certificate path
	SSLCertPath              string                     `json:"sslCertPath,omitempty"` // TLS client certificate path (e.g., Dameng)
	SSLKeyPath               string                     `json:"sslKeyPath,omitempty"`  // TLS client private key path (e.g., Dameng)
	UseSSH                   bool                       `json:"useSSH"`
	SSH                      SSHConfig                  `json:"ssh"`
	UseProxy                 bool                       `json:"useProxy,omitempty"`
	Proxy                    ProxyConfig                `json:"proxy,omitempty"`
	UseHTTPTunnel            bool                       `json:"useHttpTunnel,omitempty"`
	HTTPTunnel               HTTPTunnelConfig           `json:"httpTunnel,omitempty"`
	Driver                   string                     `json:"driver,omitempty"`                   // For custom connection
	DSN                      string                     `json:"dsn,omitempty"`                      // For custom connection
	ConnectionParams         string                     `json:"connectionParams,omitempty"`         // Extra URI query parameters for built-in drivers
	Timeout                  int                        `json:"timeout,omitempty"`                  // Connection timeout in seconds (default: 30)
	QueryTimeout             int                        `json:"queryTimeout,omitempty"`             // Per-request query timeout in seconds; 0 disables the automatic query deadline
	KeepAliveEnabled         bool                       `json:"keepAliveEnabled,omitempty"`         // Enable background keep-alive ping for long-lived cached connections
	KeepAliveIntervalMinutes int                        `json:"keepAliveIntervalMinutes,omitempty"` // Keep-alive ping interval in minutes (default: 240)
	KeepAliveSQL             string                     `json:"keepAliveSQL,omitempty"`             // Optional single SELECT/WITH probe used instead of the driver ping
	RedisDB                  int                        `json:"redisDB,omitempty"`                  // Redis database index (0-15)
	RedisSentinelMaster      string                     `json:"redisSentinelMaster,omitempty"`      // Redis Sentinel master name
	RedisSentinelUser        string                     `json:"redisSentinelUser,omitempty"`        // Redis Sentinel auth user
	RedisSentinelPassword    string                     `json:"redisSentinelPassword,omitempty"`    // Redis Sentinel auth password
	URI                      string                     `json:"uri,omitempty"`                      // Connection URI for copy/paste
	ClickHouseProtocol       string                     `json:"clickHouseProtocol,omitempty"`       // auto | http | native
	OceanBaseProtocol        string                     `json:"oceanBaseProtocol,omitempty"`        // OceanBase tenant compatibility protocol: mysql | oracle
	Hosts                    []string                   `json:"hosts,omitempty"`                    // Multi-host addresses: host:port
	Topology                 string                     `json:"topology,omitempty"`                 // single | replica | cluster | sentinel
	MySQLReplicaUser         string                     `json:"mysqlReplicaUser,omitempty"`         // MySQL replica auth user
	MySQLReplicaPassword     string                     `json:"mysqlReplicaPassword,omitempty"`     // MySQL replica auth password
	ReplicaSet               string                     `json:"replicaSet,omitempty"`               // MongoDB replica set name
	AuthSource               string                     `json:"authSource,omitempty"`               // MongoDB authSource
	ReadPreference           string                     `json:"readPreference,omitempty"`           // MongoDB readPreference
	MongoSRV                 bool                       `json:"mongoSrv,omitempty"`                 // MongoDB use mongodb+srv URI scheme
	MongoAuthMechanism       string                     `json:"mongoAuthMechanism,omitempty"`       // MongoDB authMechanism
	MongoReplicaUser         string                     `json:"mongoReplicaUser,omitempty"`         // MongoDB replica auth user
	MongoReplicaPassword     string                     `json:"mongoReplicaPassword,omitempty"`     // MongoDB replica auth password
	JVM                      JVMConfig                  `json:"jvm,omitempty"`                      // JVM connector config
	runtimeDBOverride        string                     // App-only selected database; never persisted or sent over RPC.
	runtimeDBOverrideSet     bool                       // Distinguishes an explicit server-level override from no override.
	resolvedSavedSnapshot    bool                       // App-only marker for one lock-consistent metadata and secret snapshot.
}

// WithRuntimeDatabaseOverride carries a caller-selected database through runtime
// connection normalization without letting stale persisted fields override a DSN.
func (c ConnectionConfig) WithRuntimeDatabaseOverride(database string) ConnectionConfig {
	c.runtimeDBOverride = database
	c.runtimeDBOverrideSet = true
	return c
}

// RuntimeDatabaseOverride returns the app-only selected database override.
func (c ConnectionConfig) RuntimeDatabaseOverride() string {
	return c.runtimeDBOverride
}

// HasRuntimeDatabaseOverride reports whether the app explicitly selected a
// database, including an empty server-level selection.
func (c ConnectionConfig) HasRuntimeDatabaseOverride() bool {
	return c.runtimeDBOverrideSet
}

// WithoutRuntimeDatabaseOverride removes the app-only selected database marker.
func (c ConnectionConfig) WithoutRuntimeDatabaseOverride() ConnectionConfig {
	c.runtimeDBOverride = ""
	c.runtimeDBOverrideSet = false
	return c
}

// WithResolvedSavedSnapshot marks a config whose saved metadata and secrets
// were loaded together under the shared storage lock. The marker is not
// serialized and prevents a later execution layer from mixing in a newer
// secret bundle.
func (c ConnectionConfig) WithResolvedSavedSnapshot() ConnectionConfig {
	c.resolvedSavedSnapshot = true
	return c
}

// HasResolvedSavedSnapshot reports whether the config already contains the
// complete saved connection snapshot required for one execution.
func (c ConnectionConfig) HasResolvedSavedSnapshot() bool {
	return c.resolvedSavedSnapshot
}

// ResultSetData 表示一个查询结果集（行 + 列名），用于多结果集场景。
type ResultSetData struct {
	Rows           []map[string]interface{} `json:"rows"`
	Columns        []string                 `json:"columns"`
	Messages       []string                 `json:"messages,omitempty"`
	StatementIndex int                      `json:"statementIndex,omitempty"`
}

const QueryCancellationStateUnsupported = "unsupported"

// QueryResult 是 Wails 绑定方法的统一响应格式，前端通过此结构体接收后端结果。
type QueryResult struct {
	Success            bool        `json:"success"`
	Message            string      `json:"message"`
	Data               interface{} `json:"data"`
	Fields             []string    `json:"fields,omitempty"`
	Messages           []string    `json:"messages,omitempty"`
	Partial            bool        `json:"partial,omitempty"`
	ExecutedCount      int         `json:"executedCount,omitempty"`
	FailedIndex        int         `json:"failedIndex,omitempty"`
	BoundaryMode       string      `json:"boundaryMode,omitempty"`
	CommitMode         string      `json:"commitMode,omitempty"`
	Warnings           []string    `json:"warnings,omitempty"`
	OutcomeUnknown     bool        `json:"outcomeUnknown,omitempty"`
	FailedObjectTypes  []string    `json:"failedObjectTypes,omitempty"`
	Retryable          bool        `json:"retryable,omitempty"`
	Truncated          bool        `json:"truncated,omitempty"`
	ScannedCount       int         `json:"scannedCount,omitempty"`
	QueryID            string      `json:"queryId,omitempty"` // Unique ID for query cancellation
	CancellationState  string      `json:"cancellationState,omitempty"`
	TransactionID      string      `json:"transactionId,omitempty"`
	TransactionPending bool        `json:"transactionPending,omitempty"`
}

// DatabaseObject 描述数据库或类数据库数据源中的可浏览对象。
type DatabaseObject struct {
	Name         string `json:"name"`
	Type         string `json:"type"`
	Schema       string `json:"schema,omitempty"`
	Database     string `json:"database,omitempty"`
	Parent       string `json:"parent,omitempty"`
	RawType      string `json:"rawType,omitempty"`
	ObjectStatus string `json:"objectStatus,omitempty"`
	Comment      string `json:"comment,omitempty"`
}

// DatabaseCharset 描述 MySQL 系数据源可用的字符集（SHOW CHARACTER SET）。
type DatabaseCharset struct {
	Name             string `json:"name"`
	Description      string `json:"description,omitempty"`
	DefaultCollation string `json:"defaultCollation,omitempty"`
	MaxLength        int    `json:"maxLength,omitempty"`
}

// DatabaseCollation 描述 MySQL 系数据源可用的排序规则（SHOW COLLATION）。
type DatabaseCollation struct {
	Name    string `json:"name"`
	Charset string `json:"charset"`
}

// ColumnDefinition 描述表的一个列定义。
type ColumnDefinition struct {
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Nullable   string  `json:"nullable"` // YES/NO
	Key        string  `json:"key"`      // PRI, UNI, MUL
	Default    *string `json:"default"`
	HasDefault bool    `json:"hasDefault,omitempty"`
	Extra      string  `json:"extra"` // auto_increment
	Comment    string  `json:"comment"`
	Charset    string  `json:"charset,omitempty"`
	Collation  string  `json:"collation,omitempty"`
}

// IndexDefinition 描述表的一个索引定义。
type IndexDefinition struct {
	Name       string `json:"name"`
	ColumnName string `json:"columnName"`
	NonUnique  int    `json:"nonUnique"`
	SeqInIndex int    `json:"seqInIndex"`
	IndexType  string `json:"indexType"`
	SubPart    int    `json:"subPart,omitempty"`
}

// ForeignKeyDefinition 描述表的一个外键定义。
type ForeignKeyDefinition struct {
	Name           string `json:"name"`
	ColumnName     string `json:"columnName"`
	RefTableName   string `json:"refTableName"`
	RefColumnName  string `json:"refColumnName"`
	ConstraintName string `json:"constraintName"`
}

// TriggerDefinition 描述表的一个触发器定义。
type TriggerDefinition struct {
	Name      string `json:"name"`
	Timing    string `json:"timing"` // BEFORE/AFTER
	Event     string `json:"event"`  // INSERT/UPDATE/DELETE
	Statement string `json:"statement"`
}

// ColumnDefinitionWithTable 带有表名标识的列定义，用于跨表搜索和 SQL 自动补全。
type ColumnDefinitionWithTable struct {
	TableName string `json:"tableName"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Comment   string `json:"comment,omitempty"`
}

// UpdateRow 表示一行更新操作，Keys 为 WHERE 条件，Values 为 SET 值。
type UpdateRow struct {
	Keys   map[string]interface{} `json:"keys"`
	Values map[string]interface{} `json:"values"`
}

// ChangeSet 表示一组批量变更，包含新增、修改和删除操作。
type ChangeSet struct {
	Inserts         []map[string]interface{} `json:"inserts"`
	Updates         []UpdateRow              `json:"updates"`
	Deletes         []map[string]interface{} `json:"deletes"`
	LocatorStrategy string                   `json:"locatorStrategy,omitempty"`
}

// MongoMemberInfo 描述 MongoDB 副本集成员的信息。
type MongoMemberInfo struct {
	Host      string `json:"host"`
	Role      string `json:"role"`
	State     string `json:"state"`
	StateCode int    `json:"stateCode,omitempty"`
	Healthy   bool   `json:"healthy"`
	IsSelf    bool   `json:"isSelf,omitempty"`
}
