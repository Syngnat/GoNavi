//go:build (gonavi_full_drivers || gonavi_duckdb_driver) && cgo && (duckdb_use_lib || duckdb_use_static_lib || (darwin && (amd64 || arm64)) || (linux && (amd64 || arm64)) || (windows && amd64))

package db

func duckDBBuildSupportStatus() (bool, string) {
	return true, ""
}
