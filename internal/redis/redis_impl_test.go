package redis

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/ssh"
	"GoNavi-Wails/shared/i18n"
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	goredis "github.com/redis/go-redis/v9"
	"io"
	"math"
	"math/big"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func startRedisProtocolTestServer(t *testing.T, handler func([]string) string) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen redis test server failed: %v", err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
	})

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				reader := bufio.NewReader(conn)
				for {
					args, err := readRedisProtocolArray(reader)
					if err != nil {
						return
					}
					response := handler(args)
					if response == "" {
						response = "+OK\r\n"
					}
					if _, err := conn.Write([]byte(response)); err != nil {
						return
					}
				}
			}()
		}
	}()

	return listener.Addr().String()
}

func TestLocalizedRedisSSHForwarderFailurePreservesHostKeyTrustCause(t *testing.T) {
	required := &ssh.HostKeyTrustRequiredError{Status: ssh.HostKeyTrustStatus{
		State:       "unknown",
		Host:        "bastion.internal.test",
		Port:        22,
		Address:     "bastion.internal.test:22",
		Fingerprint: "SHA256:example",
	}}
	err := localizedRedisBackendErrorWithCause("redis.backend.error.ssh_tunnel_create_failed", map[string]any{
		"detail": required.Error(),
	}, required)

	var actual *ssh.HostKeyTrustRequiredError
	if !errors.As(err, &actual) {
		t.Fatalf("errors.As(%T) did not retain HostKeyTrustRequiredError: %v", err, err)
	}
	if actual != required {
		t.Fatalf("retained cause = %p, want %p", actual, required)
	}
}

func readRedisProtocolArray(reader *bufio.Reader) ([]string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "*") {
		return nil, fmt.Errorf("expected array, got %q", line)
	}
	count, err := strconv.Atoi(strings.TrimPrefix(line, "*"))
	if err != nil {
		return nil, err
	}
	args := make([]string, 0, count)
	for i := 0; i < count; i++ {
		bulkHeader, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		bulkHeader = strings.TrimSpace(bulkHeader)
		if !strings.HasPrefix(bulkHeader, "$") {
			return nil, fmt.Errorf("expected bulk string, got %q", bulkHeader)
		}
		size, err := strconv.Atoi(strings.TrimPrefix(bulkHeader, "$"))
		if err != nil {
			return nil, err
		}
		buf := make([]byte, size+2)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return nil, err
		}
		args = append(args, string(buf[:size]))
	}
	return args, nil
}

func redisBulkString(value string) string {
	return fmt.Sprintf("$%d\r\n%s\r\n", len(value), value)
}

func TestScanKeysKeepsEntireRedisScanBatch(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			return "*2\r\n$2\r\n42\r\n*3\r\n$5\r\nalpha\r\n$4\r\nbeta\r\n$5\r\ngamma\r\n"
		case "TYPE":
			return "+string\r\n"
		case "TTL":
			return ":-1\r\n"
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

	result, err := client.ScanKeys("*", 0, 1)
	if err != nil {
		t.Fatalf("ScanKeys returned error: %v", err)
	}
	if result.Cursor != "42" {
		t.Fatalf("expected next cursor 42, got %q", result.Cursor)
	}
	if len(result.Keys) != 3 {
		t.Fatalf("expected all 3 keys from the Redis SCAN batch, got %#v", result.Keys)
	}
	for index, key := range []string{"alpha", "beta", "gamma"} {
		if result.Keys[index].Key != key {
			t.Fatalf("expected key %q at index %d, got %#v", key, index, result.Keys)
		}
	}
}

// 回归保护：HGETALL 在 RESP3 下返回 map[interface{}]interface{}（go-redis v9 默认 RESP3），
// 这种类型 encoding/json 无法序列化，原值穿透到 Wails RPC 会让 Windows 进程退出（用户感知闪退）。
// formatCommandResult 必须把 map 平展成交错 [k1, v1, k2, v2, ...] array，前端按 array 渲染。
func TestFormatCommandResultFlattensRESP3MapForJSONMarshal(t *testing.T) {
	input := map[interface{}]interface{}{
		"name": "alice",
		"age":  "30",
	}
	got := formatCommandResult(input)

	arr, ok := got.([]interface{})
	if !ok {
		t.Fatalf("expected flattened []interface{}, got %T (%#v)", got, got)
	}
	if len(arr) != 4 {
		t.Fatalf("expected 4 elements (2 pairs flattened), got %d: %#v", len(arr), arr)
	}

	// 平展后必须能被 encoding/json 序列化——这是修复的根本目的
	if _, err := json.Marshal(arr); err != nil {
		t.Fatalf("flattened result must be JSON-marshalable, got error: %v", err)
	}

	// 验证 key+value 都保留下来了（顺序由 map 遍历决定，不强断言顺序）
	collected := make([]string, 0, 4)
	for _, item := range arr {
		s, ok := item.(string)
		if !ok {
			t.Fatalf("expected string element, got %T", item)
		}
		collected = append(collected, s)
	}
	sort.Strings(collected)
	want := []string{"30", "age", "alice", "name"}
	for i, w := range want {
		if collected[i] != w {
			t.Fatalf("flattened content mismatch at %d: got %q want %q (all=%v)", i, collected[i], w, collected)
		}
	}
}

// 嵌套 array 内含 map[interface{}]interface{} 也要递归平展，
// 保证 XINFO STREAM 等返回嵌套结构的命令不会卡在序列化阶段。
func TestFormatCommandResultRecursivelyFlattensNestedMap(t *testing.T) {
	input := []interface{}{
		"stream-id",
		map[interface{}]interface{}{"k": "v"},
	}
	got := formatCommandResult(input)
	arr, ok := got.([]interface{})
	if !ok || len(arr) != 2 {
		t.Fatalf("expected []interface{} of length 2, got %#v", got)
	}
	nested, ok := arr[1].([]interface{})
	if !ok {
		t.Fatalf("expected nested map to be flattened to []interface{}, got %T", arr[1])
	}
	if _, err := json.Marshal(arr); err != nil {
		t.Fatalf("recursively flattened result must be JSON-marshalable, got error: %v", err)
	}
	_ = nested
}

// 已经是 string-key 简单类型的命令（HGET、SET 之类）不应被改变。
func TestFormatCommandResultPreservesScalarAndByteSlice(t *testing.T) {
	if got := formatCommandResult("ok"); got != "ok" {
		t.Fatalf("string scalar should pass through, got %v", got)
	}
	if got := formatCommandResult([]byte("ok")); got != "ok" {
		t.Fatalf("[]byte should be converted to string, got %v", got)
	}
	if got := formatCommandResult(int64(42)); got != int64(42) {
		t.Fatalf("int64 scalar should pass through, got %v", got)
	}
}

func TestFormatCommandResultRecursivelyFormatsStringKeyMapValues(t *testing.T) {
	input := map[string]interface{}{
		"nestedMap": map[interface{}]interface{}{"k": "v"},
		"bytes":     []byte("ok"),
	}

	got := formatCommandResult(input)
	formatted, ok := got.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map[string]interface{}, got %T (%#v)", got, got)
	}
	if formatted["bytes"] != "ok" {
		t.Fatalf("expected []byte value converted to string, got %#v", formatted["bytes"])
	}
	if _, ok := formatted["nestedMap"].([]interface{}); !ok {
		t.Fatalf("expected nested RESP3 map to be flattened, got %T", formatted["nestedMap"])
	}
	if _, err := json.Marshal(formatted); err != nil {
		t.Fatalf("formatted string-key map must be JSON-marshalable, got error: %v", err)
	}
}

func TestFormatCommandResultFormatsJSONUnsupportedScalars(t *testing.T) {
	input := []interface{}{
		math.Inf(1),
		math.Inf(-1),
		math.NaN(),
		big.NewInt(1234567890123456789),
		errors.New("redis nested error"),
	}

	got := formatCommandResult(input)
	arr, ok := got.([]interface{})
	if !ok || len(arr) != len(input) {
		t.Fatalf("expected formatted array of length %d, got %#v", len(input), got)
	}
	for i, item := range arr {
		if _, ok := item.(string); !ok {
			t.Fatalf("expected item %d to be string after formatting, got %T (%#v)", i, item, item)
		}
	}
	if _, err := json.Marshal(arr); err != nil {
		t.Fatalf("formatted unsupported scalars must be JSON-marshalable, got error: %v", err)
	}
}

func TestFormatCommandResultFormatsGenericMapsAndSlices(t *testing.T) {
	input := map[int][]byte{
		1: []byte("one"),
	}

	got := formatCommandResult(input)
	arr, ok := got.([]interface{})
	if !ok || len(arr) != 2 {
		t.Fatalf("expected generic non-string map to be flattened into 2 elements, got %#v", got)
	}
	if _, err := json.Marshal(arr); err != nil {
		t.Fatalf("formatted generic map must be JSON-marshalable, got error: %v", err)
	}
}

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

func TestListPushUsesRPushWithAllValues(t *testing.T) {
	commandCh := make(chan []string, 1)
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "RPUSH":
			commandCh <- append([]string(nil), args...)
			return ":2\r\n"
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

	if err := client.ListPush("tasks", "review", "ship"); err != nil {
		t.Fatalf("ListPush returned error: %v", err)
	}

	select {
	case command := <-commandCh:
		if len(command) != 4 || command[1] != "tasks" || command[2] != "review" || command[3] != "ship" {
			t.Fatalf("unexpected RPUSH command: %v", command)
		}
	case <-time.After(time.Second):
		t.Fatal("expected RPUSH command")
	}
}

func TestListPushLeftUsesLPushWithAllValues(t *testing.T) {
	commandCh := make(chan []string, 1)
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "LPUSH":
			commandCh <- append([]string(nil), args...)
			return ":2\r\n"
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

	if err := client.ListPushLeft("tasks", "review", "ship"); err != nil {
		t.Fatalf("ListPushLeft returned error: %v", err)
	}

	select {
	case command := <-commandCh:
		if len(command) != 4 || command[1] != "tasks" || command[2] != "review" || command[3] != "ship" {
			t.Fatalf("unexpected LPUSH command: %v", command)
		}
	case <-time.After(time.Second):
		t.Fatal("expected LPUSH command")
	}
}

func TestListRemoveAtUsesAtomicEvalWithPhysicalKeyAndExpectedValue(t *testing.T) {
	commandCh := make(chan []string, 1)
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "EVAL":
			commandCh <- append([]string(nil), args...)
			return ":1\r\n"
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
		isCluster:    true,
		currentDB:    3,
	}
	defer client.Close()

	if err := client.ListRemoveAt("tasks", 3, "review"); err != nil {
		t.Fatalf("ListRemoveAt returned error: %v", err)
	}

	select {
	case command := <-commandCh:
		if len(command) != 7 {
			t.Fatalf("unexpected EVAL command length: %v", command)
		}
		if command[2] != "1" || command[3] != "__gonavi_db_3__:tasks" {
			t.Fatalf("expected one physical Redis key, got %v", command)
		}
		if command[4] != "3" || command[5] != "review" {
			t.Fatalf("expected index and value arguments, got %v", command)
		}
		if !strings.HasPrefix(command[6], "\x00gonavi:list-remove:") {
			t.Fatalf("expected collision-resistant marker prefix, got %q", command[6])
		}
		for _, redisCommand := range []string{"LINDEX", "LSET", "LREM"} {
			if !strings.Contains(strings.ToUpper(command[1]), redisCommand) {
				t.Fatalf("expected script to contain %s, got %q", redisCommand, command[1])
			}
		}
		if !strings.Contains(command[1], `redis.pcall("LREM"`) ||
			!strings.Contains(command[1], `redis.pcall("LSET"`) ||
			!strings.Contains(command[1], "rollback failed") {
			t.Fatalf("expected script to restore the selected item after a removal error, got %q", command[1])
		}
	case <-time.After(time.Second):
		t.Fatal("expected EVAL command")
	}
}

func TestListRemoveAtReturnsItemChangedWhenIndexNoLongerMatches(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "EVAL":
			return ":0\r\n"
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

	err := client.ListRemoveAt("tasks", 3, "review")
	if !errors.Is(err, ErrRedisListItemChanged) {
		t.Fatalf("expected ErrRedisListItemChanged, got %v", err)
	}
}

func TestListRemoveAtRejectsUnexpectedScriptResult(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "EVAL":
			return ":2\r\n"
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

	err := client.ListRemoveAt("tasks", 3, "review")
	if err == nil {
		t.Fatal("expected unexpected script result to fail")
	}
	if errors.Is(err, ErrRedisListItemChanged) {
		t.Fatalf("expected protocol error, got item-changed sentinel: %v", err)
	}
}

func TestRedisSearchScanContinuesPastEmptyMatchedPages(t *testing.T) {
	var mu sync.Mutex
	scanCalls := 0
	const searchPattern = "*[lL][aA][tT][eE]*"

	redisScanResponse := func(cursor string, keys ...string) string {
		var builder strings.Builder
		builder.WriteString("*2\r\n")
		builder.WriteString(redisBulkString(cursor))
		builder.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
		for _, key := range keys {
			builder.WriteString(redisBulkString(key))
		}
		return builder.String()
	}

	addr := startRedisProtocolTestServer(t, func(args []string) string {
		command := strings.ToUpper(strings.TrimSpace(args[0]))
		switch command {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			mu.Lock()
			defer mu.Unlock()
			scanCalls++
			for i := 0; i+1 < len(args); i++ {
				if strings.EqualFold(args[i], "MATCH") && args[i+1] != searchPattern {
					t.Fatalf("expected SCAN MATCH %q, got command %v", searchPattern, args)
				}
			}
			if scanCalls <= 16 {
				return redisScanResponse(strconv.Itoa(scanCalls))
			}
			return redisScanResponse("0", "late:user:1")
		case "TYPE":
			return "+string\r\n"
		case "TTL":
			return ":-1\r\n"
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

	result, err := client.ScanKeys(searchPattern, 0, 10)
	if err != nil {
		t.Fatalf("ScanKeys returned error: %v", err)
	}
	if result == nil || len(result.Keys) != 1 {
		t.Fatalf("expected one searched key after empty pages, got %#v", result)
	}
	if result.Keys[0].Key != "late:user:1" {
		t.Fatalf("expected late:user:1, got %#v", result.Keys[0])
	}
	if result.Cursor != "0" {
		t.Fatalf("expected completed cursor, got %q", result.Cursor)
	}

	mu.Lock()
	defer mu.Unlock()
	if scanCalls <= 16 {
		t.Fatalf("expected ScanKeys to continue past 16 empty search pages, got %d calls", scanCalls)
	}
}

func TestRedisSearchScanPaginatesMoreThanOneThousandKeys(t *testing.T) {
	var mu sync.Mutex
	scanCalls := 0
	const searchPattern = "matched:*"

	redisScanResponse := func(cursor string, keys ...string) string {
		var builder strings.Builder
		builder.WriteString("*2\r\n")
		builder.WriteString(redisBulkString(cursor))
		builder.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
		for _, key := range keys {
			builder.WriteString(redisBulkString(key))
		}
		return builder.String()
	}

	firstBatch := make([]string, 1000)
	for i := range firstBatch {
		firstBatch[i] = fmt.Sprintf("matched:%d", i)
	}

	addr := startRedisProtocolTestServer(t, func(args []string) string {
		command := strings.ToUpper(strings.TrimSpace(args[0]))
		switch command {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			mu.Lock()
			defer mu.Unlock()
			scanCalls++
			if scanCalls == 1 {
				if args[1] != "0" {
					t.Fatalf("expected initial cursor 0, got %q", args[1])
				}
				return redisScanResponse("1", firstBatch...)
			}
			if args[1] != "1" {
				t.Fatalf("expected continuation cursor 1, got %q", args[1])
			}
			return redisScanResponse("0", "matched:1000")
		case "TYPE":
			return "+string\r\n"
		case "TTL":
			return ":-1\r\n"
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

	firstResult, err := client.ScanKeys(searchPattern, 0, redisScanDefaultTargetCount)
	if err != nil {
		t.Fatalf("first ScanKeys returned error: %v", err)
	}
	if firstResult == nil || len(firstResult.Keys) != 1000 || firstResult.Cursor != "1" {
		t.Fatalf("expected first 1000 keys with continuation cursor, got %#v", firstResult)
	}

	secondResult, err := client.ScanKeys(searchPattern, 1, redisScanDefaultTargetCount)
	if err != nil {
		t.Fatalf("second ScanKeys returned error: %v", err)
	}
	if secondResult == nil || len(secondResult.Keys) != 1 || secondResult.Cursor != "0" {
		t.Fatalf("expected final searched key with completed cursor, got %#v", secondResult)
	}

	mu.Lock()
	defer mu.Unlock()
	if scanCalls != 2 {
		t.Fatalf("expected exactly two paged SCAN calls, got %d", scanCalls)
	}
}

func newRedisProtocolClusterClient(t *testing.T, addrs ...string) *goredis.ClusterClient {
	t.Helper()
	slots := make([]goredis.ClusterSlot, 0, len(addrs))
	for index, addr := range addrs {
		start := index * 16384 / len(addrs)
		end := (index+1)*16384/len(addrs) - 1
		slots = append(slots, goredis.ClusterSlot{
			Start: start,
			End:   end,
			Nodes: []goredis.ClusterNode{{Addr: addr}},
		})
	}
	client := goredis.NewClusterClient(&goredis.ClusterOptions{
		ClusterSlots: func(context.Context) ([]goredis.ClusterSlot, error) {
			return slots, nil
		},
		Protocol:              2,
		ContextTimeoutEnabled: true,
	})
	t.Cleanup(func() {
		_ = client.Close()
	})
	return client
}

func TestRedisClusterConnectEnablesContextTimeouts(t *testing.T) {
	var addr string
	addr = startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "CLUSTER":
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				t.Fatalf("split cluster test address: %v", err)
			}
			return fmt.Sprintf("*1\r\n*3\r\n:0\r\n:16383\r\n*3\r\n%s%s%s", redisBulkString(host), redisBulkString(port), redisBulkString("node-1"))
		case "PING":
			return "+PONG\r\n"
		}
		return "+OK\r\n"
	})
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split cluster test address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse cluster test port: %v", err)
	}

	client := &RedisClientImpl{}
	if err := client.Connect(connection.ConnectionConfig{
		Type:     "redis",
		Host:     host,
		Port:     port,
		Topology: "cluster",
		Timeout:  2,
	}); err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}
	defer client.Close()

	if client.clusterClient == nil || !client.clusterClient.Options().ContextTimeoutEnabled {
		t.Fatalf("expected production cluster client to enable context timeouts")
	}
}

func TestRedisClusterSearchScansEveryMasterToCompletion(t *testing.T) {
	var mu sync.Mutex
	scanCalls := map[string]int{}
	redisScanResponse := func(cursor string, keys ...string) string {
		var builder strings.Builder
		builder.WriteString("*2\r\n")
		builder.WriteString(redisBulkString(cursor))
		builder.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
		for _, key := range keys {
			builder.WriteString(redisBulkString(key))
		}
		return builder.String()
	}
	startNode := func(name string, pages []string) string {
		return startRedisProtocolTestServer(t, func(args []string) string {
			switch strings.ToUpper(strings.TrimSpace(args[0])) {
			case "HELLO":
				return "-ERR unknown command 'HELLO'\r\n"
			case "CLIENT":
				return "-ERR unknown subcommand\r\n"
			case "SCAN":
				mu.Lock()
				page := scanCalls[name]
				scanCalls[name]++
				mu.Unlock()
				if page >= len(pages) {
					t.Fatalf("unexpected extra SCAN on %s", name)
				}
				if page+1 < len(pages) {
					return redisScanResponse(strconv.Itoa(page+1), pages[page])
				}
				return redisScanResponse("0", pages[page])
			case "TYPE":
				return "+string\r\n"
			case "TTL":
				return ":-1\r\n"
			}
			return "+OK\r\n"
		})
	}

	firstAddr := startNode("first", []string{"matched:first:1", "matched:first:2"})
	secondAddr := startNode("second", []string{"matched:second:1", "matched:second:2"})
	clusterClient := newRedisProtocolClusterClient(t, firstAddr, secondAddr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("matched:*", 0, 1)
	if err != nil {
		t.Fatalf("ScanKeys returned error: %v", err)
	}
	if result == nil || len(result.Keys) != 4 {
		t.Fatalf("expected all four cluster search results, got %#v", result)
	}
	if result.Cursor != "0" {
		t.Fatalf("expected completed cluster cursor, got %q", result.Cursor)
	}

	mu.Lock()
	defer mu.Unlock()
	if scanCalls["first"] != 2 || scanCalls["second"] != 2 {
		t.Fatalf("expected every master to reach cursor 0, got %#v", scanCalls)
	}
}

func TestRedisClusterExactSearchKeepsTargetCountLimit(t *testing.T) {
	keys := make([]string, redisSearchMaxResultCount+1)
	for i := range keys {
		keys[i] = fmt.Sprintf("folder:item:%d", i)
	}
	var response strings.Builder
	response.WriteString("*2\r\n$1\r\n0\r\n")
	response.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
	for _, key := range keys {
		response.WriteString(redisBulkString(key))
	}

	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			return response.String()
		case "TYPE":
			return "+string\r\n"
		case "TTL":
			return ":-1\r\n"
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("folder", 0, 2)
	if err != nil {
		t.Fatalf("ScanKeys returned error: %v", err)
	}
	if result == nil || len(result.Keys) != 2 {
		t.Fatalf("expected exact search to keep the target count, got %#v", result)
	}
}

func TestRedisClusterSearchKeepsEntireScanBatch(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			return "*2\r\n$1\r\n0\r\n*2\r\n$15\r\nmatched:first:1\r\n$15\r\nmatched:first:2\r\n"
		case "TYPE":
			return "+string\r\n"
		case "TTL":
			return ":-1\r\n"
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("matched:*", 0, 1)
	if err != nil {
		t.Fatalf("ScanKeys returned error: %v", err)
	}
	if result == nil || len(result.Keys) != 2 {
		t.Fatalf("expected the entire Redis SCAN batch, got %#v", result)
	}
}

func TestRedisClusterSearchRejectsResultsOverSafetyLimit(t *testing.T) {
	keys := make([]string, redisSearchMaxResultCount+1)
	for i := range keys {
		keys[i] = fmt.Sprintf("matched:%d", i)
	}
	var response strings.Builder
	response.WriteString("*2\r\n$1\r\n0\r\n")
	response.WriteString(fmt.Sprintf("*%d\r\n", len(keys)))
	for _, key := range keys {
		response.WriteString(redisBulkString(key))
	}

	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			return response.String()
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("matched:*", 0, redisScanDefaultTargetCount)
	if err == nil || !strings.Contains(err.Error(), strconv.Itoa(redisSearchMaxResultCount)) {
		t.Fatalf("expected safety-limit error, got result=%#v err=%v", result, err)
	}
}

func TestRedisClusterSearchHonorsSharedDeadline(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			time.Sleep(redisSearchMaxDuration + 2*time.Second)
			return "*2\r\n$1\r\n0\r\n*0\r\n"
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	startedAt := time.Now()
	result, err := client.ScanKeys("matched:*", 0, 10)
	elapsed := time.Since(startedAt)
	if err == nil {
		t.Fatalf("expected cluster search deadline error, got result %#v", result)
	}
	if elapsed >= redisSearchMaxDuration+time.Second {
		t.Fatalf("expected shared %s deadline, elapsed %s", redisSearchMaxDuration, elapsed)
	}
}

func TestRedisClusterSearchReturnsMetadataErrors(t *testing.T) {
	addr := startRedisProtocolTestServer(t, func(args []string) string {
		switch strings.ToUpper(strings.TrimSpace(args[0])) {
		case "HELLO":
			return "-ERR unknown command 'HELLO'\r\n"
		case "CLIENT":
			return "-ERR unknown subcommand\r\n"
		case "SCAN":
			return "*2\r\n$1\r\n0\r\n*1\r\n$13\r\nmatched:first\r\n"
		case "TYPE":
			return "-ERR TYPE forbidden\r\n"
		case "TTL":
			return ":-1\r\n"
		}
		return "+OK\r\n"
	})
	clusterClient := newRedisProtocolClusterClient(t, addr)
	client := &RedisClientImpl{
		client:        clusterClient,
		clusterClient: clusterClient,
		isCluster:     true,
	}

	result, err := client.ScanKeys("matched:*", 0, 10)
	if err == nil {
		t.Fatalf("expected metadata error, got result %#v", result)
	}
}

func TestRedisSelectDBReconnectsWithSentinelConfig(t *testing.T) {
	oldConnect := redisDBSwitchConnect
	defer func() {
		redisDBSwitchConnect = oldConnect
	}()

	var captured connection.ConnectionConfig
	redisDBSwitchConnect = func(client *RedisClientImpl, config connection.ConnectionConfig) error {
		captured = config
		next := goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:0"})
		client.client = next
		client.singleClient = next
		client.config = config
		client.currentDB = config.RedisDB
		return nil
	}

	oldClient := goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:0"})
	client := &RedisClientImpl{
		client:       oldClient,
		singleClient: oldClient,
		config: connection.ConnectionConfig{
			Type:                  "redis",
			Host:                  "sentinel-a.local",
			Port:                  26379,
			Hosts:                 []string{"sentinel-b.local:26379", "sentinel-c.local:26379"},
			Topology:              "sentinel",
			User:                  "data-user",
			Password:              "data-pass",
			RedisSentinelMaster:   "mymaster",
			RedisSentinelUser:     "sentinel-user",
			RedisSentinelPassword: "sentinel-pass",
			UseSSL:                true,
			SSLMode:               "required",
			RedisDB:               0,
		},
		currentDB: 0,
	}
	defer client.Close()

	if err := client.SelectDB(31); err != nil {
		t.Fatalf("SelectDB returned error: %v", err)
	}

	if captured.RedisDB != 31 || client.currentDB != 31 {
		t.Fatalf("expected RedisDB/currentDB=31, captured=%d current=%d", captured.RedisDB, client.currentDB)
	}
	if captured.Topology != "sentinel" {
		t.Fatalf("expected sentinel topology to be preserved, got %q", captured.Topology)
	}
	if captured.RedisSentinelMaster != "mymaster" {
		t.Fatalf("expected Sentinel master to be preserved, got %q", captured.RedisSentinelMaster)
	}
	if captured.RedisSentinelUser != "sentinel-user" || captured.RedisSentinelPassword != "sentinel-pass" {
		t.Fatalf("expected Sentinel credentials to be preserved, got user=%q password=%q", captured.RedisSentinelUser, captured.RedisSentinelPassword)
	}
	if len(captured.Hosts) != 2 || captured.Hosts[0] != "sentinel-b.local:26379" || captured.Hosts[1] != "sentinel-c.local:26379" {
		t.Fatalf("expected Sentinel hosts to be preserved, got %#v", captured.Hosts)
	}
	if !captured.UseSSL || captured.SSLMode != "required" {
		t.Fatalf("expected TLS settings to be preserved, got useSSL=%v sslMode=%q", captured.UseSSL, captured.SSLMode)
	}
}

func TestIsRedisKeyGone(t *testing.T) {
	tests := []struct {
		name    string
		keyType string
		ttl     int64
		want    bool
	}{
		{name: "type none", keyType: "none", ttl: -2, want: true},
		{name: "type none without ttl", keyType: "none", ttl: -1, want: true},
		{name: "missing by ttl", keyType: "string", ttl: -2, want: true},
		{name: "normal string", keyType: "string", ttl: 30, want: false},
		{name: "permanent hash", keyType: "hash", ttl: -1, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isRedisKeyGone(tt.keyType, tt.ttl); got != tt.want {
				t.Fatalf("isRedisKeyGone(%q, %d)=%v, want %v", tt.keyType, tt.ttl, got, tt.want)
			}
		})
	}
}

func TestNormalizeRedisGetValueError(t *testing.T) {
	err := normalizeRedisGetValueError("none", -2)
	if !errors.Is(err, ErrRedisKeyGone) {
		t.Fatalf("expected ErrRedisKeyGone, got %v", err)
	}
	if err == nil || err.Error() != "Redis Key 不存在或已过期" {
		t.Fatalf("unexpected error text: %v", err)
	}

	if normalizeRedisGetValueError("hash", -1) != nil {
		t.Fatal("expected nil for supported existing key")
	}
}

func TestRedisGlobPatternLiteralKey(t *testing.T) {
	tests := []struct {
		name      string
		pattern   string
		wantKey   string
		wantExact bool
	}{
		{name: "plain exact key", pattern: "Agent", wantKey: "Agent", wantExact: true},
		{name: "escaped glob characters stay literal", pattern: `user:\*:\[id\]\?\\raw`, wantKey: `user:*:[id]?\raw`, wantExact: true},
		{name: "fuzzy wildcard is not exact", pattern: "*[aA][gG][eE][nN][tT]*", wantExact: false},
		{name: "unescaped suffix wildcard is not exact", pattern: "Agent*", wantExact: false},
		{name: "unescaped single character wildcard is not exact", pattern: "Agent?", wantExact: false},
		{name: "unescaped character class is not exact", pattern: "Agent[0-9]", wantExact: false},
		{name: "empty pattern is not exact", pattern: "", wantExact: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotKey, gotExact := redisGlobPatternLiteralKey(tt.pattern)
			if gotExact != tt.wantExact {
				t.Fatalf("redisGlobPatternLiteralKey(%q) exact=%v, want %v", tt.pattern, gotExact, tt.wantExact)
			}
			if gotKey != tt.wantKey {
				t.Fatalf("redisGlobPatternLiteralKey(%q) key=%q, want %q", tt.pattern, gotKey, tt.wantKey)
			}
		})
	}
}

func TestRedisExactSearchPattern(t *testing.T) {
	tests := []struct {
		name          string
		literalKey    string
		wantExactKey  string
		wantNamespace string
	}{
		{
			name:          "plain namespace folder",
			literalKey:    "Agent",
			wantExactKey:  "Agent",
			wantNamespace: "Agent:*",
		},
		{
			name:          "escaped namespace keeps glob chars literal",
			literalKey:    `user:*:[id]?\raw`,
			wantExactKey:  `user:*:[id]?\raw`,
			wantNamespace: `user:\*:\[id\]\?\\raw:*`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotExactKey, gotNamespace := redisExactSearchPattern(tt.literalKey)
			if gotExactKey != tt.wantExactKey {
				t.Fatalf("redisExactSearchPattern(%q) exactKey=%q, want %q", tt.literalKey, gotExactKey, tt.wantExactKey)
			}
			if gotNamespace != tt.wantNamespace {
				t.Fatalf("redisExactSearchPattern(%q) namespace=%q, want %q", tt.literalKey, gotNamespace, tt.wantNamespace)
			}
		})
	}
}

func TestReadRedisHashEntriesWithFallbackUsesHScanWhenHGetAllForbidden(t *testing.T) {
	scanCalls := 0
	values, length, err := readRedisHashEntriesWithFallback(
		func() (map[string]string, error) {
			return nil, errors.New("ERR command 'HGETALL' not support for normal user")
		},
		func() (int64, error) {
			return 2, nil
		},
		func(cursor uint64, count int64) ([]string, uint64, error) {
			scanCalls++
			if cursor != 0 {
				t.Fatalf("expected first scan cursor to be 0, got %d", cursor)
			}
			if count <= 0 {
				t.Fatalf("expected positive scan count, got %d", count)
			}
			return []string{"field-a", "value-a", "field-b", "value-b"}, 0, nil
		},
	)
	if err != nil {
		t.Fatalf("readRedisHashEntriesWithFallback() unexpected error: %v", err)
	}
	if scanCalls != 1 {
		t.Fatalf("expected exactly one HSCAN fallback, got %d", scanCalls)
	}
	if length != 2 {
		t.Fatalf("expected hash length 2, got %d", length)
	}
	if got := values["field-a"]; got != "value-a" {
		t.Fatalf("expected field-a=value-a, got %q", got)
	}
	if got := values["field-b"]; got != "value-b" {
		t.Fatalf("expected field-b=value-b, got %q", got)
	}
}

func TestReadRedisHashEntriesWithFallbackReturnsOriginalErrorForNonPermissionFailure(t *testing.T) {
	expectedErr := errors.New("ERR wrong type")
	_, _, err := readRedisHashEntriesWithFallback(
		func() (map[string]string, error) {
			return nil, expectedErr
		},
		func() (int64, error) {
			t.Fatal("expected HLEN not to run for non-permission failure")
			return 0, nil
		},
		func(cursor uint64, count int64) ([]string, uint64, error) {
			t.Fatal("expected HSCAN not to run for non-permission failure")
			return nil, 0, nil
		},
	)
	if !errors.Is(err, expectedErr) {
		t.Fatalf("expected original error %v, got %v", expectedErr, err)
	}
}
