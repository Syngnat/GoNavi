package db

import (
	"context"
	"reflect"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestResolvePostgresConnectDatabases_ExplicitDatabase(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:     "postgres",
		Database: "analytics",
		User:     "app_user",
	}

	got := resolvePostgresConnectDatabases(cfg)
	want := []string{"analytics"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestResolvePostgresConnectDatabases_FallbackOrder(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type: "postgres",
		User: "app_user",
	}

	got := resolvePostgresConnectDatabases(cfg)
	want := []string{"postgres", "template1", "app_user"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestResolvePostgresConnectDatabases_DeduplicateUserDefault(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type: "postgres",
		User: "postgres",
	}

	got := resolvePostgresConnectDatabases(cfg)
	want := []string{"postgres", "template1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestPostgresDSNHasExplicitSearchPath(t *testing.T) {
	tests := []struct {
		name string
		dsn  string
		want bool
	}{
		{
			name: "encoded selected schema",
			dsn:  `postgres://user:pass@localhost:5432/app?search_path=%22Tenant.Schema%22`,
			want: true,
		},
		{
			name: "selected schema with other params",
			dsn:  `postgres://user:pass@localhost:5432/app?application_name=gonavi&search_path=%22sales%22`,
			want: true,
		},
		{
			name: "missing search path",
			dsn:  `postgres://user:pass@localhost:5432/app?application_name=gonavi`,
			want: false,
		},
		{
			name: "blank search path",
			dsn:  `postgres://user:pass@localhost:5432/app?search_path=%20`,
			want: false,
		},
		{
			name: "invalid dsn",
			dsn:  `%`,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := postgresDSNHasExplicitSearchPath(tt.dsn); got != tt.want {
				t.Fatalf("postgresDSNHasExplicitSearchPath(%q)=%v want=%v", tt.dsn, got, tt.want)
			}
		})
	}
}

func TestPostgresConnectInitializesSearchPathForEveryPhysicalConnection(t *testing.T) {
	state := newSearchPathPoolState(false)
	previousOpen := openPostgresDB
	openPostgresDB = state.open
	t.Cleanup(func() {
		openPostgresDB = previousOpen
	})

	db := &PostgresDB{}
	if err := db.Connect(connection.ConnectionConfig{
		Type:     "postgres",
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

func TestPostgresConnectFailsWhenDSNSearchPathCannotInitialize(t *testing.T) {
	state := newSearchPathPoolState(true)
	previousOpen := openPostgresDB
	openPostgresDB = state.open
	t.Cleanup(func() {
		openPostgresDB = previousOpen
	})

	db := &PostgresDB{}
	err := db.Connect(connection.ConnectionConfig{
		Type:     "postgres",
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
