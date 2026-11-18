//go:build dev && !wails3

package main

import (
	"io/fs"
	"os"
)

// The development placeholder FS is the repository, not the Vite output root.
func pluginWindowAssets() (fs.FS, error) { return os.DirFS("frontend/dist/plugin-window"), nil }
