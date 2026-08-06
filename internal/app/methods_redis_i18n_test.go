package app

import (
	"GoNavi-Wails/internal/connection"
	redislib "GoNavi-Wails/internal/redis"
	"GoNavi-Wails/shared/i18n"
	"errors"
	"strings"
	"testing"
)

func redisFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("methods_redis.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

func TestRedisBackendOperationMessageCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"redis.backend.message.connect_success",
		"redis.backend.error.test_connection_close_failed",
		"redis.backend.message.set_success",
		"redis.backend.message.select_db_success",
		"redis.backend.message.rename_success",
		"redis.backend.message.delete_success",
		"redis.backend.message.add_success",
		"redis.backend.message.flush_success",
		"redis.backend.message.export_success",
		"redis.backend.message.import_success",
		"redis.backend.error.command_required",
		"redis.backend.error.argument_required",
		"redis.backend.error.argument_invalid_type",
		"redis.backend.error.list_item_changed",
		"redis.backend.error.list_position_invalid",
		"redis.backend.error.export_no_keys",
		"redis.backend.error.import_no_keys_selected",
		"redis.backend.error.import_payload_invalid",
		"redis.backend.label.topology_sentinel",
		"redis.backend.label.topology_cluster",
		"redis.backend.label.topology_multi_node",
		"redis.backend.error.address_required",
		"redis.backend.error.node_address_required",
		"redis.backend.error.invalid_node_address",
		"redis.backend.error.invalid_port",
		"redis.backend.error.topology_ssh_tunnel_unsupported",
		"redis.backend.error.sentinel_master_required",
		"redis.backend.error.connect_tls_setup_failed",
		"redis.backend.error.connect_attempt_failed",
		"redis.backend.error.sentinel_connect_failed",
		"redis.backend.error.cluster_connect_failed",
		"redis.backend.error.connect_failed",
		"redis.backend.error.ssh_tunnel_create_failed",
		"redis.backend.error.select_db_index_required",
		"redis.backend.error.select_db_index_invalid",
		"redis.backend.error.select_db_index_out_of_range",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing Redis backend message key %q", language, key)
			}
		}
	}
}

type redisExecuteErrorClient struct {
	capturingRedisClient
	executeErr error
}

func (c *redisExecuteErrorClient) ExecuteCommand(args []string) (interface{}, error) {
	return nil, c.executeErr
}

func TestRedisDeleteHashFieldArgumentValidationUsesLocalizedText(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

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

	config := connection.ConnectionConfig{Type: "redis", Host: "redis.local", Port: 6379}
	requiredResult := app.RedisDeleteHashField(config, "profile", nil)
	if requiredResult.Success {
		t.Fatalf("RedisDeleteHashField(nil fields) returned success: %+v", requiredResult)
	}
	if requiredResult.Message != "fields is required" {
		t.Fatalf("expected localized required argument message, got %q", requiredResult.Message)
	}

	invalidTypeResult := app.RedisDeleteHashField(config, "profile", map[string]string{"nickname": "neo"})
	if invalidTypeResult.Success {
		t.Fatalf("RedisDeleteHashField(invalid fields) returned success: %+v", invalidTypeResult)
	}
	if invalidTypeResult.Message != "fields has an invalid type" {
		t.Fatalf("expected localized invalid argument type message, got %q", invalidTypeResult.Message)
	}
}

func TestRedisExecuteCommandPropagatesLocalizedBackendValidation(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	CloseAllRedisClients()
	client := &redisExecuteErrorClient{executeErr: errors.New("SELECT command requires a database index")}
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

	result := app.RedisExecuteCommand(connection.ConnectionConfig{
		Type:     "redis",
		Host:     "redis.local",
		Port:     6379,
		Topology: "cluster",
	}, "SELECT")
	if result.Success {
		t.Fatalf("RedisExecuteCommand returned success for backend validation error: %+v", result)
	}
	if result.Message != "SELECT command requires a database index" {
		t.Fatalf("expected RedisExecuteCommand to surface backend validation text, got %q", result.Message)
	}
}

func TestRedisConnectPropagatesLocalizedTopologyValidation(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	result := app.RedisConnect(connection.ConnectionConfig{
		Type:     "redis",
		Host:     "127.0.0.1",
		Port:     6379,
		Topology: "cluster",
		UseSSH:   true,
	})
	if result.Success {
		t.Fatalf("expected RedisConnect to fail for cluster+SSH, got %+v", result)
	}

	const want = "Redis Cluster mode does not support SSH tunnels yet. Disable SSH and try again."
	if !strings.Contains(result.Message, want) {
		t.Fatalf("expected RedisConnect message to contain %q, got %q", want, result.Message)
	}
	if strings.Contains(result.Message, "集群模式暂不支持 SSH 隧道") {
		t.Fatalf("expected no Chinese topology validation text in RedisConnect result, got %q", result.Message)
	}
}
