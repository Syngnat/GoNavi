package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

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

func TestSafeHealthVersionOnlyReturnsRecognizedVersionText(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  string
	}{
		{name: "plain semantic version", value: "8.4.1", want: "8.4.1"},
		{name: "postgres version with server suffix", value: "PostgreSQL 16.2 on db.internal.example", want: "PostgreSQL 16.2"},
		{name: "sql server banner", value: "Microsoft SQL Server 2022 (RTM-CU14) - 16.0.4145.4 (X64)", want: "Microsoft SQL Server 16.0.4145.4"},
		{name: "oracle banner", value: "Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production", want: "Oracle Database 19.0.0.0.0"},
		{name: "credential", value: "server password=correct-horse-battery-staple", want: ""},
		{name: "connection string", value: "jdbc:mysql://health-user:correct-horse-battery-staple@db.internal.example:3306/app", want: ""},
		{name: "bare ipv4 endpoint", value: "203.0.113.10", want: ""},
		{name: "hostname", value: "db.internal.example", want: ""},
		{name: "unrecognized server text", value: "custom database build 42 on orders-private", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := safeHealthVersion(tt.value); got != tt.want {
				t.Fatalf("safeHealthVersion(%q) = %q, want %q", tt.value, got, tt.want)
			}
		})
	}
}

func TestFirstHealthRowValueOnlyReadsVersionColumn(t *testing.T) {
	rows := []map[string]interface{}{{
		"endpoint": "db.internal.example",
		"version":  "PostgreSQL 16.2",
	}}
	if got := firstHealthRowValue(rows); got != "PostgreSQL 16.2" {
		t.Fatalf("firstHealthRowValue() = %q, want version column", got)
	}

	if got := firstHealthRowValue([]map[string]interface{}{{"endpoint": "db.internal.example"}}); got != "" {
		t.Fatalf("firstHealthRowValue() = %q, want empty without a version column", got)
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

func TestInspectSavedConnectionHealthResolvesSavedCustomDSNBeforeValidation(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	installFakeOptionalDriverRuntime(t)

	probeDB := &healthProbeDatabase{databaseNames: []string{"main"}}
	newDatabaseFunc = func(driverType string) (db.Database, error) {
		if driverType != "custom" {
			t.Fatalf("driver type = %q, want custom", driverType)
		}
		return probeDB, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	const (
		connectionID = "health-custom-saved-dsn"
		dsn          = "postgres://health-user:health-secret@db.internal.example:5432/app"
	)
	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   connectionID,
		Name: "Custom saved DSN",
		Config: connection.ConnectionConfig{
			ID:     connectionID,
			Type:   "custom",
			Driver: "postgres",
			DSN:    dsn,
			UseSSL: true,
		},
	}); err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	report := app.InspectSavedConnectionHealth(connectionID)
	if report.OverallStatus != connection.ConnectionHealthStatusPassed {
		t.Fatalf("overall status = %q, want passed; report=%#v", report.OverallStatus, report)
	}
	if probeDB.connectedConfig.DSN != dsn {
		t.Fatalf("probe DSN = %q, want saved DSN", probeDB.connectedConfig.DSN)
	}

	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	for _, forbidden := range []string{"health-user", "health-secret", "db.internal.example", dsn} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("report leaked %q: %s", forbidden, encoded)
		}
	}
}

func TestInspectSavedConnectionHealthPreflightsOrdinaryCustomDriverAsCustom(t *testing.T) {
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	var checkedDriverTypes []string
	driverRuntimeSupportStatusFunc = func(driverType string) (bool, string) {
		checkedDriverTypes = append(checkedDriverTypes, driverType)
		switch driverType {
		case "custom":
			return true, ""
		case "sqlite":
			return false, "optional sqlite driver disabled"
		default:
			t.Fatalf("unexpected driver preflight type = %q", driverType)
			return false, ""
		}
	}

	probeDB := &healthProbeDatabase{databaseNames: []string{"main"}}
	newDatabaseFunc = func(driverType string) (db.Database, error) {
		if driverType != "custom" {
			t.Fatalf("newDatabaseFunc driver type = %q, want custom", driverType)
		}
		return probeDB, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	const connectionID = "health-custom-sqlite-driver"
	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   connectionID,
		Name: "Custom SQLite fixture",
		Config: connection.ConnectionConfig{
			ID:     connectionID,
			Type:   "custom",
			Driver: "sqlite",
			DSN:    ":memory:",
			UseSSL: true,
		},
	}); err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	report := app.InspectSavedConnectionHealth(connectionID)
	if report.OverallStatus != connection.ConnectionHealthStatusPassed {
		t.Fatalf("overall status = %q, want passed; report=%#v", report.OverallStatus, report)
	}
	if len(checkedDriverTypes) == 0 {
		t.Fatal("driver preflight was not called")
	}
	for _, driverType := range checkedDriverTypes {
		if driverType != "custom" {
			t.Fatalf("driver preflight calls = %#v, want only custom", checkedDriverTypes)
		}
	}
	if probeDB.connectedConfig.Type != "custom" || probeDB.connectedConfig.Driver != "sqlite" || probeDB.connectedConfig.DSN != ":memory:" {
		t.Fatalf("custom driver config = %#v, want type=custom driver=sqlite dsn=:memory:", probeDB.connectedConfig)
	}
}

func TestInspectSavedConnectionHealthRejectsIncompleteCustomConfigurationWithoutLeakingDetails(t *testing.T) {
	tests := []struct {
		name      string
		id        string
		config    connection.ConnectionConfig
		forbidden []string
	}{
		{
			name: "missing driver",
			id:   "health-custom-missing-driver",
			config: connection.ConnectionConfig{
				ID:   "health-custom-missing-driver",
				Type: "custom",
				DSN:  "postgres://health-user:health-secret@db.example/app",
			},
			forbidden: []string{"health-secret", "db.example"},
		},
		{
			name: "missing dsn",
			id:   "health-custom-missing-dsn",
			config: connection.ConnectionConfig{
				ID:     "health-custom-missing-dsn",
				Type:   "custom",
				Driver: "postgres",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			app := NewAppWithSecretStore(newFakeAppSecretStore())
			app.configDir = t.TempDir()
			if _, err := app.SaveConnection(connection.SavedConnectionInput{
				ID:     tt.id,
				Name:   "Custom health fixture",
				Config: tt.config,
			}); err != nil {
				t.Fatalf("SaveConnection() error = %v", err)
			}

			report := app.InspectSavedConnectionHealth(tt.id)
			if report.OverallStatus != connection.ConnectionHealthStatusFailed {
				t.Fatalf("overall status = %q, want failed; report=%#v", report.OverallStatus, report)
			}
			check, ok := findConnectionHealthCheck(report, connection.ConnectionHealthCheckPing)
			if !ok {
				t.Fatalf("missing ping check: %#v", report)
			}
			if check.Recommendation != "connection_configuration_invalid" {
				t.Fatalf("ping recommendation = %q, want connection_configuration_invalid; report=%#v", check.Recommendation, report)
			}

			encoded, err := json.Marshal(report)
			if err != nil {
				t.Fatalf("marshal report: %v", err)
			}
			for _, forbidden := range tt.forbidden {
				if strings.Contains(string(encoded), forbidden) {
					t.Fatalf("report leaked %q: %s", forbidden, encoded)
				}
			}
		})
	}
}

func TestInspectSavedConnectionHealthShortCircuitsUnavailableDriverBeforeConstruction(t *testing.T) {
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		newDatabaseFunc = originalNewDatabaseFunc
	})

	driverRuntimeSupportStatusFunc = func(string) (bool, string) {
		return false, "optional driver disabled: do-not-leak-this-detail"
	}
	newDatabaseCalls := 0
	newDatabaseFunc = func(string) (db.Database, error) {
		newDatabaseCalls++
		return nil, fmt.Errorf("newDatabaseFunc must not be called")
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	const connectionID = "health-unavailable-driver"
	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   connectionID,
		Name: "Unavailable driver fixture",
		Config: connection.ConnectionConfig{
			ID:     connectionID,
			Type:   "mysql",
			Host:   "db.example",
			UseSSL: true,
		},
	}); err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	report := app.InspectSavedConnectionHealth(connectionID)
	if report.OverallStatus != connection.ConnectionHealthStatusFailed {
		t.Fatalf("overall status = %q, want failed; report=%#v", report.OverallStatus, report)
	}
	check, ok := findConnectionHealthCheck(report, connection.ConnectionHealthCheckDriver)
	if !ok {
		t.Fatalf("missing driver check: %#v", report)
	}
	if check.Recommendation != "driver_unavailable" {
		t.Fatalf("driver recommendation = %q, want driver_unavailable; report=%#v", check.Recommendation, report)
	}
	if newDatabaseCalls != 0 {
		t.Fatalf("newDatabaseFunc calls = %d, want 0", newDatabaseCalls)
	}

	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	if strings.Contains(string(encoded), "do-not-leak-this-detail") {
		t.Fatalf("report leaked driver runtime detail: %s", encoded)
	}
}

func TestInspectSavedConnectionHealthPreflightsCustomClickHouseRuntimeDriver(t *testing.T) {
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		newDatabaseFunc = originalNewDatabaseFunc
	})

	var checkedDriverTypes []string
	driverRuntimeSupportStatusFunc = func(driverType string) (bool, string) {
		checkedDriverTypes = append(checkedDriverTypes, driverType)
		if driverType != "clickhouse" {
			t.Fatalf("driver preflight type = %q, want clickhouse", driverType)
		}
		return false, "optional driver disabled: do-not-leak-this-detail"
	}
	newDatabaseFunc = func(string) (db.Database, error) {
		t.Fatal("newDatabaseFunc must not be called when the ClickHouse runtime driver is unavailable")
		return nil, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	const connectionID = "health-custom-clickhouse-driver"
	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   connectionID,
		Name: "Custom ClickHouse fixture",
		Config: connection.ConnectionConfig{
			ID:     connectionID,
			Type:   "custom",
			Driver: "clickhouse",
			DSN:    "clickhouse://health-user:health-secret@clickhouse.internal.example:9000/analytics",
		},
	}); err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	report := app.InspectSavedConnectionHealth(connectionID)
	if report.OverallStatus != connection.ConnectionHealthStatusFailed {
		t.Fatalf("overall status = %q, want failed; report=%#v", report.OverallStatus, report)
	}
	if len(checkedDriverTypes) != 1 || checkedDriverTypes[0] != "clickhouse" {
		t.Fatalf("driver preflight calls = %#v, want [clickhouse]", checkedDriverTypes)
	}
	check, ok := findConnectionHealthCheck(report, connection.ConnectionHealthCheckDriver)
	if !ok || check.Recommendation != "driver_unavailable" {
		t.Fatalf("driver preflight report = %#v, want driver_unavailable driver recommendation", report)
	}
}

func TestFinalizeConnectionHealthReportKeepsAllUnsupportedAsUnsupported(t *testing.T) {
	report := finalizeConnectionHealthReport(connection.ConnectionHealthReport{}, time.Now(), []connection.ConnectionHealthCheck{
		unsupportedHealthCheck(connection.ConnectionHealthCheckVersion, "not_available"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckPagination, "not_applicable"),
	})
	if report.OverallStatus != connection.ConnectionHealthStatusUnsupported {
		t.Fatalf("overall status = %q, want unsupported; report=%#v", report.OverallStatus, report)
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
