//go:build gonavi_full_drivers || gonavi_gaussdb_driver

package db

import (
	"context"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestGaussDBConnectInitializesSearchPathForEveryPhysicalConnection(t *testing.T) {
	state := newSearchPathPoolState(false)
	previousOpen := openGaussDB
	openGaussDB = state.open
	previousRuntimeSupportStatus := gaussDBRuntimeSupportStatus
	gaussDBRuntimeSupportStatus = func(string) (bool, string) { return true, "" }
	t.Cleanup(func() {
		openGaussDB = previousOpen
		gaussDBRuntimeSupportStatus = previousRuntimeSupportStatus
	})

	db := &GaussDB{}
	if err := db.Connect(connection.ConnectionConfig{
		Type:     "gaussdb",
		Host:     "127.0.0.1",
		Port:     5432,
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

func TestGaussDBConnectFailsWhenDSNSearchPathCannotInitialize(t *testing.T) {
	state := newSearchPathPoolState(true)
	previousOpen := openGaussDB
	openGaussDB = state.open
	previousRuntimeSupportStatus := gaussDBRuntimeSupportStatus
	gaussDBRuntimeSupportStatus = func(string) (bool, string) { return true, "" }
	t.Cleanup(func() {
		openGaussDB = previousOpen
		gaussDBRuntimeSupportStatus = previousRuntimeSupportStatus
	})

	db := &GaussDB{}
	err := db.Connect(connection.ConnectionConfig{
		Type:     "gaussdb",
		Host:     "127.0.0.1",
		Port:     5432,
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
