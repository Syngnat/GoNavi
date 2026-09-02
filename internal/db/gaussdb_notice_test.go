//go:build gonavi_full_drivers || gonavi_gaussdb_driver

package db

import (
	"context"
	"testing"

	"github.com/HuaweiCloudDeveloper/gaussdb-go/stdlib"
)

func TestGaussDBNoticeHandlerSkipsStdlibConn(t *testing.T) {
	for _, addNotice := range []func(string){func(string) {}, nil} {
		var panicVal interface{}
		func() {
			defer func() { panicVal = recover() }()
			setPostgresNoticeHandler(&stdlib.Conn{}, addNotice)
		}()
		if panicVal != nil {
			t.Fatalf("GaussDB stdlib.Conn 不应触发 notice handler panic: %v", panicVal)
		}
	}
}

func TestGaussDBQueryWithMessagesUsesPlainQueryForStdlibDriver(t *testing.T) {
	db := openFakeUserSchemaDB(t, "normal")
	client := &GaussDB{PostgresDB: PostgresDB{conn: db}}

	data, columns, messages, err := client.QueryContextWithMessages(context.Background(), "SELECT 1")
	if err != nil {
		t.Fatalf("GaussDB 查询失败: %v", err)
	}
	if len(data) != 1 || len(columns) != 1 || columns[0] != "nspname" {
		t.Fatalf("GaussDB 查询结果异常: data=%v columns=%v", data, columns)
	}
	if len(messages) != 0 {
		t.Fatalf("GaussDB 不应从 lib/pq 捕获消息: %v", messages)
	}

	session, err := client.OpenSessionExecer(context.Background())
	if err != nil {
		t.Fatalf("打开 GaussDB 会话失败: %v", err)
	}
	defer session.Close()

	messageSession, ok := session.(StatementQueryMessageExecer)
	if !ok {
		t.Fatalf("GaussDB 会话应保留消息查询接口")
	}
	_, _, messages, err = messageSession.QueryContextWithMessages(context.Background(), "SELECT 1")
	if err != nil {
		t.Fatalf("GaussDB 会话查询失败: %v", err)
	}
	if len(messages) != 0 {
		t.Fatalf("GaussDB 会话不应从 lib/pq 捕获消息: %v", messages)
	}
}
