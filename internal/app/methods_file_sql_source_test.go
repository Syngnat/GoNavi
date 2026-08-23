package app

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/uievents"
)

func TestExecuteSQLFileStreamRejectsOversizedStatementBeforeExec(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader("ABCDEFGHIJK;"), sqlFileExecutionOptions{
		DBType:            "postgres",
		MaxStatementBytes: 4,
	}, nil)
	var limitErr *SQLStatementTooLargeError
	if !errors.As(err, &limitErr) {
		t.Fatalf("execute error = %v, want SQLStatementTooLargeError", err)
	}
	if result.Executed != 0 || fakeDB.execCalls != 0 || fakeDB.batchCalls != 0 {
		t.Fatalf("result = %#v, exec=%d batch=%d; want no SQL side effect", result, fakeDB.execCalls, fakeDB.batchCalls)
	}
}

func TestExecuteSQLFileStreamPreflightsStatementBeforeExec(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader("\\connect reporting\nSELECT 1;"), sqlFileExecutionOptions{
		DBType:                 "postgres",
		PreflightEachStatement: true,
	}, nil)
	var preflightErr *sqlFilePreflightRejectedError
	if !errors.As(err, &preflightErr) {
		t.Fatalf("execute error = %v, want preflight rejection", err)
	}
	if result.Executed != 0 || fakeDB.execCalls != 0 || fakeDB.batchCalls != 0 {
		t.Fatalf("result = %#v, exec=%d batch=%d; want no SQL side effect", result, fakeDB.execCalls, fakeDB.batchCalls)
	}
}

func TestSQLFileExecutionDialogFiltersAreSafeOnMacOS(t *testing.T) {
	filters := sqlFileExecutionDialogFiltersForPlatform(nil, "darwin")
	if len(filters) != 1 || filters[0].Pattern != "*.sql;*.gz" {
		t.Fatalf("filters = %#v, want SQL and gzip extension patterns without an all-files wildcard", filters)
	}
}

func TestSQLFileExecutionDialogFiltersIncludeGzipSQLOutsideMacOS(t *testing.T) {
	filters := sqlFileExecutionDialogFiltersForPlatform(nil, "linux")
	if len(filters) != 2 || filters[0].Pattern != "*.sql;*.sql.gz" || filters[1].Pattern != "*.*" {
		t.Fatalf("filters = %#v, want SQL and gzip SQL pattern plus all-files fallback", filters)
	}
}

func TestShouldFullyPreflightSQLFileSkipsLargeSources(t *testing.T) {
	if !shouldFullyPreflightSQLFile(sqlFileFullPreflightMaxRawBytes) {
		t.Fatal("source at threshold should receive a full preflight")
	}
	if shouldFullyPreflightSQLFile(sqlFileFullPreflightMaxRawBytes + 1) {
		t.Fatal("source above threshold should use per-statement preflight")
	}
}

func TestExecuteSQLFileStreamReportsPossiblePriorEffectsOnLatePreflightRejection(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := "CREATE TABLE completed_first(id int);\n\\connect reporting\nSELECT 1;"

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:                 "postgres",
		PreflightEachStatement: true,
	}, nil)
	var preflightErr *sqlFilePreflightRejectedError
	if !errors.As(err, &preflightErr) {
		t.Fatalf("execute error = %v, want preflight rejection", err)
	}
	if result.Executed != 1 || preflightErr.executed != 1 || !strings.Contains(err.Error(), "may already have completed") {
		t.Fatalf("result = %#v, error = %v; want explicit possible prior effects", result, err)
	}
	for _, query := range fakeDB.execQueries {
		if strings.Contains(query, "\\connect") {
			t.Fatalf("unsafe client command reached database: %q", query)
		}
	}
}

func TestExecuteSQLFileStreamTreatsFailedPriorStatementAsUnknownOnLatePreflightRejection(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "broken_proc"}
	input := "CALL broken_proc();\n\\connect reporting\nSELECT 1;"

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:                 "postgres",
		ContinueOnError:        true,
		PreflightEachStatement: true,
	}, nil)
	var preflightErr *sqlFilePreflightRejectedError
	if !errors.As(err, &preflightErr) {
		t.Fatalf("execute error = %v, want preflight rejection", err)
	}
	if result.Executed != 0 || result.Failed != 1 || !preflightErr.possibleSideEffects || !preflightErr.outcomeUnknown {
		t.Fatalf("result = %#v, error = %#v", result, preflightErr)
	}
	payload := buildSQLFilePreflightFailurePayload(preflightErr)
	if payload["previousStatementsMayHaveCompleted"] != true || payload["outcomeUnknown"] != true {
		t.Fatalf("unexpected preflight payload: %#v", payload)
	}
}

func TestExecuteSQLFileDecodesUTF16LEEndToEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "utf16.sql")
	if err := os.WriteFile(path, encodeUTF16SQL("CREATE TABLE utf16_demo(id int);", binary.LittleEndian), 0o600); err != nil {
		t.Fatalf("write UTF-16 source: %v", err)
	}
	fakeDB := &fakeSQLFileBatchDB{}
	installSQLFileSourceDatabaseFactory(t, func(string) (db.Database, error) { return fakeDB, nil })

	result := newSQLFileSourceTestApp(t).executeSQLFile(sqlFileSourceTestConfig(), "demo", path, "utf16-job", false)
	if !result.Success {
		t.Fatalf("execute UTF-16 SQL file: %#v", result)
	}
	if !containsSQLFileQuery(fakeDB.execQueries, "CREATE TABLE utf16_demo(id int)") {
		t.Fatalf("executed queries = %#v, want decoded UTF-16 statement", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamsGzipEndToEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dump.sql.gz")
	writeGzipSQL(t, path, []byte("CREATE TABLE gzip_demo(id int);"))
	fakeDB := &fakeSQLFileBatchDB{}
	installSQLFileSourceDatabaseFactory(t, func(string) (db.Database, error) { return fakeDB, nil })

	result := newSQLFileSourceTestApp(t).executeSQLFile(sqlFileSourceTestConfig(), "demo", path, "gzip-job", false)
	if !result.Success {
		t.Fatalf("execute gzip SQL file: %#v", result)
	}
	if !containsSQLFileQuery(fakeDB.execQueries, "CREATE TABLE gzip_demo(id int)") {
		t.Fatalf("executed queries = %#v, want decompressed statement", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileGzipProgressUsesRawCompressedBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.sql.gz")
	payload := "/*" + strings.Repeat("0123456789abcdef", 64<<10) + "*/\nCREATE TABLE progress_demo(id int);"
	writeGzipSQL(t, path, []byte(payload))
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat gzip source: %v", err)
	}
	fakeDB := &fakeSQLFileBatchDB{}
	installSQLFileSourceDatabaseFactory(t, func(string) (db.Database, error) { return fakeDB, nil })
	recorder := &sqlFileProgressRecorder{}
	app := newSQLFileSourceTestApp(t)
	app.ctx = uievents.WithEmitter(context.Background(), recorder)

	result := app.executeSQLFile(sqlFileSourceTestConfig(), "demo", path, "gzip-progress-job", false)
	if !result.Success {
		t.Fatalf("execute gzip SQL file: %#v", result)
	}
	if len(recorder.events) == 0 {
		t.Fatal("expected SQL file progress events")
	}
	for _, event := range recorder.events {
		bytesRead, _ := event["bytesRead"].(int64)
		if bytesRead > info.Size() {
			t.Fatalf("progress bytes = %d, compressed size = %d; decoded bytes were used as numerator", bytesRead, info.Size())
		}
		if event["byteProgressKind"] != "rawSource" || event["decodedBytes"] != nil || event["decodedTotalBytes"] != nil {
			t.Fatalf("progress metadata = %#v, want explicit raw-source progress and unknown decoded totals", event)
		}
	}
}

func TestExecuteSQLFileSmallSourcePreflightRunsBeforeDatabaseOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unsafe.sql")
	if err := os.WriteFile(path, []byte("\\connect reporting\nSELECT 1;"), 0o600); err != nil {
		t.Fatalf("write unsafe source: %v", err)
	}
	factoryCalls := 0
	installSQLFileSourceDatabaseFactory(t, func(string) (db.Database, error) {
		factoryCalls++
		return &fakeSQLFileBatchDB{}, nil
	})

	result := newSQLFileSourceTestApp(t).executeSQLFile(sqlFileSourceTestConfig(), "demo", path, "unsafe-job", false)
	if result.Success || factoryCalls != 0 {
		t.Fatalf("result = %#v, factory calls = %d; want rejection before database open", result, factoryCalls)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok || payload["preflightRejected"] != true || payload["previousStatementsMayHaveCompleted"] != false {
		t.Fatalf("payload = %#v, want structured no-side-effect preflight rejection", result.Data)
	}
}

func TestExecuteSQLFileSmallSourceStatementLimitRunsBeforeDatabaseOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversized.sql")
	if err := os.WriteFile(path, []byte("ABCDEFGHIJK;"), 0o600); err != nil {
		t.Fatalf("write oversized source: %v", err)
	}
	factoryCalls := 0
	installSQLFileSourceDatabaseFactory(t, func(string) (db.Database, error) {
		factoryCalls++
		return &fakeSQLFileBatchDB{}, nil
	})

	result := newSQLFileSourceTestApp(t).executeSQLFileWithStatementLimit(sqlFileSourceTestConfig(), "demo", path, "oversized-job", false, 4)
	if result.Success || factoryCalls != 0 {
		t.Fatalf("result = %#v, factory calls = %d; want statement limit before database open", result, factoryCalls)
	}
	if !strings.Contains(result.Message, "source byte") {
		t.Fatalf("message = %q, want structured statement position", result.Message)
	}
}

func installSQLFileSourceDatabaseFactory(t *testing.T, factory func(string) (db.Database, error)) {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})
	newDatabaseFunc = factory
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }
}

func newSQLFileSourceTestApp(t *testing.T) *App {
	t.Helper()
	app := NewApp()
	app.ctx = nil
	app.configDir = t.TempDir()
	app.startedAt = time.Now().Add(-startupConnectRetryWindow - time.Second)
	return app
}

func sqlFileSourceTestConfig() connection.ConnectionConfig {
	return connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "demo",
	}
}

func containsSQLFileQuery(queries []string, expected string) bool {
	for _, query := range queries {
		if strings.TrimSpace(query) == expected {
			return true
		}
	}
	return false
}

type sqlFileProgressRecorder struct {
	events []map[string]interface{}
}

func (recorder *sqlFileProgressRecorder) Emit(name string, args ...any) {
	if name != "sqlfile:progress" || len(args) == 0 {
		return
	}
	payload, ok := args[0].(map[string]interface{})
	if ok {
		recorder.events = append(recorder.events, payload)
	}
}
