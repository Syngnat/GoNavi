package app

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"testing"

	"GoNavi-Wails/internal/connection"
	redislib "GoNavi-Wails/internal/redis"
)

type capturingRedisClient struct {
	connectConfig      connection.ConnectionConfig
	deletedHashKey     string
	deletedHashFields  []string
	listPushKey        string
	listPushValues     []string
	listPushLeftKey    string
	listPushLeftValues []string
	removedListKey     string
	removedListIndex   int64
	removedListValue   string
	listRemoveErr      error
	valueResult        *redislib.RedisValue
	listResult         []string
	listKey            string
	listStart          int64
	listStop           int64
	listCalls          int
	closed             int
	closeErr           error
	scanErr            error
	scanResults        []*redislib.RedisScanResult
	scanCalls          int
}

func (c *capturingRedisClient) Connect(config connection.ConnectionConfig) error {
	c.connectConfig = config
	return nil
}

func (c *capturingRedisClient) Close() error {
	c.closed++
	return c.closeErr
}

func (c *capturingRedisClient) Ping() error { return nil }

func (c *capturingRedisClient) ScanKeys(pattern string, cursor uint64, count int64) (*redislib.RedisScanResult, error) {
	c.scanCalls++
	if c.scanErr != nil {
		return nil, c.scanErr
	}
	if len(c.scanResults) > 0 {
		index := c.scanCalls - 1
		if index >= len(c.scanResults) {
			index = len(c.scanResults) - 1
		}
		return c.scanResults[index], nil
	}
	return &redislib.RedisScanResult{}, nil
}

func (c *capturingRedisClient) GetKeyType(key string) (string, error) { return "", nil }

func (c *capturingRedisClient) GetTTL(key string) (int64, error) { return 0, nil }

func (c *capturingRedisClient) SetTTL(key string, ttl int64) error { return nil }

func (c *capturingRedisClient) DeleteKeys(keys []string) (int64, error) { return 0, nil }

func (c *capturingRedisClient) RenameKey(oldKey, newKey string) error { return nil }

func (c *capturingRedisClient) KeyExists(key string) (bool, error) { return false, nil }

func (c *capturingRedisClient) GetValue(key string) (*redislib.RedisValue, error) {
	if c.valueResult != nil {
		return c.valueResult, nil
	}
	return &redislib.RedisValue{}, nil
}

func (c *capturingRedisClient) GetString(key string) (string, error) { return "", nil }

func (c *capturingRedisClient) SetString(key, value string, ttl int64) error { return nil }

func (c *capturingRedisClient) GetHash(key string) (map[string]string, error) {
	return map[string]string{}, nil
}

func (c *capturingRedisClient) SetHashField(key, field, value string) error { return nil }

func (c *capturingRedisClient) DeleteHashField(key string, fields ...string) error {
	c.deletedHashKey = key
	c.deletedHashFields = append([]string(nil), fields...)
	return nil
}

func (c *capturingRedisClient) GetList(key string, start, stop int64) ([]string, error) {
	c.listKey = key
	c.listStart = start
	c.listStop = stop
	c.listCalls++
	return append([]string(nil), c.listResult...), nil
}

func (c *capturingRedisClient) ListPush(key string, values ...string) error {
	c.listPushKey = key
	c.listPushValues = append([]string(nil), values...)
	return nil
}

func (c *capturingRedisClient) ListPushLeft(key string, values ...string) error {
	c.listPushLeftKey = key
	c.listPushLeftValues = append([]string(nil), values...)
	return nil
}

func (c *capturingRedisClient) ListSet(key string, index int64, value string) error { return nil }

func (c *capturingRedisClient) ListRemoveAt(key string, index int64, value string) error {
	c.removedListKey = key
	c.removedListIndex = index
	c.removedListValue = value
	return c.listRemoveErr
}

func (c *capturingRedisClient) GetSet(key string) ([]string, error) { return nil, nil }

func (c *capturingRedisClient) SetAdd(key string, members ...string) error { return nil }

func (c *capturingRedisClient) SetRemove(key string, members ...string) error { return nil }

func (c *capturingRedisClient) GetZSet(key string, start, stop int64) ([]redislib.ZSetMember, error) {
	return nil, nil
}

func (c *capturingRedisClient) ZSetAdd(key string, members ...redislib.ZSetMember) error { return nil }

func (c *capturingRedisClient) ZSetRemove(key string, members ...string) error { return nil }

func (c *capturingRedisClient) GetStream(key, start, stop string, count int64) ([]redislib.StreamEntry, error) {
	return nil, nil
}

func (c *capturingRedisClient) StreamAdd(key string, fields map[string]string, id string) (string, error) {
	return "", nil
}

func (c *capturingRedisClient) StreamDelete(key string, ids ...string) (int64, error) { return 0, nil }

func (c *capturingRedisClient) ExecuteCommand(args []string) (interface{}, error) { return nil, nil }

func (c *capturingRedisClient) GetServerInfo() (map[string]string, error) {
	return map[string]string{}, nil
}

func (c *capturingRedisClient) GetDatabases() ([]redislib.RedisDBInfo, error) { return nil, nil }

func (c *capturingRedisClient) SelectDB(index int) error { return nil }

func (c *capturingRedisClient) GetCurrentDB() int { return 0 }

func (c *capturingRedisClient) FlushDB() error { return nil }

type scriptedRedisClient struct {
	capturingRedisClient
	connectErr   error
	connectCalls *[]connection.ConnectionConfig
}

func (c *scriptedRedisClient) Connect(config connection.ConnectionConfig) error {
	c.connectConfig = config
	if c.connectCalls != nil {
		*c.connectCalls = append(*c.connectCalls, config)
	}
	return c.connectErr
}

type redisTransferTestClient struct {
	capturingRedisClient
	scanPages      []*redislib.RedisScanResult
	scanCallCount  int
	keyTypes       map[string]string
	ttls           map[string]int64
	stringValues   map[string]string
	hashValues     map[string]map[string]string
	listValues     map[string][]string
	setValues      map[string][]string
	zsetValues     map[string][]redislib.ZSetMember
	streamValues   map[string][]redislib.StreamEntry
	existingKeys   map[string]bool
	deletedKeys    []string
	setStringCalls []struct {
		key   string
		value string
		ttl   int64
	}
	setTTLCalls []struct {
		key string
		ttl int64
	}
	setHashFieldCalls []struct {
		key   string
		field string
		value string
	}
	listPushCalls []struct {
		key    string
		values []string
	}
	setAddCalls []struct {
		key     string
		members []string
	}
	zsetAddCalls []struct {
		key     string
		members []redislib.ZSetMember
	}
	streamAddCalls []struct {
		key    string
		fields map[string]string
		id     string
	}
}

func (c *redisTransferTestClient) ScanKeys(pattern string, cursor uint64, count int64) (*redislib.RedisScanResult, error) {
	if c.scanCallCount >= len(c.scanPages) {
		return &redislib.RedisScanResult{Cursor: "0"}, nil
	}
	page := c.scanPages[c.scanCallCount]
	c.scanCallCount++
	return page, nil
}

func (c *redisTransferTestClient) GetKeyType(key string) (string, error) {
	if value, ok := c.keyTypes[key]; ok {
		return value, nil
	}
	return "", fmt.Errorf("missing key type for %s", key)
}

func (c *redisTransferTestClient) GetTTL(key string) (int64, error) {
	if value, ok := c.ttls[key]; ok {
		return value, nil
	}
	return -1, nil
}

func (c *redisTransferTestClient) DeleteKeys(keys []string) (int64, error) {
	c.deletedKeys = append(c.deletedKeys, keys...)
	for _, key := range keys {
		if c.existingKeys != nil {
			delete(c.existingKeys, key)
		}
	}
	return int64(len(keys)), nil
}

func (c *redisTransferTestClient) KeyExists(key string) (bool, error) {
	if c.existingKeys == nil {
		return false, nil
	}
	return c.existingKeys[key], nil
}

func (c *redisTransferTestClient) GetString(key string) (string, error) {
	if value, ok := c.stringValues[key]; ok {
		return value, nil
	}
	return "", fmt.Errorf("missing string value for %s", key)
}

func (c *redisTransferTestClient) SetString(key, value string, ttl int64) error {
	c.setStringCalls = append(c.setStringCalls, struct {
		key   string
		value string
		ttl   int64
	}{key: key, value: value, ttl: ttl})
	if c.existingKeys == nil {
		c.existingKeys = make(map[string]bool)
	}
	c.existingKeys[key] = true
	return nil
}

func (c *redisTransferTestClient) GetHash(key string) (map[string]string, error) {
	if value, ok := c.hashValues[key]; ok {
		cloned := make(map[string]string, len(value))
		for field, item := range value {
			cloned[field] = item
		}
		return cloned, nil
	}
	return nil, fmt.Errorf("missing hash value for %s", key)
}

func (c *redisTransferTestClient) SetHashField(key, field, value string) error {
	c.setHashFieldCalls = append(c.setHashFieldCalls, struct {
		key   string
		field string
		value string
	}{key: key, field: field, value: value})
	if c.existingKeys == nil {
		c.existingKeys = make(map[string]bool)
	}
	c.existingKeys[key] = true
	return nil
}

func (c *redisTransferTestClient) GetList(key string, start, stop int64) ([]string, error) {
	if value, ok := c.listValues[key]; ok {
		return append([]string(nil), value...), nil
	}
	return nil, fmt.Errorf("missing list value for %s", key)
}

func (c *redisTransferTestClient) ListPush(key string, values ...string) error {
	c.listPushCalls = append(c.listPushCalls, struct {
		key    string
		values []string
	}{key: key, values: append([]string(nil), values...)})
	if c.existingKeys == nil {
		c.existingKeys = make(map[string]bool)
	}
	c.existingKeys[key] = true
	return nil
}

func (c *redisTransferTestClient) GetSet(key string) ([]string, error) {
	if value, ok := c.setValues[key]; ok {
		return append([]string(nil), value...), nil
	}
	return nil, fmt.Errorf("missing set value for %s", key)
}

func (c *redisTransferTestClient) SetAdd(key string, members ...string) error {
	c.setAddCalls = append(c.setAddCalls, struct {
		key     string
		members []string
	}{key: key, members: append([]string(nil), members...)})
	if c.existingKeys == nil {
		c.existingKeys = make(map[string]bool)
	}
	c.existingKeys[key] = true
	return nil
}

func (c *redisTransferTestClient) GetZSet(key string, start, stop int64) ([]redislib.ZSetMember, error) {
	if value, ok := c.zsetValues[key]; ok {
		return append([]redislib.ZSetMember(nil), value...), nil
	}
	return nil, fmt.Errorf("missing zset value for %s", key)
}

func (c *redisTransferTestClient) ZSetAdd(key string, members ...redislib.ZSetMember) error {
	c.zsetAddCalls = append(c.zsetAddCalls, struct {
		key     string
		members []redislib.ZSetMember
	}{key: key, members: append([]redislib.ZSetMember(nil), members...)})
	if c.existingKeys == nil {
		c.existingKeys = make(map[string]bool)
	}
	c.existingKeys[key] = true
	return nil
}

func (c *redisTransferTestClient) GetStream(key, start, stop string, count int64) ([]redislib.StreamEntry, error) {
	values, ok := c.streamValues[key]
	if !ok {
		return nil, fmt.Errorf("missing stream value for %s", key)
	}
	startIndex := 0
	if start != "" && start != "-" {
		for index, item := range values {
			if item.ID == start {
				startIndex = index
				break
			}
		}
	}
	if startIndex >= len(values) {
		return []redislib.StreamEntry{}, nil
	}
	endIndex := len(values)
	if count > 0 && startIndex+int(count) < endIndex {
		endIndex = startIndex + int(count)
	}
	return append([]redislib.StreamEntry(nil), values[startIndex:endIndex]...), nil
}

func (c *redisTransferTestClient) StreamAdd(key string, fields map[string]string, id string) (string, error) {
	cloned := make(map[string]string, len(fields))
	for field, value := range fields {
		cloned[field] = value
	}
	c.streamAddCalls = append(c.streamAddCalls, struct {
		key    string
		fields map[string]string
		id     string
	}{key: key, fields: cloned, id: id})
	if c.existingKeys == nil {
		c.existingKeys = make(map[string]bool)
	}
	c.existingKeys[key] = true
	return id, nil
}

func (c *redisTransferTestClient) SetTTL(key string, ttl int64) error {
	c.setTTLCalls = append(c.setTTLCalls, struct {
		key string
		ttl int64
	}{key: key, ttl: ttl})
	return nil
}

func TestRedisTestConnectionUsesIsolatedClientAndClosesIt(t *testing.T) {
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	proxySnapshot := currentGlobalProxyConfig()
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		if _, err := setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy); err != nil {
			t.Fatalf("restore global proxy failed: %v", err)
		}
		CloseAllRedisClients()
	}()
	CloseAllRedisClients()
	if _, err := setGlobalProxyConfig(true, connection.ProxyConfig{Type: "socks5", Host: "127.0.0.1", Port: 1080}); err != nil {
		t.Fatalf("enable global proxy failed: %v", err)
	}

	client := &capturingRedisClient{}
	var dialConfig connection.ConnectionConfig
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		dialConfig = raw
		return raw, nil
	}

	app := NewApp()
	result := app.RedisTestConnection(connection.ConnectionConfig{
		Type: "redis",
		Host: "127.0.0.1",
		Port: 6379,
	})

	if !result.Success {
		t.Fatalf("expected redis test connection success, got %s", result.Message)
	}
	if client.closed != 1 {
		t.Fatalf("expected isolated redis test client to be closed once, got %d", client.closed)
	}
	if len(redisCache) != 0 {
		t.Fatalf("redis test connection must not write global redis cache, got %d entries", len(redisCache))
	}
	if dialConfig.UseProxy {
		t.Fatalf("global proxy must not be applied to Redis connections, got %+v", dialConfig)
	}
}

func TestRedisTestConnectionReturnsLocalizedCloseFailure(t *testing.T) {
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	proxySnapshot := currentGlobalProxyConfig()
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		if _, err := setGlobalProxyConfig(proxySnapshot.Enabled, proxySnapshot.Proxy); err != nil {
			t.Fatalf("restore global proxy failed: %v", err)
		}
		CloseAllRedisClients()
	}()
	CloseAllRedisClients()
	if _, err := setGlobalProxyConfig(false, proxySnapshot.Proxy); err != nil {
		t.Fatalf("disable global proxy failed: %v", err)
	}

	client := &capturingRedisClient{closeErr: errors.New("close failed")}
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	app := NewApp()
	result := app.RedisTestConnection(connection.ConnectionConfig{
		Type: "redis",
		Host: "127.0.0.1",
		Port: 6379,
	})

	if result.Success {
		t.Fatalf("expected localized close failure, got success with %q", result.Message)
	}
	if want := app.appText("redis.backend.error.test_connection_close_failed", map[string]any{"detail": "close failed"}); result.Message != want {
		t.Fatalf("expected localized close failure message %q, got %q", want, result.Message)
	}
	if client.closed != 1 {
		t.Fatalf("expected isolated redis test client to be closed once, got %d", client.closed)
	}
}

func TestRedisConnectResolvesSavedSecretsByConnectionID(t *testing.T) {
	testCases := []struct {
		name           string
		savedConfig    connection.ConnectionConfig
		runtimeConfig  connection.ConnectionConfig
		assertResolved func(t *testing.T, got connection.ConnectionConfig)
	}{
		{
			name: "redis and ssh secrets",
			savedConfig: connection.ConnectionConfig{
				ID:       "redis-1",
				Type:     "redis",
				Host:     "redis.local",
				Port:     6379,
				Password: "redis-secret",
				UseSSH:   true,
				SSH: connection.SSHConfig{
					Host:     "ssh.local",
					Port:     22,
					User:     "ops",
					Password: "ssh-secret",
				},
			},
			runtimeConfig: connection.ConnectionConfig{
				ID:     "redis-1",
				Type:   "redis",
				Host:   "redis.local",
				Port:   6379,
				UseSSH: true,
				SSH: connection.SSHConfig{
					Host: "ssh.local",
					Port: 22,
					User: "ops",
				},
			},
			assertResolved: func(t *testing.T, got connection.ConnectionConfig) {
				t.Helper()
				if got.Password != "redis-secret" {
					t.Fatalf("expected RedisConnect to resolve saved Redis password, got %q", got.Password)
				}
				if got.SSH.Password != "ssh-secret" {
					t.Fatalf("expected RedisConnect to resolve saved SSH password, got %q", got.SSH.Password)
				}
			},
		},
		{
			name: "proxy secret",
			savedConfig: connection.ConnectionConfig{
				ID:       "redis-1",
				Type:     "redis",
				Host:     "redis.local",
				Port:     6379,
				Password: "redis-secret",
				UseProxy: true,
				Proxy: connection.ProxyConfig{
					Type:     "http",
					Host:     "proxy.local",
					Port:     8080,
					User:     "proxy-user",
					Password: "proxy-secret",
				},
			},
			runtimeConfig: connection.ConnectionConfig{
				ID:       "redis-1",
				Type:     "redis",
				Host:     "redis.local",
				Port:     6379,
				UseProxy: true,
				Proxy: connection.ProxyConfig{
					Type: "http",
					Host: "proxy.local",
					Port: 8080,
					User: "proxy-user",
				},
			},
			assertResolved: func(t *testing.T, got connection.ConnectionConfig) {
				t.Helper()
				if got.Password != "redis-secret" {
					t.Fatalf("expected RedisConnect to resolve saved Redis password, got %q", got.Password)
				}
				if got.Proxy.Password != "proxy-secret" {
					t.Fatalf("expected RedisConnect to resolve saved proxy password, got %q", got.Proxy.Password)
				}
			},
		},
		{
			name: "http tunnel secret",
			savedConfig: connection.ConnectionConfig{
				ID:            "redis-1",
				Type:          "redis",
				Host:          "redis.local",
				Port:          6379,
				Password:      "redis-secret",
				UseHTTPTunnel: true,
				HTTPTunnel: connection.HTTPTunnelConfig{
					Host:     "tunnel.local",
					Port:     8443,
					User:     "tunnel-user",
					Password: "tunnel-secret",
				},
			},
			runtimeConfig: connection.ConnectionConfig{
				ID:            "redis-1",
				Type:          "redis",
				Host:          "redis.local",
				Port:          6379,
				UseHTTPTunnel: true,
				HTTPTunnel: connection.HTTPTunnelConfig{
					Host: "tunnel.local",
					Port: 8443,
					User: "tunnel-user",
				},
			},
			assertResolved: func(t *testing.T, got connection.ConnectionConfig) {
				t.Helper()
				if got.Password != "redis-secret" {
					t.Fatalf("expected RedisConnect to resolve saved Redis password, got %q", got.Password)
				}
				if got.HTTPTunnel.Password != "tunnel-secret" {
					t.Fatalf("expected RedisConnect to resolve saved HTTP tunnel password, got %q", got.HTTPTunnel.Password)
				}
			},
		},
		{
			name: "explicit redis username from uri is preserved even when it is root",
			savedConfig: connection.ConnectionConfig{
				ID:       "redis-1",
				Type:     "redis",
				Host:     "redis.local",
				Port:     6379,
				User:     "root",
				Password: "redis-secret",
				URI:      "redis://root:redis-secret@redis.local:6379/0",
			},
			runtimeConfig: connection.ConnectionConfig{
				ID:   "redis-1",
				Type: "redis",
				Host: "redis.local",
				Port: 6379,
				User: "root",
			},
			assertResolved: func(t *testing.T, got connection.ConnectionConfig) {
				t.Helper()
				if got.User != "root" {
					t.Fatalf("expected RedisConnect to preserve explicit uri user root, got %q", got.User)
				}
				if got.URI != "redis://root:redis-secret@redis.local:6379/0" {
					t.Fatalf("expected RedisConnect to restore saved redis uri, got %q", got.URI)
				}
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			app := NewAppWithSecretStore(newFakeAppSecretStore())
			app.configDir = t.TempDir()

			_, err := app.SaveConnection(connection.SavedConnectionInput{
				ID:     "redis-1",
				Name:   "Redis Saved",
				Config: testCase.savedConfig,
			})
			if err != nil {
				t.Fatalf("SaveConnection returned error: %v", err)
			}

			CloseAllRedisClients()
			client := &capturingRedisClient{}
			originalNewRedisClientFunc := newRedisClientFunc
			originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
			defer func() {
				newRedisClientFunc = originalNewRedisClientFunc
				resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
				CloseAllRedisClients()
			}()
			newRedisClientFunc = func() redislib.RedisClient {
				return client
			}
			resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
				return raw, nil
			}

			result := app.RedisConnect(testCase.runtimeConfig)
			if !result.Success {
				t.Fatalf("RedisConnect returned failure: %+v", result)
			}

			testCase.assertResolved(t, client.connectConfig)
		})
	}
}

func TestRedisConnectPreservesExplicitRootUserWithoutURIWhenConnectSucceeds(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "redis-1",
		Name: "Redis Saved",
		Config: connection.ConnectionConfig{
			ID:       "redis-1",
			Type:     "redis",
			Host:     "redis.local",
			Port:     6379,
			User:     "root",
			Password: "redis-secret",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	CloseAllRedisClients()
	connectCalls := make([]connection.ConnectionConfig, 0, 1)
	client := &scriptedRedisClient{connectCalls: &connectCalls}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisConnect(connection.ConnectionConfig{
		ID:   "redis-1",
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
		User: "root",
	})
	if !result.Success {
		t.Fatalf("RedisConnect returned failure: %+v", result)
	}
	if len(connectCalls) != 1 {
		t.Fatalf("expected exactly one Redis connect attempt, got %d", len(connectCalls))
	}
	if connectCalls[0].User != "root" {
		t.Fatalf("expected RedisConnect to preserve explicit root user when connect succeeds, got %q", connectCalls[0].User)
	}
}

func TestRedisConnectRetriesLegacyDefaultRootUserWithoutUsernameAfterAuthFailure(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "redis-1",
		Name: "Redis Saved",
		Config: connection.ConnectionConfig{
			ID:       "redis-1",
			Type:     "redis",
			Host:     "redis.local",
			Port:     6379,
			User:     "root",
			Password: "redis-secret",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	CloseAllRedisClients()
	connectCalls := make([]connection.ConnectionConfig, 0, 2)
	clients := []redislib.RedisClient{
		&scriptedRedisClient{
			connectErr:   errors.New("WRONGPASS invalid username-password pair"),
			connectCalls: &connectCalls,
		},
		&scriptedRedisClient{
			connectCalls: &connectCalls,
		},
	}
	clientIndex := 0
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		if clientIndex >= len(clients) {
			t.Fatalf("unexpected Redis client allocation #%d", clientIndex+1)
		}
		client := clients[clientIndex]
		clientIndex++
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisConnect(connection.ConnectionConfig{
		ID:   "redis-1",
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
		User: "root",
	})
	if !result.Success {
		t.Fatalf("RedisConnect returned failure after fallback: %+v", result)
	}
	if len(connectCalls) != 2 {
		t.Fatalf("expected RedisConnect to retry exactly once after auth failure, got %d attempts", len(connectCalls))
	}
	if connectCalls[0].User != "root" {
		t.Fatalf("expected first Redis connect attempt to keep root user, got %q", connectCalls[0].User)
	}
	if connectCalls[1].User != "" {
		t.Fatalf("expected fallback Redis connect attempt to clear legacy root user, got %q", connectCalls[1].User)
	}
}

func TestRedisDeleteHashFieldAcceptsSingleStringField(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	CloseAllRedisClients()
	client := &capturingRedisClient{}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisDeleteHashField(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "profile", "nickname")
	if !result.Success {
		t.Fatalf("RedisDeleteHashField returned failure: %+v", result)
	}
	if client.deletedHashKey != "profile" {
		t.Fatalf("expected hash key profile, got %q", client.deletedHashKey)
	}
	if len(client.deletedHashFields) != 1 || client.deletedHashFields[0] != "nickname" {
		t.Fatalf("expected one deleted hash field nickname, got %v", client.deletedHashFields)
	}
}

func TestRedisDeleteHashFieldAcceptsStringSlice(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	CloseAllRedisClients()
	client := &capturingRedisClient{}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisDeleteHashField(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "profile", []string{"nickname", "avatar"})
	if !result.Success {
		t.Fatalf("RedisDeleteHashField returned failure: %+v", result)
	}
	if client.deletedHashKey != "profile" {
		t.Fatalf("expected hash key profile, got %q", client.deletedHashKey)
	}
	if len(client.deletedHashFields) != 2 || client.deletedHashFields[0] != "nickname" || client.deletedHashFields[1] != "avatar" {
		t.Fatalf("unexpected deleted hash fields: %v", client.deletedHashFields)
	}
}

func TestRedisGetListValueDescendingReadsAndReversesTailWindow(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	CloseAllRedisClients()
	client := &capturingRedisClient{
		valueResult: &redislib.RedisValue{
			Type:   "list",
			TTL:    -1,
			Value:  []string{"item-0", "item-1", "item-2"},
			Length: 5,
		},
		listResult: []string{"item-2", "item-3", "item-4"},
	}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisGetListValue(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "tasks", true)
	if !result.Success {
		t.Fatalf("RedisGetListValue returned failure: %+v", result)
	}
	if client.listCalls != 1 || client.listKey != "tasks" || client.listStart != 2 || client.listStop != -1 {
		t.Fatalf("unexpected list tail request: calls=%d key=%q start=%d stop=%d", client.listCalls, client.listKey, client.listStart, client.listStop)
	}
	value, ok := result.Data.(*redislib.RedisValue)
	if !ok {
		t.Fatalf("expected *redis.RedisValue result, got %T", result.Data)
	}
	if !reflect.DeepEqual(value.Value, []string{"item-4", "item-3", "item-2"}) {
		t.Fatalf("unexpected descending list values: %#v", value.Value)
	}
	if value.Length != 5 || value.TTL != -1 {
		t.Fatalf("expected list metadata to remain unchanged, got length=%d ttl=%d", value.Length, value.TTL)
	}
}

func TestRedisListPushAppendsValuesWithoutChangingThem(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	CloseAllRedisClients()
	client := &capturingRedisClient{}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	values := []string{"  review  ", "", "\t"}
	result := app.RedisListPush(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "tasks", RedisListPushOptions{
		Values:   values,
		Position: "right",
	})
	if !result.Success {
		t.Fatalf("RedisListPush returned failure: %+v", result)
	}
	if client.listPushKey != "tasks" || !reflect.DeepEqual(client.listPushValues, values) {
		t.Fatalf("unexpected list push call: key=%q values=%#v", client.listPushKey, client.listPushValues)
	}
}

func TestRedisListPushPrependsValues(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	CloseAllRedisClients()
	client := &capturingRedisClient{}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	values := []string{"review", "ship"}
	result := app.RedisListPush(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "tasks", RedisListPushOptions{
		Values:   values,
		Position: "left",
	})
	if !result.Success {
		t.Fatalf("RedisListPush returned failure: %+v", result)
	}
	if client.listPushLeftKey != "tasks" || !reflect.DeepEqual(client.listPushLeftValues, values) {
		t.Fatalf("unexpected left list push call: key=%q values=%#v", client.listPushLeftKey, client.listPushLeftValues)
	}
	if client.listPushKey != "" || client.listPushValues != nil {
		t.Fatalf("right list push must not be used: key=%q values=%#v", client.listPushKey, client.listPushValues)
	}
}

func TestRedisListPushRejectsEmptyValues(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	CloseAllRedisClients()
	client := &capturingRedisClient{}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisListPush(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "tasks", RedisListPushOptions{Position: "right"})
	if result.Success {
		t.Fatalf("RedisListPush should reject empty values: %+v", result)
	}
	want := app.appText("redis.backend.error.argument_required", map[string]any{"name": "values"})
	if result.Message != want {
		t.Fatalf("unexpected empty values error: got %q want %q", result.Message, want)
	}
	if client.listPushKey != "" || client.listPushLeftKey != "" {
		t.Fatalf("empty values must not be pushed: right=%q left=%q", client.listPushKey, client.listPushLeftKey)
	}
}

func TestRedisListPushRejectsInvalidPosition(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	CloseAllRedisClients()
	client := &capturingRedisClient{}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisListPush(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "tasks", RedisListPushOptions{
		Values:   []string{"review"},
		Position: "LEFT",
	})
	if result.Success {
		t.Fatalf("RedisListPush should reject an invalid position: %+v", result)
	}
	want := app.appText("redis.backend.error.list_position_invalid", nil)
	if result.Message != want {
		t.Fatalf("unexpected invalid position error: got %q want %q", result.Message, want)
	}
	if client.listPushKey != "" || client.listPushLeftKey != "" {
		t.Fatalf("invalid position must not be pushed: right=%q left=%q", client.listPushKey, client.listPushLeftKey)
	}
}

func TestRedisListRemoveDeletesTheSelectedValue(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	CloseAllRedisClients()
	client := &capturingRedisClient{}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisListRemove(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "tasks", 3, "review")
	if !result.Success {
		t.Fatalf("RedisListRemove returned failure: %+v", result)
	}
	if client.removedListKey != "tasks" || client.removedListIndex != 3 || client.removedListValue != "review" {
		t.Fatalf("unexpected list remove call: key=%q index=%d value=%q", client.removedListKey, client.removedListIndex, client.removedListValue)
	}
}

func TestRedisListRemoveReportsWhenTheSelectedItemChanged(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	CloseAllRedisClients()
	client := &capturingRedisClient{
		listRemoveErr: fmt.Errorf("concurrent update: %w", redislib.ErrRedisListItemChanged),
	}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisListRemove(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, "tasks", 3, "review")
	if result.Success {
		t.Fatalf("RedisListRemove should report a changed item: %+v", result)
	}
	want := app.appText("redis.backend.error.list_item_changed", nil)
	if result.Message != want {
		t.Fatalf("unexpected changed item error: got %q want %q", result.Message, want)
	}
}

func TestBuildRedisExportPayloadCollectsPagedKeysAndSerializesAllSupportedShapes(t *testing.T) {
	client := &redisTransferTestClient{
		scanPages: []*redislib.RedisScanResult{
			{
				Keys: []redislib.RedisKeyInfo{
					{Key: "beta"},
					{Key: "alpha"},
				},
				Cursor: "1",
			},
			{
				Keys: []redislib.RedisKeyInfo{
					{Key: "alpha"},
					{Key: "events"},
				},
				Cursor: "0",
			},
		},
		keyTypes: map[string]string{
			"alpha":  "string",
			"beta":   "set",
			"events": "stream",
		},
		ttls: map[string]int64{
			"alpha":  120,
			"beta":   -1,
			"events": 45,
		},
		stringValues: map[string]string{
			"alpha": "value-1",
		},
		setValues: map[string][]string{
			"beta": {"member-b", "member-a"},
		},
		streamValues: map[string][]redislib.StreamEntry{
			"events": {
				{ID: "1710000000000-0", Fields: map[string]string{"kind": "start"}},
				{ID: "1710000000001-0", Fields: map[string]string{"kind": "finish"}},
			},
		},
	}

	payload, err := buildRedisExportPayload(client, 7, RedisExportKeysOptions{
		Scope:   "all",
		Pattern: "app:*",
	})
	if err != nil {
		t.Fatalf("buildRedisExportPayload returned error: %v", err)
	}

	if payload.Format != redisTransferFileFormat || payload.Version != redisTransferFileVersion {
		t.Fatalf("unexpected redis transfer header: %+v", payload)
	}
	if payload.Database != 7 || payload.Scope != "all" || payload.Pattern != "app:*" {
		t.Fatalf("unexpected redis transfer metadata: %+v", payload)
	}
	if got := len(payload.Keys); got != 3 {
		t.Fatalf("expected 3 exported keys, got %d", got)
	}
	if payload.Keys[0].Key != "alpha" || payload.Keys[1].Key != "beta" || payload.Keys[2].Key != "events" {
		t.Fatalf("expected sorted exported keys, got %+v", payload.Keys)
	}

	if value, ok := payload.Keys[0].Value.(string); !ok || value != "value-1" {
		t.Fatalf("expected string payload for alpha, got %#v", payload.Keys[0].Value)
	}

	setMembers, ok := payload.Keys[1].Value.([]string)
	if !ok {
		t.Fatalf("expected set payload slice, got %#v", payload.Keys[1].Value)
	}
	if !reflect.DeepEqual(setMembers, []string{"member-a", "member-b"}) {
		t.Fatalf("expected sorted set members, got %v", setMembers)
	}

	streamEntries, ok := payload.Keys[2].Value.([]redislib.StreamEntry)
	if !ok {
		t.Fatalf("expected stream payload slice, got %#v", payload.Keys[2].Value)
	}
	if len(streamEntries) != 2 || streamEntries[1].Fields["kind"] != "finish" {
		t.Fatalf("unexpected stream payload: %+v", streamEntries)
	}
}

func TestImportRedisTransferPayloadHonorsConflictMode(t *testing.T) {
	basePayload := redisTransferFile{
		Keys: []redisTransferEntry{
			{Key: "existing", Type: "string", TTL: 90, Value: "updated"},
			{Key: "profile", Type: "hash", TTL: 30, Value: map[string]string{"name": "neo", "role": "admin"}},
			{Key: "events", Type: "stream", TTL: -1, Value: []redislib.StreamEntry{{ID: "1710000000000-0", Fields: map[string]string{"status": "ok"}}}},
		},
	}

	skipClient := &redisTransferTestClient{
		existingKeys: map[string]bool{
			"existing": true,
		},
	}
	skipSummary, err := importRedisTransferPayload(skipClient, basePayload, RedisImportKeysOptions{ConflictMode: "skip"})
	if err != nil {
		t.Fatalf("importRedisTransferPayload(skip) returned error: %v", err)
	}
	if skipSummary["imported"] != 2 || skipSummary["skipped"] != 1 || skipSummary["total"] != 3 {
		t.Fatalf("unexpected skip import summary: %+v", skipSummary)
	}
	if len(skipClient.deletedKeys) != 0 {
		t.Fatalf("skip mode should not delete existing keys, got %v", skipClient.deletedKeys)
	}
	if len(skipClient.setStringCalls) != 0 {
		t.Fatalf("skip mode should not overwrite existing string keys, got %+v", skipClient.setStringCalls)
	}
	if len(skipClient.setHashFieldCalls) != 2 {
		t.Fatalf("expected hash fields to import in skip mode, got %+v", skipClient.setHashFieldCalls)
	}
	sort.Slice(skipClient.setHashFieldCalls, func(i, j int) bool {
		return skipClient.setHashFieldCalls[i].field < skipClient.setHashFieldCalls[j].field
	})
	if skipClient.setHashFieldCalls[0].field != "name" || skipClient.setHashFieldCalls[1].field != "role" {
		t.Fatalf("unexpected imported hash fields: %+v", skipClient.setHashFieldCalls)
	}
	if len(skipClient.setTTLCalls) != 1 || skipClient.setTTLCalls[0].key != "profile" || skipClient.setTTLCalls[0].ttl != 30 {
		t.Fatalf("expected imported hash ttl to be restored, got %+v", skipClient.setTTLCalls)
	}
	if len(skipClient.streamAddCalls) != 1 || skipClient.streamAddCalls[0].id != "1710000000000-0" {
		t.Fatalf("expected stream entry import in skip mode, got %+v", skipClient.streamAddCalls)
	}

	overwriteClient := &redisTransferTestClient{
		existingKeys: map[string]bool{
			"existing": true,
		},
	}
	overwriteSummary, err := importRedisTransferPayload(overwriteClient, basePayload, RedisImportKeysOptions{ConflictMode: "overwrite"})
	if err != nil {
		t.Fatalf("importRedisTransferPayload(overwrite) returned error: %v", err)
	}
	if overwriteSummary["imported"] != 3 || overwriteSummary["skipped"] != 0 || overwriteSummary["total"] != 3 {
		t.Fatalf("unexpected overwrite import summary: %+v", overwriteSummary)
	}
	if !reflect.DeepEqual(overwriteClient.deletedKeys, []string{"existing"}) {
		t.Fatalf("expected overwrite mode to delete the existing key first, got %v", overwriteClient.deletedKeys)
	}
	if len(overwriteClient.setStringCalls) != 1 {
		t.Fatalf("expected overwrite mode to restore one string key, got %+v", overwriteClient.setStringCalls)
	}
	if overwriteClient.setStringCalls[0].key != "existing" || overwriteClient.setStringCalls[0].value != "updated" || overwriteClient.setStringCalls[0].ttl != 90 {
		t.Fatalf("unexpected overwrite string restore call: %+v", overwriteClient.setStringCalls[0])
	}
}

func TestImportRedisTransferPayloadHonorsSelectedScope(t *testing.T) {
	payload := redisTransferFile{
		Keys: []redisTransferEntry{
			{Key: "existing", Type: "string", TTL: 90, Value: "updated"},
			{Key: "profile", Type: "hash", TTL: 30, Value: map[string]string{"name": "neo"}},
			{Key: "events", Type: "stream", TTL: -1, Value: []redislib.StreamEntry{{ID: "1710000000000-0", Fields: map[string]string{"status": "ok"}}}},
		},
	}

	client := &redisTransferTestClient{
		existingKeys: map[string]bool{
			"existing": true,
		},
	}
	result, err := importRedisTransferPayload(client, payload, RedisImportKeysOptions{
		Scope:        "selected",
		Keys:         []string{"profile", "events"},
		ConflictMode: "overwrite",
	})
	if err != nil {
		t.Fatalf("importRedisTransferPayload(selected) returned error: %v", err)
	}
	if result["imported"] != 2 || result["skipped"] != 0 || result["total"] != 2 {
		t.Fatalf("unexpected selected import summary: %+v", result)
	}
	if len(client.deletedKeys) != 0 {
		t.Fatalf("selected import should not touch unselected keys, got %v", client.deletedKeys)
	}
	if len(client.setStringCalls) != 0 {
		t.Fatalf("selected import should not restore unselected string keys, got %+v", client.setStringCalls)
	}
	if len(client.setHashFieldCalls) != 1 || client.setHashFieldCalls[0].key != "profile" {
		t.Fatalf("expected only selected hash key import, got %+v", client.setHashFieldCalls)
	}
	if len(client.streamAddCalls) != 1 || client.streamAddCalls[0].key != "events" {
		t.Fatalf("expected only selected stream key import, got %+v", client.streamAddCalls)
	}
}

func TestSelectRedisTransferEntriesForImportRequiresSelectedKeys(t *testing.T) {
	payload := redisTransferFile{
		Keys: []redisTransferEntry{
			{Key: "alpha", Type: "string", TTL: -1, Value: "1"},
		},
	}

	_, err := selectRedisTransferEntriesForImport(payload, RedisImportKeysOptions{Scope: "selected"})
	if !errors.Is(err, errRedisImportNoKeysSelected) {
		t.Fatalf("expected errRedisImportNoKeysSelected, got %v", err)
	}
}
