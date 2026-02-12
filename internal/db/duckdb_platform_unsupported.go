//go:build !(cgo && (duckdb_use_lib || duckdb_use_static_lib || (darwin && (amd64 || arm64)) || (linux && (amd64 || arm64)) || (windows && amd64)))

package db

import (
	"fmt"
	"runtime"
)

func duckDBBuildSupportStatus() (bool, string) {
	return false, fmt.Sprintf("当前构建不包含 DuckDB 驱动（平台=%s/%s）。需要启用 CGO，并使用受支持平台（darwin/linux amd64|arm64、windows/amd64）或通过 -tags duckdb_use_lib / duckdb_use_static_lib 提供自定义库", runtime.GOOS, runtime.GOARCH)
}
