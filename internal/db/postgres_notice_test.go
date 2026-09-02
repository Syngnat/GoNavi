package db

import (
	"context"
	"testing"
)

func TestQueryPostgresConnWithMessagesDoesNotPanicForNonPQDriver(t *testing.T) {
	db := openFakeUserSchemaDB(t, "normal")
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatalf("获取物理连接失败: %v", err)
	}
	defer conn.Close()

	var (
		data     []map[string]interface{}
		columns  []string
		messages []string
		queryErr error
		panicVal interface{}
	)
	func() {
		defer func() { panicVal = recover() }()
		data, columns, messages, queryErr = queryPostgresConnWithMessages(context.Background(), conn, "SELECT 1")
	}()

	if panicVal != nil {
		t.Fatalf("非 lib/pq 驱动不应触发 notice handler panic: %v", panicVal)
	}
	if queryErr != nil {
		t.Fatalf("查询失败: %v", queryErr)
	}
	if len(data) != 1 || len(columns) != 1 || columns[0] != "nspname" {
		t.Fatalf("查询结果异常: data=%v columns=%v", data, columns)
	}
	if len(messages) != 0 {
		t.Fatalf("不支持 notice 的驱动应返回空消息: %v", messages)
	}
}
