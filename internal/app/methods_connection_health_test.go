package app

import (
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type healthProbeDatabase struct {
	connectedConfig   connection.ConnectionConfig
	closed            int
	pingCalls         int
	queries           []string
	execCalls         int
	getDatabasesCalls int
	databaseNames     []string
	version           string
}

func (f *healthProbeDatabase) Connect(config connection.ConnectionConfig) error {
	f.connectedConfig = config
	return nil
}

func (f *healthProbeDatabase) Close() error { f.closed++; return nil }

func (f *healthProbeDatabase) Ping() error { f.pingCalls++; return nil }

func (f *healthProbeDatabase) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queries = append(f.queries, query)
	version := f.version
	if version == "" {
		version = "8.4.1"
	}
	return []map[string]interface{}{{"version": version}}, []string{"version"}, nil
}

func (f *healthProbeDatabase) Exec(string) (int64, error) { f.execCalls++; return 0, nil }

func (f *healthProbeDatabase) GetDatabases() ([]string, error) {
	f.getDatabasesCalls++
	return append([]string(nil), f.databaseNames...), nil
}

func (f *healthProbeDatabase) GetTables(string) ([]string, error) { return nil, nil }

func (f *healthProbeDatabase) GetCreateStatement(string, string) (string, error) { return "", nil }

func (f *healthProbeDatabase) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}

func (f *healthProbeDatabase) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}

func (f *healthProbeDatabase) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}

func (f *healthProbeDatabase) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}

func (f *healthProbeDatabase) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

var _ db.Database = (*healthProbeDatabase)(nil)

func TestSafeHealthVersionRejectsConnectionDetails(t *testing.T) {
	for _, value := range []string{
		"server password=correct-horse-battery-staple",
		"jdbc:mysql://health-user:correct-horse-battery-staple@db.internal.example:3306/app",
		"redis://:correct-horse-battery-staple@db.internal.example:6379",
	} {
		if got := safeHealthVersion(value); got != "" {
			t.Errorf("safeHealthVersion(%q) = %q, want empty", value, got)
		}
	}
	if got := safeHealthVersion("PostgreSQL 16.2"); got != "PostgreSQL 16.2" {
		t.Fatalf("safeHealthVersion() = %q, want version text", got)
	}
}

func TestInspectSavedConnectionHealthUsesIsolatedReadOnlyProbesAndRedactsReport(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	probeDB := &healthProbeDatabase{databaseNames: []string{"orders_private"}}
	newDatabaseFunc = func(string) (db.Database, error) { return probeDB, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "health-1",
		Name: "Production database",
		Config: connection.ConnectionConfig{
			ID:       "health-1",
			Type:     "mysql",
			Host:     "db.internal.example",
			Port:     3306,
			User:     "health-user",
			Password: "correct-horse-battery-staple",
			UseSSL:   true,
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	report := app.InspectSavedConnectionHealth("health-1")
	if report.ConnectionID != "health-1" || report.ConnectionName != "Production database" {
		t.Fatalf("unexpected report identity: %#v", report)
	}
	if report.OverallStatus != connection.ConnectionHealthStatusPassed {
		t.Fatalf("expected passing report, got %#v", report)
	}
	for _, key := range []string{
		connection.ConnectionHealthCheckPing,
		connection.ConnectionHealthCheckVersion,
		connection.ConnectionHealthCheckTLS,
		connection.ConnectionHealthCheckPermissions,
		connection.ConnectionHealthCheckSchemaVisibility,
		connection.ConnectionHealthCheckPagination,
		connection.ConnectionHealthCheckResponse,
	} {
		check, ok := findConnectionHealthCheck(report, key)
		if !ok {
			t.Fatalf("report is missing %q: %#v", key, report.Checks)
		}
		if check.Status != connection.ConnectionHealthStatusPassed {
			t.Fatalf("%s status = %q, want passed; report=%#v", key, check.Status, report)
		}
	}

	if probeDB.connectedConfig.Password != "correct-horse-battery-staple" {
		t.Fatalf("saved secret was not resolved for the isolated probe: %#v", probeDB.connectedConfig)
	}
	if probeDB.closed != 1 || probeDB.pingCalls != 1 || probeDB.getDatabasesCalls != 1 {
		t.Fatalf("unexpected isolated probe lifecycle: closed=%d ping=%d databases=%d", probeDB.closed, probeDB.pingCalls, probeDB.getDatabasesCalls)
	}
	if probeDB.execCalls != 0 {
		t.Fatalf("health probe must not execute writes; Exec calls=%d", probeDB.execCalls)
	}
	if len(probeDB.queries) != 1 || !strings.HasPrefix(strings.ToUpper(strings.TrimSpace(probeDB.queries[0])), "SELECT") {
		t.Fatalf("version probe must use one read-only SELECT, got %#v", probeDB.queries)
	}
	if len(app.dbCache) != 0 {
		t.Fatalf("health probe must not populate the shared DB cache: %#v", app.dbCache)
	}

	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	for _, forbidden := range []string{
		"correct-horse-battery-staple",
		"health-user",
		"db.internal.example",
		"orders_private",
	} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("health report leaked %q: %s", forbidden, encoded)
		}
	}
}

func TestInspectSavedConnectionHealthUsesIsolatedOptionalDriverAgentWithoutWrites(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	installFakeOptionalDriverRuntime(t)

	probeDB := &healthProbeDatabase{databaseNames: []string{"main"}}
	newDatabaseFunc = func(driverType string) (db.Database, error) {
		if driverType != "sqlite" {
			t.Fatalf("driver type = %q, want sqlite", driverType)
		}
		return probeDB, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "health-sqlite-agent",
		Name: "SQLite driver agent",
		Config: connection.ConnectionConfig{
			ID:     "health-sqlite-agent",
			Type:   "sqlite",
			Host:   "C:/private/orders.sqlite",
			UseSSL: true,
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	report := app.InspectSavedConnectionHealth("health-sqlite-agent")
	if check, ok := findConnectionHealthCheck(report, connection.ConnectionHealthCheckVersion); !ok || check.Status != connection.ConnectionHealthStatusPassed {
		t.Fatalf("optional driver agent version probe = %#v, want passed; report=%#v", check, report)
	}
	if probeDB.execCalls != 0 || len(probeDB.queries) != 1 {
		t.Fatalf("isolated optional driver agent must use one read-only query and no writes: queries=%#v exec=%d", probeDB.queries, probeDB.execCalls)
	}
	if probeDB.closed != 1 || len(app.dbCache) != 0 {
		t.Fatalf("optional driver agent probe must close its isolated connection and avoid the cache: closed=%d cache=%#v", probeDB.closed, app.dbCache)
	}
}

func TestInspectSavedConnectionsHealthDeduplicatesIDsAndKeepsMissingConnectionSafe(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	newDatabaseFunc = func(string) (db.Database, error) {
		return &healthProbeDatabase{databaseNames: []string{"visible"}}, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID: "batch-1", Name: "Batch one", Config: connection.ConnectionConfig{ID: "batch-1", Type: "mysql", Host: "127.0.0.1", UseSSL: true},
	})
	if err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	reports := app.InspectSavedConnectionsHealth([]string{"batch-1", "batch-1", "missing-connection"})
	if len(reports) != 2 {
		t.Fatalf("expected deduplicated batch reports, got %#v", reports)
	}
	if reports[0].ConnectionID != "batch-1" || reports[0].OverallStatus != connection.ConnectionHealthStatusPassed {
		t.Fatalf("unexpected saved connection report: %#v", reports[0])
	}
	if reports[1].ConnectionID != "missing-connection" || reports[1].OverallStatus != connection.ConnectionHealthStatusFailed {
		t.Fatalf("unexpected missing connection report: %#v", reports[1])
	}
	encoded, err := json.Marshal(reports[1])
	if err != nil {
		t.Fatalf("marshal missing report: %v", err)
	}
	if strings.Contains(strings.ToLower(string(encoded)), "saved connection not found") {
		t.Fatalf("missing connection report must not expose raw backend detail: %s", encoded)
	}
}

func findConnectionHealthCheck(report connection.ConnectionHealthReport, key string) (connection.ConnectionHealthCheck, bool) {
	for _, check := range report.Checks {
		if check.Key == key {
			return check, true
		}
	}
	return connection.ConnectionHealthCheck{}, false
}
