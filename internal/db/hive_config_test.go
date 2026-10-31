package db

import (
	"net/url"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveConfigURIs(t *testing.T) {
	cases := []struct {
		name                                  string
		config                                connection.ConnectionConfig
		host, auth, transport, path, database string
		port                                  int
		ssl                                   bool
	}{
		{name: "default", host: "localhost", auth: "NONE", transport: "binary", path: "cliservice", database: "default", port: 10000},
		{name: "jdbc/http", config: connection.ConnectionConfig{URI: "jdbc:hive2://server/db;transportMode=http;httpPath=hs2;auth=NOSASL"}, host: "server", auth: "NOSASL", transport: "http", path: "hs2", database: "db", port: 10001},
		{name: "https", config: connection.ConnectionConfig{URI: "https://server/endpoint?database=analytics&authMode=LDAP"}, host: "server", auth: "LDAP", transport: "http", path: "endpoint", database: "analytics", port: 443, ssl: true},
		{name: "http", config: connection.ConnectionConfig{URI: "http://server/endpoint"}, host: "server", auth: "NONE", transport: "http", path: "endpoint", database: "default", port: 80},
		{name: "kerberos implied", config: connection.ConnectionConfig{URI: "hive2://server/default;principal=hive/_HOST@REALM"}, host: "server", auth: "KERBEROS", transport: "binary", path: "cliservice", database: "default", port: 10000},
		{name: "impala", config: connection.ConnectionConfig{ConnectionParams: "hiveFamily=impala"}, host: "localhost", auth: "NONE", transport: "binary", path: "cliservice", database: "default", port: 21050},
	}
	cases = append(cases, struct {
		name                                  string
		config                                connection.ConnectionConfig
		host, auth, transport, path, database string
		port                                  int
		ssl                                   bool
	}{name: "spark http", config: connection.ConnectionConfig{ConnectionParams: "hiveFamily=spark&transportMode=http"}, host: "localhost", auth: "NONE", transport: "http", path: "cliservice", database: "default", port: 10001})
	cases = append(cases, struct {
		name                                  string
		config                                connection.ConnectionConfig
		host, auth, transport, path, database string
		port                                  int
		ssl                                   bool
	}{name: "impala http", config: connection.ConnectionConfig{ConnectionParams: "hiveFamily=impala&transportMode=http"}, host: "localhost", auth: "NONE", transport: "http", path: "cliservice", database: "default", port: 28000})
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeHiveConfig(test.config)
			if err != nil {
				t.Fatal(err)
			}
			if got.Host != test.host || got.Port != test.port || got.auth != test.auth || got.transport != test.transport || got.httpPath != test.path || got.Database != test.database || got.UseSSL != test.ssl {
				t.Fatalf("unexpected normalized endpoint %s:%d auth=%s transport=%s path=%s db=%s ssl=%v", got.Host, got.Port, got.auth, got.transport, got.httpPath, got.Database, got.UseSSL)
			}
			if got.UseSSL && got.SSLMode != "required" {
				t.Fatal("TLS must verify by default")
			}
		})
	}
}

func TestHiveConfigCredentialEncodingAndPrecedence(t *testing.T) {
	config := connection.ConnectionConfig{URI: "jdbc:hive2://server/db%20name;user=u%2Bser;password=p%3Bass%2Bword;auth=LDAP", ConnectionParams: "authMode=NOSASL"}
	got, err := normalizeHiveConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	if got.Database != "db name" || got.User != "u+ser" || got.Password != "p;ass+word" || got.auth != "NOSASL" {
		t.Fatalf("JDBC parameter decode mismatch: database=%q user=%q auth=%q passwordCorrect=%v", got.Database, got.User, got.auth, got.Password == "p;ass+word")
	}
	parsed, err := url.ParseQuery(got.ConnectionParams)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Has("auth") || parsed.Has("password") || parsed.Has("user") || parsed.Get("authMode") != "NOSASL" {
		t.Fatal("normalized parameters retain credential aliases")
	}
}

func TestHiveConfigRejectsAmbiguousProtocolModes(t *testing.T) {
	for _, params := range []string{"authMode=typo", "hiveFamily=postgres", "transportMode=socket", "fetchSize=0", "saslQop=auth-conf", "serviceDiscoveryMode=zooKeeper", "httpPath=%2F%2Fevil"} {
		t.Run(params, func(t *testing.T) {
			if _, err := normalizeHiveConfig(connection.ConnectionConfig{ConnectionParams: params}); err == nil {
				t.Fatal("invalid protocol configuration accepted")
			}
		})
	}
}

func TestHiveSessionConfigUsesOpenSessionKeysAndUnqualifiedColumns(t *testing.T) {
	got, err := normalizeHiveConfig(connection.ConnectionConfig{ConnectionParams: "session.hive.exec.mode.local.auto=false&session.use:database=analytics&session.hiveconf:tez.queue.name=adhoc"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"set:hiveconf:hive.exec.mode.local.auto":              "false",
		"use:database":                                        "analytics",
		"set:hiveconf:tez.queue.name":                         "adhoc",
		"set:hiveconf:hive.resultset.use.unique.column.names": "false",
	}
	for key, value := range want {
		if got.session[key] != value {
			t.Fatalf("session[%q]=%q want %q", key, got.session[key], value)
		}
	}
}

func TestHiveSessionConfigAllowsUniqueColumnNamesOverride(t *testing.T) {
	got, err := normalizeHiveConfig(connection.ConnectionConfig{ConnectionParams: "session.hive.resultset.use.unique.column.names=true"})
	if err != nil {
		t.Fatal(err)
	}
	if got.session["set:hiveconf:hive.resultset.use.unique.column.names"] != "true" {
		t.Fatalf("explicit override lost: %+v", got.session)
	}
}
