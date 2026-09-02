//go:build gonavi_full_drivers || gonavi_kingbase_driver

package db

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestKingbaseConnectInitializesSearchPathForEveryPhysicalConnection(t *testing.T) {
	state := newSearchPathPoolState(false)
	previousOpen := openKingbaseDB
	openKingbaseDB = state.open
	t.Cleanup(func() {
		openKingbaseDB = previousOpen
	})

	db := &KingbaseDB{}
	if err := db.Connect(connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "gonavi",
		Password: "test",
		Database: "app",
		SSLMode:  "disable",
	}); err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	first, err := db.conn.Conn(context.Background())
	if err != nil {
		t.Fatalf("获取第一个物理连接失败: %v", err)
	}
	t.Cleanup(func() { _ = first.Close() })
	second, err := db.conn.Conn(context.Background())
	if err != nil {
		t.Fatalf("获取第二个物理连接失败: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })

	assertUnqualifiedDuplicateObjectUsesTargetSchema(t, first)
	assertUnqualifiedDuplicateObjectUsesTargetSchema(t, second)
	state.assertAllPathConnectionsInitialized(t, 2)
	state.assertNoSessionSearchPath(t)
}

func TestKingbaseConnectFailsWhenDSNSearchPathCannotInitialize(t *testing.T) {
	state := newSearchPathPoolState(true)
	previousOpen := openKingbaseDB
	openKingbaseDB = state.open
	t.Cleanup(func() {
		openKingbaseDB = previousOpen
	})

	db := &KingbaseDB{}
	err := db.Connect(connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "gonavi",
		Password: "test",
		Database: "app",
		SSLMode:  "disable",
	})
	if err == nil {
		t.Fatal("DSN search_path 初始化失败时 Connect 应返回错误")
	}
	state.assertPoolUsedTwoPhysicalConnections(t)
	state.assertNoSessionSearchPath(t)
}
