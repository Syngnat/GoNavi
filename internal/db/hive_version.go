//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"regexp"

	hs "github.com/beltran/gohive/hiveserver"
)

var hiveReleaseVersion = regexp.MustCompile("(?:^|[^0-9])([0-9]+)[.][0-9]+(?:[.][0-9]+)?")

func hiveVariantForServer(requested, family, version string, protocol hs.TProtocolVersion) string {
	if requested != "" && requested != "auto" {
		return requested
	}
	if family == "hive" {
		if match := hiveReleaseVersion.FindStringSubmatch(version); len(match) > 1 {
			switch match[1] {
			case "0", "1":
				return "hive1"
			case "2":
				return "hive2"
			case "3", "4":
				return "hive3"
			}
		}
	}
	// Spark/Impala release numbers are not Hive releases. Only an unknown Hive
	// version or another family falls back to its negotiated HS2 protocol floor.
	if protocol < hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V8 {
		return "hive1"
	}
	if protocol < hs.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V10 {
		return "hive2"
	}
	return "hive3"
}
