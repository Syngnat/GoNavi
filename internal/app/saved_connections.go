package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dailysecret"
	"GoNavi-Wails/internal/secretstore"
	"github.com/google/uuid"
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

func cloneStringSlice(input []string) []string {
	if len(input) == 0 {
		return nil
	}
	cloned := make([]string, len(input))
	copy(cloned, input)
	return cloned
}

func sanitizeIncludedDatabases(input []string) []string {
	if len(input) == 0 {
		return nil
	}

	result := make([]string, 0, min(len(input), maxIncludedDatabases))
	seen := make(map[string]struct{}, cap(result))
	for _, database := range input {
		if len(result) >= maxIncludedDatabases {
			break
		}
		database = strings.TrimSpace(database)
		if database == "" || len(database) > maxIncludedDatabaseNameBytes {
			continue
		}
		if _, exists := seen[database]; exists {
			continue
		}
		seen[database] = struct{}{}
		result = append(result, database)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func sanitizeDatabasePatterns(input []string) []string {
	if len(input) == 0 {
		return nil
	}

	result := make([]string, 0, len(input))
	seen := make(map[string]struct{}, cap(result))
	for _, pattern := range input {
		pattern = strings.TrimSpace(pattern)
		if pattern == "" {
			continue
		}
		if _, exists := seen[pattern]; exists {
			continue
		}
		seen[pattern] = struct{}{}
		result = append(result, pattern)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func validateDatabasePatterns(kind string, input []string) error {
	patterns := sanitizeDatabasePatterns(input)
	if len(patterns) > maxDatabaseFilterPatterns {
		return fmt.Errorf("too many database %s patterns: maximum is %d", kind, maxDatabaseFilterPatterns)
	}
	for _, pattern := range patterns {
		if len(pattern) > maxDatabaseFilterPatternBytes {
			return fmt.Errorf(
				"database %s pattern exceeds %d UTF-8 bytes",
				kind,
				maxDatabaseFilterPatternBytes,
			)
		}
	}
	return nil
}

func cloneIntSlice(input []int) []int {
	if len(input) == 0 {
		return nil
	}
	cloned := make([]int, len(input))
	copy(cloned, input)
	return cloned
}

func sanitizeIncludedRedisDatabases(input []int) []int {
	if len(input) == 0 {
		return nil
	}

	result := make([]int, 0, len(input))
	seen := make(map[int]struct{}, len(input))
	for _, database := range input {
		if database < 0 || int64(database) > maxRedisDatabaseIndex {
			continue
		}
		if _, exists := seen[database]; exists {
			continue
		}
		seen[database] = struct{}{}
		result = append(result, database)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func cloneSchemaVisibilityByDatabase(input map[string]connection.SchemaVisibilityRule) map[string]connection.SchemaVisibilityRule {
	if len(input) == 0 {
		return nil
	}
	cloned := make(map[string]connection.SchemaVisibilityRule, len(input))
	for database, rule := range input {
		cloned[database] = connection.SchemaVisibilityRule{
			Mode:    rule.Mode,
			Schemas: cloneStringSlice(rule.Schemas),
		}
	}
	return cloned
}

func schemaVisibilityIdentifiersCaseSensitive(config connection.ConnectionConfig) bool {
	driverType := strings.ToLower(strings.TrimSpace(config.Type))
	if driverType == "custom" {
		driverType = strings.ToLower(strings.TrimSpace(config.Driver))
	}
	switch driverType {
	case "postgres", "postgresql", "kingbase", "highgo", "vastbase", "opengauss", "open_gauss", "open-gauss", "gaussdb":
		return true
	default:
		return false
	}
}

func sanitizeSchemaVisibilityByDatabase(
	input map[string]connection.SchemaVisibilityRule,
	caseSensitive bool,
) map[string]connection.SchemaVisibilityRule {
	if len(input) == 0 {
		return nil
	}

	result := make(map[string]connection.SchemaVisibilityRule)
	seenDatabases := make(map[string]struct{})
	for database, rule := range input {
		if len(result) >= maxSchemaVisibilityDatabases {
			break
		}
		database = strings.TrimSpace(database)
		if database == "" || len(database) > maxSchemaVisibilityNameBytes {
			continue
		}
		databaseKey := database
		if !caseSensitive {
			databaseKey = strings.ToLower(database)
		}
		if _, exists := seenDatabases[databaseKey]; exists {
			continue
		}

		mode := strings.TrimSpace(rule.Mode)
		if mode != "include" && mode != "exclude" {
			continue
		}
		seenSchemas := make(map[string]struct{})
		schemas := make([]string, 0, min(len(rule.Schemas), maxSchemaVisibilitySchemas))
		for _, schema := range rule.Schemas {
			if len(schemas) >= maxSchemaVisibilitySchemas {
				break
			}
			schema = strings.TrimSpace(schema)
			if schema == "" || len(schema) > maxSchemaVisibilityNameBytes {
				continue
			}
			schemaKey := schema
			if !caseSensitive {
				schemaKey = strings.ToLower(schema)
			}
			if _, exists := seenSchemas[schemaKey]; exists {
				continue
			}
			seenSchemas[schemaKey] = struct{}{}
			schemas = append(schemas, schema)
		}
		if len(schemas) == 0 {
			continue
		}
		seenDatabases[databaseKey] = struct{}{}
		result[database] = connection.SchemaVisibilityRule{Mode: mode, Schemas: schemas}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func cloneStringMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(input))
	for key, value := range input {
		cloned[key] = value
	}
	return cloned
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

func (r *savedConnectionRepository) connectionsPath() string {
	return filepath.Join(r.configDir, savedConnectionsFileName)
}

func (r *savedConnectionRepository) dailySecrets() *dailysecret.Store {
	return dailysecret.NewStore(r.configDir)
}

func (r *savedConnectionRepository) withWriteLock(operation func() error) (resultErr error) {
	savedConnectionsMu.Lock()
	defer savedConnectionsMu.Unlock()
	if err := os.MkdirAll(r.configDir, 0o755); err != nil {
		return err
	}
	sharedLock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(r.configDir))
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, sharedLock.Close())
	}()
	fileLock, err := appdata.AcquireFileLock(r.connectionsPath() + ".lock")
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

type savedConnectionFilesSnapshot struct {
	connectionsExists bool
	connectionsData   []byte
	secretsExists     bool
	secretsData       []byte
}

func (r *savedConnectionRepository) captureFilesSnapshotUnlocked() (savedConnectionFilesSnapshot, error) {
	var snapshot savedConnectionFilesSnapshot
	connectionsData, connectionsExists, err := readOptionalFile(r.connectionsPath())
	if err != nil {
		return snapshot, err
	}
	secretsData, secretsExists, err := readOptionalFile(r.dailySecrets().Path())
	if err != nil {
		return snapshot, err
	}
	snapshot.connectionsExists = connectionsExists
	snapshot.connectionsData = connectionsData
	snapshot.secretsExists = secretsExists
	snapshot.secretsData = secretsData
	return snapshot, nil
}

func (snapshot savedConnectionFilesSnapshot) restoreUnlocked(r *savedConnectionRepository) error {
	var restoreErr error
	if err := r.dailySecrets().RestoreUnlocked(snapshot.secretsExists, snapshot.secretsData); err != nil {
		restoreErr = errors.Join(restoreErr, err)
	}
	if snapshot.connectionsExists {
		if err := writeSavedConnectionsFileAtomic(r.connectionsPath(), snapshot.connectionsData); err != nil {
			restoreErr = errors.Join(restoreErr, err)
		}
	} else if err := os.Remove(r.connectionsPath()); err != nil && !os.IsNotExist(err) {
		restoreErr = errors.Join(restoreErr, err)
	}
	return restoreErr
}

// withWriteTransaction keeps the metadata and daily-secret files coherent
// when a multi-file mutation reports an error. The shared cross-process lock
// remains held while both the mutation and any rollback are performed.
func (r *savedConnectionRepository) withWriteTransaction(operation func() error) error {
	return r.withWriteLock(func() error {
		snapshot, err := r.captureFilesSnapshotUnlocked()
		if err != nil {
			return err
		}
		if operation == nil {
			return nil
		}
		if err := operation(); err != nil {
			if restoreErr := snapshot.restoreUnlocked(r); restoreErr != nil {
				return errors.Join(err, fmt.Errorf("restore saved connection files: %w", restoreErr))
			}
			return err
		}
		return nil
	})
}

func (r *savedConnectionRepository) load() ([]connection.SavedConnectionView, error) {
	connections, _, err := r.loadWithLegacyCreatedAt()
	return connections, err
}

// loadWithLegacyCreatedAt preserves the display order of legacy connection
// files while reporting whether their derived timestamps need writing back.
func (r *savedConnectionRepository) loadWithLegacyCreatedAt() ([]connection.SavedConnectionView, bool, error) {
	data, err := os.ReadFile(r.connectionsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return []connection.SavedConnectionView{}, false, nil
		}
		return nil, false, err
	}

	var file savedConnectionsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, false, err
	}
	if file.Connections == nil {
		return []connection.SavedConnectionView{}, false, nil
	}
	// Legacy files predate CreatedAt. Derive a stable monotonic order from the
	// file timestamp so repeated restarts do not reshuffle old connections.
	legacyCreatedAt := int64(0)
	if info, statErr := os.Stat(r.connectionsPath()); statErr == nil {
		legacyCreatedAt = info.ModTime().UnixMilli()
	}
	legacyCreatedAtChanged := false
	for index := range file.Connections {
		if file.Connections[index].CreatedAt <= 0 && legacyCreatedAt > 0 {
			file.Connections[index].CreatedAt = legacyCreatedAt - int64(index)
			legacyCreatedAtChanged = true
		}
		file.Connections[index].EnvironmentType = normalizeConnectionEnvironmentType(
			file.Connections[index].EnvironmentType,
		)
		if err := validateDatabasePatterns("include", file.Connections[index].IncludeDatabasePatterns); err != nil {
			return nil, false, fmt.Errorf("invalid saved connection %q: %w", file.Connections[index].ID, err)
		}
		if err := validateDatabasePatterns("exclude", file.Connections[index].ExcludeDatabasePatterns); err != nil {
			return nil, false, fmt.Errorf("invalid saved connection %q: %w", file.Connections[index].ID, err)
		}
		file.Connections[index].IncludeDatabasePatterns = sanitizeDatabasePatterns(
			file.Connections[index].IncludeDatabasePatterns,
		)
		file.Connections[index].ExcludeDatabasePatterns = sanitizeDatabasePatterns(
			file.Connections[index].ExcludeDatabasePatterns,
		)
	}
	return file.Connections, legacyCreatedAtChanged, nil
}

func (r *savedConnectionRepository) saveAll(connections []connection.SavedConnectionView) error {
	if err := os.MkdirAll(r.configDir, 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(savedConnectionsFile{Connections: connections}, "", "  ")
	if err != nil {
		return err
	}
	// 原子替换而非 os.WriteFile：后者先把目标文件截断再写，进程在该窗口内被杀
	// （或并发读者恰好进入）会得到一个空的/半截的 connections.json，全部已保存连接一次性丢失。
	// 改成临时文件 + Sync + rename 后，读者要么看到旧文件、要么看到完整新文件，
	// 因此 List/Find 这类只读路径无需加锁。
	return writeSavedConnectionsFileAtomicFunc(r.connectionsPath(), payload)
}

var writeSavedConnectionsFileAtomicFunc = writeSavedConnectionsFileAtomic

// writeSavedConnectionsFileAtomic 以「临时文件 + Sync + 原子替换」写入 connections.json。
// 复用 replaceSavedQueryTempFile 的替换逻辑（其中包含 Windows 上 rename 失败的回退处理）。
func writeSavedConnectionsFileAtomic(targetPath string, payload []byte) error {
	dir := filepath.Dir(targetPath)
	temp, err := os.CreateTemp(dir, ".connections_*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()

	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	// 保持与原 os.WriteFile 相同的权限位，不在本次修复中顺带调整。
	if err := os.Chmod(tempPath, 0o644); err != nil {
		return err
	}
	if err := replaceSavedQueryTempFile(tempPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func prepareSavedConnectionInput(input connection.SavedConnectionInput) (connection.SavedConnectionInput, error) {
	if err := validateDatabasePatterns("include", input.IncludeDatabasePatterns); err != nil {
		return connection.SavedConnectionInput{}, err
	}
	if err := validateDatabasePatterns("exclude", input.ExcludeDatabasePatterns); err != nil {
		return connection.SavedConnectionInput{}, err
	}

	if strings.TrimSpace(input.ID) == "" && strings.TrimSpace(input.Config.ID) == "" {
		input.ID = "conn-" + uuid.New().String()[:8]
	}
	if strings.TrimSpace(input.ID) == "" {
		input.ID = strings.TrimSpace(input.Config.ID)
	}
	input.Config.ID = input.ID
	if input.CreatedAt <= 0 {
		input.CreatedAt = time.Now().UnixMilli()
	}
	return input, nil
}

// saveUnlocked persists one already-normalized connection while the caller
// holds withWriteLock. Keeping this operation separate lets a multi-item import
// retain the same cross-process lock across snapshot, every item, and rollback.
func (r *savedConnectionRepository) saveUnlocked(input connection.SavedConnectionInput) (connection.SavedConnectionView, error) {
	connections, err := r.load()
	if err != nil {
		return connection.SavedConnectionView{}, err
	}

	view, bundle := splitConnectionSecrets(input)
	index := -1
	var existing connection.SavedConnectionView
	for i, item := range connections {
		if item.ID == view.ID {
			index = i
			existing = item
			break
		}
	}

	mergedBundle := bundle
	if index >= 0 && savedConnectionViewHasSecrets(existing) {
		existingBundle, bundleErr := r.loadSecretBundle(existing)
		if bundleErr != nil {
			return connection.SavedConnectionView{}, bundleErr
		}
		mergedBundle = mergeConnectionSecretBundles(existingBundle, bundle)
	}
	mergedBundle = applyConnectionSecretClears(mergedBundle, input)

	if mergedBundle.hasAny() {
		if storeErr := r.saveSecretBundle(view.ID, mergedBundle); storeErr != nil {
			return connection.SavedConnectionView{}, storeErr
		}
	} else {
		if deleteErr := r.deleteSecretBundle(view.ID); deleteErr != nil {
			return connection.SavedConnectionView{}, deleteErr
		}
	}
	view.SecretRef = ""
	applyConnectionBundleFlags(&view, mergedBundle)

	if index >= 0 {
		connections[index] = view
	} else {
		connections = append(connections, view)
	}
	if err := r.saveAll(connections); err != nil {
		return connection.SavedConnectionView{}, err
	}
	return view, nil
}

func (r *savedConnectionRepository) Save(input connection.SavedConnectionInput) (connection.SavedConnectionView, error) {
	prepared, err := prepareSavedConnectionInput(input)
	if err != nil {
		return connection.SavedConnectionView{}, err
	}

	var saved connection.SavedConnectionView
	err = r.withWriteTransaction(func() error {
		var saveErr error
		saved, saveErr = r.saveUnlocked(prepared)
		return saveErr
	})
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	return saved, nil
}

func prepareConnectionVisibilityInput(input connection.ConnectionVisibilityInput) (connection.ConnectionVisibilityInput, error) {
	if err := validateDatabasePatterns("include", input.IncludeDatabasePatterns); err != nil {
		return connection.ConnectionVisibilityInput{}, err
	}
	if err := validateDatabasePatterns("exclude", input.ExcludeDatabasePatterns); err != nil {
		return connection.ConnectionVisibilityInput{}, err
	}

	input.ID = strings.TrimSpace(input.ID)
	input.IncludeDatabases = sanitizeIncludedDatabases(input.IncludeDatabases)
	input.IncludeDatabasePatterns = sanitizeDatabasePatterns(input.IncludeDatabasePatterns)
	input.ExcludeDatabasePatterns = sanitizeDatabasePatterns(input.ExcludeDatabasePatterns)
	input.IncludeRedisDatabases = sanitizeIncludedRedisDatabases(input.IncludeRedisDatabases)
	return input, nil
}

func (r *savedConnectionRepository) UpdateVisibility(input connection.ConnectionVisibilityInput) (connection.SavedConnectionView, error) {
	prepared, err := prepareConnectionVisibilityInput(input)
	if err != nil {
		return connection.SavedConnectionView{}, err
	}

	var updated connection.SavedConnectionView
	err = r.withWriteLock(func() error {
		connections, loadErr := r.load()
		if loadErr != nil {
			return loadErr
		}
		for index := range connections {
			if connections[index].ID != prepared.ID {
				continue
			}
			connections[index].IncludeDatabases = prepared.IncludeDatabases
			connections[index].IncludeDatabasePatterns = prepared.IncludeDatabasePatterns
			connections[index].ExcludeDatabasePatterns = prepared.ExcludeDatabasePatterns
			connections[index].IncludeRedisDatabases = prepared.IncludeRedisDatabases
			connections[index].SchemaVisibilityByDatabase = sanitizeSchemaVisibilityByDatabase(
				prepared.SchemaVisibilityByDatabase,
				schemaVisibilityIdentifiersCaseSensitive(connections[index].Config),
			)
			if saveErr := r.saveAll(connections); saveErr != nil {
				return saveErr
			}
			updated = connections[index]
			return nil
		}
		return fmt.Errorf("saved connection not found: %s", prepared.ID)
	})
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	return updated, nil
}

func (r *savedConnectionRepository) Find(id string) (connection.SavedConnectionView, error) {
	connections, err := r.load()
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	for _, item := range connections {
		if item.ID == strings.TrimSpace(id) {
			return item, nil
		}
	}
	return connection.SavedConnectionView{}, fmt.Errorf("saved connection not found: %s", id)
}

// loadConnectionSnapshot reads one saved connection and its daily-secret
// bundle while holding the same cross-process lock used by writers. This is
// the only read path that may return both files' contents as one execution
// snapshot.
func (r *savedConnectionRepository) loadConnectionSnapshot(id string) (connection.SavedConnectionView, connectionSecretBundle, error) {
	var view connection.SavedConnectionView
	var bundle connectionSecretBundle
	err := r.withWriteLock(func() error {
		connections, err := r.load()
		if err != nil {
			return err
		}
		connectionID := strings.TrimSpace(id)
		for _, item := range connections {
			if item.ID != connectionID {
				continue
			}
			view = item
			bundle, err = r.loadSecretBundle(item)
			return err
		}
		return fmt.Errorf("saved connection not found: %s", id)
	})
	if err != nil {
		return view, bundle, err
	}
	return view, bundle, nil
}

func (r *savedConnectionRepository) saveSecretBundle(id string, bundle connectionSecretBundle) error {
	return r.dailySecrets().PutConnectionUnlocked(id, toDailyConnectionBundle(bundle))
}

func (r *savedConnectionRepository) deleteSecretBundle(id string) error {
	return r.dailySecrets().DeleteConnectionUnlocked(id)
}

func (r *savedConnectionRepository) storeSecretBundle(id string, existingRef string, bundle connectionSecretBundle) (string, error) {
	if r.secretStore == nil {
		return "", fmt.Errorf("secret store unavailable")
	}
	if err := r.secretStore.HealthCheck(); err != nil {
		return "", err
	}
	ref := strings.TrimSpace(existingRef)
	if ref == "" {
		var err error
		ref, err = secretstore.BuildRef(savedConnectionSecretKind, id)
		if err != nil {
			return "", err
		}
	}
	payload, err := json.Marshal(bundle)
	if err != nil {
		return "", err
	}
	if err := r.secretStore.Put(ref, payload); err != nil {
		return "", err
	}
	return ref, nil
}

func (r *savedConnectionRepository) loadSecretBundle(view connection.SavedConnectionView) (connectionSecretBundle, error) {
	inline := extractConnectionSecretBundle(view.Config)
	if inline.hasAny() {
		return inline, nil
	}
	if !savedConnectionViewHasSecrets(view) {
		return connectionSecretBundle{}, nil
	}
	bundle, ok, err := r.dailySecrets().GetConnection(view.ID)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	if ok {
		return fromDailyConnectionBundle(bundle), nil
	}
	return connectionSecretBundle{}, os.ErrNotExist
}

func (r *savedConnectionRepository) loadSecretBundleFromStore(view connection.SavedConnectionView) (connectionSecretBundle, error) {
	if r.secretStore == nil {
		return connectionSecretBundle{}, fmt.Errorf("secret store unavailable")
	}
	ref := strings.TrimSpace(view.SecretRef)
	if ref == "" {
		var err error
		ref, err = secretstore.BuildRef(savedConnectionSecretKind, view.ID)
		if err != nil {
			return connectionSecretBundle{}, err
		}
	}
	payload, err := r.secretStore.Get(ref)
	if err != nil {
		return connectionSecretBundle{}, err
	}
	var bundle connectionSecretBundle
	if err := json.Unmarshal(payload, &bundle); err != nil {
		return connectionSecretBundle{}, err
	}
	return bundle, nil
}

func savedConnectionViewHasSecrets(view connection.SavedConnectionView) bool {
	return view.HasPrimaryPassword || view.HasSSHPassword || view.HasProxyPassword || view.HasHTTPTunnelPassword ||
		view.HasMySQLReplicaPassword || view.HasMongoReplicaPassword || view.HasRedisSentinelPassword || view.HasOpaqueURI || view.HasOpaqueDSN ||
		view.HasJVMJMXPassword || view.HasJVMEndpointAPIKey || view.HasJVMAgentAPIKey || view.HasJVMDiagnosticAPIKey || view.HasSensitiveParams
}

func applyConnectionBundleFlags(view *connection.SavedConnectionView, bundle connectionSecretBundle) {
	view.HasPrimaryPassword = strings.TrimSpace(bundle.Password) != ""
	view.HasSSHPassword = strings.TrimSpace(bundle.SSHPassword) != ""
	view.HasProxyPassword = strings.TrimSpace(bundle.ProxyPassword) != ""
	view.HasHTTPTunnelPassword = strings.TrimSpace(bundle.HTTPTunnelPassword) != ""
	view.HasMySQLReplicaPassword = strings.TrimSpace(bundle.MySQLReplicaPassword) != ""
	view.HasMongoReplicaPassword = strings.TrimSpace(bundle.MongoReplicaPassword) != ""
	view.HasRedisSentinelPassword = strings.TrimSpace(bundle.RedisSentinelPassword) != ""
	view.HasOpaqueURI = strings.TrimSpace(bundle.OpaqueURI) != ""
	view.HasOpaqueDSN = strings.TrimSpace(bundle.OpaqueDSN) != ""
	view.HasJVMJMXPassword = strings.TrimSpace(bundle.JVMJMXPassword) != ""
	view.HasJVMEndpointAPIKey = strings.TrimSpace(bundle.JVMEndpointAPIKey) != ""
	view.HasJVMAgentAPIKey = strings.TrimSpace(bundle.JVMAgentAPIKey) != ""
	view.HasJVMDiagnosticAPIKey = strings.TrimSpace(bundle.JVMDiagnosticAPIKey) != ""
	view.HasSensitiveParams = strings.TrimSpace(bundle.SensitiveParams) != ""
}

func buildDuplicateConnectionName(baseName string, existing []connection.SavedConnectionView, unnamedName string, copySuffix string) string {
	trimmedBaseName := strings.TrimSpace(baseName)
	if trimmedBaseName == "" {
		trimmedBaseName = strings.TrimSpace(unnamedName)
	}
	if trimmedBaseName == "" {
		trimmedBaseName = "Unnamed Connection"
	}
	suffix := copySuffix
	if strings.TrimSpace(suffix) == "" {
		suffix = " - Copy"
	}
	usedNames := make(map[string]struct{}, len(existing))
	for _, item := range existing {
		usedNames[strings.TrimSpace(item.Name)] = struct{}{}
	}
	candidate := trimmedBaseName + suffix
	counter := 2
	for {
		if _, exists := usedNames[candidate]; !exists {
			return candidate
		}
		candidate = fmt.Sprintf("%s%s %d", trimmedBaseName, suffix, counter)
		counter++
	}
}

func (r *savedConnectionRepository) List() ([]connection.SavedConnectionView, error) {
	// load derives stable timestamps for legacy records in memory. Do not try
	// to persist that normalization here: List is also called while callers
	// hold the repository write lock (for example during cloud restore), and
	// the lock is deliberately non-reentrant.
	return r.load()
}

// MigrateLegacyCreatedAt persists timestamps derived for older connection
// files. It is deliberately explicit so callers that already hold the
// non-reentrant repository lock can keep using List safely.
func (r *savedConnectionRepository) MigrateLegacyCreatedAt() error {
	return r.withWriteTransaction(func() error {
		connections, changed, err := r.loadWithLegacyCreatedAt()
		if err != nil || !changed {
			return err
		}
		return r.saveAll(connections)
	})
}

func (r *savedConnectionRepository) Delete(id string) error {
	return r.DeleteMany([]string{id})
}

// DeleteMany removes all requested connections in one metadata/credential
// transaction. A failed credential or metadata write restores both files.
func (r *savedConnectionRepository) DeleteMany(ids []string) error {
	targets := make(map[string]struct{}, len(ids))
	for _, rawID := range ids {
		if id := strings.TrimSpace(rawID); id != "" {
			targets[id] = struct{}{}
		}
	}
	if len(targets) == 0 {
		return nil
	}
	return r.withWriteTransaction(func() error {
		connections, err := r.load()
		if err != nil {
			return err
		}
		filtered := make([]connection.SavedConnectionView, 0, len(connections))
		for _, item := range connections {
			if _, remove := targets[item.ID]; remove {
				if deleteErr := r.deleteSecretBundle(item.ID); deleteErr != nil {
					return deleteErr
				}
				continue
			}
			filtered = append(filtered, item)
		}
		return r.saveAll(filtered)
	})
}

func (r *savedConnectionRepository) Duplicate(id string, unnamedName string, copySuffix string) (connection.SavedConnectionView, error) {
	var saved connection.SavedConnectionView
	err := r.withWriteTransaction(func() error {
		connections, err := r.load()
		if err != nil {
			return err
		}

		index := -1
		for i, item := range connections {
			if item.ID == strings.TrimSpace(id) {
				index = i
				break
			}
		}
		if index < 0 {
			return fmt.Errorf("saved connection not found: %s", id)
		}

		original := connections[index]
		duplicate := original
		duplicate.ID = "conn-" + uuid.New().String()[:8]
		duplicate.CreatedAt = time.Now().UnixMilli()
		duplicate.Config.ID = duplicate.ID
		duplicate.Name = buildDuplicateConnectionName(original.Name, connections, unnamedName, copySuffix)
		duplicate.IncludeDatabasePatterns = cloneStringSlice(original.IncludeDatabasePatterns)
		duplicate.ExcludeDatabasePatterns = cloneStringSlice(original.ExcludeDatabasePatterns)
		duplicate.SchemaVisibilityByDatabase = cloneSchemaVisibilityByDatabase(original.SchemaVisibilityByDatabase)

		bundle, err := r.loadSecretBundle(original)
		if err != nil {
			return err
		}
		if bundle.hasAny() {
			if storeErr := r.saveSecretBundle(duplicate.ID, bundle); storeErr != nil {
				return storeErr
			}
		}
		duplicate.SecretRef = ""
		applyConnectionBundleFlags(&duplicate, bundle)

		connections = append(connections, duplicate)
		if err := r.saveAll(connections); err != nil {
			return err
		}
		saved = duplicate
		return nil
	})
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	return saved, nil
}
