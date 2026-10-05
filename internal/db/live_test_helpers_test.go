package db

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 实测用例共用的辅助函数：各数据源的 *_live_test.go 通过环境变量指向真实服务（见 deploy/datasource-lab）。

// liveAddrs 读取逗号分隔的 host:port 列表；为空时跳过实测。
func liveAddrs(t *testing.T, env string) []string {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv(env))
	if raw == "" {
		t.Skipf("set %s=host:port[,host:port] to run live smoke tests", env)
	}
	return strings.Split(raw, ",")
}

func liveConfig(t *testing.T, typ, addr, user, database string) connection.ConnectionConfig {
	t.Helper()
	host, portText, ok := strings.Cut(strings.TrimSpace(addr), ":")
	port, err := strconv.Atoi(portText)
	if !ok || err != nil {
		t.Fatalf("invalid address %q", addr)
	}
	return connection.ConnectionConfig{Type: typ, Host: host, Port: port, User: user, Database: database, Timeout: 15}
}

func mustExec(t *testing.T, client Database, statement string) {
	t.Helper()
	if _, err := client.Exec(statement); err != nil {
		t.Fatalf("exec %q: %v", statement, err)
	}
}
