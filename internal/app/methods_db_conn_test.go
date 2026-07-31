package app

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type releaseRecordingDB struct {
	closed            int
	connect           func(config connection.ConnectionConfig) error
	closeErr          error
	pingCalls         int
	getDatabasesCalls int
	databases         []string
}

func (f *releaseRecordingDB) Connect(config connection.ConnectionConfig) error {
	if f.connect != nil {
		return f.connect(config)
	}
	return nil
}
func (f *releaseRecordingDB) Close() error {
	f.closed++
	return f.closeErr
}
func (f *releaseRecordingDB) Ping() error {
	f.pingCalls++
	return nil
}
func (f *releaseRecordingDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, nil
}
func (f *releaseRecordingDB) Exec(query string) (int64, error) { return 0, nil }
func (f *releaseRecordingDB) GetDatabases() ([]string, error) {
	f.getDatabasesCalls++
	return f.databases, nil
}
func (f *releaseRecordingDB) GetTables(dbName string) ([]string, error) { return nil, nil }
func (f *releaseRecordingDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (f *releaseRecordingDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (f *releaseRecordingDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *releaseRecordingDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *releaseRecordingDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *releaseRecordingDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func TestNormalizeTestConnectionConfig_CapsTimeout(t *testing.T) {
	cfg := connection.ConnectionConfig{Timeout: 60}
	got := normalizeTestConnectionConfig(cfg)
	if got.Timeout != testConnectionTimeoutUpperBoundSeconds {
		t.Fatalf("timeout 应被限制为 %d, got=%d", testConnectionTimeoutUpperBoundSeconds, got.Timeout)
	}
}

func TestNormalizeTestConnectionConfig_KeepSmallTimeout(t *testing.T) {
	cfg := connection.ConnectionConfig{Timeout: 5}
	got := normalizeTestConnectionConfig(cfg)
	if got.Timeout != 5 {
		t.Fatalf("timeout 不应被修改, got=%d", got.Timeout)
	}
}

func TestNormalizeTestConnectionConfig_ZeroTimeout(t *testing.T) {
	cfg := connection.ConnectionConfig{Timeout: 0}
	got := normalizeTestConnectionConfig(cfg)
	if got.Timeout != testConnectionTimeoutUpperBoundSeconds {
		t.Fatalf("零值 timeout 应被修正, got=%d", got.Timeout)
	}
}

func TestDBGetDatabases_MongoConfiguredDatabaseSkipsEnumeration(t *testing.T) {
	installFakeOptionalDriverRuntime(t)

	tests := []struct {
		name   string
		config connection.ConnectionConfig
		want   string
	}{
		{
			name: "database field",
			config: connection.ConnectionConfig{
				Type:     "mongodb",
				Database: " application ",
			},
			want: "application",
		},
		{
			name: "database in URI",
			config: connection.ConnectionConfig{
				Type: "mongodb",
				URI:  "mongodb://user:password@localhost:27017/reporting?authSource=admin",
			},
			want: "reporting",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := NewApp()
			database := &releaseRecordingDB{databases: []string{"admin", "other"}}
			app.dbCache[getCacheKey(test.config)] = cachedDatabase{
				inst:   database,
				config: normalizeCacheKeyConfig(test.config),
			}

			result := app.DBGetDatabases(test.config)
			if !result.Success {
				t.Fatalf("expected scoped MongoDB database lookup to succeed, got %q", result.Message)
			}
			if database.pingCalls != 1 {
				t.Fatalf("expected scoped MongoDB lookup to validate the connection, got %d pings", database.pingCalls)
			}
			if database.getDatabasesCalls != 0 {
				t.Fatalf("expected scoped MongoDB lookup to skip database enumeration, got %d calls", database.getDatabasesCalls)
			}
			rows, ok := result.Data.([]map[string]string)
			if !ok {
				t.Fatalf("expected database rows, got %#v", result.Data)
			}
			if len(rows) != 1 || rows[0]["Database"] != test.want {
				t.Fatalf("expected only configured database %q, got %#v", test.want, rows)
			}
		})
	}
}

func TestDBGetDatabases_MongoWithoutConfiguredDatabaseStillEnumerates(t *testing.T) {
	installFakeOptionalDriverRuntime(t)

	config := connection.ConnectionConfig{Type: "mongodb"}
	app := NewApp()
	database := &releaseRecordingDB{databases: []string{"admin", "application"}}
	app.dbCache[getCacheKey(config)] = cachedDatabase{
		inst:   database,
		config: normalizeCacheKeyConfig(config),
	}

	result := app.DBGetDatabases(config)
	if !result.Success {
		t.Fatalf("expected unscoped MongoDB database lookup to succeed, got %q", result.Message)
	}
	if database.getDatabasesCalls != 1 {
		t.Fatalf("expected unscoped MongoDB lookup to enumerate databases once, got %d calls", database.getDatabasesCalls)
	}
	rows, ok := result.Data.([]map[string]string)
	if !ok || len(rows) != 2 || rows[0]["Database"] != "admin" || rows[1]["Database"] != "application" {
		t.Fatalf("expected enumerated MongoDB databases, got %#v", result.Data)
	}
}

func TestValidateTestConnectionInput_ClickHouseRequiresTarget(t *testing.T) {
	err := validateTestConnectionInput(connection.ConnectionConfig{Type: "clickhouse"})
	if err == nil {
		t.Fatal("expected ClickHouse target validation error")
	}
	if !strings.Contains(err.Error(), "ClickHouse 主机地址") {
		t.Fatalf("unexpected validation error: %v", err)
	}
}

func TestValidateTestConnectionInput_ClickHouseAllowsURI(t *testing.T) {
	err := validateTestConnectionInput(connection.ConnectionConfig{
		Type: "clickhouse",
		URI:  "http://clickhouse.example.com:8125/default",
	})
	if err != nil {
		t.Fatalf("expected ClickHouse URI to satisfy target validation, got %v", err)
	}
}

func TestFormatConnSummary_BasicMySQL(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:     "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		User:     "root",
		Database: "test_db",
		Timeout:  30,
	}
	got := formatConnSummary(cfg)
	for _, want := range []string{"类型=mysql", "127.0.0.1:3306", "test_db", "root"} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatConnSummary 应包含 %q, got=%q", want, got)
		}
	}
}

func TestFormatConnSummary_SQLitePath(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type: "sqlite",
		Host: "/data/test.db",
	}
	got := formatConnSummary(cfg)
	if !strings.Contains(got, "类型=sqlite") {
		t.Fatalf("formatConnSummary 缺少类型, got=%q", got)
	}
	if !strings.Contains(got, "/data/test.db") {
		t.Fatalf("formatConnSummary 缺少路径, got=%q", got)
	}
}

func TestFormatConnSummary_SSH(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:   "mysql",
		Host:   "db.internal",
		Port:   3306,
		User:   "app",
		UseSSH: true,
		SSH: connection.SSHConfig{
			Host: "jump.server",
			Port: 22,
			User: "admin",
		},
	}
	got := formatConnSummary(cfg)
	if !strings.Contains(got, "SSH=jump.server:22") {
		t.Fatalf("formatConnSummary 应包含 SSH 信息, got=%q", got)
	}
}

func TestFormatConnSummary_Proxy(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:     "mysql",
		Host:     "db.internal",
		Port:     3306,
		UseProxy: true,
		Proxy: connection.ProxyConfig{
			Type: "socks5",
			Host: "proxy.local",
			Port: 1080,
		},
	}
	got := formatConnSummary(cfg)
	if !strings.Contains(got, "代理=socks5://proxy.local:1080") {
		t.Fatalf("formatConnSummary 应包含代理信息, got=%q", got)
	}
}

func TestFormatConnSummary_DefaultTimeout(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type: "mysql",
		Host: "localhost",
		Port: 3306,
	}
	got := formatConnSummary(cfg)
	if !strings.Contains(got, "超时=30s") {
		t.Fatalf("formatConnSummary 默认超时应为30s, got=%q", got)
	}
}

func TestDBReleaseConnectionClosesAllDatabaseCacheEntriesForSameInstanceDespiteGlobalProxy(t *testing.T) {
	proxySnapshot := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(true, connection.ProxyConfig{Type: "socks5", Host: "127.0.0.1", Port: 1080}); err != nil {
		t.Fatalf("enable global proxy failed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy)
	})

	app := NewApp()
	mainConfig := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root", Database: "main"}
	analyticsConfig := mainConfig
	analyticsConfig.Database = "analytics"
	otherConfig := mainConfig
	otherConfig.Port = 3307
	otherConfig.Database = "main"

	mainDB := &releaseRecordingDB{}
	analyticsDB := &releaseRecordingDB{}
	otherDB := &releaseRecordingDB{}

	app.dbCache[getCacheKey(mainConfig)] = cachedDatabase{
		inst:   mainDB,
		config: normalizeCacheKeyConfig(mainConfig),
	}
	app.dbCache[getCacheKey(analyticsConfig)] = cachedDatabase{
		inst:   analyticsDB,
		config: normalizeCacheKeyConfig(analyticsConfig),
	}
	app.dbCache[getCacheKey(otherConfig)] = cachedDatabase{
		inst:   otherDB,
		config: normalizeCacheKeyConfig(otherConfig),
	}

	result := app.DBReleaseConnection(connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"})
	if !result.Success {
		t.Fatalf("expected release success, got %s", result.Message)
	}
	if mainDB.closed != 1 || analyticsDB.closed != 1 {
		t.Fatalf("expected both same-instance cached connections closed, got main=%d analytics=%d", mainDB.closed, analyticsDB.closed)
	}
	if otherDB.closed != 0 {
		t.Fatalf("expected other instance cache to remain open, got closed=%d", otherDB.closed)
	}
	if len(app.dbCache) != 1 {
		t.Fatalf("expected only unrelated cache entry to remain, got %d", len(app.dbCache))
	}
}

func TestTestConnectionUsesIsolatedConnectionAndClosesIt(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	proxySnapshot := currentGlobalProxyConfig()
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		if _, err := setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy); err != nil {
			t.Fatalf("restore global proxy failed: %v", err)
		}
	}()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}

	testDB := &releaseRecordingDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return testDB, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewApp()
	result := app.TestConnection(connection.ConnectionConfig{
		Type:     "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		User:     "root",
		Database: "app",
	})

	if !result.Success {
		t.Fatalf("expected test connection success, got %s", result.Message)
	}
	if testDB.closed != 1 {
		t.Fatalf("expected isolated test connection to be closed once, got %d", testDB.closed)
	}
	if len(app.dbCache) != 0 {
		t.Fatalf("test connection must not write global db cache, got %d entries", len(app.dbCache))
	}
}

func TestTestConnectionReturnsLocalizedCloseFailure(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	proxySnapshot := currentGlobalProxyConfig()
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		if _, err := setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy); err != nil {
			t.Fatalf("restore global proxy failed: %v", err)
		}
	}()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}

	testDB := &releaseRecordingDB{closeErr: errors.New("close failed")}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return testDB, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewApp()
	result := app.TestConnection(connection.ConnectionConfig{
		Type:     "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		User:     "root",
		Database: "app",
	})

	if result.Success {
		t.Fatalf("expected localized close failure, got success with %q", result.Message)
	}
	if want := app.appText("db.backend.error.test_connection_close_failed", map[string]any{"detail": "close failed"}); result.Message != want {
		t.Fatalf("expected localized close failure message %q, got %q", want, result.Message)
	}
	if testDB.closed != 1 {
		t.Fatalf("expected isolated test connection to be closed once, got %d", testDB.closed)
	}
}

func TestGetDatabaseReleasesSameInstanceCacheAndRetriesOnMaxUserConnections(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	proxySnapshot := currentGlobalProxyConfig()
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		if _, err := setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy); err != nil {
			t.Fatalf("restore global proxy failed: %v", err)
		}
	}()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}

	connectCalls := 0
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return &releaseRecordingDB{
			connect: func(config connection.ConnectionConfig) error {
				connectCalls++
				if connectCalls == 1 {
					return errors.New("Error 1226 (42000): User 'yangguofeng' has exceeded the 'max_user_connections' resource (current value: 5)")
				}
				return nil
			},
		}, nil
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewApp()
	mainConfig := connection.ConnectionConfig{Type: "mysql", Host: "db.example.com", Port: 3306, User: "yangguofeng", Database: "main"}
	analyticsConfig := mainConfig
	analyticsConfig.Database = "analytics"
	analyticsConfig.ConnectionParams = "charset=utf8mb4"
	otherConfig := mainConfig
	otherConfig.User = "other"

	mainDB := &releaseRecordingDB{}
	analyticsDB := &releaseRecordingDB{}
	otherDB := &releaseRecordingDB{}
	app.dbCache[getCacheKey(mainConfig)] = cachedDatabase{inst: mainDB, config: normalizeCacheKeyConfig(mainConfig)}
	app.dbCache[getCacheKey(analyticsConfig)] = cachedDatabase{inst: analyticsDB, config: normalizeCacheKeyConfig(analyticsConfig)}
	app.dbCache[getCacheKey(otherConfig)] = cachedDatabase{inst: otherDB, config: normalizeCacheKeyConfig(otherConfig)}

	targetConfig := mainConfig
	targetConfig.Database = "target"
	targetConfig.ConnectionParams = "timeout=10"

	inst, err := app.getDatabase(targetConfig)
	if err != nil {
		t.Fatalf("expected retry after releasing cached same-instance connections, got %v", err)
	}
	if inst == nil {
		t.Fatal("expected database instance")
	}
	if connectCalls != 2 {
		t.Fatalf("expected one failed connect and one retry, got %d calls", connectCalls)
	}
	if mainDB.closed != 1 || analyticsDB.closed != 1 {
		t.Fatalf("expected same-instance cached connections closed, got main=%d analytics=%d", mainDB.closed, analyticsDB.closed)
	}
	if otherDB.closed != 0 {
		t.Fatalf("expected other user cache to remain open, got closed=%d", otherDB.closed)
	}
}
