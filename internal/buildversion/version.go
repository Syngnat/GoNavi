// Package buildversion classifies host versions for plugin compatibility checks.
package buildversion

import (
	"strings"

	"golang.org/x/mod/semver"
)

// IsDevelopment reports whether version labels a development or test build.
//
// CI dev builds use "dev-<sha>", local checkouts fall back to
// version/dev-version.txt ("0.0.1-test"), and a bare wails build can resolve
// to "0.0.0". Those builds track the newest source, so they are newer than any
// released minimum and must not be locked out of installing plugins.
//
// Unrecognized strings are not development versions: a corrupted release
// version still fails closed instead of silently bypassing compatibility.
func IsDevelopment(version string) bool {
	value := strings.ToLower(strings.TrimSpace(version))
	value = strings.TrimPrefix(value, "v")
	if value == "" || value == "dev" {
		return true
	}
	if strings.HasPrefix(value, "dev-") {
		return true
	}
	// version/dev-version.txt ships "0.0.1-test"; a bare local build resolves "0.0.0".
	if strings.HasPrefix(value, "0.0.") {
		return true
	}
	return strings.Contains(value, "-dev") || strings.Contains(value, "-test") || strings.Contains(value, "-snapshot")
}

// SatisfiesMinimum reports whether host can run a manifest that requires
// minimum. A development host satisfies every valid minimum; release hosts
// compare with semver. An invalid minimum never matches and an invalid
// release host fails closed.
func SatisfiesMinimum(host, minimum string) bool {
	minimum = strings.TrimPrefix(strings.TrimSpace(minimum), "v")
	if minimum == "" || !semver.IsValid("v"+minimum) {
		return false
	}
	if IsDevelopment(host) {
		return true
	}
	host = strings.TrimPrefix(strings.TrimSpace(host), "v")
	if !semver.IsValid("v" + host) {
		return false
	}
	return semver.Compare("v"+host, "v"+minimum) >= 0
}
