package app

import (
	"os"
	"path/filepath"
	"strings"
)

// expandPluginPackagePath resolves the "~" prefix a user can type into the package field.
//
// macOS and Go both leave a tilde untouched, so an unexpanded "~/Downloads/x.zip" reached the
// package scanner as a relative path and failed with a bare "stat package failed". Only a
// leading home prefix is rewritten: every other path stays exactly as typed.
func expandPluginPackagePath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed != "~" && !strings.HasPrefix(trimmed, "~/") {
		return trimmed
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return trimmed
	}
	if trimmed == "~" {
		return home
	}
	return filepath.Join(home, filepath.FromSlash(strings.TrimPrefix(trimmed, "~/")))
}
