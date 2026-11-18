//go:build !dev && !wails3

package main

import "io/fs"

func pluginWindowAssets() (fs.FS, error) { return fs.Sub(assets, "plugin-window") }
