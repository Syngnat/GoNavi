package app

import (
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type customClickHouseRecordingDB struct {
	fakeStartupRetryDB
	closeCalls int
}

func (d *customClickHouseRecordingDB) Close() error {
	d.closeCalls++
	return nil
}

func TestResolveEffectiveConnectionConfigCanonicalizesCustomClickHouseJDBCDSN(t *testing.T) {
	a := NewApp()
	proxy := connection.ProxyConfig{
		Type: "socks5",
		Host: "proxy.internal",
		Port: 1080,
	}
	raw := connection.ConnectionConfig{
		Type:               "custom",
		Driver:             " ClickHouse ",
		DSN:                "jdbc:clickhouse://alice:p%40ss@[2001:db8::1]:8443/analytics?compress=lz4&ssl=true",
		Host:               "stale.example.com",
		Port:               3306,
		User:               "stale-user",
		Password:           "stale-password",
		Database:           "stale-database",
		URI:                "mysql://stale.example.com:3306/stale-database",
		ConnectionParams:   "stale=true",
		ClickHouseProtocol: "native",
		Hosts:              []string{"stale-replica.example.com:3306"},
		Topology:           "replica",
		SSLCAPath:          "stale-ca.pem",
		SSLCertPath:        "stale-cert.pem",
		SSLKeyPath:         "stale-key.pem",
		Timeout:            42,
		UseProxy:           true,
		Proxy:              proxy,
	}

	got, err := a.resolveEffectiveConnectionConfig(raw)
	if err != nil {
		t.Fatalf("resolveEffectiveConnectionConfig returned error: %v", err)
	}
	if got.Type != "clickhouse" {
		t.Fatalf("expected runtime type clickhouse, got %q", got.Type)
	}
	if got.Driver != "" || got.DSN != "" {
		t.Fatalf("expected custom driver fields to be removed from runtime config, got driver=%q dsn=%q", got.Driver, got.DSN)
	}
	if got.URI != "" {
		t.Fatalf("expected runtime URI to be cleared after extracting fields, got %q", got.URI)
	}
	if got.Host != "2001:db8::1" || got.Port != 8443 {
		t.Fatalf("unexpected endpoint: host=%q port=%d", got.Host, got.Port)
	}
	if got.User != "alice" || got.Password != "p@ss" || got.Database != "analytics" {
		t.Fatalf("unexpected credentials/database mapping: user=%q password=%q database=%q", got.User, got.Password, got.Database)
	}
	if got.ClickHouseProtocol != "http" {
		t.Fatalf("expected JDBC DSN to force HTTP even on a non-standard port, got %q", got.ClickHouseProtocol)
	}
	if !got.UseSSL || got.SSLMode != "required" {
		t.Fatalf("expected ssl=true to enable required TLS, got useSSL=%v sslMode=%q", got.UseSSL, got.SSLMode)
	}
	if got.SSLCAPath != "" || got.SSLCertPath != "" || got.SSLKeyPath != "" {
		t.Fatalf("expected hidden stale TLS paths to be cleared, got ca=%q cert=%q key=%q", got.SSLCAPath, got.SSLCertPath, got.SSLKeyPath)
	}
	if got.ConnectionParams != "compress=lz4" {
		t.Fatalf("expected non-connection query params to be preserved, got %q", got.ConnectionParams)
	}
	if len(got.Hosts) != 0 || got.Topology != "" {
		t.Fatalf("expected stale topology fields to be cleared, got hosts=%v topology=%q", got.Hosts, got.Topology)
	}
	if got.Timeout != 42 || !got.UseProxy || !reflect.DeepEqual(got.Proxy, proxy) {
		t.Fatalf("expected runtime-neutral settings to be preserved, got %+v", got)
	}
}

func TestResolveEffectiveConnectionConfigAcceptsOfficialClickHouseJDBCHTTPSAlias(t *testing.T) {
	a := NewApp()
	raw := connection.ConnectionConfig{
		Type:   "custom",
		Driver: "clickhouse",
		DSN:    "jdbc:ch:https://reporter:secret@clickhouse.example.com:8443/default?skip_verify=true&max_open_conns=8",
	}

	got, err := a.resolveEffectiveConnectionConfig(raw)
	if err != nil {
		t.Fatalf("resolveEffectiveConnectionConfig returned error: %v", err)
	}
	if got.URI != "" {
		t.Fatalf("expected runtime URI to be cleared, got %q", got.URI)
	}
	if got.ClickHouseProtocol != "http" {
		t.Fatalf("expected HTTPS JDBC alias to select HTTP protocol, got %q", got.ClickHouseProtocol)
	}
	if !got.UseSSL || got.SSLMode != "skip-verify" {
		t.Fatalf("expected HTTPS skip_verify mapping, got useSSL=%v sslMode=%q", got.UseSSL, got.SSLMode)
	}
	if got.ConnectionParams != "max_open_conns=8" {
		t.Fatalf("unexpected connection params: %q", got.ConnectionParams)
	}
}

func TestResolveEffectiveConnectionConfigUsesJDBCHTTPDefaultsAndQueryOverrides(t *testing.T) {
	tests := []struct {
		name    string
		dsn     string
		port    int
		useSSL  bool
		sslMode string
	}{
		{
			name: "plain JDBC defaults to HTTP 8123",
			dsn:  "jdbc:clickhouse://url-user:url-pass@clickhouse.example.com/path_db?user=query-user&password=query%40pass&database=query_db",
			port: 8123,
		},
		{
			name: "explicit non-standard port remains HTTP",
			dsn:  "jdbc:ch://clickhouse.example.com:9000/default",
			port: 9000,
		},
		{
			name:    "HTTPS alias defaults to 8443",
			dsn:     "jdbc:clickhouse:https://clickhouse.example.com/default",
			port:    8443,
			useSSL:  true,
			sslMode: "required",
		},
		{
			name:    "HTTPS protocol parameter cannot downgrade to plaintext",
			dsn:     "jdbc:clickhouse://clickhouse.example.com/default?protocol=https",
			port:    8443,
			useSSL:  true,
			sslMode: "required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := NewApp()
			got, err := a.resolveEffectiveConnectionConfig(connection.ConnectionConfig{
				Type:   "custom",
				Driver: "clickhouse",
				DSN:    tt.dsn,
			})
			if err != nil {
				t.Fatalf("resolveEffectiveConnectionConfig returned error: %v", err)
			}
			if got.Host != "clickhouse.example.com" || got.Port != tt.port {
				t.Fatalf("unexpected endpoint: host=%q port=%d", got.Host, got.Port)
			}
			if got.ClickHouseProtocol != "http" {
				t.Fatalf("expected JDBC protocol HTTP, got %q", got.ClickHouseProtocol)
			}
			if got.UseSSL != tt.useSSL || got.SSLMode != tt.sslMode {
				t.Fatalf("unexpected TLS mapping: useSSL=%v sslMode=%q", got.UseSSL, got.SSLMode)
			}
			if tt.name == "plain JDBC defaults to HTTP 8123" {
				if got.User != "query-user" || got.Password != "query@pass" || got.Database != "query_db" {
					t.Fatalf("expected query properties to override URL credentials/database, got user=%q password=%q database=%q", got.User, got.Password, got.Database)
				}
				if got.ConnectionParams != "" {
					t.Fatalf("expected connection-only query properties to be removed, got %q", got.ConnectionParams)
				}
			}
		})
	}
}

func TestResolveEffectiveConnectionConfigSupportsNativeAndHTTPClickHouseDSN(t *testing.T) {
	tests := []struct {
		name     string
		dsn      string
		port     int
		protocol string
		useSSL   bool
		sslMode  string
	}{
		{name: "native", dsn: "clickhouse://clickhouse.example.com/analytics", port: 9000},
		{name: "native HTTP port inference", dsn: "clickhouse://clickhouse.example.com:8123/analytics", port: 8123, protocol: "http"},
		{name: "HTTP", dsn: "http://clickhouse.example.com/analytics", port: 8123, protocol: "http"},
		{name: "HTTPS", dsn: "https://clickhouse.example.com/analytics", port: 8443, protocol: "http", useSSL: true, sslMode: "required"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := NewApp()
			got, err := a.resolveEffectiveConnectionConfig(connection.ConnectionConfig{
				Type:   "custom",
				Driver: "clickhouse",
				DSN:    tt.dsn,
			})
			if err != nil {
				t.Fatalf("resolveEffectiveConnectionConfig returned error: %v", err)
			}
			if got.Host != "clickhouse.example.com" || got.Port != tt.port || got.Database != "analytics" {
				t.Fatalf("unexpected endpoint mapping: host=%q port=%d database=%q", got.Host, got.Port, got.Database)
			}
			if got.ClickHouseProtocol != tt.protocol || got.UseSSL != tt.useSSL || got.SSLMode != tt.sslMode {
				t.Fatalf("unexpected protocol/TLS mapping: protocol=%q useSSL=%v sslMode=%q", got.ClickHouseProtocol, got.UseSSL, got.SSLMode)
			}
		})
	}
}

func TestResolveEffectiveConnectionConfigRejectsInvalidCustomClickHouseDSN(t *testing.T) {
	tests := []struct {
		name string
		dsn  string
	}{
		{name: "empty", dsn: ""},
		{name: "wrong scheme", dsn: "jdbc:mysql://db.example.com:3306/app"},
		{name: "missing host", dsn: "jdbc:clickhouse:///analytics"},
		{name: "invalid port", dsn: "jdbc:clickhouse://db.example.com:not-a-port/analytics"},
		{name: "port out of range", dsn: "jdbc:clickhouse://db.example.com:65536/analytics"},
		{name: "unbracketed IPv6", dsn: "jdbc:clickhouse://2001:db8::1:8123/analytics"},
		{name: "unsupported grpc", dsn: "jdbc:ch:grpc://db.example.com/analytics"},
		{name: "unsupported multiple hosts", dsn: "jdbc:clickhouse://db-1.example.com:8123,db-2.example.com:8123/analytics"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := NewApp()
			_, err := a.resolveEffectiveConnectionConfig(connection.ConnectionConfig{
				Type:   "custom",
				Driver: "clickhouse",
				DSN:    tt.dsn,
			})
			if err == nil {
				t.Fatal("expected invalid custom ClickHouse DSN to be rejected")
			}
			if !strings.Contains(strings.ToLower(err.Error()), "clickhouse") {
				t.Fatalf("expected ClickHouse-specific error, got %q", err.Error())
			}
		})
	}
}

func TestResolveEffectiveConnectionConfigDoesNotExposeInvalidClickHouseDSN(t *testing.T) {
	a := NewApp()
	secretDSN := "jdbc:clickhouse://admin:super-secret@db.example.com:not-a-port/analytics"
	_, err := a.resolveEffectiveConnectionConfig(connection.ConnectionConfig{
		Type:   "custom",
		Driver: "clickhouse",
		DSN:    secretDSN,
	})
	if err == nil {
		t.Fatal("expected invalid custom ClickHouse DSN to be rejected")
	}
	message := err.Error()
	for _, secret := range []string{secretDSN, "super-secret", "admin"} {
		if strings.Contains(message, secret) {
			t.Fatalf("invalid DSN error leaked %q: %q", secret, message)
		}
	}
}

func TestResolveEffectiveConnectionConfigLeavesOtherCustomDriversUntouched(t *testing.T) {
	a := NewApp()
	raw := connection.ConnectionConfig{
		Type:   "custom",
		Driver: "mysql",
		DSN:    "root:secret@tcp(db.example.com:3306)/app",
	}

	got, err := a.resolveEffectiveConnectionConfig(raw)
	if err != nil {
		t.Fatalf("resolveEffectiveConnectionConfig returned error: %v", err)
	}
	if !reflect.DeepEqual(got, raw) {
		t.Fatalf("non-ClickHouse custom config changed:\nwant=%+v\n got=%+v", raw, got)
	}
}

func TestNormalizeRunConfigCarriesCustomClickHouseDatabaseOverride(t *testing.T) {
	a := NewApp()
	raw := connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "clickhouse",
		DSN:      "jdbc:clickhouse://clickhouse.example.com:8123/default",
		Database: "stale-hidden-database",
	}

	direct, err := a.resolveEffectiveConnectionConfig(raw)
	if err != nil {
		t.Fatalf("direct resolve returned error: %v", err)
	}
	if direct.Database != "default" {
		t.Fatalf("expected DSN database to override stale hidden field, got %q", direct.Database)
	}

	runConfig := normalizeRunConfig(raw, "analytics")
	effective, err := a.resolveEffectiveConnectionConfig(runConfig)
	if err != nil {
		t.Fatalf("run config resolve returned error: %v", err)
	}
	if effective.Database != "analytics" {
		t.Fatalf("expected selected database override analytics, got %q", effective.Database)
	}
	if effective.RuntimeDatabaseOverride() != "" {
		t.Fatalf("expected runtime database marker to be consumed, got %q", effective.RuntimeDatabaseOverride())
	}
	if effective.HasRuntimeDatabaseOverride() {
		t.Fatal("expected runtime database marker state to be consumed")
	}

	serverLevel, err := a.resolveEffectiveConnectionConfig(raw.WithRuntimeDatabaseOverride(""))
	if err != nil {
		t.Fatalf("server-level config resolve returned error: %v", err)
	}
	if serverLevel.Database != "" {
		t.Fatalf("expected explicit empty override to clear DSN database, got %q", serverLevel.Database)
	}

	ddlConfig := buildRunConfigForDDL(raw, "clickhouse", "reporting")
	ddlEffective, err := a.resolveEffectiveConnectionConfig(ddlConfig)
	if err != nil {
		t.Fatalf("DDL config resolve returned error: %v", err)
	}
	if ddlEffective.Database != "reporting" {
		t.Fatalf("expected DDL database override reporting, got %q", ddlEffective.Database)
	}
}

func TestCustomClickHouseDatabaseDDLConnectsAtServerLevel(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	driverRuntimeSupportStatusFunc = func(dbType string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error { return nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	raw := connection.ConnectionConfig{
		Type:   "custom",
		Driver: "clickhouse",
		DSN:    "jdbc:clickhouse://clickhouse.example.com:8123/analytics",
	}
	tests := []struct {
		name      string
		run       func(*App) connection.QueryResult
		wantQuery string
	}{
		{
			name: "create database",
			run: func(a *App) connection.QueryResult {
				return a.CreateDatabase(raw, "reporting", "", "")
			},
			wantQuery: "CREATE DATABASE IF NOT EXISTS `reporting`",
		},
		{
			name: "drop current DSN database",
			run: func(a *App) connection.QueryResult {
				return a.DropDatabase(raw, "analytics")
			},
			wantQuery: "DROP DATABASE `analytics`",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fakeDB := &fakeCreateDatabaseDB{}
			newDatabaseFunc = func(dbType string) (db.Database, error) {
				if dbType != "clickhouse" {
					t.Fatalf("expected ClickHouse factory, got %q", dbType)
				}
				return fakeDB, nil
			}

			result := tt.run(NewApp())
			if !result.Success {
				t.Fatalf("database DDL failed: %s", result.Message)
			}
			if fakeDB.connectConfig.Database != "" {
				t.Fatalf("expected server-level connection, got database %q", fakeDB.connectConfig.Database)
			}
			if len(fakeDB.execQueries) != 1 || fakeDB.execQueries[0] != tt.wantQuery {
				t.Fatalf("unexpected DDL query: %#v", fakeDB.execQueries)
			}
		})
	}
}

func TestResolveEffectiveConnectionConfigLoadsSavedOpaqueClickHouseDSN(t *testing.T) {
	store := newFakeAppSecretStore()
	a := NewAppWithSecretStore(store)
	a.configDir = t.TempDir()

	view, err := a.SaveConnection(connection.SavedConnectionInput{
		ID:   "custom-clickhouse-secret",
		Name: "Custom ClickHouse",
		Config: connection.ConnectionConfig{
			ID:     "custom-clickhouse-secret",
			Type:   "custom",
			Driver: "clickhouse",
			DSN:    "jdbc:clickhouse://secret-user:secret-password@clickhouse.example.com:8123/analytics",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	if view.Config.DSN != "" || !view.HasOpaqueDSN {
		t.Fatalf("expected saved view to keep the ClickHouse DSN opaque, got dsn=%q hasOpaque=%v", view.Config.DSN, view.HasOpaqueDSN)
	}

	effective, err := a.resolveEffectiveConnectionConfig(view.Config)
	if err != nil {
		t.Fatalf("resolveEffectiveConnectionConfig returned error: %v", err)
	}
	if effective.Type != "clickhouse" || effective.Host != "clickhouse.example.com" || effective.Port != 8123 {
		t.Fatalf("unexpected effective ClickHouse endpoint: %+v", effective)
	}
	if effective.User != "secret-user" || effective.Password != "secret-password" || effective.Database != "analytics" {
		t.Fatalf("saved opaque DSN was not restored before conversion: user=%q password=%q database=%q", effective.User, effective.Password, effective.Database)
	}
	if effective.DSN != "" || effective.URI != "" {
		t.Fatalf("expected restored DSN to be removed from runtime config, got dsn=%q uri=%q", effective.DSN, effective.URI)
	}
}

func TestOpenDatabaseIsolatedRoutesCustomClickHouseThroughOptionalDriverPipeline(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	var supportType string
	var revisionConfig connection.ConnectionConfig
	var factoryType string
	var dialConfig connection.ConnectionConfig
	var connectConfig connection.ConnectionConfig
	driverRuntimeSupportStatusFunc = func(dbType string) (bool, string) {
		supportType = dbType
		return true, ""
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		revisionConfig = config
		return nil
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		factoryType = dbType
		return &fakeStartupRetryDB{connect: func(config connection.ConnectionConfig) error {
			connectConfig = config
			return nil
		}}, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		dialConfig = config
		return config, nil
	}

	a := NewApp()
	inst, err := a.openDatabaseIsolated(connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "clickhouse",
		DSN:      "jdbc:clickhouse://db.example.com:9000/analytics",
		UseProxy: true,
		Proxy: connection.ProxyConfig{
			Type: "socks5",
			Host: "proxy.example.com",
			Port: 1080,
		},
	})
	if err != nil {
		t.Fatalf("openDatabaseIsolated returned error: %v", err)
	}
	if inst == nil {
		t.Fatal("expected database instance")
	}
	for name, got := range map[string]string{
		"support":  supportType,
		"revision": revisionConfig.Type,
		"factory":  factoryType,
		"dial":     dialConfig.Type,
		"connect":  connectConfig.Type,
	} {
		if got != "clickhouse" {
			t.Fatalf("expected %s stage to use clickhouse, got %q", name, got)
		}
	}
	if dialConfig.Host != "db.example.com" || dialConfig.Port != 9000 {
		t.Fatalf("proxy preparation received unresolved endpoint: %+v", dialConfig)
	}
	if dialConfig.ClickHouseProtocol != "http" || connectConfig.ClickHouseProtocol != "http" {
		t.Fatalf("expected JDBC HTTP protocol to stay pinned through proxy/connect stages: dial=%q connect=%q", dialConfig.ClickHouseProtocol, connectConfig.ClickHouseProtocol)
	}
}

func TestGetDatabaseReusesCanonicalCacheForEquivalentClickHouseJDBCDSN(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	factoryCalls := 0
	connectCalls := 0
	instance := &fakeStartupRetryDB{connect: func(config connection.ConnectionConfig) error {
		connectCalls++
		if config.Type != "clickhouse" || config.ClickHouseProtocol != "http" {
			t.Fatalf("unexpected connect config: %+v", config)
		}
		return nil
	}}
	driverRuntimeSupportStatusFunc = func(dbType string) (bool, string) {
		if dbType != "clickhouse" {
			t.Fatalf("support check used unexpected type %q", dbType)
		}
		return true, ""
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		if config.Type != "clickhouse" {
			t.Fatalf("revision check used unexpected type %q", config.Type)
		}
		return nil
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		factoryCalls++
		if dbType != "clickhouse" {
			t.Fatalf("factory used unexpected type %q", dbType)
		}
		return instance, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	a := NewApp()
	first, err := a.getDatabase(connection.ConnectionConfig{
		Type:   "custom",
		Driver: "clickhouse",
		DSN:    "jdbc:clickhouse://alice:secret@clickhouse.example.com:8123/analytics?compress=lz4",
	})
	if err != nil {
		t.Fatalf("first getDatabase returned error: %v", err)
	}
	second, err := a.getDatabase(connection.ConnectionConfig{
		Type:   "custom",
		Driver: "CLICKHOUSE",
		DSN:    "jdbc:ch:http://clickhouse.example.com:8123/analytics?password=secret&user=alice&compress=lz4",
	})
	if err != nil {
		t.Fatalf("second getDatabase returned error: %v", err)
	}
	if first != second {
		t.Fatal("expected equivalent JDBC DSNs to reuse the same cached instance")
	}
	if factoryCalls != 1 || connectCalls != 1 || len(a.dbCache) != 1 {
		t.Fatalf("expected one canonical cached connection, got factory=%d connect=%d cache=%d", factoryCalls, connectCalls, len(a.dbCache))
	}
}

func TestGetDatabaseSavedOpaqueClickHouseDSNReusesAndReleasesCanonicalCache(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	store := newFakeAppSecretStore()
	a := NewAppWithSecretStore(store)
	a.configDir = t.TempDir()
	view, err := a.SaveConnection(connection.SavedConnectionInput{
		ID:   "saved-custom-clickhouse",
		Name: "Saved Custom ClickHouse",
		Config: connection.ConnectionConfig{
			ID:     "saved-custom-clickhouse",
			Type:   "custom",
			Driver: "clickhouse",
			DSN:    "jdbc:clickhouse://alice:secret@clickhouse.example.com:8123/analytics",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	factoryCalls := 0
	connectCalls := 0
	recording := &customClickHouseRecordingDB{fakeStartupRetryDB: fakeStartupRetryDB{
		connect: func(config connection.ConnectionConfig) error {
			connectCalls++
			if config.Type != "clickhouse" || config.DSN != "" || config.URI != "" {
				t.Fatalf("saved opaque DSN leaked back into connect config: %+v", config)
			}
			return nil
		},
	}}
	driverRuntimeSupportStatusFunc = func(dbType string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error { return nil }
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		factoryCalls++
		return recording, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	first, err := a.getDatabase(view.Config)
	if err != nil {
		t.Fatalf("first getDatabase returned error: %v", err)
	}
	second, err := a.getDatabase(view.Config)
	if err != nil {
		t.Fatalf("second getDatabase returned error: %v", err)
	}
	if first != second || factoryCalls != 1 || connectCalls != 1 || len(a.dbCache) != 1 {
		t.Fatalf("expected one reusable canonical connection, same=%v factory=%d connect=%d cache=%d", first == second, factoryCalls, connectCalls, len(a.dbCache))
	}
	for _, entry := range a.dbCache {
		if entry.config.DSN != "" || entry.config.URI != "" || entry.config.Type != "clickhouse" {
			t.Fatalf("cache retained non-canonical opaque DSN config: %+v", entry.config)
		}
	}

	result := a.DBReleaseConnection(view.Config)
	if !result.Success {
		t.Fatalf("DBReleaseConnection failed: %s", result.Message)
	}
	if recording.closeCalls != 1 || len(a.dbCache) != 0 {
		t.Fatalf("expected saved canonical connection to be released once, close=%d cache=%d", recording.closeCalls, len(a.dbCache))
	}
}

func TestResolveDataSyncEndpointConfigCanonicalizesCustomClickHouse(t *testing.T) {
	a := NewApp()
	effective, selectedDatabase, err := a.resolveDataSyncEndpointConfig(connection.ConnectionConfig{
		Type:   "custom",
		Driver: "clickhouse",
		DSN:    "jdbc:clickhouse://clickhouse.example.com:8123/default",
	}, "analytics")
	if err != nil {
		t.Fatalf("resolveDataSyncEndpointConfig returned error: %v", err)
	}
	if effective.Type != "clickhouse" || effective.Host != "clickhouse.example.com" || effective.Port != 8123 {
		t.Fatalf("unexpected data sync ClickHouse endpoint: %+v", effective)
	}
	if effective.DSN != "" || effective.ClickHouseProtocol != "http" {
		t.Fatalf("data sync endpoint was not canonicalized: %+v", effective)
	}
	if selectedDatabase != "analytics" {
		t.Fatalf("expected selected sync database analytics, got %q", selectedDatabase)
	}
}

func TestVerifyOptionalDriverAgentReadyForExportRecognizesCustomClickHouse(t *testing.T) {
	originalProbe := optionalDriverAgentMetadataProbe
	originalResolvePath := resolveOptionalDriverAgentExecutablePathFunc
	t.Cleanup(func() {
		optionalDriverAgentMetadataProbe = originalProbe
		resolveOptionalDriverAgentExecutablePathFunc = originalResolvePath
	})

	resolveCalls := 0
	resolveOptionalDriverAgentExecutablePathFunc = func(downloadDir string, driverType string) (string, error) {
		resolveCalls++
		if driverType != "clickhouse" {
			t.Fatalf("expected ClickHouse export preflight, got %q", driverType)
		}
		return "clickhouse-driver-agent", nil
	}
	optionalDriverAgentMetadataProbe = func(driverType string, executablePath string) (db.OptionalDriverAgentMetadata, error) {
		return db.OptionalDriverAgentMetadata{
			DriverType:    driverType,
			AgentRevision: db.OptionalDriverAgentRevision(driverType),
		}, nil
	}

	if err := verifyOptionalDriverAgentReadyForExport(connection.ConnectionConfig{
		Type:   "custom",
		Driver: "clickhouse",
	}); err != nil {
		t.Fatalf("custom ClickHouse export preflight failed: %v", err)
	}
	if resolveCalls != 1 {
		t.Fatalf("expected one ClickHouse agent preflight, got %d", resolveCalls)
	}

	if err := verifyOptionalDriverAgentReadyForExport(connection.ConnectionConfig{
		Type:   "custom",
		Driver: "kingbase",
	}); err != nil {
		t.Fatalf("unrelated custom driver export preflight changed: %v", err)
	}
	if resolveCalls != 1 {
		t.Fatalf("expected unrelated custom driver to skip optional-agent preflight, got %d calls", resolveCalls)
	}
}

func TestDBReleaseConnectionCanonicalizesCustomClickHouseCacheKey(t *testing.T) {
	a := NewApp()
	raw := connection.ConnectionConfig{
		Type:   "custom",
		Driver: "clickhouse",
		DSN:    "jdbc:clickhouse://db.example.com:8123/analytics",
	}
	effective, err := a.resolveEffectiveConnectionConfig(raw)
	if err != nil {
		t.Fatalf("resolve effective config failed: %v", err)
	}
	recording := &customClickHouseRecordingDB{}
	a.dbCache[getCacheKey(effective)] = cachedDatabase{
		inst:   recording,
		config: normalizeCacheKeyConfig(effective),
	}

	result := a.DBReleaseConnection(raw)
	if !result.Success {
		t.Fatalf("DBReleaseConnection failed: %s", result.Message)
	}
	if recording.closeCalls != 1 {
		t.Fatalf("expected cached ClickHouse agent connection to close once, got %d", recording.closeCalls)
	}
	if len(a.dbCache) != 0 {
		t.Fatalf("expected cache to be empty, got %d entries", len(a.dbCache))
	}
}
