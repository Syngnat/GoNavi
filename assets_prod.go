//go:build !dev && !wails3

package main

import (
	"io/fs"

	frontendbundle "GoNavi-Wails/frontend"
)

// The embedded frontend bundle lives in the frontend package so the Wails v3
// entry point can embed and serve the same bytes without importing package main.
var (
	assets             fs.FS = frontendbundle.Assets
	embeddedDistBundle       = frontendbundle.EmbeddedBundle()
)
