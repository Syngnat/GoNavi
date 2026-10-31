package db

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveConnectionFamilyMatchesDriverPrecedence(t *testing.T) {
	cases := []struct {
		name   string
		config connection.ConnectionConfig
		want   string
	}{
		{name: "static default", want: "hive"},
		{name: "JDBC session", config: connection.ConnectionConfig{URI: "jdbc:hive2://host/default;hiveFamily=spark"}, want: "spark"},
		{name: "URI query", config: connection.ConnectionConfig{URI: "hive2://host/default?hiveFamily=impala"}, want: "impala"},
		{name: "HTTP URI", config: connection.ConnectionConfig{URI: "https://host/cliservice?hiveFamily=spark"}, want: "spark"},
		{name: "params override", config: connection.ConnectionConfig{URI: "jdbc:hive2://host/default;hiveFamily=spark", ConnectionParams: "hiveFamily=impala"}, want: "impala"},
		{name: "static missing host auth", config: connection.ConnectionConfig{ConnectionParams: "hiveFamily=spark&authMode=KERBEROS"}, want: "spark"},
		{name: "partial URI", config: connection.ConnectionConfig{URI: "jdbc:hive2:///default;hiveFamily=spark"}, want: "spark"},
		{name: "Host URI", config: connection.ConnectionConfig{Host: "hive2://host/default;hiveFamily=impala"}, want: "impala"},
		{name: "case insensitive", config: connection.ConnectionConfig{ConnectionParams: "HiveFamily=Spark"}, want: "spark"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := HiveConnectionFamily(test.config)
			if err != nil || got != test.want {
				t.Fatalf("family=%q err=%v want=%q", got, err, test.want)
			}
			if test.name != "partial URI" {
				normalized, err := normalizeHiveConfig(test.config)
				if err != nil || normalized.family != got {
					t.Fatalf("static/driver family mismatch normalized=%q error=%v", normalized.family, err)
				}
			}
		})
	}
	for _, config := range []connection.ConnectionConfig{{URI: "invalid://host"}, {ConnectionParams: "hiveFamily=postgres"}, {ConnectionParams: "hiveFamily=%zz"}} {
		if family, err := HiveConnectionFamily(config); err == nil || family != "" {
			t.Fatalf("invalid family silently defaulted: %q %v", family, err)
		}
	}
}
