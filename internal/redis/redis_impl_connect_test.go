package redis

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"

	goredis "github.com/redis/go-redis/v9"
)

func TestSanitizeRedisPassword(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "empty password",
			input:    "",
			expected: "",
		},
		{
			name:     "plain password without special chars",
			input:    "mypassword123",
			expected: "mypassword123",
		},
		{
			name:     "password with @ not encoded",
			input:    "p@ssword",
			expected: "p@ssword",
		},
		{
			name:     "password with @ URL-encoded as %40",
			input:    "p%40ssword",
			expected: "p@ssword",
		},
		{
			name:     "password with multiple encoded chars",
			input:    "p%40ss%23word",
			expected: "p@ss#word",
		},
		{
			name:     "password with + encoded as %2B",
			input:    "p%2Bss",
			expected: "p+ss",
		},
		{
			name:     "password that is purely encoded",
			input:    "%40%23%24",
			expected: "@#$",
		},
		{
			name:     "password with invalid percent encoding",
			input:    "p%ZZssword",
			expected: "p%ZZssword",
		},
		{
			name:     "password with trailing percent",
			input:    "password%",
			expected: "password%",
		},
		{
			name:     "password with literal percent not encoding anything",
			input:    "100%safe",
			expected: "100%safe",
		},
		{
			name:     "password with space encoded as %20",
			input:    "my%20pass",
			expected: "my pass",
		},
		{
			name:     "complex password with mixed content",
			input:    "P%40ss%23w0rd!",
			expected: "P@ss#w0rd!",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := sanitizeRedisPassword(tt.input)
			if result != tt.expected {
				t.Errorf("sanitizeRedisPassword(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestRedisSentinelRequiresMasterNameBeforeDial(t *testing.T) {
	client := NewRedisClient()
	err := client.Connect(connection.ConnectionConfig{
		Type:     "redis",
		Host:     "127.0.0.1",
		Port:     26379,
		Topology: "sentinel",
	})
	if err == nil || !strings.Contains(err.Error(), "master 名称") {
		t.Fatalf("expected missing Sentinel master validation error, got %v", err)
	}
}

func TestRedisSentinelWithMultipleAddrsDoesNotUseClusterBranch(t *testing.T) {
	client := NewRedisClient()
	err := client.Connect(connection.ConnectionConfig{
		Type:                "redis",
		Host:                "127.0.0.1",
		Port:                26379,
		Hosts:               []string{"127.0.0.2:26379"},
		Topology:            "sentinel",
		RedisSentinelMaster: "mymaster",
		UseSSH:              true,
	})
	if err == nil {
		t.Fatal("expected Sentinel SSH validation error")
	}
	if !strings.Contains(err.Error(), "Sentinel模式暂不支持 SSH 隧道") {
		t.Fatalf("expected Sentinel-specific SSH error, got %v", err)
	}
}

func TestRedisClusterKeepsSSHValidation(t *testing.T) {
	client := NewRedisClient()
	err := client.Connect(connection.ConnectionConfig{
		Type:     "redis",
		Host:     "127.0.0.1",
		Port:     6379,
		Topology: "cluster",
		UseSSH:   true,
	})
	if err == nil {
		t.Fatal("expected cluster SSH validation error")
	}
	if !strings.Contains(err.Error(), "集群模式暂不支持 SSH 隧道") {
		t.Fatalf("expected cluster SSH error, got %v", err)
	}
}

func TestRedisConnectValidationUsesEnglishMessages(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cases := []struct {
		name  string
		run   func() error
		want  string
		avoid string
	}{
		{
			name: "node address required",
			run: func() error {
				_, err := normalizeRedisSeedAddress("   ", 6379)
				return err
			},
			want:  "Redis node address cannot be empty",
			avoid: "Redis 节点地址不能为空",
		},
		{
			name: "node port invalid",
			run: func() error {
				_, err := normalizeRedisSeedAddress("cache.local:notaport", 6379)
				return err
			},
			want:  "Invalid Redis port: cache.local:notaport",
			avoid: "无效 Redis 端口",
		},
		{
			name: "address required",
			run: func() error {
				_, err := buildRedisSeedAddrs(connection.ConnectionConfig{Type: "redis"})
				return err
			},
			want:  "Redis connection address cannot be empty",
			avoid: "Redis 连接地址不能为空",
		},
		{
			name: "sentinel master required",
			run: func() error {
				client := NewRedisClient()
				return client.Connect(connection.ConnectionConfig{
					Type:     "redis",
					Host:     "127.0.0.1",
					Port:     26379,
					Topology: "sentinel",
				})
			},
			want:  "Redis Sentinel mode requires a master name",
			avoid: "master 名称",
		},
		{
			name: "cluster ssh unsupported",
			run: func() error {
				client := NewRedisClient()
				return client.Connect(connection.ConnectionConfig{
					Type:     "redis",
					Host:     "127.0.0.1",
					Port:     6379,
					Topology: "cluster",
					UseSSH:   true,
				})
			},
			want:  "Redis Cluster mode does not support SSH tunnels yet. Disable SSH and try again.",
			avoid: "集群模式暂不支持 SSH 隧道",
		},
		{
			name: "multi node ssh unsupported",
			run: func() error {
				client := NewRedisClient()
				return client.Connect(connection.ConnectionConfig{
					Type:   "redis",
					Host:   "127.0.0.1",
					Port:   6379,
					Hosts:  []string{"127.0.0.2:6379"},
					UseSSH: true,
				})
			},
			want:  "Redis multi-node mode does not support SSH tunnels yet. Disable SSH and try again.",
			avoid: "多节点模式暂不支持 SSH 隧道",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			if err == nil {
				t.Fatal("expected error")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), tc.avoid) {
				t.Fatalf("expected no Chinese validation text %q, got %q", tc.avoid, err.Error())
			}
		})
	}
}

func TestRedisConnectFailureWrappersUseEnglishPrefixes(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cases := []struct {
		name       string
		config     connection.ConnectionConfig
		wantPrefix string
		avoid      string
	}{
		{
			name: "single",
			config: connection.ConnectionConfig{
				Type:    "redis",
				Host:    "127.0.0.1",
				Port:    1,
				Timeout: 1,
			},
			wantPrefix: "Redis connection failed: Attempt 1 connection failed: ",
			avoid:      "Redis 连接失败",
		},
		{
			name: "sentinel",
			config: connection.ConnectionConfig{
				Type:                "redis",
				Host:                "127.0.0.1",
				Port:                1,
				Timeout:             1,
				Topology:            "sentinel",
				RedisSentinelMaster: "mymaster",
			},
			wantPrefix: "Redis Sentinel connection failed: Attempt 1 connection failed: ",
			avoid:      "Redis Sentinel 连接失败",
		},
		{
			name: "cluster",
			config: connection.ConnectionConfig{
				Type:     "redis",
				Host:     "127.0.0.1",
				Port:     1,
				Timeout:  1,
				Topology: "cluster",
			},
			wantPrefix: "Redis Cluster connection failed: Attempt 1 connection failed: ",
			avoid:      "Redis 集群连接失败",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := NewRedisClient()
			err := client.Connect(tc.config)
			if err == nil {
				t.Fatal("expected connect error")
			}
			if !strings.HasPrefix(err.Error(), tc.wantPrefix) {
				t.Fatalf("expected prefix %q, got %q", tc.wantPrefix, err.Error())
			}
			if strings.Contains(err.Error(), tc.avoid) {
				t.Fatalf("expected no Chinese wrapper %q, got %q", tc.avoid, err.Error())
			}
		})
	}
}

func TestRedisExecuteCommandClusterSelectValidationUsesEnglishMessages(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	rawClient := goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:0"})
	client := &RedisClientImpl{
		client:    rawClient,
		isCluster: true,
	}
	t.Cleanup(func() {
		_ = client.Close()
	})

	cases := []struct {
		name  string
		args  []string
		want  string
		avoid string
	}{
		{
			name:  "missing database index",
			args:  []string{"SELECT"},
			want:  "SELECT command requires a database index",
			avoid: "SELECT 命令缺少数据库索引",
		},
		{
			name:  "invalid database index",
			args:  []string{"SELECT", "foo"},
			want:  "Invalid database index: foo",
			avoid: "无效数据库索引",
		},
		{
			name:  "database index out of range",
			args:  []string{"SELECT", "16"},
			want:  "Database index must be between 0 and 15",
			avoid: "数据库索引必须在",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := client.ExecuteCommand(tc.args)
			if err == nil {
				t.Fatalf("expected cluster SELECT validation error for args %#v", tc.args)
			}
			if err.Error() != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), tc.avoid) {
				t.Fatalf("expected no Chinese validation text %q, got %q", tc.avoid, err.Error())
			}
		})
	}
}

func TestRedisSelectDBClusterRangeUsesEnglishMessage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	rawClient := goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:0"})
	client := &RedisClientImpl{
		client:    rawClient,
		isCluster: true,
	}
	t.Cleanup(func() {
		_ = client.Close()
	})

	err := client.SelectDB(redisClusterLogicalDBCount)
	if err == nil {
		t.Fatalf("expected SelectDB to reject out-of-range cluster index %d", redisClusterLogicalDBCount)
	}
	const want = "Database index must be between 0 and 15"
	if err.Error() != want {
		t.Fatalf("expected %q, got %q", want, err.Error())
	}
	if strings.Contains(err.Error(), "数据库索引必须在") {
		t.Fatalf("expected no Chinese SelectDB validation text, got %q", err.Error())
	}
}

func TestRedisGetDatabasesUsesConfiguredDatabaseCountAboveDefault(t *testing.T) {
	keyspaceInfo := "# Keyspace\r\ndb0:keys=1,expires=0,avg_ttl=0\r\ndb31:keys=2,expires=0,avg_ttl=0\r\n"
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		command := strings.ToUpper(strings.TrimSpace(args[0]))
		switch command {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "CONFIG":
			if len(args) >= 3 && strings.EqualFold(args[1], "GET") && strings.EqualFold(args[2], "databases") {
				return "*2\r\n$9\r\ndatabases\r\n$2\r\n32\r\n"
			}
		case "INFO":
			return redisBulkString(keyspaceInfo)
		}
		return "+OK\r\n"
	})

	rawClient := goredis.NewClient(&goredis.Options{
		Addr:     addr,
		Protocol: 2,
	})
	client := &RedisClientImpl{
		client:       rawClient,
		singleClient: rawClient,
	}
	defer client.Close()

	dbs, err := client.GetDatabases()
	if err != nil {
		t.Fatalf("GetDatabases returned error: %v", err)
	}
	if len(dbs) != 32 {
		t.Fatalf("expected 32 redis databases, got %d (%#v)", len(dbs), dbs)
	}
	if dbs[31].Index != 31 || dbs[31].Keys != 2 {
		t.Fatalf("expected db31 with 2 keys, got %#v", dbs[31])
	}
}
