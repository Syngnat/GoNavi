package db

import (
	"fmt"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// HiveConnectionFamily reads the effective Hive SQL family using the driver's
// URI/JDBC parsing and ConnectionParams override order. It does not connect or
// require a complete endpoint or authentication configuration.
func HiveConnectionFamily(config connection.ConnectionConfig) (string, error) {
	_, params, err := hiveConfigFromURIWithPolicy(config, false)
	if err != nil {
		return "", err
	}
	extra, err := url.ParseQuery(strings.TrimLeft(strings.TrimSpace(config.ConnectionParams), "?&"))
	if err != nil {
		return "", fmt.Errorf("invalid Hive connection parameters")
	}
	hiveMergeParams(params, extra)
	family := strings.ToLower(strings.TrimSpace(params.Get("hivefamily")))
	if family == "" {
		return "hive", nil
	}
	switch family {
	case "hive", "spark", "impala":
		return family, nil
	}
	return "", fmt.Errorf("unsupported Hive server family")
}
