//go:build gonavi_full_drivers || gonavi_kingbase_driver

package db

import (
	"fmt"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// resolveKingbaseExplicitDatabase returns the database configured for a Kingbase
// connection: the dedicated field, the URI path, or the dbname/database
// connection parameters, which win over both (mirroring getDSN's allowlist merge).
func resolveKingbaseExplicitDatabase(config connection.ConnectionConfig) string {
	params := url.Values{}
	mergeConnectionParamValuesWithAllowlist(params, connectionParamsFromURI(config.URI, "kingbase", "postgres", "postgresql"), kingbaseConnectionParamNames)
	mergeConnectionParamValuesWithAllowlist(params, connectionParamsFromText(config.ConnectionParams), kingbaseConnectionParamNames)

	explicit := strings.TrimSpace(config.Database)
	if explicit == "" {
		explicit = kingbaseDatabaseFromURI(config.URI)
	}
	if paramDatabase := strings.TrimSpace(firstConnectionParamValue(params, "dbname", "database")); paramDatabase != "" {
		explicit = paramDatabase
	}
	return explicit
}

// resolveKingbaseConnectDatabases returns databases that can be used to establish
// a connection. Kingbase follows PostgreSQL's default of using the login user as
// the database when no database is supplied, which is surprising for the UI's
// optional database field. Use known maintenance databases instead.
func resolveKingbaseConnectDatabases(config connection.ConnectionConfig) []string {
	if explicit := resolveKingbaseExplicitDatabase(config); explicit != "" {
		return []string{explicit}
	}
	return []string{"test", "template1"}
}

// kingbaseConnectFailureError assembles the final error when every candidate
// database failed to verify. When the maintenance fallback was chosen because
// the user left the database empty, append self-service guidance: business
// databases usually stay reachable while test/template1 are broken server-side
// (e.g. after the server lost the OS locale it was initialized with).
func kingbaseConnectFailureError(failures []string, maintenanceFallback bool, causes ...error) error {
	var lastErr error
	if len(causes) > 0 {
		lastErr = causes[0]
	}
	prefix := "连接建立后验证失败"
	if maintenanceFallback {
		// 提示并入前缀，而不是在外面再包一层 fmt.Errorf("%w%s")：那样会让
		// logger.ErrorChain 先打印「汇总+提示」、再打印同一段汇总，明细重复两遍。
		prefix += localizedDriverRuntimeText("db.backend.error.kingbase_maintenance_database_hint", nil)
	}
	return newConnectAttemptError(prefix, failures, lastErr)
}
