package sync

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func hiveSyncEnvironmentConfig(t *testing.T) connection.ConnectionConfig {
	t.Helper()
	host := strings.TrimSpace(os.Getenv("GONAVI_HIVE_LIVE_HOST"))
	if host == "" {
		t.Skip("GONAVI_HIVE_LIVE_HOST is not configured")
	}
	port := 10000
	if raw := os.Getenv("GONAVI_HIVE_LIVE_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 65535 {
			t.Fatalf("invalid GONAVI_HIVE_LIVE_PORT")
		}
		port = parsed
	}
	return connection.ConnectionConfig{Type: "hive", Host: host, Port: port, User: os.Getenv("GONAVI_HIVE_LIVE_USER"), Password: os.Getenv("GONAVI_HIVE_LIVE_PASSWORD"), Database: "default", Timeout: 30, QueryTimeout: 180, ConnectionParams: os.Getenv("GONAVI_HIVE_LIVE_PARAMS")}
}
