package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type fakeElasticsearchConsoleDatabase struct {
	mu           sync.Mutex
	requests     []db.ElasticsearchConsoleRequest
	responses    []db.ElasticsearchConsoleResponse
	errors       []error
	serverMajor  int
	afterRequest func(int)
}

type stoppedElasticsearchConsoleDatabase struct {
	*fakeElasticsearchConsoleDatabase
}

func (*stoppedElasticsearchConsoleDatabase) ElasticsearchConsoleTransportUsable() bool { return false }

func (f *fakeElasticsearchConsoleDatabase) ElasticsearchServerMajor() int { return f.serverMajor }

func (f *fakeElasticsearchConsoleDatabase) Connect(connection.ConnectionConfig) error { return nil }
func (f *fakeElasticsearchConsoleDatabase) Close() error                              { return nil }
func (f *fakeElasticsearchConsoleDatabase) Ping() error                               { return nil }
func (f *fakeElasticsearchConsoleDatabase) Query(string) ([]map[string]interface{}, []string, error) {
	return nil, nil, errors.New("unexpected legacy query")
}
func (f *fakeElasticsearchConsoleDatabase) Exec(string) (int64, error) {
	return 0, errors.New("unexpected exec")
}
func (f *fakeElasticsearchConsoleDatabase) GetDatabases() ([]string, error) { return nil, nil }
func (f *fakeElasticsearchConsoleDatabase) GetTables(string) ([]string, error) {
	return nil, nil
}
func (f *fakeElasticsearchConsoleDatabase) GetCreateStatement(string, string) (string, error) {
	return "", nil
}
func (f *fakeElasticsearchConsoleDatabase) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (f *fakeElasticsearchConsoleDatabase) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *fakeElasticsearchConsoleDatabase) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *fakeElasticsearchConsoleDatabase) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *fakeElasticsearchConsoleDatabase) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func (f *fakeElasticsearchConsoleDatabase) ExecuteElasticsearchConsoleRequest(_ context.Context, request db.ElasticsearchConsoleRequest) (db.ElasticsearchConsoleResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, request)
	index := len(f.requests) - 1
	if f.afterRequest != nil {
		f.afterRequest(index)
	}
	if index < len(f.errors) && f.errors[index] != nil {
		return db.ElasticsearchConsoleResponse{}, f.errors[index]
	}
	if index < len(f.responses) {
		return f.responses[index], nil
	}
	return db.ElasticsearchConsoleResponse{StatusCode: 200, RawBody: `{}`}, nil
}

func TestExecuteElasticsearchConsoleStopsBeforeNextRequestAfterCancellation(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	const queryID = "es-cancel-between"
	fake := &fakeElasticsearchConsoleDatabase{
		responses: []db.ElasticsearchConsoleResponse{
			{StatusCode: 200, RawBody: `{"count":1}`},
			{StatusCode: 200, RawBody: `{"count":2}`},
		},
	}
	fake.afterRequest = func(index int) {
		if index == 0 {
			app.CancelQuery(queryID)
		}
	}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	source := "GET /orders/_count\n\nGET /orders/_count"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)
	result := app.ExecuteElasticsearchConsole(config, "orders", source, queryID, inspection.Fingerprint, "")
	if result.Success || result.Completed != 1 || len(result.Results) != 1 || result.FailedIndex != 1 {
		t.Fatalf("unexpected canceled batch result: %+v", result)
	}
	if len(fake.requests) != 1 {
		t.Fatalf("canceled batch executed a later request: %+v", fake.requests)
	}
}

func cacheElasticsearchConsoleTestDatabase(t *testing.T, app *App, config connection.ConnectionConfig, database db.Database) {
	t.Helper()
	originalSupport := driverRuntimeSupportStatusFunc
	originalRevision := verifyDriverAgentRevisionFunc
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }
	t.Cleanup(func() {
		driverRuntimeSupportStatusFunc = originalSupport
		verifyDriverAgentRevisionFunc = originalRevision
	})
	app.mu.Lock()
	defer app.mu.Unlock()
	app.dbCache[getCacheKey(config)] = cachedDatabase{
		inst:     database,
		lastPing: time.Now(),
		config:   config,
	}
}

func TestInspectElasticsearchConsoleClassifiesAndIssuesDangerToken(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}

	inspection := app.InspectElasticsearchConsole(config, "orders", strings.Join([]string{
		"GET /orders/_search",
		`{"query":{"match_all":{}}}`,
		"DELETE /orders/_doc/42",
	}, "\n"))
	if !inspection.Success || !inspection.RequiresConfirmation || inspection.ConfirmationToken == "" {
		t.Fatalf("unexpected inspection: %+v", inspection)
	}
	if len(inspection.Requests) != 2 || inspection.Requests[0].Category != "read" || inspection.Requests[1].Category != "write" {
		t.Fatalf("unexpected request classification: %+v", inspection.Requests)
	}

	blocked := app.InspectElasticsearchConsole(config, "orders", "POST /_reindex\n{}")
	if blocked.Success || !blocked.Blocked || blocked.ConfirmationToken != "" {
		t.Fatalf("blocked endpoint was not rejected: %+v", blocked)
	}
}

func TestInspectElasticsearchConsoleHonorsConnectionProtectionForWritesAndScripts(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{
		Type: "elasticsearch",
		Protection: connection.ConnectionProtectionConfig{
			RestrictScriptExecution: true,
		},
	}

	write := app.InspectElasticsearchConsole(config, "orders", "PUT /orders/_doc/42\n{}")
	if write.Success || write.BlockReason != elasticsearchConsoleBlockConnectionProtected {
		t.Fatalf("protected write was not rejected: %+v", write)
	}
	scriptRead := app.InspectElasticsearchConsole(config, "orders", "POST /orders/_search\n{\"query\":{\"script_score\":{\"script\":{\"source\":\"1\"}}}}")
	if scriptRead.Success || scriptRead.BlockReason != elasticsearchConsoleBlockConnectionProtected {
		t.Fatalf("protected scripted read was not rejected: %+v", scriptRead)
	}
}

func TestInspectElasticsearchConsoleHonorsLegacyReadOnlyWhenFineGrainedProtectionExists(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{
		Type:     "elasticsearch",
		ReadOnly: true,
		Protection: connection.ConnectionProtectionConfig{
			RestrictDataEdit: true,
		},
	}
	inspection := app.InspectElasticsearchConsole(config, "orders", "PUT /orders/_doc/42\n{}")
	if inspection.Success || inspection.BlockReason != elasticsearchConsoleBlockConnectionProtected {
		t.Fatalf("legacy readOnly write was not rejected: %+v", inspection)
	}
}

func TestElasticsearchConsoleUsesAuthoritativeSavedProtection(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()
	repo := newSavedConnectionRepository(app.configDir, store)
	base := connection.SavedConnectionInput{
		ID:   "protected-es",
		Name: "Protected ES",
		Config: connection.ConnectionConfig{
			ID:   "protected-es",
			Type: "elasticsearch",
			Host: "es.local",
			Port: 9200,
		},
	}
	view, err := repo.Save(base)
	if err != nil {
		t.Fatalf("save connection: %v", err)
	}
	callerConfig := view.Config
	callerConfig.Host = "attacker.invalid"
	effective, err := app.resolveElasticsearchConsoleConnectionConfig(callerConfig)
	if err != nil || effective.Host != "es.local" {
		t.Fatalf("saved connection identity was not authoritative: config=%+v err=%v", effective, err)
	}

	const source = "DELETE /orders/_doc/42"
	inspection := app.InspectElasticsearchConsole(callerConfig, "orders", source)
	if !inspection.Success || inspection.ConfirmationToken == "" {
		t.Fatalf("unexpected initial inspection: %+v", inspection)
	}

	base.Config.ReadOnly = true
	if _, err := repo.Save(base); err != nil {
		t.Fatalf("protect saved connection: %v", err)
	}
	blocked := app.InspectElasticsearchConsole(callerConfig, "orders", source)
	if blocked.Success || blocked.BlockReason != elasticsearchConsoleBlockConnectionProtected {
		t.Fatalf("caller cleared authoritative saved protection: %+v", blocked)
	}
	executed := app.ExecuteElasticsearchConsole(callerConfig, "orders", source, "stale-protection", inspection.Fingerprint, inspection.ConfirmationToken)
	if executed.Success || !strings.Contains(executed.Message, readOnlyConnectionQueryBlockedMessage()) {
		t.Fatalf("stale token bypassed authoritative saved protection: %+v", executed)
	}
}

func TestInspectElasticsearchConsoleResolvesSavedSecretsForCachedServerVersion(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()
	repo := newSavedConnectionRepository(app.configDir, store)
	view, err := repo.Save(connection.SavedConnectionInput{
		ID:   "saved-es-6",
		Name: "Saved ES 6",
		Config: connection.ConnectionConfig{
			ID:       "saved-es-6",
			Type:     "elasticsearch",
			Host:     "es6.local",
			Port:     9200,
			User:     "elastic",
			Password: "stored-secret",
		},
	})
	if err != nil {
		t.Fatalf("save connection: %v", err)
	}
	effective, err := app.resolveEffectiveConnectionConfig(view.Config)
	if err != nil {
		t.Fatalf("resolve saved connection: %v", err)
	}
	cacheElasticsearchConsoleTestDatabase(t, app, effective, &fakeElasticsearchConsoleDatabase{serverMajor: 6})

	inspection := app.InspectElasticsearchConsole(view.Config, "logs", "GET /")
	if !inspection.Success || inspection.ServerMajor != 6 {
		t.Fatalf("cached server version was not resolved through saved secrets: %+v", inspection)
	}
}

func TestExecuteElasticsearchConsoleUsesAuthoritativeSavedConnectionIdentity(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()
	repo := newSavedConnectionRepository(app.configDir, store)
	view, err := repo.Save(connection.SavedConnectionInput{
		ID:   "saved-es-authoritative",
		Name: "Saved ES",
		Config: connection.ConnectionConfig{
			ID:       "saved-es-authoritative",
			Type:     "elasticsearch",
			Host:     "es.saved.local",
			Port:     9200,
			User:     "elastic",
			Password: "stored-secret",
		},
	})
	if err != nil {
		t.Fatalf("save connection: %v", err)
	}
	effective, err := app.resolveElasticsearchConsoleConnectionConfig(view.Config)
	if err != nil {
		t.Fatalf("resolve saved connection: %v", err)
	}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
		{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders"}}}}`},
		{StatusCode: 200, RawBody: `{"result":"deleted"}`},
	}}
	cacheElasticsearchConsoleTestDatabase(t, app, effective, fake)
	callerConfig := view.Config
	callerConfig.Host = "attacker.invalid"
	callerConfig.Port = 19200
	const source = "DELETE /orders/_doc/42"
	inspection := app.InspectElasticsearchConsole(callerConfig, "orders", source)
	result := app.ExecuteElasticsearchConsole(callerConfig, "orders", source, "es-saved-identity", inspection.Fingerprint, inspection.ConfirmationToken)
	if !result.Success || len(fake.requests) != 2 {
		t.Fatalf("execution did not use the authoritative saved connection: result=%+v requests=%+v", result, fake.requests)
	}
}

func TestElasticsearchConsoleConfirmationTokenBindsSavedConnectionID(t *testing.T) {
	app := NewApp()
	configA := connection.ConnectionConfig{ID: "es-a", Type: "elasticsearch", Host: "same.local", Port: 9200, User: "elastic", Password: "inline-secret"}
	configB := configA
	configB.ID = "es-b"
	const source = "DELETE /orders/_doc/42"
	inspection := app.InspectElasticsearchConsole(configA, "orders", source)
	if !inspection.Success || inspection.ConfirmationToken == "" {
		t.Fatalf("unexpected inspection: %+v", inspection)
	}
	result := app.ExecuteElasticsearchConsole(configB, "orders", source, "es-cross-id", inspection.Fingerprint, inspection.ConfirmationToken)
	if result.Success || !strings.Contains(strings.ToLower(result.Message), "does not match") {
		t.Fatalf("token crossed saved connection IDs: %+v", result)
	}
}

func TestExecuteElasticsearchConsoleValidatesFingerprintAndConsumesTokenOnce(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
		{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders"}}}}`},
		{StatusCode: 200, RawBody: `{"result":"deleted"}`},
	}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	const source = "DELETE /orders/_doc/42"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)

	mismatch := app.ExecuteElasticsearchConsole(config, "orders", source, "es-fingerprint", strings.Repeat("0", 64), inspection.ConfirmationToken)
	if mismatch.Success || !strings.Contains(strings.ToLower(mismatch.Message), "fingerprint") {
		t.Fatalf("fingerprint mismatch was not rejected: %+v", mismatch)
	}

	executed := app.ExecuteElasticsearchConsole(config, "orders", source, "es-once", inspection.Fingerprint, inspection.ConfirmationToken)
	if !executed.Success || len(executed.Results) != 1 || executed.Results[0].Outcome != "success" {
		t.Fatalf("unexpected execution: %+v", executed)
	}
	replayed := app.ExecuteElasticsearchConsole(config, "orders", source, "es-replay", inspection.Fingerprint, inspection.ConfirmationToken)
	if replayed.Success || !strings.Contains(strings.ToLower(replayed.Message), "token") {
		t.Fatalf("confirmation token replay was not rejected: %+v", replayed)
	}
}

func TestElasticsearchConsoleConfirmationTokenConcurrentConsumption(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
		{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders"}}}}`},
		{StatusCode: 200, RawBody: `{"result":"deleted"}`},
	}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	const source = "DELETE /orders/_doc/42"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)

	results := make(chan ElasticsearchConsoleExecutionResult, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(queryID string) {
			defer wg.Done()
			results <- app.ExecuteElasticsearchConsole(config, "orders", source, queryID, inspection.Fingerprint, inspection.ConfirmationToken)
		}(fmt.Sprintf("es-token-race-%d", i))
	}
	wg.Wait()
	close(results)
	successes := 0
	for result := range results {
		if result.Success {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("confirmation token executions succeeded %d times, want exactly once", successes)
	}
	if len(fake.requests) != 2 {
		t.Fatalf("one confirmed delete should issue one probe and one write, got %+v", fake.requests)
	}
}

func TestExecuteElasticsearchConsoleRejectsMissingTamperedExpiredAndCrossConnectionTokens(t *testing.T) {
	baseConfig := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	otherConfig := baseConfig
	otherConfig.Host = "127.0.0.2"
	const source = "DELETE /orders/_doc/42"

	tests := []struct {
		name        string
		prepare     func(*App, ElasticsearchConsoleInspection) string
		execConfig  connection.ConnectionConfig
		wantMessage string
	}{
		{
			name:        "missing",
			prepare:     func(*App, ElasticsearchConsoleInspection) string { return "" },
			execConfig:  baseConfig,
			wantMessage: "required",
		},
		{
			name: "tampered",
			prepare: func(_ *App, inspection ElasticsearchConsoleInspection) string {
				return inspection.ConfirmationToken + "-tampered"
			},
			execConfig:  baseConfig,
			wantMessage: "invalid",
		},
		{
			name: "expired",
			prepare: func(app *App, inspection ElasticsearchConsoleInspection) string {
				app.elasticsearchConsoleTokenMu.Lock()
				entry := app.elasticsearchConsoleTokens[inspection.ConfirmationToken]
				entry.expiresAt = time.Now().Add(-time.Second)
				app.elasticsearchConsoleTokens[inspection.ConfirmationToken] = entry
				app.elasticsearchConsoleTokenMu.Unlock()
				return inspection.ConfirmationToken
			},
			execConfig:  baseConfig,
			wantMessage: "expired",
		},
		{
			name: "cross connection",
			prepare: func(_ *App, inspection ElasticsearchConsoleInspection) string {
				return inspection.ConfirmationToken
			},
			execConfig:  otherConfig,
			wantMessage: "does not match",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := NewApp()
			inspection := app.InspectElasticsearchConsole(baseConfig, "orders", source)
			token := test.prepare(app, inspection)
			result := app.ExecuteElasticsearchConsole(test.execConfig, "orders", source, "es-token", inspection.Fingerprint, token)
			if result.Success || !strings.Contains(strings.ToLower(result.Message), test.wantMessage) {
				t.Fatalf("unexpected token result: %+v", result)
			}
		})
	}
}

func TestExecuteElasticsearchConsoleStopsAfterBulkPartialFailure(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
		{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders"}}}}`},
		{StatusCode: 200, RawBody: `{"errors":true,"items":[{"index":{"status":409,"error":{"type":"version_conflict_engine_exception"}}}]}`},
		{StatusCode: 200, RawBody: `{"count":5}`},
	}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	source := "POST /orders/_bulk\n{\"index\":{\"_id\":\"1\"}}\n{\"status\":\"paid\"}\n\nGET /orders/_count"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)
	result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-bulk", inspection.Fingerprint, inspection.ConfirmationToken)
	if result.Success || len(result.Results) != 1 || result.Results[0].Outcome != "partial" || !result.Results[0].PartialFailure {
		t.Fatalf("unexpected bulk result: %+v", result)
	}
	if len(fake.requests) != 2 {
		t.Fatalf("executed %d requests after partial failure, want target probe plus Bulk", len(fake.requests))
	}
}

func TestExecuteElasticsearchConsoleStopsAfterIncompleteByQuery(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
		{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders"}}}}`},
		{StatusCode: 200, RawBody: `{"timed_out":true,"deleted":3,"failures":[]}`},
		{StatusCode: 200, RawBody: `{"count":5}`},
	}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	source := "POST /orders/_delete_by_query\n{\"query\":{\"match_all\":{}}}\n\nGET /orders/_count"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)
	result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-by-query-partial", inspection.Fingerprint, inspection.ConfirmationToken)
	if result.Success || result.Status != "partial" || !result.OutcomeUnknown || len(result.Results) != 1 || !result.Results[0].PartialFailure || !result.Results[0].OutcomeUnknown {
		t.Fatalf("incomplete by-query response was not stopped safely: %+v", result)
	}
	if len(fake.requests) != 2 {
		t.Fatalf("batch continued after incomplete by-query response: %+v", fake.requests)
	}
}

func TestExecuteElasticsearchConsoleBlocksDangerousAliasToSystemIndex(t *testing.T) {
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	for _, source := range []string{
		"DELETE /public-write/_doc/42",
		"POST /public-write/_bulk\n{\"delete\":{\"_id\":\"42\"}}",
	} {
		app := NewApp()
		fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{{
			StatusCode: 200,
			RawBody:    `{ ".security-7":{"settings":{"index":{"uuid":"uuid-system"}}}}`,
		}}}
		cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
		inspection := app.InspectElasticsearchConsole(config, "", source)
		result := app.ExecuteElasticsearchConsole(config, "", source, "es-system-alias", inspection.Fingerprint, inspection.ConfirmationToken)
		if result.Success || len(result.Results) != 1 || !strings.Contains(strings.ToLower(result.Results[0].Message), "system") {
			t.Fatalf("dangerous alias-to-system write was not rejected: %+v", result)
		}
		if len(fake.requests) != 1 || fake.requests[0].Method != "GET" {
			t.Fatalf("unsafe write was sent after target probe: %+v", fake.requests)
		}
	}
}

func TestExecuteElasticsearchConsoleAllowsNonIngestWriteOnPipelinedIndex(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
		{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders","default_pipeline":"normalize"}}}}`},
		{StatusCode: 200, RawBody: `{"result":"deleted"}`},
	}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	const source = "DELETE /orders/_doc/42"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)
	result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-delete-pipelined", inspection.Fingerprint, inspection.ConfirmationToken)
	if !result.Success || len(fake.requests) != 2 {
		t.Fatalf("non-ingest delete was incorrectly blocked by index pipeline: result=%+v requests=%+v", result, fake.requests)
	}
}

func TestExecuteElasticsearchConsoleChecksBulkPipelinesPerActionTarget(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
		{StatusCode: 200, RawBody: `{"create-target":{"settings":{"index":{"uuid":"uuid-create"}}}}`},
		{StatusCode: 200, RawBody: `{"delete-target":{"settings":{"index":{"uuid":"uuid-delete","default_pipeline":"normalize"}}}}`},
		{StatusCode: 200, RawBody: `{"errors":false,"items":[{"index":{"status":201}},{"delete":{"status":200}}]}`},
	}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	const source = "POST /_bulk\n" +
		`{"index":{"_index":"create-target","_id":"1"}}` + "\n" +
		`{"name":"created"}` + "\n" +
		`{"delete":{"_index":"delete-target","_id":"2"}}` + "\n"
	inspection := app.InspectElasticsearchConsole(config, "", source)
	result := app.ExecuteElasticsearchConsole(config, "", source, "es-bulk-pipeline-target", inspection.Fingerprint, inspection.ConfirmationToken)
	if !result.Success || len(fake.requests) != 3 {
		t.Fatalf("delete-only target pipeline incorrectly blocked Bulk: result=%+v requests=%+v", result, fake.requests)
	}
}

func TestExecuteElasticsearchConsoleTreatsInvalidWriteResponseAsUnknown(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
		{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders"}}}}`},
		{StatusCode: 200, RawBody: `accepted but not json`},
	}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	const source = "PUT /orders/_doc/42\n{\"status\":\"paid\"}"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)
	result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-invalid-write-response", inspection.Fingerprint, "")
	if result.Success || !result.OutcomeUnknown || len(result.Results) != 1 || !result.Results[0].OutcomeUnknown {
		t.Fatalf("invalid write response was not treated as unknown: %+v", result)
	}
}

func TestExecuteElasticsearchConsoleExtractsSearchHitsAndRawResponse(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{{
		StatusCode: 200,
		RawBody: `{"hits":{"total":{"value":1,"relation":"eq"},"hits":[` +
			`{"_index":"orders","_id":"42","_score":1,"_source":{"status":"paid","amount":12.5}}]}}`,
		ServerMajor: 8,
	}}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	const source = "GET /orders/_search"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)
	result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-read", inspection.Fingerprint, "")
	if !result.Success || len(result.Results) != 1 {
		t.Fatalf("unexpected execution result: %+v", result)
	}
	response := result.Results[0]
	if response.RawResponse == "" || len(response.Rows) != 1 || response.ServerMajor != 8 {
		t.Fatalf("raw/tabular response missing: %+v", response)
	}
	if response.Rows[0]["status"] != "paid" || response.Rows[0]["_id"] != "42" {
		t.Fatalf("unexpected hit row: %#v", response.Rows[0])
	}
}

func TestExecuteElasticsearchConsoleBindsQueryStringToSelectedIndex(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200, Database: "old-default"}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{{
		StatusCode: 200,
		RawBody:    `{"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}`,
	}}}
	cacheElasticsearchConsoleTestDatabase(t, app, normalizeRunConfig(config, ""), fake)
	const source = "status:open"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)
	result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-query-string", inspection.Fingerprint, "")
	if !result.Success || len(fake.requests) != 1 || fake.requests[0].Path != "/orders/_search" || !strings.Contains(fake.requests[0].Body, `"query":"status:open"`) {
		t.Fatalf("query_string did not use selected index: result=%+v requests=%+v", result, fake.requests)
	}
}

func TestElasticsearchConsoleConvertsSimplifiedSelectAndRejectsURLTargets(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{{
		StatusCode: 200,
		RawBody:    `{"hits":{"total":{"value":0,"relation":"eq"},"hits":[]}}`,
	}}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)

	const safeSource = `SELECT * FROM "orders" WHERE status = 'open' LIMIT 10`
	inspection := app.InspectElasticsearchConsole(config, "fallback", safeSource)
	result := app.ExecuteElasticsearchConsole(config, "fallback", safeSource, "es-select", inspection.Fingerprint, "")
	if !result.Success || len(fake.requests) != 1 || fake.requests[0].Path != "/orders/_search" || !strings.Contains(fake.requests[0].Body, `"size":10`) {
		t.Fatalf("simplified SELECT was not converted to the REST executor: result=%+v requests=%+v", result, fake.requests)
	}

	blocked := app.InspectElasticsearchConsole(config, "fallback", `SELECT * FROM "orders/_delete_by_query?pretty=true#"`)
	if blocked.Success || !blocked.Blocked {
		t.Fatalf("unsafe SELECT target was not blocked: %+v", blocked)
	}
	if len(fake.requests) != 1 {
		t.Fatalf("unsafe SELECT target reached the executor: %+v", fake.requests)
	}
}

func TestProjectElasticsearchConsoleResponsePreservesHitMetadataAndCountsBulkSuccesses(t *testing.T) {
	rows, columns, affected, partial, incomplete := projectElasticsearchConsoleResponse(`{"hits":{"total":1,"hits":[{"_index":"orders","_id":"42","_score":1,"_source":{"_id":"spoofed","status":"paid"}}]}}`)
	if partial || incomplete || affected != 0 || len(rows) != 1 || rows[0]["_id"] != "42" || len(columns) == 0 {
		t.Fatalf("unexpected hit projection: rows=%+v columns=%+v affected=%d partial=%v", rows, columns, affected, partial)
	}
	_, _, affected, partial, incomplete = projectElasticsearchConsoleResponse(`{"errors":true,"items":[{"index":{"status":201}},{"update":{"status":200,"result":"noop"}},{"delete":{"status":404}}]}`)
	if !partial || incomplete || affected != 1 {
		t.Fatalf("bulk projection = affected:%d partial:%v, want 1/true", affected, partial)
	}
}

func TestProjectElasticsearchConsoleResponseDetectsIncompleteSuccessPayloads(t *testing.T) {
	for _, raw := range []string{
		`{"timed_out":true,"updated":3,"failures":[]}`,
		`{"acknowledged":false}`,
		`{"shards_acknowledged":false}`,
	} {
		_, _, _, partial, incomplete := projectElasticsearchConsoleResponse(raw)
		if !partial || !incomplete {
			t.Fatalf("incomplete payload was not detected: %s", raw)
		}
	}
	_, _, _, partial, incomplete := projectElasticsearchConsoleResponse(`{"failures":[{"cause":{"type":"version_conflict_engine_exception"}}]}`)
	if !partial || incomplete {
		t.Fatalf("by-query failures classification = partial:%v incomplete:%v", partial, incomplete)
	}
	_, _, _, partial, incomplete = projectElasticsearchConsoleResponse(`{"responses":[{"hits":{"hits":[]}},{"error":{"type":"index_not_found_exception"},"status":404}]}`)
	if !partial || incomplete {
		t.Fatalf("msearch partial classification = partial:%v incomplete:%v", partial, incomplete)
	}
	_, _, _, partial, incomplete = projectElasticsearchConsoleResponse(`{"hits":{"hits":[]},"_shards":{"total":2,"successful":1,"failed":1}}`)
	if !partial || incomplete {
		t.Fatalf("shard failure classification = partial:%v incomplete:%v", partial, incomplete)
	}
	_, _, _, partial, incomplete = projectElasticsearchConsoleResponse(`{"responses":[{"timed_out":true,"hits":{"hits":[]}}]}`)
	if !partial || !incomplete {
		t.Fatalf("msearch timeout classification = partial:%v incomplete:%v", partial, incomplete)
	}
	_, _, _, partial, incomplete = projectElasticsearchConsoleResponse(`{"updated":3,"version_conflicts":2,"failures":[]}`)
	if !partial || incomplete {
		t.Fatalf("version-conflict response classification = partial:%v incomplete:%v", partial, incomplete)
	}
}

func TestExecuteElasticsearchConsoleReportsHTTPErrorAndUnknownWriteOutcome(t *testing.T) {
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}

	t.Run("structured HTTP error is known", func(t *testing.T) {
		app := NewApp()
		fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{{
			StatusCode: 429,
			RawBody:    `{"error":{"type":"es_rejected_execution_exception"},"status":429}`,
		}}}
		cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
		const source = "GET /orders/_search"
		inspection := app.InspectElasticsearchConsole(config, "orders", source)
		result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-429", inspection.Fingerprint, "")
		if result.Success || result.Results[0].HTTPStatus != 429 || result.Results[0].OutcomeUnknown {
			t.Fatalf("unexpected HTTP error result: %+v", result)
		}
		if len(result.Results[0].Rows) != 0 {
			t.Fatalf("HTTP error payload was projected into rows: %+v", result.Results[0].Rows)
		}
	})

	t.Run("large HTTP error is display truncated before projection", func(t *testing.T) {
		app := NewApp()
		raw := `{"hits":{"hits":[{"_source":{"payload":"` + strings.Repeat("x", 70<<10) + `"}}]}}`
		fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{{StatusCode: 400, RawBody: raw}}}
		cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
		const source = "GET /orders/_search"
		inspection := app.InspectElasticsearchConsole(config, "orders", source)
		result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-large-400", inspection.Fingerprint, "")
		if result.Success || len(result.Results) != 1 || len(result.Results[0].RawResponse) > elasticsearchConsoleErrorDisplayLimit+32 || len(result.Results[0].Rows) != 0 {
			t.Fatalf("large HTTP error was not safely truncated: %+v", result.Results[0])
		}
	})

	t.Run("write transport error is potentially unknown", func(t *testing.T) {
		app := NewApp()
		fake := &fakeElasticsearchConsoleDatabase{
			responses: []db.ElasticsearchConsoleResponse{{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders"}}}}`}, {}},
			errors:    []error{nil, context.DeadlineExceeded},
		}
		cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
		const source = "PUT /orders/_doc/42\n{}"
		inspection := app.InspectElasticsearchConsole(config, "orders", source)
		result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-timeout", inspection.Fingerprint, "")
		if result.Success || !result.OutcomeUnknown || !result.Results[0].OutcomeUnknown {
			t.Fatalf("write outcome was not marked unknown: %+v", result)
		}
		app.mu.RLock()
		_, cached := app.dbCache[getCacheKey(config)]
		app.mu.RUnlock()
		if !cached {
			t.Fatal("direct HTTP cancellation evicted a reusable shared Elasticsearch connection")
		}
	})

	t.Run("stopped optional transport is evicted", func(t *testing.T) {
		app := NewApp()
		base := &fakeElasticsearchConsoleDatabase{errors: []error{context.Canceled}}
		stopped := &stoppedElasticsearchConsoleDatabase{fakeElasticsearchConsoleDatabase: base}
		cacheElasticsearchConsoleTestDatabase(t, app, config, stopped)
		const source = "GET /orders/_search"
		inspection := app.InspectElasticsearchConsole(config, "orders", source)
		result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-stopped-agent", inspection.Fingerprint, "")
		if result.Success {
			t.Fatalf("stopped transport unexpectedly succeeded: %+v", result)
		}
		app.mu.RLock()
		_, cached := app.dbCache[getCacheKey(config)]
		app.mu.RUnlock()
		if cached {
			t.Fatal("stopped optional transport remained cached")
		}
	})
}

func TestExecuteElasticsearchConsoleValidatesNormalWriteTarget(t *testing.T) {
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	const source = "PUT /orders/_doc/42\n{}"

	for _, test := range []struct {
		name     string
		response db.ElasticsearchConsoleResponse
		message  string
	}{
		{
			name:     "missing index",
			response: db.ElasticsearchConsoleResponse{StatusCode: 404, RawBody: `{"error":{"type":"index_not_found_exception"}}`},
			message:  "existing concrete",
		},
		{
			name:     "metadata permission denied",
			response: db.ElasticsearchConsoleResponse{StatusCode: 403, RawBody: `{"error":{"type":"security_exception"}}`},
			message:  "view_index_metadata",
		},
		{
			name:     "alias to system index",
			response: db.ElasticsearchConsoleResponse{StatusCode: 200, RawBody: `{ ".security-7":{"settings":{"index":{"uuid":"uuid-system"}}}}`},
			message:  "system",
		},
		{
			name:     "configured ingest pipeline",
			response: db.ElasticsearchConsoleResponse{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders","default_pipeline":"redirect"}}}}`},
			message:  "pipeline",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := NewApp()
			fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{test.response}}
			cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
			inspection := app.InspectElasticsearchConsole(config, "orders", source)
			result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-target-"+test.name, inspection.Fingerprint, "")
			if result.Success || len(result.Results) != 1 || !strings.Contains(strings.ToLower(result.Results[0].Message), test.message) {
				t.Fatalf("unsafe normal write target was not rejected: %+v", result)
			}
			if len(fake.requests) != 1 || fake.requests[0].Method != "GET" {
				t.Fatalf("write executed after target validation failure: %+v", fake.requests)
			}
		})
	}

	t.Run("existing concrete index", func(t *testing.T) {
		app := NewApp()
		fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
			{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders"}}}}`},
			{StatusCode: 200, RawBody: `{"result":"updated"}`},
		}}
		cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
		inspection := app.InspectElasticsearchConsole(config, "orders", source)
		result := app.ExecuteElasticsearchConsole(config, "orders", source, "es-target-existing", inspection.Fingerprint, "")
		if !result.Success || len(fake.requests) != 2 || fake.requests[1].Method != "PUT" {
			t.Fatalf("existing concrete index write failed: result=%+v requests=%+v", result, fake.requests)
		}
	})

	t.Run("plus sign is escaped in target probe", func(t *testing.T) {
		app := NewApp()
		fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
			{StatusCode: 200, RawBody: `{"logs+2026":{"settings":{"index":{"uuid":"uuid-plus"}}}}`},
			{StatusCode: 200, RawBody: `{"result":"updated"}`},
		}}
		cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
		const plusSource = "PUT /logs+2026/_doc/42\n{}"
		inspection := app.InspectElasticsearchConsole(config, "", plusSource)
		result := app.ExecuteElasticsearchConsole(config, "", plusSource, "es-target-plus", inspection.Fingerprint, "")
		if !result.Success || len(fake.requests) != 2 || !strings.Contains(fake.requests[0].Path, "logs%2B2026") {
			t.Fatalf("plus target probe was not safely escaped: result=%+v requests=%+v", result, fake.requests)
		}
	})
}

func TestExecuteElasticsearchConsoleRejectsDuplicateRunningQueryID(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "elasticsearch", Host: "127.0.0.1", Port: 9200}
	fake := &fakeElasticsearchConsoleDatabase{responses: []db.ElasticsearchConsoleResponse{
		{StatusCode: 200, RawBody: `{"orders":{"settings":{"index":{"uuid":"uuid-orders"}}}}`},
		{StatusCode: 200, RawBody: `{"result":"deleted"}`},
	}}
	cacheElasticsearchConsoleTestDatabase(t, app, config, fake)
	const source = "DELETE /orders/_doc/42"
	inspection := app.InspectElasticsearchConsole(config, "orders", source)
	app.queryMu.Lock()
	app.runningQueries["duplicate-es-query"] = queryContext{cancel: func() {}, started: time.Now(), retainUntilDone: true}
	app.queryMu.Unlock()
	t.Cleanup(func() {
		app.queryMu.Lock()
		delete(app.runningQueries, "duplicate-es-query")
		app.queryMu.Unlock()
	})

	result := app.ExecuteElasticsearchConsole(config, "orders", source, "duplicate-es-query", inspection.Fingerprint, inspection.ConfirmationToken)
	if result.Success || !strings.Contains(strings.ToLower(result.Message), "already running") {
		t.Fatalf("duplicate query ID was not rejected: %+v", result)
	}
	if len(fake.requests) != 0 {
		t.Fatalf("duplicate query ID executed %d requests", len(fake.requests))
	}
	app.queryMu.Lock()
	delete(app.runningQueries, "duplicate-es-query")
	app.queryMu.Unlock()
	retry := app.ExecuteElasticsearchConsole(config, "orders", source, "retry-es-query", inspection.Fingerprint, inspection.ConfirmationToken)
	if !retry.Success {
		t.Fatalf("duplicate query ID consumed confirmation token before execution: %+v", retry)
	}
}
