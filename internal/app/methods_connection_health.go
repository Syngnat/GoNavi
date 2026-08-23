package app

import (
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// InspectSavedConnectionHealth runs a bounded set of isolated, read-only
// probes for one saved connection. The probe payload intentionally contains no
// raw driver error, resolved endpoint, credential, database name, or query
// result. Exporters must still remove the saved connection identity fields.
func (a *App) InspectSavedConnectionHealth(id string) connection.ConnectionHealthReport {
	startedAt := time.Now()
	report := connection.ConnectionHealthReport{ConnectionID: strings.TrimSpace(id)}
	view, err := a.GetEditableSavedConnection(report.ConnectionID)
	if err != nil {
		return finalizeConnectionHealthReport(report, startedAt, healthChecksAfterConnectionFailure())
	}

	report.ConnectionID = strings.TrimSpace(view.ID)
	report.ConnectionName = strings.TrimSpace(view.Name)
	report.ConnectionType = strings.ToLower(strings.TrimSpace(view.Config.Type))
	config := normalizeTestConnectionConfig(view.Config)
	config.ID = report.ConnectionID

	var checks []connection.ConnectionHealthCheck
	switch strings.ToLower(strings.TrimSpace(config.Type)) {
	case "redis":
		checks = a.inspectRedisConnectionHealth(config)
	case "nacos":
		checks = a.inspectNacosConnectionHealth(config)
	case "jvm":
		checks = a.inspectJVMConnectionHealth(config)
	default:
		checks = a.inspectDatabaseConnectionHealth(config)
	}
	return finalizeConnectionHealthReport(report, startedAt, checks)
}

// InspectSavedConnectionsHealth checks a caller-selected set of saved
// connections sequentially. Sequential execution avoids a connection group
// health run opening an unbounded number of sockets at once.
func (a *App) InspectSavedConnectionsHealth(ids []string) []connection.ConnectionHealthReport {
	seen := make(map[string]struct{}, len(ids))
	reports := make([]connection.ConnectionHealthReport, 0, len(ids))
	for _, rawID := range ids {
		id := strings.TrimSpace(rawID)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		reports = append(reports, a.InspectSavedConnectionHealth(id))
	}
	return reports
}

func (a *App) inspectDatabaseConnectionHealth(config connection.ConnectionConfig) []connection.ConnectionHealthCheck {
	dbInst, err := a.openDatabaseIsolated(config)
	if err != nil {
		return healthChecksAfterConnectionFailure()
	}
	defer func() {
		_ = dbInst.Close()
	}()

	pingStartedAt := time.Now()
	if err := dbInst.Ping(); err != nil {
		checks := []connection.ConnectionHealthCheck{failedHealthCheck(connection.ConnectionHealthCheckPing, time.Since(pingStartedAt), "check_connection_settings")}
		checks = append(checks, healthTLSCheck(config))
		return append(checks, healthChecksBlockedByPingFailure()...)
	}
	pingDuration := time.Since(pingStartedAt)
	checks := []connection.ConnectionHealthCheck{
		passedHealthCheck(connection.ConnectionHealthCheckPing, pingDuration, ""),
		healthTLSCheck(config),
	}
	checks = append(checks, inspectDatabaseVersionHealth(dbInst, config))
	checks = append(checks, inspectDatabaseMetadataHealth(dbInst)...)
	checks = append(checks, healthPaginationCheck(config))
	checks = append(checks, passedHealthCheck(connection.ConnectionHealthCheckResponse, pingDuration, ""))
	return orderConnectionHealthChecks(checks)
}

func (a *App) inspectRedisConnectionHealth(config connection.ConnectionConfig) []connection.ConnectionHealthCheck {
	client, err := a.openRedisClientIsolated(config)
	if err != nil {
		return healthChecksAfterConnectionFailure()
	}
	defer func() {
		_ = client.Close()
	}()

	pingStartedAt := time.Now()
	if err := client.Ping(); err != nil {
		checks := []connection.ConnectionHealthCheck{failedHealthCheck(connection.ConnectionHealthCheckPing, time.Since(pingStartedAt), "check_connection_settings")}
		checks = append(checks, healthTLSCheck(config))
		return append(checks, healthChecksBlockedByPingFailure()...)
	}
	pingDuration := time.Since(pingStartedAt)
	checks := []connection.ConnectionHealthCheck{
		passedHealthCheck(connection.ConnectionHealthCheckPing, pingDuration, ""),
		healthTLSCheck(config),
		unsupportedHealthCheck(connection.ConnectionHealthCheckSchemaVisibility, "not_applicable"),
		passedHealthCheck(connection.ConnectionHealthCheckPagination, 0, ""),
		passedHealthCheck(connection.ConnectionHealthCheckResponse, pingDuration, ""),
	}

	versionStartedAt := time.Now()
	info, versionErr := client.GetServerInfo()
	if versionErr != nil {
		checks = append(checks, failedHealthCheck(connection.ConnectionHealthCheckVersion, time.Since(versionStartedAt), "review_driver_compatibility"))
	} else {
		version := safeHealthVersion(info["redis_version"])
		if version == "" {
			checks = append(checks, unsupportedHealthCheck(connection.ConnectionHealthCheckVersion, "not_available"))
		} else {
			checks = append(checks, passedHealthCheck(connection.ConnectionHealthCheckVersion, time.Since(versionStartedAt), version))
		}
	}

	permissionsStartedAt := time.Now()
	if _, err := client.GetDatabases(); err != nil {
		checks = append(checks, failedHealthCheck(connection.ConnectionHealthCheckPermissions, time.Since(permissionsStartedAt), "grant_metadata_read"))
	} else {
		checks = append(checks, passedHealthCheck(connection.ConnectionHealthCheckPermissions, time.Since(permissionsStartedAt), ""))
	}
	return orderConnectionHealthChecks(checks)
}

func (a *App) inspectNacosConnectionHealth(config connection.ConnectionConfig) []connection.ConnectionHealthCheck {
	client, err := a.openNacosClientIsolated(config)
	if err != nil {
		return healthChecksAfterConnectionFailure()
	}
	defer func() {
		_ = client.Close()
	}()

	pingContext, cancelPing := a.nacosOperationContext(config)
	defer cancelPing()
	pingStartedAt := time.Now()
	if err := client.Ping(pingContext); err != nil {
		checks := []connection.ConnectionHealthCheck{failedHealthCheck(connection.ConnectionHealthCheckPing, time.Since(pingStartedAt), "check_connection_settings")}
		checks = append(checks, healthTLSCheck(config))
		return append(checks, healthChecksBlockedByPingFailure()...)
	}
	pingDuration := time.Since(pingStartedAt)
	metadataContext, cancelMetadata := a.nacosOperationContext(config)
	defer cancelMetadata()
	permissionsStartedAt := time.Now()
	_, namespacesErr := client.ListNamespaces(metadataContext)
	permissions := passedHealthCheck(connection.ConnectionHealthCheckPermissions, time.Since(permissionsStartedAt), "")
	if namespacesErr != nil {
		permissions = failedHealthCheck(connection.ConnectionHealthCheckPermissions, time.Since(permissionsStartedAt), "grant_metadata_read")
	}
	return orderConnectionHealthChecks([]connection.ConnectionHealthCheck{
		passedHealthCheck(connection.ConnectionHealthCheckPing, pingDuration, ""),
		healthTLSCheck(config),
		unsupportedHealthCheck(connection.ConnectionHealthCheckVersion, "not_available"),
		permissions,
		unsupportedHealthCheck(connection.ConnectionHealthCheckSchemaVisibility, "not_applicable"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckPagination, "not_applicable"),
		passedHealthCheck(connection.ConnectionHealthCheckResponse, pingDuration, ""),
	})
}

func (a *App) inspectJVMConnectionHealth(config connection.ConnectionConfig) []connection.ConnectionHealthCheck {
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		return healthChecksAfterConnectionFailure()
	}
	pingStartedAt := time.Now()
	result := a.TestJVMConnection(resolvedConfig)
	if !result.Success {
		checks := []connection.ConnectionHealthCheck{failedHealthCheck(connection.ConnectionHealthCheckPing, time.Since(pingStartedAt), "check_connection_settings")}
		checks = append(checks, healthTLSCheck(resolvedConfig))
		return append(checks, healthChecksBlockedByPingFailure()...)
	}
	pingDuration := time.Since(pingStartedAt)
	return orderConnectionHealthChecks([]connection.ConnectionHealthCheck{
		passedHealthCheck(connection.ConnectionHealthCheckPing, pingDuration, ""),
		healthTLSCheck(resolvedConfig),
		unsupportedHealthCheck(connection.ConnectionHealthCheckVersion, "not_available"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckPermissions, "not_available"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckSchemaVisibility, "not_applicable"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckPagination, "not_applicable"),
		passedHealthCheck(connection.ConnectionHealthCheckResponse, pingDuration, ""),
	})
}

func inspectDatabaseVersionHealth(dbInst db.Database, config connection.ConnectionConfig) connection.ConnectionHealthCheck {
	query, ok := connectionHealthVersionQuery(config)
	if !ok {
		return unsupportedHealthCheck(connection.ConnectionHealthCheckVersion, "not_available")
	}
	startedAt := time.Now()
	rows, _, err := dbInst.Query(query)
	if err != nil {
		return failedHealthCheck(connection.ConnectionHealthCheckVersion, time.Since(startedAt), "review_driver_compatibility")
	}
	version := safeHealthVersion(firstHealthRowValue(rows))
	if version == "" {
		return unsupportedHealthCheck(connection.ConnectionHealthCheckVersion, "not_available")
	}
	return passedHealthCheck(connection.ConnectionHealthCheckVersion, time.Since(startedAt), version)
}

func inspectDatabaseMetadataHealth(dbInst db.Database) []connection.ConnectionHealthCheck {
	startedAt := time.Now()
	databases, err := dbInst.GetDatabases()
	duration := time.Since(startedAt)
	if err != nil {
		return []connection.ConnectionHealthCheck{
			failedHealthCheck(connection.ConnectionHealthCheckPermissions, duration, "grant_metadata_read"),
			failedHealthCheck(connection.ConnectionHealthCheckSchemaVisibility, duration, "adjust_visibility_or_permissions"),
		}
	}
	checks := []connection.ConnectionHealthCheck{
		passedHealthCheck(connection.ConnectionHealthCheckPermissions, duration, ""),
	}
	if len(databases) == 0 {
		return append(checks, failedHealthCheck(connection.ConnectionHealthCheckSchemaVisibility, duration, "adjust_visibility_or_permissions"))
	}
	return append(checks, passedHealthCheck(connection.ConnectionHealthCheckSchemaVisibility, duration, ""))
}

// healthPaginationCheck reads the same data-source contract as the query
// editor and backend gates, so a new driver cannot silently acquire a second
// pagination policy through this diagnostic probe.
func healthPaginationCheck(config connection.ConnectionConfig) connection.ConnectionHealthCheck {
	if connectionHealthSupportsPagination(config) {
		return passedHealthCheck(connection.ConnectionHealthCheckPagination, 0, "")
	}
	return unsupportedHealthCheck(connection.ConnectionHealthCheckPagination, "not_applicable")
}

func connectionHealthSupportsPagination(config connection.ConnectionConfig) bool {
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		return db.ResolveCustomDataSourceCapability(config.Driver).Pagination.Supported
	}
	return db.ResolveDataSourceCapability(config.Type).Pagination.Supported
}

func connectionHealthVersionQuery(config connection.ConnectionConfig) (string, bool) {
	typeName := strings.ToLower(strings.TrimSpace(config.Type))
	if typeName == "custom" {
		typeName = strings.ToLower(strings.TrimSpace(config.Driver))
	}
	switch typeName {
	case "mysql", "goldendb", "mariadb", "oceanbase", "diros", "starrocks", "sphinx",
		"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb",
		"clickhouse", "trino":
		return "SELECT VERSION() AS version", true
	case "sqlserver":
		return "SELECT @@VERSION AS version", true
	case "sqlite":
		return "SELECT sqlite_version() AS version", true
	case "oracle":
		return "SELECT banner AS version FROM v$version WHERE ROWNUM = 1", true
	default:
		return "", false
	}
}

func healthTLSCheck(config connection.ConnectionConfig) connection.ConnectionHealthCheck {
	if strings.EqualFold(strings.TrimSpace(config.Type), "jvm") {
		if connectionHealthUsesHTTPS(config.JVM.Endpoint.BaseURL) || connectionHealthUsesHTTPS(config.JVM.Agent.BaseURL) || connectionHealthUsesHTTPS(config.JVM.Diagnostic.BaseURL) {
			return passedHealthCheck(connection.ConnectionHealthCheckTLS, 0, "")
		}
		return unsupportedHealthCheck(connection.ConnectionHealthCheckTLS, "not_available")
	}
	if config.UseSSL || (strings.TrimSpace(config.SSLMode) != "" && !strings.EqualFold(strings.TrimSpace(config.SSLMode), "disable")) || strings.TrimSpace(config.SSLCAPath) != "" || strings.TrimSpace(config.SSLCertPath) != "" || strings.TrimSpace(config.SSLKeyPath) != "" {
		return passedHealthCheck(connection.ConnectionHealthCheckTLS, 0, "")
	}
	return failedHealthCheck(connection.ConnectionHealthCheckTLS, 0, "enable_tls")
}

func connectionHealthUsesHTTPS(value string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(value)), "https://")
}

func healthChecksAfterConnectionFailure() []connection.ConnectionHealthCheck {
	return []connection.ConnectionHealthCheck{
		failedHealthCheck(connection.ConnectionHealthCheckPing, 0, "check_connection_settings"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckTLS, "restore_connectivity_first"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckVersion, "restore_connectivity_first"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckPermissions, "restore_connectivity_first"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckSchemaVisibility, "restore_connectivity_first"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckPagination, "restore_connectivity_first"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckResponse, "restore_connectivity_first"),
	}
}

func healthChecksBlockedByPingFailure() []connection.ConnectionHealthCheck {
	return []connection.ConnectionHealthCheck{
		unsupportedHealthCheck(connection.ConnectionHealthCheckVersion, "restore_connectivity_first"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckPermissions, "restore_connectivity_first"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckSchemaVisibility, "restore_connectivity_first"),
		unsupportedHealthCheck(connection.ConnectionHealthCheckPagination, "restore_connectivity_first"),
		failedHealthCheck(connection.ConnectionHealthCheckResponse, 0, "check_connection_settings"),
	}
}

func passedHealthCheck(key string, duration time.Duration, detail string) connection.ConnectionHealthCheck {
	return connection.ConnectionHealthCheck{
		Key:        key,
		Status:     connection.ConnectionHealthStatusPassed,
		DurationMs: duration.Milliseconds(),
		Detail:     safeHealthVersion(detail),
	}
}

func failedHealthCheck(key string, duration time.Duration, recommendation string) connection.ConnectionHealthCheck {
	return connection.ConnectionHealthCheck{
		Key:            key,
		Status:         connection.ConnectionHealthStatusFailed,
		DurationMs:     duration.Milliseconds(),
		Recommendation: recommendation,
	}
}

func unsupportedHealthCheck(key, recommendation string) connection.ConnectionHealthCheck {
	return connection.ConnectionHealthCheck{
		Key:            key,
		Status:         connection.ConnectionHealthStatusUnsupported,
		Recommendation: recommendation,
	}
}

func finalizeConnectionHealthReport(report connection.ConnectionHealthReport, startedAt time.Time, checks []connection.ConnectionHealthCheck) connection.ConnectionHealthReport {
	report.Checks = orderConnectionHealthChecks(checks)
	report.DurationMs = time.Since(startedAt).Milliseconds()
	report.OverallStatus = connection.ConnectionHealthStatusPassed
	for _, check := range report.Checks {
		if check.Status == connection.ConnectionHealthStatusFailed {
			report.OverallStatus = connection.ConnectionHealthStatusFailed
			break
		}
	}
	return report
}

func orderConnectionHealthChecks(checks []connection.ConnectionHealthCheck) []connection.ConnectionHealthCheck {
	order := []string{
		connection.ConnectionHealthCheckPing,
		connection.ConnectionHealthCheckVersion,
		connection.ConnectionHealthCheckTLS,
		connection.ConnectionHealthCheckPermissions,
		connection.ConnectionHealthCheckSchemaVisibility,
		connection.ConnectionHealthCheckPagination,
		connection.ConnectionHealthCheckResponse,
	}
	byKey := make(map[string]connection.ConnectionHealthCheck, len(checks))
	for _, check := range checks {
		byKey[check.Key] = check
	}
	ordered := make([]connection.ConnectionHealthCheck, 0, len(order))
	for _, key := range order {
		if check, ok := byKey[key]; ok {
			ordered = append(ordered, check)
		}
	}
	return ordered
}

func firstHealthRowValue(rows []map[string]interface{}) string {
	if len(rows) == 0 {
		return ""
	}
	for _, value := range rows[0] {
		return fmt.Sprint(value)
	}
	return ""
}

func safeHealthVersion(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r", " "), "\n", " "))
	lowerValue := strings.ToLower(value)
	for _, secretMarker := range []string{"password", "passwd", "secret", "token", "api key", "apikey", "jdbc:", "://"} {
		if strings.Contains(lowerValue, secretMarker) {
			return ""
		}
	}
	if len(value) > 256 {
		value = value[:256]
	}
	return value
}
