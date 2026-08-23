package db

import (
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
