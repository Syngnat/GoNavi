package app

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
	redislib "GoNavi-Wails/internal/redis"
	"GoNavi-Wails/internal/sqlaudit"
)

func TestRedisExecuteCommandFailureLogUsesRedactQuery(t *testing.T) {
	source, err := os.ReadFile("methods_redis.go")
	if err != nil {
		t.Fatalf("read methods_redis.go: %v", err)
	}
	fn := redisFunctionSource(t, string(source), "func (a *App) RedisExecuteCommand")
	if !strings.Contains(fn, "redisExecuteCommandFailureLogMessage") {
		t.Fatal("RedisExecuteCommand failure log does not use redisExecuteCommandFailureLogMessage")
	}
	if strings.Contains(fn, "logger.Error(err,") {
		t.Fatal("RedisExecuteCommand still logs the raw error chain")
	}
	if strings.Contains(fn, `"RedisExecuteCommand 执行失败：command=%s", command)`) {
		t.Fatal("RedisExecuteCommand still interpolates the raw command into the failure log")
	}
}

func TestRedisExecuteCommandFailureLogRedactsAuthAndHelloSecrets(t *testing.T) {
	tests := []struct {
		name    string
		command string
		want    string
		secrets []string
	}{
		{
			name:    "auth",
			command: "AUTH default auth-secret",
			want:    "AUTH ? ?",
			secrets: []string{"default", "auth-secret"},
		},
		{
			name:    "hello auth",
			command: "HELLO 3 AUTH app hello-secret SETNAME client-secret",
			want:    "HELLO 3 AUTH ? ? SETNAME ?",
			secrets: []string{"app", "hello-secret", "client-secret"},
		},
		{
			name:    "set keeps key",
			command: "SET session:key set-secret EX 60",
			want:    "SET session:key ?",
			secrets: []string{"set-secret", "60"},
		},
		{
			name:    "unparseable keeps verb only",
			command: `SET key "unterminated-secret`,
			want:    "SET",
			secrets: []string{"unterminated-secret"},
		},
		{
			name:    "unknown write keeps verb only",
			command: "CUSTOM.SET key custom-secret",
			want:    "CUSTOM.SET",
			secrets: []string{"key", "custom-secret"},
		},
		{
			name:    "config set",
			command: "CONFIG SET requirepass config-secret",
			want:    "CONFIG SET requirepass ?",
			secrets: []string{"config-secret"},
		},
		{
			name:    "acl setuser",
			command: "ACL SETUSER alice on >acl-secret",
			want:    "ACL SETUSER alice ?",
			secrets: []string{"acl-secret", "on"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := redactRedisCommandForLog(tt.command)
			if got != tt.want {
				t.Fatalf("redactRedisCommandForLog(%q)=%q, want %q", tt.command, got, tt.want)
			}
			if canonical := sqlaudit.RedactQuery("redis", tt.command); canonical != "" && got != canonical {
				t.Fatalf("redactRedisCommandForLog=%q diverged from RedactQuery=%q", got, canonical)
			}
			for _, secret := range tt.secrets {
				if strings.Contains(got, secret) {
					t.Fatalf("Redis failure log redaction leaked %q in %q", secret, got)
				}
			}
		})
	}
}

func TestRedisExecuteCommandFailureLogRedactsErrorChainSecrets(t *testing.T) {
	got := redisExecuteCommandFailureLogMessage(
		errors.New("ERR unknown command 'AUUTH', with args beginning with: 'default' 'auth-secret'"),
		"AUUTH default auth-secret",
	)
	for _, secret := range []string{"auth-secret", "default"} {
		if strings.Contains(got, secret) {
			t.Fatalf("failure log message leaked %q in %q", secret, got)
		}
	}
	if !strings.Contains(got, "command=AUUTH") {
		t.Fatalf("failure log message missing redacted command: %q", got)
	}
	if !strings.Contains(got, "错误链") {
		t.Fatalf("failure log message dropped error chain: %q", got)
	}
}

func TestRedisExecuteCommandFailureLogWritesRedactedCommandToDisk(t *testing.T) {
	const helperEnv = "GONAVI_REDIS_FAILURE_LOG_HELPER"
	if os.Getenv(helperEnv) == "1" {
		runRedisExecuteCommandFailureLogHelper(t)
		return
	}

	tests := []struct {
		name       string
		command    string
		executeErr string
		wantPart   string
		secrets    []string
	}{
		{
			name:       "auth",
			command:    "AUTH default auth-secret",
			executeErr: "WRONGPASS invalid username-password pair",
			wantPart:   "command=AUTH ? ?",
			secrets:    []string{"default", "auth-secret"},
		},
		{
			name:       "hello auth",
			command:    "HELLO 3 AUTH app hello-secret SETNAME client-secret",
			executeErr: "ERR Protocol error",
			wantPart:   "command=HELLO 3 AUTH ? ? SETNAME ?",
			secrets:    []string{"app", "hello-secret", "client-secret"},
		},
		{
			name:       "set keeps key",
			command:    "SET session:key set-secret EX 60",
			executeErr: "READONLY You can't write against a read only replica",
			wantPart:   "command=SET session:key ?",
			secrets:    []string{"set-secret"},
		},
		{
			name:       "unknown command echo",
			command:    "AUUTH default auth-secret",
			executeErr: "ERR unknown command 'AUUTH', with args beginning with: 'default' 'auth-secret'",
			wantPart:   "command=AUUTH",
			secrets:    []string{"auth-secret"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logDir := t.TempDir()
			cmd := exec.Command(os.Args[0], "-test.run=^TestRedisExecuteCommandFailureLogWritesRedactedCommandToDisk$")
			cmd.Env = append(os.Environ(),
				helperEnv+"=1",
				"GONAVI_LOG_DIR="+logDir,
				"GONAVI_REDIS_FAILURE_LOG_COMMAND="+tt.command,
				"GONAVI_REDIS_FAILURE_LOG_ERROR="+tt.executeErr,
			)
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("helper process failed: %v\n%s", err, output)
			}
			body, err := os.ReadFile(filepath.Join(logDir, "gonavi.log"))
			if err != nil {
				t.Fatalf("read gonavi.log: %v", err)
			}
			got := string(body)
			if !strings.Contains(got, tt.wantPart) {
				t.Fatalf("disk log missing %q in %q", tt.wantPart, got)
			}
			if !strings.Contains(got, "错误链") {
				t.Fatalf("disk log dropped error chain: %q", got)
			}
			for _, secret := range tt.secrets {
				if strings.Contains(got, secret) {
					t.Fatalf("disk log leaked %q in %q", secret, got)
				}
			}
		})
	}
}

func runRedisExecuteCommandFailureLogHelper(t *testing.T) {
	t.Helper()
	command := os.Getenv("GONAVI_REDIS_FAILURE_LOG_COMMAND")
	executeErr := os.Getenv("GONAVI_REDIS_FAILURE_LOG_ERROR")
	if command == "" || executeErr == "" {
		t.Fatal("helper missing GONAVI_REDIS_FAILURE_LOG_COMMAND or GONAVI_REDIS_FAILURE_LOG_ERROR")
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	CloseAllRedisClients()
	client := &redisExecuteErrorClient{executeErr: errors.New(executeErr)}
	originalNewRedisClientFunc := newRedisClientFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	defer func() {
		newRedisClientFunc = originalNewRedisClientFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		CloseAllRedisClients()
		logger.Close()
	}()
	newRedisClientFunc = func() redislib.RedisClient {
		return client
	}
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	result := app.RedisExecuteCommand(connection.ConnectionConfig{
		Type: "redis",
		Host: "redis.local",
		Port: 6379,
	}, command)
	if result.Success {
		t.Fatalf("expected RedisExecuteCommand to fail, got %+v", result)
	}
}
