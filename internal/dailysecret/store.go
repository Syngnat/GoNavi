package dailysecret

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/appdata"
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
	JVMJMXPassword        string `json:"jvmJMXPassword,omitempty"`
	JVMEndpointAPIKey     string `json:"jvmEndpointAPIKey,omitempty"`
	JVMAgentAPIKey        string `json:"jvmAgentAPIKey,omitempty"`
	JVMDiagnosticAPIKey   string `json:"jvmDiagnosticAPIKey,omitempty"`
	SensitiveParams       string `json:"sensitiveConnectionParams,omitempty"`
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
		strings.TrimSpace(b.OpaqueDSN) != "" ||
		strings.TrimSpace(b.JVMJMXPassword) != "" ||
		strings.TrimSpace(b.JVMEndpointAPIKey) != "" ||
		strings.TrimSpace(b.JVMAgentAPIKey) != "" ||
		strings.TrimSpace(b.JVMDiagnosticAPIKey) != "" ||
		strings.TrimSpace(b.SensitiveParams) != ""
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
	return s.load()
}

func (s *Store) load() (File, error) {
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
	return s.withWriteLock(func() error {
		return s.saveUnlocked(file)
	})
}

func (s *Store) withWriteLock(operation func() error) (resultErr error) {
	if strings.TrimSpace(s.root) == "" {
		return nil
	}
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(s.root, 0o700); err != nil {
		return err
	}
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(s.root))
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, sharedLock.Close())
	}()
	fileLock, err := appdata.AcquireFileLock(s.Path() + ".lock")
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, fileLock.Close())
	}()
	if operation == nil {
		return nil
	}
	return operation()
}

func (s *Store) saveUnlocked(file File) error {
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
	payload, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(s.root, ".daily-secrets-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	cleanupTemporary := true
	defer func() {
		if cleanupTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := appdata.AtomicReplaceFile(temporaryPath, s.Path()); err != nil {
		return err
	}
	cleanupTemporary = false
	// Historical files may have been created with 0o644, so explicitly tighten
	// the replaced target after the atomic write. On Windows Chmod only affects
	// the read-only bit and is otherwise harmless.
	if err := os.Chmod(s.Path(), 0o600); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// RestoreUnlocked restores a previously captured daily secret file while the
// caller holds SharedStorageLockPath(s.root). It is used to roll back a
// multi-connection import without releasing the cross-process critical
// section between metadata and secret restoration.
func (s *Store) RestoreUnlocked(exists bool, data []byte) error {
	if !exists {
		if err := os.Remove(s.Path()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	var file File
	if err := json.Unmarshal(data, &file); err != nil {
		return err
	}
	return s.saveUnlocked(file)
}

func (s *Store) update(mutator func(*File)) error {
	return s.withWriteLock(func() error {
		return s.updateUnlocked(mutator)
	})
}

// updateUnlocked performs one read-modify-write operation while the caller
// already holds SharedStorageLockPath(s.root). It is intentionally kept
// separate so the saved-connection repository can update metadata and secrets
// under one cross-process critical section.
func (s *Store) updateUnlocked(mutator func(*File)) error {
	file, err := s.load()
	if err != nil {
		return err
	}
	if mutator != nil {
		mutator(&file)
	}
	return s.saveUnlocked(file)
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
	return s.update(func(file *File) {
		if !bundle.HasAny() {
			deleteConnectionFromFile(file, id)
			return
		}
		if file.Connections == nil {
			file.Connections = make(map[string]ConnectionBundle)
		}
		file.Connections[strings.TrimSpace(id)] = bundle
	})
}

// PutConnectionUnlocked updates one connection bundle while the caller holds
// SharedStorageLockPath(s.root).
func (s *Store) PutConnectionUnlocked(id string, bundle ConnectionBundle) error {
	return s.updateUnlocked(func(file *File) {
		if !bundle.HasAny() {
			deleteConnectionFromFile(file, id)
			return
		}
		if file.Connections == nil {
			file.Connections = make(map[string]ConnectionBundle)
		}
		file.Connections[strings.TrimSpace(id)] = bundle
	})
}

func (s *Store) DeleteConnection(id string) error {
	return s.update(func(file *File) {
		deleteConnectionFromFile(file, id)
	})
}

// DeleteConnectionUnlocked deletes one connection bundle while the caller
// holds SharedStorageLockPath(s.root).
func (s *Store) DeleteConnectionUnlocked(id string) error {
	return s.updateUnlocked(func(file *File) {
		deleteConnectionFromFile(file, id)
	})
}

func deleteConnectionFromFile(file *File, id string) {
	if file == nil {
		return
	}
	if len(file.Connections) != 0 {
		delete(file.Connections, strings.TrimSpace(id))
	}
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
	return s.update(func(file *File) {
		if !bundle.HasAny() {
			file.GlobalProxy = nil
			return
		}
		copyBundle := bundle
		file.GlobalProxy = &copyBundle
	})
}

func (s *Store) DeleteGlobalProxy() error {
	return s.update(func(file *File) {
		file.GlobalProxy = nil
	})
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
	return s.update(func(file *File) {
		if !bundle.HasAny() {
			file.MCPHTTPServer = nil
			return
		}
		copyBundle := bundle
		file.MCPHTTPServer = &copyBundle
	})
}

func (s *Store) DeleteMCPHTTPServer() error {
	return s.update(func(file *File) {
		file.MCPHTTPServer = nil
	})
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
	return s.update(func(file *File) {
		if !bundle.HasAny() {
			deleteAIProviderFromFile(file, id)
			return
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
	})
}

func (s *Store) DeleteAIProvider(id string) error {
	return s.update(func(file *File) {
		deleteAIProviderFromFile(file, id)
	})
}

func deleteAIProviderFromFile(file *File, id string) {
	if file == nil {
		return
	}
	if len(file.AIProviders) != 0 {
		delete(file.AIProviders, strings.TrimSpace(id))
	}
}
