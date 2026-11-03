package plugin

import (
	"errors"
	"path"
	"strings"
)

// SafePackagePath reports whether name is a package-relative path that cannot
// escape the package or collide with a platform-reserved name.
//
// The rule is shared with the host so a manifest accepted by one is accepted by
// the other: forward slashes only, no absolute path, no "." or ".." segment, no
// control characters, no Windows device names, and no trailing space or dot in a
// segment (which Windows silently trims, turning two names into one).
func SafePackagePath(name string) error {
	if name == "" || len(name) > 1024 || strings.Count(name, "/") > 32 ||
		strings.ContainsAny(name, "\\:\x00<>\"|?*") || path.IsAbs(name) || path.Clean(name) != name {
		return errors.New("unsafe package path")
	}
	for _, char := range name {
		if char < 32 {
			return errors.New("control character in package path")
		}
	}
	for _, part := range strings.Split(name, "/") {
		if part == "." || part == ".." || len(part) > 240 || strings.TrimRight(part, " .") != part {
			return errors.New("unsafe package path segment")
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
			base == "CLOCK$" || base == "CONIN$" || base == "CONOUT$" || reservedPortName(base) {
			return errors.New("reserved package path")
		}
	}
	return nil
}

// reservedPortName rejects the Windows "COM1".."COM9" and "LPT1".."LPT9" device
// names, including the superscript digit variants Windows also reserves.
func reservedPortName(base string) bool {
	if !strings.HasPrefix(base, "COM") && !strings.HasPrefix(base, "LPT") {
		return false
	}
	suffix := base[3:]
	return len(suffix) == 1 && suffix[0] >= '0' && suffix[0] <= '9' ||
		suffix == "¹" || suffix == "²" || suffix == "³"
}
