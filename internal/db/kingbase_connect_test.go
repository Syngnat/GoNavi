//go:build gonavi_full_drivers || gonavi_kingbase_driver

package db

import (
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestResolveKingbaseConnectDatabases_ExplicitDatabase(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:     "kingbase",
		Database: "analytics",
		User:     "gonavi_kingbase",
	}

	got := resolveKingbaseConnectDatabases(cfg)
	want := []string{"analytics"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestResolveKingbaseConnectDatabases_UsesKingbaseDefaultsWithoutUser(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type: "kingbase",
		User: "gonavi_kingbase",
	}

	got := resolveKingbaseConnectDatabases(cfg)
	want := []string{"test", "template1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
	for _, database := range got {
		if strings.EqualFold(database, cfg.User) {
			t.Fatalf("database candidates must not include the connection user %q: %v", cfg.User, got)
		}
	}
}

func TestResolveKingbaseConnectDatabases_HonorsConnectionParamDatabase(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:             "kingbase",
		User:             "gonavi_kingbase",
		ConnectionParams: "application_name=GoNavi&DBNAME=analytics",
	}

	got := resolveKingbaseConnectDatabases(cfg)
	want := []string{"analytics"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestResolveKingbaseConnectDatabases_HonorsDatabaseAlias(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:             "kingbase",
		User:             "gonavi_kingbase",
		ConnectionParams: "application_name=GoNavi&database=analytics",
	}

	got := resolveKingbaseConnectDatabases(cfg)
	want := []string{"analytics"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestResolveKingbaseConnectDatabases_UsesURIPath(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type: "kingbase",
		URI:  "kingbase://gonavi_kingbase:pass@127.0.0.1:54321/analytics",
	}

	got := resolveKingbaseConnectDatabases(cfg)
	want := []string{"analytics"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestResolveKingbaseConnectDatabases_ExplicitDatabaseOverridesURIPath(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:     "kingbase",
		URI:      "kingbase://gonavi_kingbase:pass@127.0.0.1:54321/from-uri",
		Database: "from-config",
	}

	got := resolveKingbaseConnectDatabases(cfg)
	want := []string{"from-config"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestResolveKingbaseConnectDatabases_QueryOverridesURIPath(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type: "kingbase",
		URI:  "kingbase://gonavi_kingbase:pass@127.0.0.1:54321/from-uri?dbname=from-query",
	}

	got := resolveKingbaseConnectDatabases(cfg)
	want := []string{"from-query"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestResolveKingbaseConnectDatabases_ConnectionParamsOverrideURIQuery(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:             "kingbase",
		URI:              "kingbase://gonavi_kingbase:pass@127.0.0.1:54321/from-uri?dbname=from-query",
		ConnectionParams: "database=from-params",
	}

	got := resolveKingbaseConnectDatabases(cfg)
	want := []string{"from-params"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestResolveKingbaseConnectDatabases_SupportsPostgresURIPath(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type: "kingbase",
		URI:  "postgresql://gonavi_kingbase:pass@127.0.0.1:54321/analytics",
	}

	got := resolveKingbaseConnectDatabases(cfg)
	want := []string{"analytics"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected databases, got=%v want=%v", got, want)
	}
}

func TestKingbaseDSN_UsesDefaultDatabaseWhenDatabaseIsEmpty(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "gonavi_kingbase",
		Password: "pass",
	}

	dsn := (&KingbaseDB{}).getDSN(cfg)
	if strings.Contains(dsn, "dbname=''") {
		t.Fatalf("empty database must not be sent to Kingbase: %s", dsn)
	}
	if !strings.Contains(dsn, "dbname=test") {
		t.Fatalf("empty database should use the Kingbase maintenance database: %s", dsn)
	}
}

func TestKingbaseDSN_UsesURIPathDatabaseWhenDatabaseIsEmpty(t *testing.T) {
	cfg := connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "gonavi_kingbase",
		Password: "pass",
		URI:      "kingbase://gonavi_kingbase:pass@127.0.0.1:54321/analytics",
	}

	dsn := (&KingbaseDB{}).getDSN(cfg)
	if !strings.Contains(dsn, "dbname=analytics") {
		t.Fatalf("URI path database should be used when config database is empty: %s", dsn)
	}
}
