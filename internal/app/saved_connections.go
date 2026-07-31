package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dailysecret"
	"GoNavi-Wails/internal/secretstore"
	"github.com/google/uuid"
)

// savedConnectionsMu 串行化 connections.json 的「读取→修改→整体重写」序列。
//
// 必须是包级锁：savedConnectionRepository() 每次调用都返回一个新实例
// （methods_saved_connections.go:9-11），实例级锁起不到任何作用。
// Wails 每个前端调用都在独立 goroutine 中派发，因此批量导入连接包、Navicat 导入、
// web-server 多请求都会真并发进入这些写路径；无锁时后写者会用自己那份旧列表整体覆盖前写者，
// 导致已保存的连接静默丢失，或产生「有密码标记但密文已被删除」的僵尸连接。
//
// 注意不要把锁下沉进 load()/saveAll()：Save/Delete/Duplicate 内部都会调用它们，会造成重入死锁。
var savedConnectionsMu sync.Mutex

const (
	savedConnectionsFileName     = "connections.json"
	savedConnectionSecretKind    = "connection"
	defaultConnectionEnvironment = "local"
	maxSchemaVisibilityDatabases = 128
	maxSchemaVisibilitySchemas   = 256
	maxSchemaVisibilityNameBytes = 256
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
		strings.TrimSpace(b.OpaqueDSN) != ""
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

func cloneIntSlice(input []int) []int {
	if len(input) == 0 {
		return nil
	}
	cloned := make([]int, len(input))
	copy(cloned, input)
	return cloned
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

func sanitizeSchemaVisibilityByDatabase(input map[string]connection.SchemaVisibilityRule) map[string]connection.SchemaVisibilityRule {
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
		databaseKey := strings.ToLower(database)
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
			schemaKey := strings.ToLower(schema)
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
		ID:                         id,
		Name:                       strings.TrimSpace(input.Name),
		EnvironmentType:            normalizeConnectionEnvironmentType(input.EnvironmentType),
		Config:                     meta,
		IncludeDatabases:           cloneStringSlice(input.IncludeDatabases),
		IncludeRedisDatabases:      cloneIntSlice(input.IncludeRedisDatabases),
		SchemaVisibilityByDatabase: sanitizeSchemaVisibilityByDatabase(input.SchemaVisibilityByDatabase),
		IconType:                   strings.TrimSpace(input.IconType),
		IconColor:                  strings.TrimSpace(input.IconColor),
		HasPrimaryPassword:         strings.TrimSpace(bundle.Password) != "",
		HasSSHPassword:             strings.TrimSpace(bundle.SSHPassword) != "",
		HasProxyPassword:           strings.TrimSpace(bundle.ProxyPassword) != "",
		HasHTTPTunnelPassword:      strings.TrimSpace(bundle.HTTPTunnelPassword) != "",
		HasMySQLReplicaPassword:    strings.TrimSpace(bundle.MySQLReplicaPassword) != "",
		HasMongoReplicaPassword:    strings.TrimSpace(bundle.MongoReplicaPassword) != "",
		HasRedisSentinelPassword:   strings.TrimSpace(bundle.RedisSentinelPassword) != "",
		HasOpaqueURI:               strings.TrimSpace(bundle.OpaqueURI) != "",
		HasOpaqueDSN:               strings.TrimSpace(bundle.OpaqueDSN) != "",
	}
	return view, bundle
}

func (r *savedConnectionRepository) connectionsPath() string {
	return filepath.Join(r.configDir, savedConnectionsFileName)
}

func (r *savedConnectionRepository) dailySecrets() *dailysecret.Store {
	return dailysecret.NewStore(r.configDir)
}

func (r *savedConnectionRepository) load() ([]connection.SavedConnectionView, error) {
	data, err := os.ReadFile(r.connectionsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return []connection.SavedConnectionView{}, nil
		}
		return nil, err
	}

	var file savedConnectionsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, err
	}
	if file.Connections == nil {
		return []connection.SavedConnectionView{}, nil
	}
	for index := range file.Connections {
		file.Connections[index].EnvironmentType = normalizeConnectionEnvironmentType(
			file.Connections[index].EnvironmentType,
		)
	}
	return file.Connections, nil
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
	return writeSavedConnectionsFileAtomic(r.connectionsPath(), payload)
}

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

func (r *savedConnectionRepository) Save(input connection.SavedConnectionInput) (connection.SavedConnectionView, error) {
	savedConnectionsMu.Lock()
	defer savedConnectionsMu.Unlock()

	if strings.TrimSpace(input.ID) == "" && strings.TrimSpace(input.Config.ID) == "" {
		input.ID = "conn-" + uuid.New().String()[:8]
	}
	if strings.TrimSpace(input.ID) == "" {
		input.ID = strings.TrimSpace(input.Config.ID)
	}
	input.Config.ID = input.ID

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

func (r *savedConnectionRepository) saveSecretBundle(id string, bundle connectionSecretBundle) error {
	return r.dailySecrets().PutConnection(id, toDailyConnectionBundle(bundle))
}

func (r *savedConnectionRepository) deleteSecretBundle(id string) error {
	return r.dailySecrets().DeleteConnection(id)
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
		view.HasMySQLReplicaPassword || view.HasMongoReplicaPassword || view.HasRedisSentinelPassword || view.HasOpaqueURI || view.HasOpaqueDSN
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
	return r.load()
}

func (r *savedConnectionRepository) Delete(id string) error {
	savedConnectionsMu.Lock()
	defer savedConnectionsMu.Unlock()

	connections, err := r.load()
	if err != nil {
		return err
	}
	filtered := make([]connection.SavedConnectionView, 0, len(connections))
	for _, item := range connections {
		if item.ID == strings.TrimSpace(id) {
			if deleteErr := r.deleteSecretBundle(item.ID); deleteErr != nil {
				return deleteErr
			}
			continue
		}
		filtered = append(filtered, item)
	}
	return r.saveAll(filtered)
}

func (r *savedConnectionRepository) Duplicate(id string, unnamedName string, copySuffix string) (connection.SavedConnectionView, error) {
	savedConnectionsMu.Lock()
	defer savedConnectionsMu.Unlock()

	connections, err := r.load()
	if err != nil {
		return connection.SavedConnectionView{}, err
	}

	index := -1
	for i, item := range connections {
		if item.ID == strings.TrimSpace(id) {
			index = i
			break
		}
	}
	if index < 0 {
		return connection.SavedConnectionView{}, fmt.Errorf("saved connection not found: %s", id)
	}

	original := connections[index]
	duplicate := original
	duplicate.ID = "conn-" + uuid.New().String()[:8]
	duplicate.Config.ID = duplicate.ID
	duplicate.Name = buildDuplicateConnectionName(original.Name, connections, unnamedName, copySuffix)
	duplicate.SchemaVisibilityByDatabase = cloneSchemaVisibilityByDatabase(original.SchemaVisibilityByDatabase)

	bundle, err := r.loadSecretBundle(original)
	if err != nil {
		return connection.SavedConnectionView{}, err
	}
	if bundle.hasAny() {
		if storeErr := r.saveSecretBundle(duplicate.ID, bundle); storeErr != nil {
			return connection.SavedConnectionView{}, storeErr
		}
	}
	duplicate.SecretRef = ""
	applyConnectionBundleFlags(&duplicate, bundle)

	connections = append(connections, duplicate)
	if err := r.saveAll(connections); err != nil {
		return connection.SavedConnectionView{}, err
	}
	return duplicate, nil
}
