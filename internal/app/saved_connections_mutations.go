package app

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"

	"github.com/google/uuid"
)

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
