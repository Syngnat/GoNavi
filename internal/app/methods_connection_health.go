package app

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	redisbackend "GoNavi-Wails/internal/redis"
	"github.com/google/uuid"
)

const (
	maxRetainedConnectionHealthRuns = 20
	maxActiveConnectionHealthRuns   = 1
)

type connectionHealthRun struct {
	mu            sync.Mutex
	run           connection.ConnectionHealthRun
	connectionIDs []string
	ctx           context.Context
	cancel        context.CancelFunc
	done          chan struct{}
	pending       sync.WaitGroup
	finishedAt    time.Time
}

type connectionHealthRunContextKey struct{}

// InspectSavedConnectionHealth runs a bounded set of isolated, read-only
// probes for one saved connection. The probe payload intentionally contains no
// raw driver error, resolved endpoint, credential, database name, or query
// result. Exporters must still remove the saved connection identity fields.
func (a *App) InspectSavedConnectionHealth(id string) connection.ConnectionHealthReport {
	report, _ := a.inspectSavedConnectionHealthWithContext(context.Background(), id)
	return report
}

func (a *App) inspectSavedConnectionHealthWithContext(ctx context.Context, id string) (connection.ConnectionHealthReport, bool) {
	if ctx == nil {
		ctx = context.Background()
	}
	startedAt := time.Now()
	report := connection.ConnectionHealthReport{ConnectionID: strings.TrimSpace(id)}
	if ctx.Err() != nil {
		return report, false
	}
	view, err := a.GetEditableSavedConnection(report.ConnectionID)
	if err != nil {
		return finalizeConnectionHealthReport(report, startedAt, healthChecksAfterConnectionFailure()), ctx.Err() == nil
	}

	report.ConnectionID = strings.TrimSpace(view.ID)
	report.ConnectionName = strings.TrimSpace(view.Name)
	report.ConnectionType = strings.ToLower(strings.TrimSpace(view.Config.Type))
	config := normalizeTestConnectionConfig(view.Config)
	config.ID = report.ConnectionID

	var checks []connection.ConnectionHealthCheck
	switch strings.ToLower(strings.TrimSpace(config.Type)) {
	case "redis":
		checks = a.inspectRedisConnectionHealth(ctx, config)
	case "nacos":
		checks = a.inspectNacosConnectionHealth(ctx, config)
	case "jvm":
		checks = a.inspectJVMConnectionHealth(ctx, config)
	default:
		checks = a.inspectDatabaseConnectionHealth(ctx, config)
	}
	if ctx.Err() != nil {
		return report, false
	}
	return finalizeConnectionHealthReport(report, startedAt, checks), true
}

// InspectSavedConnectionsHealth checks a caller-selected set of saved
// connections sequentially. Sequential execution avoids a connection group
// health run opening an unbounded number of sockets at once.
func (a *App) InspectSavedConnectionsHealth(ids []string) []connection.ConnectionHealthReport {
	connectionIDs := normalizeConnectionHealthIDs(ids)
	reports := make([]connection.ConnectionHealthReport, 0, len(connectionIDs))
	for _, id := range connectionIDs {
		reports = append(reports, a.InspectSavedConnectionHealth(id))
	}
	return reports
}

// StartSavedConnectionsHealthRun 启动顺序执行的健康检查，并立即返回运行 ID。
// 调用方通过 GetSavedConnectionsHealthRun 轮询完成报告，也可以通过
// CancelSavedConnectionsHealthRun 请求跳过尚未执行的探测。
func (a *App) StartSavedConnectionsHealthRun(ids []string) connection.ConnectionHealthRun {
	connectionIDs := normalizeConnectionHealthIDs(ids)
	ctx, cancel := context.WithCancel(context.Background())
	run := &connectionHealthRun{
		run: connection.ConnectionHealthRun{
			RunID:                  "connection-health-" + uuid.NewString(),
			Status:                 connection.ConnectionHealthRunStatusRunning,
			Total:                  len(connectionIDs),
			Reports:                make([]connection.ConnectionHealthReport, 0, len(connectionIDs)),
			RemainingConnectionIDs: append([]string(nil), connectionIDs...),
		},
		connectionIDs: connectionIDs,
		ctx:           ctx,
		cancel:        cancel,
		done:          make(chan struct{}),
	}
	run.ctx = context.WithValue(ctx, connectionHealthRunContextKey{}, run)
	if len(connectionIDs) == 0 {
		run.run.Status = connection.ConnectionHealthRunStatusCompleted
		run.finishedAt = time.Now()
		close(run.done)
	}

	a.connectionHealthRunsMu.Lock()
	if a.connectionHealthRuns == nil {
		a.connectionHealthRuns = make(map[string]*connectionHealthRun)
	}
	if a.connectionHealthRunsClosing || a.activeConnectionHealthRunsLocked() >= maxActiveConnectionHealthRuns {
		a.connectionHealthRunsMu.Unlock()
		cancel()
		return connection.ConnectionHealthRun{Status: connection.ConnectionHealthRunStatusRejected}
	}
	a.pruneConnectionHealthRunsLocked()
	a.connectionHealthRuns[run.run.RunID] = run
	a.connectionHealthRunsMu.Unlock()

	if len(connectionIDs) > 0 {
		go a.runSavedConnectionsHealth(run)
	}
	return run.snapshot()
}

// GetSavedConnectionsHealthRun 返回最新批量任务快照。零值 RunID 表示任务不
// 存在、已过期或参数无效。
func (a *App) GetSavedConnectionsHealthRun(runID string) connection.ConnectionHealthRun {
	run := a.getConnectionHealthRun(runID)
	if run == nil {
		return connection.ConnectionHealthRun{}
	}
	return run.snapshot()
}

// CancelSavedConnectionsHealthRun 请求取消批量任务。已经开始的隔离探测会在其
// 自身有界执行结束后返回；此后不会再启动新的连接探测。
func (a *App) CancelSavedConnectionsHealthRun(runID string) connection.ConnectionHealthRun {
	run := a.getConnectionHealthRun(runID)
	if run == nil {
		return connection.ConnectionHealthRun{}
	}

	run.mu.Lock()
	defer run.mu.Unlock()
	if run.run.Status == connection.ConnectionHealthRunStatusRunning || run.run.Status == connection.ConnectionHealthRunStatusCancelling {
		run.run.CancelRequested = true
		run.run.Status = connection.ConnectionHealthRunStatusCancelling
		run.cancel()
	}
	return cloneConnectionHealthRun(run.run)
}

func (a *App) runSavedConnectionsHealth(run *connectionHealthRun) {
	defer func() {
		run.cancel()
		run.pending.Wait()
		close(run.done)
	}()
	for index, id := range run.connectionIDs {
		run.mu.Lock()
		if run.run.CancelRequested || run.ctx.Err() != nil {
			run.finishCancelledLocked(index)
			run.mu.Unlock()
			return
		}
		run.run.CurrentConnectionID = id
		run.run.RemainingConnectionIDs = append([]string(nil), run.connectionIDs[index:]...)
		run.mu.Unlock()

		report, completed := a.inspectSavedConnectionHealthForRun(run.ctx, id)

		run.mu.Lock()
		if !completed || run.ctx.Err() != nil {
			run.finishCancelledLocked(index)
			run.mu.Unlock()
			return
		}
		run.run.Reports = append(run.run.Reports, report)
		run.run.Completed++
		run.run.CurrentConnectionID = ""
		if run.run.CancelRequested {
			run.finishCancelledLocked(index + 1)
			run.mu.Unlock()
			return
		}
		if index+1 == len(run.connectionIDs) {
			run.run.Status = connection.ConnectionHealthRunStatusCompleted
			run.run.RemainingConnectionIDs = []string{}
			run.finishedAt = time.Now()
			run.mu.Unlock()
			return
		}
		run.run.RemainingConnectionIDs = append([]string(nil), run.connectionIDs[index+1:]...)
		run.mu.Unlock()
	}
}

func (a *App) inspectSavedConnectionHealthForRun(ctx context.Context, id string) (connection.ConnectionHealthReport, bool) {
	if a.connectionHealthRunInspect != nil {
		return a.connectionHealthRunInspect(ctx, id), ctx.Err() == nil
	}
	return a.inspectSavedConnectionHealthWithContext(ctx, id)
}

func (a *App) getConnectionHealthRun(runID string) *connectionHealthRun {
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return nil
	}
	a.connectionHealthRunsMu.Lock()
	defer a.connectionHealthRunsMu.Unlock()
	a.pruneConnectionHealthRunsLocked()
	return a.connectionHealthRuns[runID]
}

func (a *App) pruneConnectionHealthRunsLocked() {
	if len(a.connectionHealthRuns) < maxRetainedConnectionHealthRuns {
		return
	}
	var oldestID string
	var oldestFinishedAt time.Time
	for runID, run := range a.connectionHealthRuns {
		select {
		case <-run.done:
		default:
			// A cancelled run can publish its terminal status before late
			// connection cleanup completes. Keep it reachable for Shutdown.
			continue
		}
		run.mu.Lock()
		finishedAt := run.finishedAt
		run.mu.Unlock()
		if finishedAt.IsZero() {
			continue
		}
		if oldestFinishedAt.IsZero() || finishedAt.Before(oldestFinishedAt) {
			oldestID = runID
			oldestFinishedAt = finishedAt
		}
	}
	if oldestID != "" {
		delete(a.connectionHealthRuns, oldestID)
	}
}

func (a *App) activeConnectionHealthRunsLocked() int {
	active := 0
	for _, run := range a.connectionHealthRuns {
		select {
		case <-run.done:
		default:
			active++
		}
	}
	return active
}

func (a *App) cancelAndWaitConnectionHealthRuns(timeout time.Duration) bool {
	a.connectionHealthRunsMu.Lock()
	a.connectionHealthRunsClosing = true
	runs := make([]*connectionHealthRun, 0, len(a.connectionHealthRuns))
	for _, run := range a.connectionHealthRuns {
		run.mu.Lock()
		active := run.run.Status == connection.ConnectionHealthRunStatusRunning || run.run.Status == connection.ConnectionHealthRunStatusCancelling
		select {
		case <-run.done:
			run.mu.Unlock()
			continue
		default:
		}
		if active {
			run.run.CancelRequested = true
			run.run.Status = connection.ConnectionHealthRunStatusCancelling
			run.cancel()
		}
		runs = append(runs, run)
		run.mu.Unlock()
	}
	a.connectionHealthRunsMu.Unlock()

	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for _, run := range runs {
		select {
		case <-run.done:
		case <-deadline.C:
			return false
		}
	}
	return true
}

func (run *connectionHealthRun) finishCancelledLocked(nextIndex int) {
	run.run.Status = connection.ConnectionHealthRunStatusCancelled
	run.run.CurrentConnectionID = ""
	run.run.RemainingConnectionIDs = append([]string(nil), run.connectionIDs[nextIndex:]...)
	run.finishedAt = time.Now()
}

func (run *connectionHealthRun) snapshot() connection.ConnectionHealthRun {
	run.mu.Lock()
	defer run.mu.Unlock()
	return cloneConnectionHealthRun(run.run)
}

func cloneConnectionHealthRun(run connection.ConnectionHealthRun) connection.ConnectionHealthRun {
	run.Reports = append([]connection.ConnectionHealthReport(nil), run.Reports...)
	run.RemainingConnectionIDs = append([]string(nil), run.RemainingConnectionIDs...)
	return run
}

func normalizeConnectionHealthIDs(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	normalized := make([]string, 0, len(ids))
	for _, rawID := range ids {
		id := strings.TrimSpace(rawID)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		normalized = append(normalized, id)
	}
	return normalized
}

func (a *App) inspectDatabaseConnectionHealth(ctx context.Context, config connection.ConnectionConfig) []connection.ConnectionHealthCheck {
	dbInst, err := a.openDatabaseIsolatedWithContext(ctx, config)
	if err != nil {
		return healthChecksAfterConnectionFailure()
	}
	db.BindMetadataContext(dbInst, ctx)
	defer db.ClearMetadataContext(dbInst)
	defer closeConnectionHealthResource(ctx, dbInst.Close)()

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

func (a *App) inspectRedisConnectionHealth(ctx context.Context, config connection.ConnectionConfig) []connection.ConnectionHealthCheck {
	client, err := a.openRedisClientIsolatedWithContext(ctx, config)
	if err != nil {
		return healthChecksAfterConnectionFailure()
	}
	defer closeConnectionHealthResource(ctx, client.Close)()

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

func (a *App) inspectNacosConnectionHealth(ctx context.Context, config connection.ConnectionConfig) []connection.ConnectionHealthCheck {
	client, err := a.openNacosClientIsolatedWithContext(ctx, config)
	if err != nil {
		return healthChecksAfterConnectionFailure()
	}
	defer func() {
		_ = client.Close()
	}()

	pingContext, cancelPing := connectionHealthNacosOperationContext(ctx, config)
	defer cancelPing()
	pingStartedAt := time.Now()
	if err := client.Ping(pingContext); err != nil {
		checks := []connection.ConnectionHealthCheck{failedHealthCheck(connection.ConnectionHealthCheckPing, time.Since(pingStartedAt), "check_connection_settings")}
		checks = append(checks, healthTLSCheck(config))
		return append(checks, healthChecksBlockedByPingFailure()...)
	}
	pingDuration := time.Since(pingStartedAt)
	metadataContext, cancelMetadata := connectionHealthNacosOperationContext(ctx, config)
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

func (a *App) inspectJVMConnectionHealth(ctx context.Context, config connection.ConnectionConfig) []connection.ConnectionHealthCheck {
	resolvedConfig, err := a.resolveConnectionSecrets(config)
	if err != nil {
		return healthChecksAfterConnectionFailure()
	}
	pingStartedAt := time.Now()
	result := a.testJVMConnectionWithContext(ctx, resolvedConfig)
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

func (a *App) openDatabaseIsolatedWithContext(ctx context.Context, config connection.ConnectionConfig) (db.Database, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	type result struct {
		instance db.Database
		err      error
	}
	resultCh := make(chan result, 1)
	go func() {
		instance, err := a.openDatabaseIsolated(config)
		resultCh <- result{instance: instance, err: err}
	}()
	select {
	case result := <-resultCh:
		if ctx.Err() != nil && result.instance != nil {
			_ = result.instance.Close()
			return nil, ctx.Err()
		}
		return result.instance, result.err
	case <-ctx.Done():
		trackConnectionHealthCleanup(ctx, func() {
			result := <-resultCh
			if result.instance != nil {
				_ = result.instance.Close()
			}
		})
		return nil, ctx.Err()
	}
}

func (a *App) openRedisClientIsolatedWithContext(ctx context.Context, config connection.ConnectionConfig) (redisbackend.RedisClient, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	type result struct {
		client redisbackend.RedisClient
		err    error
	}
	resultCh := make(chan result, 1)
	go func() {
		client, err := a.openRedisClientIsolated(config)
		resultCh <- result{client: client, err: err}
	}()
	select {
	case result := <-resultCh:
		if ctx.Err() != nil && result.client != nil {
			_ = result.client.Close()
			return nil, ctx.Err()
		}
		return result.client, result.err
	case <-ctx.Done():
		trackConnectionHealthCleanup(ctx, func() {
			result := <-resultCh
			if result.client != nil {
				_ = result.client.Close()
			}
		})
		return nil, ctx.Err()
	}
}

func trackConnectionHealthCleanup(ctx context.Context, cleanup func()) {
	run, _ := ctx.Value(connectionHealthRunContextKey{}).(*connectionHealthRun)
	if run == nil {
		go cleanup()
		return
	}
	run.pending.Add(1)
	go func() {
		defer run.pending.Done()
		cleanup()
	}()
}

func closeConnectionHealthResource(ctx context.Context, closeResource func() error) func() {
	done := make(chan struct{})
	var closeOnce sync.Once
	closeNow := func() {
		closeOnce.Do(func() { _ = closeResource() })
	}
	go func() {
		select {
		case <-ctx.Done():
			closeNow()
		case <-done:
		}
	}()
	return func() {
		close(done)
		closeNow()
	}
}

func connectionHealthNacosOperationContext(parent context.Context, config connection.ConnectionConfig) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, time.Duration(nacosOperationTimeoutSeconds(config))*time.Second)
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
