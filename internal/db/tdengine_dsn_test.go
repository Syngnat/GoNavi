//go:build gonavi_full_drivers || gonavi_tdengine_driver

package db

import (
	"testing"

	"GoNavi-Wails/internal/connection"

	"github.com/taosdata/driver-go/v3/taosWS"
)

func TestTDengineDSNCredentialsRoundTrip(t *testing.T) {
	config := connection.ConnectionConfig{
		Host:     "127.0.0.1",
		Port:     6041,
		User:     "user+%@: name",
		Password: "pass+%41@:/ word",
		Database: "metrics",
	}

	dsn := (&TDengineDB{}).getDSN(config)
	parsed, err := taosWS.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("parse TDengine DSN: %v", err)
	}
	if parsed.User != config.User {
		t.Fatalf("username changed during DSN round trip: got %q, want %q", parsed.User, config.User)
	}
	if parsed.Passwd != config.Password {
		t.Fatalf("password changed during DSN round trip: got %q, want %q", parsed.Passwd, config.Password)
	}
}
