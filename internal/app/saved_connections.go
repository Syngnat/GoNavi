package app

import (
	"strings"
	"sync"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
)

// savedConnectionsMu 串行化单进程内 connections.json 的「读取→修改→整体重写」序列。
//
// 必须是包级锁：savedConnectionRepository() 每次调用都返回一个新实例
// （methods_saved_connections.go:9-11），实例级锁起不到任何作用。
// Wails 每个前端调用都在独立 goroutine 中派发，因此批量导入连接包、Navicat 导入、
// web-server 多请求都会真并发进入这些写路径；无锁时后写者会用自己那份旧列表整体覆盖前写者，
// 导致已保存的连接静默丢失，或产生「有密码标记但密文已被删除」的僵尸连接。
//
// 跨进程写路径还必须持有 connections.json.lock。注意不要把锁下沉进
// load()/saveAll()：Save/Delete/Duplicate 内部都会调用它们，会造成重入死锁。
var savedConnectionsMu sync.Mutex

const (
	savedConnectionsFileName            = "connections.json"
	savedConnectionSecretKind           = "connection"
	defaultConnectionEnvironment        = "local"
	maxIncludedDatabases                = 256
	maxIncludedDatabaseNameBytes        = 256
	maxSchemaVisibilityDatabases        = 128
	maxSchemaVisibilitySchemas          = 256
	maxSchemaVisibilityNameBytes        = 256
	maxDatabaseFilterPatterns           = 256
	maxDatabaseFilterPatternBytes       = 256
	maxRedisDatabaseIndex         int64 = 1<<53 - 1
)

func normalizeConnectionEnvironmentType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "production":
		return "production"
	case "test":
		return "test"
	case "development":
		return "development"
	default:
		return defaultConnectionEnvironment
	}
}

type connectionSecretBundle struct {
	Password              string `json:"password,omitempty"`
	SSHPassword           string `json:"sshPassword,omitempty"`
	ProxyPassword         string `json:"proxyPassword,omitempty"`
	HTTPTunnelPassword    string `json:"httpTunnelPassword,omitempty"`
	MySQLReplicaPassword  string `json:"mysqlReplicaPassword,omitempty"`
	MongoReplicaPassword  string `json:"mongoReplicaPassword,omitempty"`
	RedisSentinelPassword string `json:"redisSentinelPassword,omitempty"`
	OpaqueURI             string `json:"opaqueURI,omitempty"`
	OpaqueDSN             string `json:"opaqueDSN,omitempty"`
	JVMJMXPassword        string `json:"jvmJMXPassword,omitempty"`
	JVMEndpointAPIKey     string `json:"jvmEndpointAPIKey,omitempty"`
	JVMAgentAPIKey        string `json:"jvmAgentAPIKey,omitempty"`
	JVMDiagnosticAPIKey   string `json:"jvmDiagnosticAPIKey,omitempty"`
	SensitiveParams       string `json:"sensitiveConnectionParams,omitempty"`
}

type savedConnectionsFile struct {
	Connections []connection.SavedConnectionView `json:"connections"`
}

type savedConnectionRepository struct {
	configDir   string
	secretStore secretstore.SecretStore
}

func resolveAppConfigDir() string {
	return appdata.MustResolveActiveRoot()
}

func newSavedConnectionRepository(configDir string, store secretstore.SecretStore) *savedConnectionRepository {
	if strings.TrimSpace(configDir) == "" {
		configDir = resolveAppConfigDir()
	}
	if store == nil {
		store = secretstore.NewUnavailableStore("secret store unavailable")
	}
	return &savedConnectionRepository{configDir: configDir, secretStore: store}
}
