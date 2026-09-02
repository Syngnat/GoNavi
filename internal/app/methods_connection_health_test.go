package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/nacos"
)

type healthProbeDatabase struct {
	connectedConfig   connection.ConnectionConfig
	closed            int
	pingCalls         int
	queries           []string
	execCalls         int
	getDatabasesCalls int
	databaseNames     []string
	version           string
}

type blockingHealthProbeDatabase struct {
	healthProbeDatabase
	connectStarted chan struct{}
	releaseConnect chan struct{}
	startOnce      sync.Once
}

func (f *blockingHealthProbeDatabase) Connect(config connection.ConnectionConfig) error {
	f.startOnce.Do(func() { close(f.connectStarted) })
	<-f.releaseConnect
	return f.healthProbeDatabase.Connect(config)
}

func (f *healthProbeDatabase) Connect(config connection.ConnectionConfig) error {
	f.connectedConfig = config
	return nil
}

func (f *healthProbeDatabase) Close() error { f.closed++; return nil }

func (f *healthProbeDatabase) Ping() error { f.pingCalls++; return nil }

func (f *healthProbeDatabase) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queries = append(f.queries, query)
	version := f.version
	if version == "" {
		version = "8.4.1"
	}
	return []map[string]interface{}{{"version": version}}, []string{"version"}, nil
}

func (f *healthProbeDatabase) Exec(string) (int64, error) { f.execCalls++; return 0, nil }

func (f *healthProbeDatabase) GetDatabases() ([]string, error) {
	f.getDatabasesCalls++
	return append([]string(nil), f.databaseNames...), nil
}

func (f *healthProbeDatabase) GetTables(string) ([]string, error) { return nil, nil }

func (f *healthProbeDatabase) GetCreateStatement(string, string) (string, error) { return "", nil }

func (f *healthProbeDatabase) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}

func (f *healthProbeDatabase) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}

func (f *healthProbeDatabase) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}

func (f *healthProbeDatabase) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}

func (f *healthProbeDatabase) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

var _ db.Database = (*healthProbeDatabase)(nil)

func TestSafeHealthVersionRejectsConnectionDetails(t *testing.T) {
	for _, value := range []string{
		"server password=correct-horse-battery-staple",
		"jdbc:mysql://health-user:correct-horse-battery-staple@db.internal.example:3306/app",
		"redis://:correct-horse-battery-staple@db.internal.example:6379",
	} {
		if got := safeHealthVersion(value); got != "" {
			t.Errorf("safeHealthVersion(%q) = %q, want empty", value, got)
		}
	}
	if got := safeHealthVersion("PostgreSQL 16.2"); got != "PostgreSQL 16.2" {
		t.Fatalf("safeHealthVersion() = %q, want version text", got)
	}
}

func TestInspectSavedConnectionHealthUsesIsolatedReadOnlyProbesAndRedactsReport(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	probeDB := &healthProbeDatabase{databaseNames: []string{"orders_private"}}
	newDatabaseFunc = func(string) (db.Database, error) { return probeDB, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "health-1",
		Name: "Production database",
		Config: connection.ConnectionConfig{
			ID:       "health-1",
			Type:     "mysql",
			Host:     "db.internal.example",
			Port:     3306,
			User:     "health-user",
			Password: "correct-horse-battery-staple",
			UseSSL:   true,
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	report := app.InspectSavedConnectionHealth("health-1")
	if report.ConnectionID != "health-1" || report.ConnectionName != "Production database" {
		t.Fatalf("unexpected report identity: %#v", report)
	}
	if report.OverallStatus != connection.ConnectionHealthStatusPassed {
		t.Fatalf("expected passing report, got %#v", report)
	}
	for _, key := range []string{
		connection.ConnectionHealthCheckPing,
		connection.ConnectionHealthCheckVersion,
		connection.ConnectionHealthCheckTLS,
		connection.ConnectionHealthCheckPermissions,
		connection.ConnectionHealthCheckSchemaVisibility,
		connection.ConnectionHealthCheckPagination,
		connection.ConnectionHealthCheckResponse,
	} {
		check, ok := findConnectionHealthCheck(report, key)
		if !ok {
			t.Fatalf("report is missing %q: %#v", key, report.Checks)
		}
		if check.Status != connection.ConnectionHealthStatusPassed {
			t.Fatalf("%s status = %q, want passed; report=%#v", key, check.Status, report)
		}
	}

	if probeDB.connectedConfig.Password != "correct-horse-battery-staple" {
		t.Fatalf("saved secret was not resolved for the isolated probe: %#v", probeDB.connectedConfig)
	}
	if probeDB.closed != 1 || probeDB.pingCalls != 1 || probeDB.getDatabasesCalls != 1 {
		t.Fatalf("unexpected isolated probe lifecycle: closed=%d ping=%d databases=%d", probeDB.closed, probeDB.pingCalls, probeDB.getDatabasesCalls)
	}
	if probeDB.execCalls != 0 {
		t.Fatalf("health probe must not execute writes; Exec calls=%d", probeDB.execCalls)
	}
	if len(probeDB.queries) != 1 || !strings.HasPrefix(strings.ToUpper(strings.TrimSpace(probeDB.queries[0])), "SELECT") {
		t.Fatalf("version probe must use one read-only SELECT, got %#v", probeDB.queries)
	}
	if len(app.dbCache) != 0 {
		t.Fatalf("health probe must not populate the shared DB cache: %#v", app.dbCache)
	}

	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	for _, forbidden := range []string{
		"correct-horse-battery-staple",
		"health-user",
		"db.internal.example",
		"orders_private",
	} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("health report leaked %q: %s", forbidden, encoded)
		}
	}
}

func TestInspectSavedConnectionHealthUsesIsolatedOptionalDriverAgentWithoutWrites(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	installFakeOptionalDriverRuntime(t)

	probeDB := &healthProbeDatabase{databaseNames: []string{"main"}}
	newDatabaseFunc = func(driverType string) (db.Database, error) {
		if driverType != "sqlite" {
			t.Fatalf("driver type = %q, want sqlite", driverType)
		}
		return probeDB, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "health-sqlite-agent",
		Name: "SQLite driver agent",
		Config: connection.ConnectionConfig{
			ID:     "health-sqlite-agent",
			Type:   "sqlite",
			Host:   "C:/private/orders.sqlite",
			UseSSL: true,
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	report := app.InspectSavedConnectionHealth("health-sqlite-agent")
	if check, ok := findConnectionHealthCheck(report, connection.ConnectionHealthCheckVersion); !ok || check.Status != connection.ConnectionHealthStatusPassed {
		t.Fatalf("optional driver agent version probe = %#v, want passed; report=%#v", check, report)
	}
	if probeDB.execCalls != 0 || len(probeDB.queries) != 1 {
		t.Fatalf("isolated optional driver agent must use one read-only query and no writes: queries=%#v exec=%d", probeDB.queries, probeDB.execCalls)
	}
	if probeDB.closed != 1 || len(app.dbCache) != 0 {
		t.Fatalf("optional driver agent probe must close its isolated connection and avoid the cache: closed=%d cache=%#v", probeDB.closed, app.dbCache)
	}
}

func TestInspectSavedConnectionsHealthDeduplicatesIDsAndKeepsMissingConnectionSafe(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	newDatabaseFunc = func(string) (db.Database, error) {
		return &healthProbeDatabase{databaseNames: []string{"visible"}}, nil
	}
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID: "batch-1", Name: "Batch one", Config: connection.ConnectionConfig{ID: "batch-1", Type: "mysql", Host: "127.0.0.1", UseSSL: true},
	})
	if err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}

	reports := app.InspectSavedConnectionsHealth([]string{"batch-1", "batch-1", "missing-connection"})
	if len(reports) != 2 {
		t.Fatalf("expected deduplicated batch reports, got %#v", reports)
	}
	if reports[0].ConnectionID != "batch-1" || reports[0].OverallStatus != connection.ConnectionHealthStatusPassed {
		t.Fatalf("unexpected saved connection report: %#v", reports[0])
	}
	if reports[1].ConnectionID != "missing-connection" || reports[1].OverallStatus != connection.ConnectionHealthStatusFailed {
		t.Fatalf("unexpected missing connection report: %#v", reports[1])
	}
	encoded, err := json.Marshal(reports[1])
	if err != nil {
		t.Fatalf("marshal missing report: %v", err)
	}
	if strings.Contains(strings.ToLower(string(encoded)), "saved connection not found") {
		t.Fatalf("missing connection report must not expose raw backend detail: %s", encoded)
	}
}

func TestSavedConnectionsHealthRunReportsProgressAndCancelsRemainingProbes(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	firstProbeStarted := make(chan struct{})
	app.connectionHealthRunInspect = func(ctx context.Context, id string) connection.ConnectionHealthReport {
		if id == "first" {
			close(firstProbeStarted)
			<-ctx.Done()
		}
		return connection.ConnectionHealthReport{
			ConnectionID:  id,
			OverallStatus: connection.ConnectionHealthStatusPassed,
		}
	}

	started := app.StartSavedConnectionsHealthRun([]string{" first ", "first", "second", "third"})
	if started.RunID == "" || started.Status != connection.ConnectionHealthRunStatusRunning || started.Total != 3 || started.Completed != 0 {
		t.Fatalf("unexpected initial health run: %#v", started)
	}
	if len(started.RemainingConnectionIDs) != 3 {
		t.Fatalf("initial remaining connections = %#v, want three IDs", started.RemainingConnectionIDs)
	}

	select {
	case <-firstProbeStarted:
	case <-time.After(time.Second):
		t.Fatal("first health probe did not begin")
	}
	progress := app.GetSavedConnectionsHealthRun(started.RunID)
	if progress.CurrentConnectionID != "first" || progress.Completed != 0 || len(progress.RemainingConnectionIDs) != 3 {
		t.Fatalf("unexpected in-progress health run: %#v", progress)
	}

	cancelling := app.CancelSavedConnectionsHealthRun(started.RunID)
	if cancelling.Status != connection.ConnectionHealthRunStatusCancelling || !cancelling.CancelRequested {
		t.Fatalf("cancel request = %#v, want cancelling state", cancelling)
	}
	deadline := time.Now().Add(time.Second)
	for {
		finished := app.GetSavedConnectionsHealthRun(started.RunID)
		if finished.Status == connection.ConnectionHealthRunStatusCancelled {
			if finished.Completed != 0 || len(finished.Reports) != 0 {
				t.Fatalf("cancelled reports = %#v, want no report from the interrupted probe", finished)
			}
			if got := strings.Join(finished.RemainingConnectionIDs, ","); got != "first,second,third" {
				t.Fatalf("remaining connections = %q, want first,second,third", got)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("health run did not reach cancelled state: %#v", finished)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSavedConnectionsHealthRunRejectsConcurrentRunAndReleasesSlotAfterCancellation(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	firstProbeStarted := make(chan struct{})
	app.connectionHealthRunInspect = func(ctx context.Context, id string) connection.ConnectionHealthReport {
		if id == "first" {
			close(firstProbeStarted)
			<-ctx.Done()
		}
		return connection.ConnectionHealthReport{ConnectionID: id, OverallStatus: connection.ConnectionHealthStatusPassed}
	}

	first := app.StartSavedConnectionsHealthRun([]string{"first"})
	select {
	case <-firstProbeStarted:
	case <-time.After(time.Second):
		t.Fatal("first health probe did not begin")
	}
	if rejected := app.StartSavedConnectionsHealthRun([]string{"second"}); rejected.Status != connection.ConnectionHealthRunStatusRejected || rejected.RunID != "" {
		t.Fatalf("concurrent run = %#v, want rejected result without run ID", rejected)
	}
	app.CancelSavedConnectionsHealthRun(first.RunID)
	if !waitForConnectionHealthRunStatus(app, first.RunID, connection.ConnectionHealthRunStatusCancelled, time.Second) {
		t.Fatalf("first run did not cancel: %#v", app.GetSavedConnectionsHealthRun(first.RunID))
	}

	third := app.StartSavedConnectionsHealthRun([]string{"third"})
	if third.RunID == "" || third.Status == connection.ConnectionHealthRunStatusRejected {
		t.Fatalf("run after cancellation = %#v, want accepted run", third)
	}
	if !waitForConnectionHealthRunStatus(app, third.RunID, connection.ConnectionHealthRunStatusCompleted, time.Second) {
		t.Fatalf("third run did not complete: %#v", app.GetSavedConnectionsHealthRun(third.RunID))
	}
}

func TestConnectionHealthRunRetentionKeepsCancelledCleanupReachable(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	blocked := &connectionHealthRun{
		run:        connection.ConnectionHealthRun{Status: connection.ConnectionHealthRunStatusCancelled},
		done:       make(chan struct{}),
		finishedAt: time.Now().Add(-time.Hour),
	}
	app.connectionHealthRuns = map[string]*connectionHealthRun{"blocked": blocked}
	for index := 0; index < maxRetainedConnectionHealthRuns-1; index++ {
		done := make(chan struct{})
		close(done)
		app.connectionHealthRuns[fmt.Sprintf("finished-%d", index)] = &connectionHealthRun{
			run:        connection.ConnectionHealthRun{Status: connection.ConnectionHealthRunStatusCompleted},
			done:       done,
			finishedAt: time.Now().Add(time.Duration(index) * time.Second),
		}
	}

	app.pruneConnectionHealthRunsLocked()
	if app.connectionHealthRuns["blocked"] != blocked {
		t.Fatal("pruning removed a cancelled run whose cleanup is still pending")
	}
	if len(app.connectionHealthRuns) != maxRetainedConnectionHealthRuns-1 {
		t.Fatalf("retained run count = %d, want %d after pruning a completed run", len(app.connectionHealthRuns), maxRetainedConnectionHealthRuns-1)
	}
}

func TestCancelAndWaitConnectionHealthRunsCancelsActiveProbe(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	probeStarted := make(chan struct{})
	app.connectionHealthRunInspect = func(ctx context.Context, id string) connection.ConnectionHealthReport {
		close(probeStarted)
		<-ctx.Done()
		return connection.ConnectionHealthReport{ConnectionID: id, OverallStatus: connection.ConnectionHealthStatusPassed}
	}

	run := app.StartSavedConnectionsHealthRun([]string{"shutdown"})
	select {
	case <-probeStarted:
	case <-time.After(time.Second):
		t.Fatal("health probe did not begin")
	}
	if !app.cancelAndWaitConnectionHealthRuns(time.Second) {
		t.Fatal("cancelAndWaitConnectionHealthRuns() timed out")
	}
	if finished := app.GetSavedConnectionsHealthRun(run.RunID); finished.Status != connection.ConnectionHealthRunStatusCancelled {
		t.Fatalf("shutdown cancellation = %#v, want cancelled", finished)
	}
}

func TestCancelAndWaitConnectionHealthRunsWaitsForCancelledConnectCleanup(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	probe := &blockingHealthProbeDatabase{
		connectStarted: make(chan struct{}),
		releaseConnect: make(chan struct{}),
	}
	newDatabaseFunc = func(string) (db.Database, error) { return probe, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) { return config, nil }

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID: "blocked-connect", Name: "Blocked connect", Config: connection.ConnectionConfig{ID: "blocked-connect", Type: "mysql", Host: "127.0.0.1", UseSSL: true},
	}); err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}
	run := app.StartSavedConnectionsHealthRun([]string{"blocked-connect"})
	select {
	case <-probe.connectStarted:
	case <-time.After(time.Second):
		t.Fatal("isolated database connect did not begin")
	}
	app.CancelSavedConnectionsHealthRun(run.RunID)
	if !waitForConnectionHealthRunStatus(app, run.RunID, connection.ConnectionHealthRunStatusCancelled, time.Second) {
		t.Fatalf("run did not publish cancellation: %#v", app.GetSavedConnectionsHealthRun(run.RunID))
	}
	if rejected := app.StartSavedConnectionsHealthRun([]string{"blocked-connect"}); rejected.Status != connection.ConnectionHealthRunStatusRejected {
		t.Fatalf("run started before cancelled connect cleanup completed: %#v", rejected)
	}
	if app.cancelAndWaitConnectionHealthRuns(10 * time.Millisecond) {
		t.Fatal("cancelAndWaitConnectionHealthRuns() returned before blocked connect cleanup finished")
	}
	close(probe.releaseConnect)
	if !app.cancelAndWaitConnectionHealthRuns(time.Second) {
		t.Fatal("cancelAndWaitConnectionHealthRuns() did not finish after connect returned")
	}
	if rejected := app.StartSavedConnectionsHealthRun([]string{"blocked-connect"}); rejected.Status != connection.ConnectionHealthRunStatusRejected {
		t.Fatalf("run started after shutdown barrier: %#v", rejected)
	}
}

func TestSavedConnectionsHealthRunWaitsForCancelledNacosConnectCleanup(t *testing.T) {
	installNacosCacheTestHooks(t)
	connectStarted := make(chan struct{})
	releaseConnect := make(chan struct{})
	var connectStartOnce sync.Once
	client := &nacosCacheTestClient{
		connect: func(connection.ConnectionConfig) error {
			connectStartOnce.Do(func() { close(connectStarted) })
			<-releaseConnect
			return nil
		},
	}
	newNacosClientFunc = func() nacos.Client { return client }

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID: "blocked-nacos-connect", Name: "Blocked Nacos connect", Config: connection.ConnectionConfig{ID: "blocked-nacos-connect", Type: "nacos", Host: "127.0.0.1", Port: 8848},
	}); err != nil {
		t.Fatalf("SaveConnection() error = %v", err)
	}
	run := app.StartSavedConnectionsHealthRun([]string{"blocked-nacos-connect"})
	select {
	case <-connectStarted:
	case <-time.After(time.Second):
		t.Fatal("isolated Nacos connect did not begin")
	}
	app.CancelSavedConnectionsHealthRun(run.RunID)
	if !waitForConnectionHealthRunStatus(app, run.RunID, connection.ConnectionHealthRunStatusCancelled, time.Second) {
		t.Fatalf("run did not publish cancellation: %#v", app.GetSavedConnectionsHealthRun(run.RunID))
	}
	if rejected := app.StartSavedConnectionsHealthRun([]string{"blocked-nacos-connect"}); rejected.Status != connection.ConnectionHealthRunStatusRejected {
		t.Fatalf("run started before cancelled Nacos connect cleanup completed: %#v", rejected)
	}
	close(releaseConnect)
	select {
	case <-app.getConnectionHealthRun(run.RunID).done:
	case <-time.After(time.Second):
		t.Fatal("cancelled Nacos connect cleanup did not finish")
	}
	next := app.StartSavedConnectionsHealthRun([]string{"blocked-nacos-connect"})
	if next.Status == connection.ConnectionHealthRunStatusRejected {
		t.Fatalf("run stayed rejected after Nacos connect cleanup finished: %#v", next)
	}
	if !waitForConnectionHealthRunStatus(app, next.RunID, connection.ConnectionHealthRunStatusCompleted, time.Second) {
		t.Fatalf("new Nacos health run did not complete: %#v", app.GetSavedConnectionsHealthRun(next.RunID))
	}
}

func waitForConnectionHealthRunStatus(app *App, runID string, want connection.ConnectionHealthRunStatus, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if app.GetSavedConnectionsHealthRun(runID).Status == want {
			return true
		}
		time.Sleep(time.Millisecond)
	}
	return app.GetSavedConnectionsHealthRun(runID).Status == want
}

func findConnectionHealthCheck(report connection.ConnectionHealthReport, key string) (connection.ConnectionHealthCheck, bool) {
	for _, check := range report.Checks {
		if check.Key == key {
			return check, true
		}
	}
	return connection.ConnectionHealthCheck{}, false
}
