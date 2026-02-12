//go:build cgo && (duckdb_use_lib || duckdb_use_static_lib || (darwin && (amd64 || arm64)) || (linux && (amd64 || arm64)) || (windows && amd64))

package db

import _ "github.com/duckdb/duckdb-go/v2"
