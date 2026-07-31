package dailysecret

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const (
	fileName      = "daily_secrets.json"
	schemaVersion = 1
)

type ConnectionBundle struct {
	Password              string `json:"password,omitempty"`
	SSHPassword           string `json:"sshPassword,omitempty"`
	ProxyPassword         string `json:"proxyPassword,omitempty"`
	HTTPTunnelPassword    string `json:"httpTunnelPassword,omitempty"`
	MySQLReplicaPassword  string `json:"mysqlReplicaPassword,omitempty"`
	MongoReplicaPassword  string `json:"mongoReplicaPassword,omitempty"`
	RedisSentinelPassword string `json:"redisSentinelPassword,omitempty"`
	OpaqueURI             string `json:"opaqueURI,omitempty"`
	OpaqueDSN             string `json:"opaqueDSN,omitempty"`
}

func (b ConnectionBundle) HasAny() bool {
	return strings.TrimSpace(b.Password) != "" ||
		strings.TrimSpace(b.SSHPassword) != "" ||
		strings.TrimSpace(b.ProxyPassword) != "" ||
		strings.TrimSpace(b.HTTPTunnelPassword) != "" ||
		strings.TrimSpace(b.MySQLReplicaPassword) != "" ||
		strings.TrimSpace(b.MongoReplicaPassword) != "" ||
		strings.TrimSpace(b.RedisSentinelPassword) != "" ||
		strings.TrimSpace(b.OpaqueURI) != "" ||
		strings.TrimSpace(b.OpaqueDSN) != ""
}

type GlobalProxyBundle struct {
	Password string `json:"password,omitempty"`
}

func (b GlobalProxyBundle) HasAny() bool {
	return strings.TrimSpace(b.Password) != ""
}

type MCPHTTPServerBundle struct {
	Token string `json:"token,omitempty"`
}

func (b MCPHTTPServerBundle) HasAny() bool {
	return strings.TrimSpace(b.Token) != ""
}

type ProviderBundle struct {
	APIKey           string            `json:"apiKey,omitempty"`
	SensitiveHeaders map[string]string `json:"sensitiveHeaders,omitempty"`
}

func (b ProviderBundle) HasAny() bool {
	return strings.TrimSpace(b.APIKey) != "" || len(b.SensitiveHeaders) > 0
}

type File struct {
	SchemaVersion int                         `json:"schemaVersion,omitempty"`
	Connections   map[string]ConnectionBundle `json:"connections,omitempty"`
	GlobalProxy   *GlobalProxyBundle          `json:"globalProxy,omitempty"`
	MCPHTTPServer *MCPHTTPServerBundle        `json:"mcpHTTPServer,omitempty"`
	AIProviders   map[string]ProviderBundle   `json:"aiProviders,omitempty"`
}

type Store struct {
	root string
}

func NewStore(root string) *Store {
	return &Store{root: strings.TrimSpace(root)}
}

func (s *Store) Path() string {
	return filepath.Join(s.root, fileName)
}

func (s *Store) Load() (File, error) {
	if strings.TrimSpace(s.root) == "" {
		return File{SchemaVersion: schemaVersion}, nil
	}
	data, err := os.ReadFile(s.Path())
	if err != nil {
		if os.IsNotExist(err) {
			return File{SchemaVersion: schemaVersion}, nil
		}
		return File{}, err
	}
	var file File
	if err := json.Unmarshal(data, &file); err != nil {
		return File{}, err
	}
	if file.SchemaVersion == 0 {
		file.SchemaVersion = schemaVersion
	}
	return file, nil
}

func (s *Store) Save(file File) error {
	if strings.TrimSpace(s.root) == "" {
		return nil
	}
	file.SchemaVersion = schemaVersion
	if len(file.Connections) == 0 {
		file.Connections = nil
	}
	if file.GlobalProxy != nil && !file.GlobalProxy.HasAny() {
		file.GlobalProxy = nil
	}
	if file.MCPHTTPServer != nil && !file.MCPHTTPServer.HasAny() {
		file.MCPHTTPServer = nil
	}
	if len(file.AIProviders) == 0 {
		file.AIProviders = nil
	}
	// 本文件以明文保存全部数据库/SSH/代理口令与 AI Provider 的 API Key，必须限制为仅属主可读。
	// 目录同时收紧到 0o700，避免同机其他用户遍历目录。
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.Path(), payload, 0o600); err != nil {
		return err
	}
	// os.WriteFile 的权限参数只在创建新文件时生效；对历史上以 0o644 创建的文件必须显式收紧，
	// 否则升级后的用户仍然暴露。Windows 上 Chmod 只影响只读位，此调用无实际副作用。
	if err := os.Chmod(s.Path(), 0o600); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *Store) GetConnection(id string) (ConnectionBundle, bool, error) {
	file, err := s.Load()
	if err != nil {
		return ConnectionBundle{}, false, err
	}
	bundle, ok := file.Connections[strings.TrimSpace(id)]
	return bundle, ok, nil
}

func (s *Store) PutConnection(id string, bundle ConnectionBundle) error {
	file, err := s.Load()
	if err != nil {
		return err
	}
	if !bundle.HasAny() {
		return s.deleteConnectionFromFile(file, id)
	}
	if file.Connections == nil {
		file.Connections = make(map[string]ConnectionBundle)
	}
	file.Connections[strings.TrimSpace(id)] = bundle
	return s.Save(file)
}

func (s *Store) DeleteConnection(id string) error {
	file, err := s.Load()
	if err != nil {
		return err
	}
	return s.deleteConnectionFromFile(file, id)
}

func (s *Store) deleteConnectionFromFile(file File, id string) error {
	if len(file.Connections) != 0 {
		delete(file.Connections, strings.TrimSpace(id))
	}
	return s.Save(file)
}

func (s *Store) GetGlobalProxy() (GlobalProxyBundle, bool, error) {
	file, err := s.Load()
	if err != nil {
		return GlobalProxyBundle{}, false, err
	}
	if file.GlobalProxy == nil {
		return GlobalProxyBundle{}, false, nil
	}
	return *file.GlobalProxy, true, nil
}

func (s *Store) PutGlobalProxy(bundle GlobalProxyBundle) error {
	file, err := s.Load()
	if err != nil {
		return err
	}
	if !bundle.HasAny() {
		file.GlobalProxy = nil
		return s.Save(file)
	}
	copyBundle := bundle
	file.GlobalProxy = &copyBundle
	return s.Save(file)
}

func (s *Store) DeleteGlobalProxy() error {
	file, err := s.Load()
	if err != nil {
		return err
	}
	file.GlobalProxy = nil
	return s.Save(file)
}

func (s *Store) GetMCPHTTPServer() (MCPHTTPServerBundle, bool, error) {
	file, err := s.Load()
	if err != nil {
		return MCPHTTPServerBundle{}, false, err
	}
	if file.MCPHTTPServer == nil {
		return MCPHTTPServerBundle{}, false, nil
	}
	return *file.MCPHTTPServer, true, nil
}

func (s *Store) PutMCPHTTPServer(bundle MCPHTTPServerBundle) error {
	file, err := s.Load()
	if err != nil {
		return err
	}
	if !bundle.HasAny() {
		file.MCPHTTPServer = nil
		return s.Save(file)
	}
	copyBundle := bundle
	file.MCPHTTPServer = &copyBundle
	return s.Save(file)
}

func (s *Store) DeleteMCPHTTPServer() error {
	file, err := s.Load()
	if err != nil {
		return err
	}
	file.MCPHTTPServer = nil
	return s.Save(file)
}

func (s *Store) GetAIProvider(id string) (ProviderBundle, bool, error) {
	file, err := s.Load()
	if err != nil {
		return ProviderBundle{}, false, err
	}
	bundle, ok := file.AIProviders[strings.TrimSpace(id)]
	return bundle, ok, nil
}

func (s *Store) PutAIProvider(id string, bundle ProviderBundle) error {
	file, err := s.Load()
	if err != nil {
		return err
	}
	if !bundle.HasAny() {
		return s.deleteAIProviderFromFile(file, id)
	}
	if file.AIProviders == nil {
		file.AIProviders = make(map[string]ProviderBundle)
	}
	if len(bundle.SensitiveHeaders) > 0 {
		cloned := make(map[string]string, len(bundle.SensitiveHeaders))
		for key, value := range bundle.SensitiveHeaders {
			cloned[key] = value
		}
		bundle.SensitiveHeaders = cloned
	}
	file.AIProviders[strings.TrimSpace(id)] = bundle
	return s.Save(file)
}

func (s *Store) DeleteAIProvider(id string) error {
	file, err := s.Load()
	if err != nil {
		return err
	}
	return s.deleteAIProviderFromFile(file, id)
}

func (s *Store) deleteAIProviderFromFile(file File, id string) error {
	if len(file.AIProviders) != 0 {
		delete(file.AIProviders, strings.TrimSpace(id))
	}
	return s.Save(file)
}
