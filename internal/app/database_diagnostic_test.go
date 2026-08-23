package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/requesttrace"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func TestBuildDatabaseDiagnosticPackageIsReadOnlyAndRedactsDatabaseContent(t *testing.T) {
	application := NewApp()
	application.configDir = t.TempDir()
	config := connection.ConnectionConfig{
		ID:           "connection-private-id",
		Type:         "postgres",
		Host:         "db.internal.example",
		Port:         5432,
		User:         "diagnostic-user",
		Password:     "super-secret-password",
		Database:     "customer_records",
		DSN:          "postgres://diagnostic-user:super-secret-password@db.internal.example/customer_records",
		URI:          "postgres://diagnostic-user:super-secret-password@db.internal.example/customer_records",
		SSLCAPath:    "C:\\private\\ca.pem",
		Timeout:      17,
		QueryTimeout: 31,
		UseSSH:       true,
	}
	application.dbCache = map[string]cachedDatabase{
		"fixture-cache-key": {
			config:   config,
			lastPing: time.UnixMilli(1_700_000_000_000),
		},
	}

	fingerprints, ok := queryHistoryConnectionFingerprints(config, config.Database)
	if !ok || len(fingerprints) == 0 {
		t.Fatal("fixture connection fingerprint was not created")
	}
	if err := newQueryHistoryStore(application.configDir, fingerprints[0]).Append(connection.QueryExecutionRecord{
		ID:           "slow-query-private-id",
		ConnectionFP: fingerprints[0],
		DBType:       "postgres",
		SQLPreview:   "SELECT account_no FROM customer_records WHERE token = 'private-row-value'",
		SQLText:      "SELECT account_no FROM customer_records WHERE token = 'private-row-value'",
		DurationMs:   queryHistorySlowThresholdMs + 50,
		RowsRead:     42,
		RowsReturned: 1,
		ExecutedAt:   time.UnixMilli(1_700_000_000_100),
	}); err != nil {
		t.Fatalf("append slow-query fixture: %v", err)
	}

	trace := application.requestDiagnostics().Start(requesttrace.Input{
		RequestID:      "query-11111111-2222-3333-4444-555555555555",
		Entry:          "desktop",
		Operation:      "database.query",
		DataSourceType: "postgres",
		DriverMode:     "builtin-over-ssh",
	})
	trace.AddEvent("driver.dispatched", map[string]string{
		"sql": "SELECT * FROM customer_records WHERE token = 'private-row-value'",
	})
	trace.MarkCancellation(true)
	trace.Complete(requesttrace.Completion{
		Status:       "error",
		ErrorKind:    "connection",
		ErrorMessage: "postgres://diagnostic-user:super-secret-password@db.internal.example/customer_records failed",
	})

	application.queryMu.Lock()
	application.runningQueries["query-11111111-2222-3333-4444-555555555555"] = queryContext{
		started: time.Now().Add(-time.Second),
	}
	application.runningQueries["query-private-row-value"] = queryContext{
		started: time.Now().Add(-time.Second),
	}
	application.queryMu.Unlock()
	application.sqlTransactionMu.Lock()
	application.sqlTransactions["tx-11111111-2222-3333-4444-555555555555"] = &managedSQLTransaction{
		id:           "tx-11111111-2222-3333-4444-555555555555",
		dbType:       "postgres",
		boundaryMode: "driver_api",
		createdAt:    time.Now().Add(-time.Second),
	}
	application.sqlTransactionMu.Unlock()

	result := application.BuildDatabaseDiagnosticPackage()
	if !result.Success {
		t.Fatalf("BuildDatabaseDiagnosticPackage failed: %s", result.Message)
	}
	export, ok := result.Data.(databaseDiagnosticExportPayload)
	if !ok {
		t.Fatalf("unexpected export payload: %#v", result.Data)
	}
	if export.FileName == "" || export.MimeType != "application/json;charset=utf-8" || export.Content == "" {
		t.Fatalf("invalid diagnostic export payload: %#v", export)
	}

	var diagnostic databaseDiagnosticPackage
	if err := json.Unmarshal([]byte(export.Content), &diagnostic); err != nil {
		t.Fatalf("decode diagnostic package: %v", err)
	}
	if !diagnostic.ReadOnly || diagnostic.SchemaVersion == "" {
		t.Fatalf("package must advertise the read-only schema: %#v", diagnostic)
	}
	if len(diagnostic.Connections) != 1 {
		t.Fatalf("connection summary count = %d, want 1", len(diagnostic.Connections))
	}
	if got := diagnostic.Connections[0]; got.DataSourceType != "postgres" || got.QueryTimeoutSeconds != 31 || !got.Transport.SSH {
		t.Fatalf("unexpected connection summary: %#v", got)
	}
	if len(diagnostic.RequestTraces) != 1 || diagnostic.RequestTraces[0].QueryID != "query-11111111-2222-3333-4444-555555555555" {
		t.Fatalf("missing safe query trace: %#v", diagnostic.RequestTraces)
	}
	if diagnostic.Sources.ConnectionState != "connected" || len(diagnostic.Sources.DriverTypes) != 1 || diagnostic.Sources.Logs != "excluded_privacy_boundary" || diagnostic.Sources.AISnapshot != "excluded_privacy_boundary" {
		t.Fatalf("unexpected diagnostic source availability: %#v", diagnostic.Sources)
	}
	if len(diagnostic.RunningQueries) != 2 || diagnostic.RunningQueries[0].State != "running" {
		t.Fatalf("missing running-query state: %#v", diagnostic.RunningQueries)
	}
	containsRedactedID := false
	for _, query := range diagnostic.RunningQueries {
		containsRedactedID = containsRedactedID || strings.HasPrefix(query.QueryID, "redacted-")
	}
	if !containsRedactedID {
		t.Fatalf("unsafe running query identifier was not redacted: %#v", diagnostic.RunningQueries)
	}
	if len(diagnostic.Transactions) != 1 || diagnostic.Transactions[0].State != "pending" {
		t.Fatalf("missing pending transaction state: %#v", diagnostic.Transactions)
	}
	if len(diagnostic.SlowQuerySummaries) != 1 || diagnostic.SlowQuerySummaries[0].RecordCount != 1 {
		t.Fatalf("missing read-only slow-query summary: %#v", diagnostic.SlowQuerySummaries)
	}

	for _, forbidden := range []string{
		"super-secret-password",
		"db.internal.example",
		"diagnostic-user",
		"customer_records",
		"private-row-value",
		"C:\\private\\ca.pem",
		"SELECT account_no",
	} {
		if strings.Contains(export.Content, forbidden) {
			t.Fatalf("diagnostic package leaked %q: %s", forbidden, export.Content)
		}
	}
}

func TestDatabaseDiagnosticPreviewAndBuildDoNotCreateHistoryFilesWithoutData(t *testing.T) {
	application := NewApp()
	application.configDir = t.TempDir()

	previewResult := application.GetDatabaseDiagnosticPackagePreview()
	if !previewResult.Success {
		t.Fatalf("GetDatabaseDiagnosticPackagePreview failed: %s", previewResult.Message)
	}
	preview, ok := previewResult.Data.(databaseDiagnosticPreview)
	if !ok {
		t.Fatalf("unexpected diagnostic preview: %#v", previewResult.Data)
	}
	if !preview.ReadOnly || preview.ConnectionCount != 0 || preview.Sources.ConnectionState != "no_connection" || preview.Redaction.Credentials != "excluded" {
		t.Fatalf("unexpected no-connection preview: %#v", preview)
	}

	buildResult := application.BuildDatabaseDiagnosticPackage()
	if !buildResult.Success {
		t.Fatalf("BuildDatabaseDiagnosticPackage failed: %s", buildResult.Message)
	}
	if _, err := os.Stat(filepath.Join(application.configDir, queryHistoryDirName)); !os.IsNotExist(err) {
		t.Fatalf("read-only diagnostic build created query-history storage: %v", err)
	}
}

func TestDatabaseDiagnosticConnectionStateDistinguishesMultipleDrivers(t *testing.T) {
	connections := []databaseDiagnosticCachedConnection{
		{config: connection.ConnectionConfig{Type: "postgres"}},
		{config: connection.ConnectionConfig{Type: "mysql"}},
	}
	if got := databaseDiagnosticConnectionState(connections); got != "multiple_drivers" {
		t.Fatalf("connection state = %q, want multiple_drivers", got)
	}
}

func TestExportDatabaseDiagnosticPackageWritesSelectedJSONFile(t *testing.T) {
	application := NewApp()
	application.configDir = t.TempDir()
	target := filepath.Join(t.TempDir(), "support-package")
	application.saveFileDialog = func(_ context.Context, options runtime.SaveDialogOptions) (string, error) {
		if !strings.HasPrefix(options.DefaultFilename, "gonavi-database-diagnostics-") {
			t.Fatalf("unexpected default filename: %q", options.DefaultFilename)
		}
		return target, nil
	}

	result := application.ExportDatabaseDiagnosticPackage()
	if !result.Success {
		t.Fatalf("ExportDatabaseDiagnosticPackage failed: %s", result.Message)
	}
	path := result.Data.(map[string]string)["path"]
	if filepath.Ext(path) != ".json" {
		t.Fatalf("diagnostic package extension = %q, want .json", filepath.Ext(path))
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read exported diagnostic package: %v", err)
	}
	var diagnostic databaseDiagnosticPackage
	if err := json.Unmarshal(content, &diagnostic); err != nil {
		t.Fatalf("decode exported package: %v", err)
	}
	if !diagnostic.ReadOnly {
		t.Fatalf("exported package must remain read-only: %#v", diagnostic)
	}
}

func TestExportDatabaseDiagnosticPackageRejectsApplicationStorageTarget(t *testing.T) {
	application := NewApp()
	application.configDir = t.TempDir()
	application.saveFileDialog = func(_ context.Context, _ runtime.SaveDialogOptions) (string, error) {
		return filepath.Join(application.configDir, "database-diagnostic"), nil
	}

	result := application.ExportDatabaseDiagnosticPackage()
	if result.Success || !strings.Contains(result.Message, "cannot be inside application storage") {
		t.Fatalf("expected application storage target rejection, got %#v", result)
	}
	if _, err := os.Stat(filepath.Join(application.configDir, "database-diagnostic.json")); !os.IsNotExist(err) {
		t.Fatalf("diagnostic export unexpectedly wrote into application storage: %v", err)
	}
}
