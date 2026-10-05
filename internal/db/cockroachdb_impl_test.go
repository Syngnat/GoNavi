//go:build gonavi_full_drivers || gonavi_cockroachdb_driver || gonavi_kwdb_driver

package db

import (
	"net/url"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestWithCockroachSearchPathKeepsSessionDefault(t *testing.T) {
	config := withCockroachSearchPath(connection.ConnectionConfig{ConnectionParams: "application_name=gonavi"})
	params, err := url.ParseQuery(config.ConnectionParams)
	if err != nil || params.Get("search_path") != cockroachDefaultSearchPath || params.Get("application_name") != "gonavi" {
		t.Fatalf("connection params = %q, %v", config.ConnectionParams, err)
	}

	explicit := connection.ConnectionConfig{ConnectionParams: "search_path=analytics"}
	if got := withCockroachSearchPath(explicit); got.ConnectionParams != explicit.ConnectionParams {
		t.Fatalf("an explicit search_path must be kept, got %q", got.ConnectionParams)
	}
	fromURI := connection.ConnectionConfig{URI: "postgresql://root@127.0.0.1:26257/shop?search_path=sales"}
	if got := withCockroachSearchPath(fromURI); got.ConnectionParams != "" {
		t.Fatalf("a search_path in the URI must be kept, got %q", got.ConnectionParams)
	}
}

func TestExtractCockroachVersion(t *testing.T) {
	cases := map[string]string{
		"CockroachDB CCL v24.3.36 (x86_64-pc-linux-gnu, built 2025/01/01)": "24.3.36",
		"KaiwuDB 3.2.2 (x86_64-linux-gnu, built 2025/06/01)":               "3.2.2",
		"unknown":                                                          "",
	}
	for banner, want := range cases {
		if got := extractCockroachVersion(banner); got != want {
			t.Fatalf("extractCockroachVersion(%q) = %q, want %q", banner, got, want)
		}
	}
}
