//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveURIUserinfoPasswordPresenceIsExplicit(t *testing.T) {
	for _, test := range []struct {
		name, uri, password string
		hasPassword         bool
	}{
		{name: "user without password", uri: "hive2://analyst@warehouse.example:10000/default"},
		{name: "user with empty password", uri: "hive2://analyst:@warehouse.example:10000/default", hasPassword: true},
		{name: "percent encoded password", uri: "hive2://analyst:s%3Bcret@warehouse.example:10000/default", password: "s;cret", hasPassword: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			config, err := normalizeHiveConfig(connection.ConnectionConfig{Type: "hive", URI: test.uri})
			if err != nil {
				t.Fatalf("normalize Hive URI: %v", err)
			}
			if config.User != "analyst" || config.Password != test.password {
				t.Fatalf("URI credentials = user:%q password:%q, want analyst and %q", config.User, config.Password, test.password)
			}
		})
	}
}
