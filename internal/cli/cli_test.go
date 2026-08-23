package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/mcpserver"
	"GoNavi-Wails/internal/sqlaudit"
)

type fakeBackend struct {
	closed       bool
	saveCalls    int
	resolveCalls int

	connections       []connection.SavedConnectionView
	resolveErr        error
	queryResult       connection.QueryResult
	batchResult       connection.QueryResult
	diagnosticResult  connection.QueryResult
	diagnosticQueryID string

	queryConfig           connection.ConnectionConfig
	querySQL              string
	queryOptions          appcore.HeadlessQueryOptions
	savedConnectionParams string
	batchConfig           connection.ConnectionConfig
	batchFile             string
	batchOptions          appcore.HeadlessSQLFileOptions
	auditFilter           sqlaudit.Filter
	auditFormat           string
	auditPath             string
	auditOverwrite        bool
}

func (backend *fakeBackend) Close() { backend.closed = true }

func (backend *fakeBackend) GetSavedConnections() ([]connection.SavedConnectionView, error) {
	return backend.connections, nil
}

func (backend *fakeBackend) SaveConnection(input connection.SavedConnectionInput) (connection.SavedConnectionView, error) {
	backend.saveCalls++
	backend.savedConnectionParams = input.Config.ConnectionParams
	return connection.SavedConnectionView{ID: input.ID, Name: input.Name, Config: input.Config}, nil
}

func (backend *fakeBackend) ImportLegacyConnections(items []connection.LegacySavedConnection) ([]connection.SavedConnectionView, error) {
	result := make([]connection.SavedConnectionView, 0, len(items))
	for _, item := range items {
		result = append(result, connection.SavedConnectionView{ID: item.ID, Name: item.Name, Config: item.Config})
	}
	return result, nil
}

func (backend *fakeBackend) ResolveSavedConnection(selector string) (connection.SavedConnectionView, error) {
	backend.resolveCalls++
	if backend.resolveErr != nil {
		return connection.SavedConnectionView{}, backend.resolveErr
	}
	for _, item := range backend.connections {
		if item.ID == selector || item.Name == selector {
			return item, nil
		}
	}
	return connection.SavedConnectionView{}, errors.New("saved connection not found")
}

func (backend *fakeBackend) Query(_ context.Context, config connection.ConnectionConfig, _ string, sql string, options appcore.HeadlessQueryOptions) connection.QueryResult {
	backend.queryConfig = config
	backend.querySQL = sql
	backend.queryOptions = options
	return backend.queryResult
}

func (backend *fakeBackend) ExportQueryToPath(context.Context, connection.ConnectionConfig, string, string, string, appcore.ExportFileOptions, bool) connection.QueryResult {
	return connection.QueryResult{Success: true}
}

func (backend *fakeBackend) ExecuteSQLFile(_ context.Context, config connection.ConnectionConfig, _ string, filePath string, options appcore.HeadlessSQLFileOptions) connection.QueryResult {
	backend.batchConfig = config
	backend.batchFile = filePath
	backend.batchOptions = options
	return backend.batchResult
}

func (backend *fakeBackend) ExportSQLAuditToPath(filter sqlaudit.Filter, format string, path string, overwrite bool) connection.QueryResult {
	backend.auditFilter = filter
	backend.auditFormat = format
	backend.auditPath = path
	backend.auditOverwrite = overwrite
	return connection.QueryResult{Success: true}
}

func (backend *fakeBackend) GetRequestDiagnostic(requestID string) connection.QueryResult {
	backend.diagnosticQueryID = requestID
	return backend.diagnosticResult
}

func runWithBackend(t *testing.T, fake *fakeBackend, args ...string) (int, string, string) {
	t.Helper()
	previous := newBackend
	newBackend = func(context.Context, appcore.HeadlessRuntimeOptions) (backend, error) {
		return fake, nil
	}
	t.Cleanup(func() { newBackend = previous })

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(context.Background(), args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestRunVersionAcceptsFlagForm(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(context.Background(), []string{"--version"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("Run(--version) = %d, stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `"version":"`) {
		t.Fatalf("version output missing JSON payload: %s", stdout.String())
	}
}

func TestRunVersionRejectsExtraArguments(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(context.Background(), []string{"version", "extra"}, &stdout, &stderr); code != ExitUsage {
		t.Fatalf("Run(version extra) = %d, stderr=%s, want usage exit=%d", code, stderr.String(), ExitUsage)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), `"code":"usage"`) {
		t.Fatalf("version extra output mismatch: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestRunAuditWithoutSubcommandRejectsBeforeBackendInitialization(t *testing.T) {
	previous := newBackend
	started := false
	newBackend = func(context.Context, appcore.HeadlessRuntimeOptions) (backend, error) {
		started = true
		return nil, errors.New("runtime should not start for invalid audit command")
	}
	t.Cleanup(func() { newBackend = previous })

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(context.Background(), []string{"audit"}, &stdout, &stderr)
	if code != ExitUsage || started || stdout.Len() != 0 || !strings.Contains(stderr.String(), `"code":"usage"`) {
		t.Fatalf("audit exit=%d started=%t stdout=%q stderr=%q", code, started, stdout.String(), stderr.String())
	}
}

func TestRunCommandHelpSkipsRuntimeInitialization(t *testing.T) {
	previous := newBackend
	started := false
	newBackend = func(context.Context, appcore.HeadlessRuntimeOptions) (backend, error) {
		started = true
		return nil, errors.New("runtime should not start for help")
	}
	t.Cleanup(func() { newBackend = previous })

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Run(context.Background(), []string{"query", "--help"}, &stdout, &stderr)
	if code != ExitSuccess || started || !strings.Contains(stdout.String(), "Usage: gonavi query") {
		t.Fatalf("help exit=%d started=%t stdout=%s stderr=%s", code, started, stdout.String(), stderr.String())
	}
}

func TestRunDataRootOverrideUsesActiveRootResolution(t *testing.T) {
	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", "existing-root")

	previous := newBackend
	var receivedOptions appcore.HeadlessRuntimeOptions
	var receivedRoot string
	newBackend = func(_ context.Context, options appcore.HeadlessRuntimeOptions) (backend, error) {
		receivedOptions = options
		receivedRoot = os.Getenv("GONAVI_DATA_ROOT")
		return &fakeBackend{}, nil
	}
	t.Cleanup(func() { newBackend = previous })

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := Run(context.Background(), []string{"--data-root", root, "list-connections"}, &stdout, &stderr); code != ExitSuccess {
		t.Fatalf("Run returned %d, stderr=%s", code, stderr.String())
	}
	if receivedOptions.DataRoot != "" {
		t.Fatalf("CLI bypassed ResolveActiveRoot with DataRoot=%q", receivedOptions.DataRoot)
	}
	if receivedRoot != root {
		t.Fatalf("GONAVI_DATA_ROOT during backend initialization = %q, want %q", receivedRoot, root)
	}
	if restored := os.Getenv("GONAVI_DATA_ROOT"); restored != "existing-root" {
		t.Fatalf("GONAVI_DATA_ROOT after invocation = %q, want existing-root", restored)
	}
}

func TestRunQueryForwardsMutatingAcknowledgementAndTimeout(t *testing.T) {
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production", Config: connection.ConnectionConfig{ID: "conn-1", Type: "mysql"}}},
		queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{{Columns: []string{"id"}, Rows: []map[string]any{{"id": 1}}}}},
	}
	code, stdout, stderr := runWithBackend(t, fake,
		"query", "--conn", "production", "--allow-mutating", "--query-timeout", "17", "UPDATE account SET active = 1",
	)
	if code != ExitSuccess {
		t.Fatalf("query exit = %d, stderr=%s", code, stderr)
	}
	if !fake.queryOptions.AllowMutating || fake.queryConfig.QueryTimeout != 17 || !strings.Contains(fake.querySQL, "UPDATE") {
		t.Fatalf("query options not forwarded: %#v, %#v, %q", fake.queryOptions, fake.queryConfig, fake.querySQL)
	}
	if !strings.Contains(stdout, `"success":true`) {
		t.Fatalf("query stdout missing result: %s", stdout)
	}
}

func TestRunQueryDefaultsToJSONLResultSetsRowsAndSummary(t *testing.T) {
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production", Config: connection.ConnectionConfig{ID: "conn-1", Type: "mysql"}}},
		queryResult: connection.QueryResult{
			Success: true,
			QueryID: "query-1",
			Data: []connection.ResultSetData{
				{Columns: []string{"id"}, Rows: []map[string]any{{"id": 1}}},
				{Columns: []string{"name"}, Rows: []map[string]any{{"name": "GoNavi"}}},
			},
		},
	}
	code, stdout, stderr := runWithBackend(t, fake, "query", "--conn", "production", "SELECT 1; SELECT 'GoNavi'")
	if code != ExitSuccess {
		t.Fatalf("query exit = %d, stderr=%s", code, stderr)
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if len(lines) != 5 {
		t.Fatalf("JSONL lines = %d, want 5: %s", len(lines), stdout)
	}
	types := make([]string, 0, len(lines))
	for _, line := range lines {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("invalid JSONL event %q: %v", line, err)
		}
		types = append(types, event["type"].(string))
	}
	if got, want := strings.Join(types, ","), "result_set,row,result_set,row,summary"; got != want {
		t.Fatalf("event order = %s, want %s", got, want)
	}
	if !strings.Contains(lines[4], `"queryId":"query-1"`) || !strings.Contains(lines[4], `"resultSets":2`) || !strings.Contains(lines[4], `"rows":2`) {
		t.Fatalf("summary is incomplete: %s", lines[4])
	}
}

func TestRunQueryWritesRedactedRequestTraceToStderrWhenRequested(t *testing.T) {
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production", Config: connection.ConnectionConfig{ID: "conn-1", Type: "mysql"}}},
		queryResult: connection.QueryResult{
			Success: true,
			QueryID: "request-1",
			Data:    []connection.ResultSetData{},
		},
		diagnosticResult: connection.QueryResult{
			Success: true,
			Data: map[string]any{
				"requestId": "request-1",
				"entry":     "cli",
				"status":    "success",
			},
		},
	}
	code, _, stderr := runWithBackend(t, fake, "query", "--request-trace", "--conn", "production", "SELECT 1")
	if code != ExitSuccess {
		t.Fatalf("query exit = %d, stderr=%s", code, stderr)
	}
	if fake.diagnosticQueryID != "request-1" || !strings.Contains(stderr, `"type":"request_trace"`) || !strings.Contains(stderr, `"requestId":"request-1"`) {
		t.Fatalf("request trace was not emitted: queryID=%q stderr=%s", fake.diagnosticQueryID, stderr)
	}
}

func TestRunQueryJSONLSummarizesSuccessfulNonTabularWrite(t *testing.T) {
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production", Config: connection.ConnectionConfig{ID: "conn-1", Type: "mysql"}}},
		queryResult: connection.QueryResult{
			Success: true,
			QueryID: "write-1",
			Data:    map[string]int64{"affectedRows": 3},
		},
	}
	code, stdout, stderr := runWithBackend(t, fake, "query", "--conn", "production", "--allow-write", "UPDATE account SET active = 1")
	if code != ExitSuccess {
		t.Fatalf("query exit = %d, stderr=%s", code, stderr)
	}
	var summary map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &summary); err != nil {
		t.Fatalf("non-tabular JSONL summary is invalid: %v; stdout=%s", err, stdout)
	}
	if summary["type"] != "summary" || summary["success"] != true || summary["queryId"] != "write-1" {
		t.Fatalf("unexpected non-tabular summary: %#v", summary)
	}
	if summary["resultSets"] != float64(0) || summary["rows"] != float64(0) {
		t.Fatalf("unexpected non-tabular counts: %#v", summary)
	}
	data, ok := summary["data"].(map[string]any)
	if !ok || data["affectedRows"] != float64(3) {
		t.Fatalf("affectedRows metadata missing from summary: %#v", summary["data"])
	}
}

func TestRunQueryFormatJSONKeepsEnvelopeCompatibility(t *testing.T) {
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production"}},
		queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{{Columns: []string{"id"}, Rows: []map[string]any{{"id": 1}}}}},
	}
	code, stdout, stderr := runWithBackend(t, fake, "query", "--conn", "production", "--format", "json", "SELECT 1")
	if code != ExitSuccess {
		t.Fatalf("query exit = %d, stderr=%s", code, stderr)
	}
	if !strings.Contains(stdout, `"success":true`) || !strings.Contains(stdout, `"data"`) || strings.Contains(stdout, `"type":"summary"`) {
		t.Fatalf("json envelope changed unexpectedly: %s", stdout)
	}
}

func TestRunQueryAcceptsAllowWriteAndLegacyAlias(t *testing.T) {
	for _, flagName := range []string{"--allow-write", "--allow-mutating"} {
		t.Run(flagName, func(t *testing.T) {
			fake := &fakeBackend{
				connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production"}},
				queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{}},
			}
			code, _, stderr := runWithBackend(t, fake, "query", "--conn", "production", flagName, "UPDATE account SET active = 1")
			if code != ExitSuccess || !fake.queryOptions.AllowMutating {
				t.Fatalf("query exit=%d allow=%t stderr=%s", code, fake.queryOptions.AllowMutating, stderr)
			}
		})
	}
}

func TestRunQueryUsesTemporaryConnectionFileWithoutSavedConnectionLookup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "temporary-connection.json")
	contents := []byte(`{"type":"postgres","host":"db.example.test","port":5432,"user":"cli","password":"temporary-secret","database":"app"}`)
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	fake := &fakeBackend{
		queryResult: connection.QueryResult{Success: true, Data: []connection.ResultSetData{}},
	}
	code, _, stderr := runWithBackend(t, fake, "query", "--connection-file", path, "SELECT 1")
	if code != ExitSuccess {
		t.Fatalf("query exit=%d stderr=%s", code, stderr)
	}
	if fake.queryConfig.ID != "" || fake.queryConfig.SavePassword || fake.queryConfig.Password != "temporary-secret" || fake.queryConfig.Type != "postgres" {
		t.Fatalf("temporary config was not isolated: %#v", fake.queryConfig)
	}
	if fake.resolveCalls != 0 || fake.saveCalls != 0 {
		t.Fatalf("temporary config touched saved connections: resolve=%d save=%d", fake.resolveCalls, fake.saveCalls)
	}
}

func TestRunConnectionAddKeepsSensitiveConnectionParamsOutOfArgv(t *testing.T) {
	t.Run("rejects sensitive argv parameters without leaking them", func(t *testing.T) {
		fake := &fakeBackend{}
		code, _, stderr := runWithBackend(t, fake,
			"connection", "add", "--name", "production", "--type", "postgres",
			"--connection-params", "application_name=gonavi&password=argv-secret",
		)
		if code != ExitUsage || fake.saveCalls != 0 {
			t.Fatalf("connection add exit=%d saves=%d stderr=%s", code, fake.saveCalls, stderr)
		}
		if !strings.Contains(stderr, "--connection-params-env") || strings.Contains(stderr, "argv-secret") {
			t.Fatalf("sensitive argv rejection leaked or omitted remediation: %s", stderr)
		}
	})

	t.Run("accepts public argv parameters", func(t *testing.T) {
		fake := &fakeBackend{}
		code, _, stderr := runWithBackend(t, fake,
			"connection", "add", "--name", "production", "--type", "postgres",
			"--connection-params", "application_name=gonavi&connect_timeout=10",
		)
		if code != ExitSuccess || fake.saveCalls != 1 {
			t.Fatalf("connection add exit=%d saves=%d stderr=%s", code, fake.saveCalls, stderr)
		}
	})

	t.Run("accepts complete sensitive parameters from environment", func(t *testing.T) {
		t.Setenv("GONAVI_CLI_CONNECTION_PARAMS", "application_name=gonavi&password=environment-secret")
		fake := &fakeBackend{}
		code, _, stderr := runWithBackend(t, fake,
			"connection", "add", "--name", "production", "--type", "postgres",
			"--connection-params-env", "GONAVI_CLI_CONNECTION_PARAMS",
		)
		if code != ExitSuccess || fake.saveCalls != 1 {
			t.Fatalf("connection add exit=%d saves=%d stderr=%s", code, fake.saveCalls, stderr)
		}
		if got := fake.savedConnectionParams; got != "application_name=gonavi&password=environment-secret" {
			t.Fatalf("connection parameters from environment = %q", got)
		}
	})

	t.Run("rejects conflicting direct and environment sources", func(t *testing.T) {
		t.Setenv("GONAVI_CLI_CONNECTION_PARAMS", "password=environment-secret")
		fake := &fakeBackend{}
		code, _, stderr := runWithBackend(t, fake,
			"connection", "add", "--name", "production", "--type", "postgres",
			"--connection-params", "application_name=gonavi",
			"--connection-params-env", "GONAVI_CLI_CONNECTION_PARAMS",
		)
		if code != ExitUsage || fake.saveCalls != 0 || !strings.Contains(stderr, "either --connection-params or --connection-params-env") {
			t.Fatalf("conflicting parameter sources exit=%d saves=%d stderr=%s", code, fake.saveCalls, stderr)
		}
	})
}

func TestLoadTemporaryConnectionConfigRejectsInsecurePermissions(t *testing.T) {
	if cliGOOS() == "windows" {
		t.Skip("Windows ACLs are not represented by os.FileMode")
	}
	path := filepath.Join(t.TempDir(), "temporary-connection.json")
	if err := os.WriteFile(path, []byte(`{"type":"mysql"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := loadTemporaryConnectionConfig(path)
	if err == nil || !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("loadTemporaryConnectionConfig error = %v, want permission rejection", err)
	}

	fake := &fakeBackend{}
	code, _, stderr := runWithBackend(t, fake, "query", "--connection-file", path, "SELECT 1")
	if code != ExitConnection || fake.querySQL != "" || !strings.Contains(stderr, `"code":"connection_file_invalid"`) {
		t.Fatalf("insecure connection file exit=%d sql=%q stderr=%s", code, fake.querySQL, stderr)
	}
}

func TestLoadTemporaryConnectionConfigAccepts0600AndRejectsSymlink(t *testing.T) {
	if cliGOOS() == "windows" {
		t.Skip("Windows ACLs and symlinks differ from POSIX mode checks")
	}
	directory := t.TempDir()
	path := filepath.Join(directory, "temporary-connection.json")
	if err := os.WriteFile(path, []byte(`{"type":"mysql","password":"temporary-secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := loadTemporaryConnectionConfig(path)
	if err != nil || config.Password != "temporary-secret" {
		t.Fatalf("0600 connection file = %#v, %v", config, err)
	}

	linkPath := filepath.Join(directory, "connection-link.json")
	if err := os.Symlink(path, linkPath); err != nil {
		t.Fatal(err)
	}
	if _, err := loadTemporaryConnectionConfig(linkPath); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("symlink error = %v, want rejection", err)
	}
}

func TestRunQueryRejectsConnectionSelectorAndFileTogether(t *testing.T) {
	path := filepath.Join(t.TempDir(), "temporary-connection.json")
	if err := os.WriteFile(path, []byte(`{"type":"mysql"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	fake := &fakeBackend{}
	code, _, stderr := runWithBackend(t, fake, "query", "--conn", "saved", "--connection-file", path, "SELECT 1")
	if code != ExitUsage || fake.querySQL != "" || fake.resolveCalls != 0 {
		t.Fatalf("query exit=%d sql=%q resolve=%d stderr=%s", code, fake.querySQL, fake.resolveCalls, stderr)
	}
	if !strings.Contains(stderr, `"code":"usage"`) {
		t.Fatalf("connection source conflict was not a usage error: %s", stderr)
	}
}

func TestRunHelpUsesAllowWriteAsPrimaryFlag(t *testing.T) {
	for _, args := range [][]string{{"query", "--help"}, {"batch", "--help"}} {
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := Run(context.Background(), args, &stdout, &stderr); code != ExitSuccess {
			t.Fatalf("Run(%v) = %d, stderr=%s", args, code, stderr.String())
		}
		if !strings.Contains(stdout.String(), "--allow-write") || strings.Contains(stdout.String(), "--allow-mutating") {
			t.Fatalf("help did not make --allow-write primary: %s", stdout.String())
		}
	}
}

func TestRunQueryRejectsInvalidFormatBeforeExecution(t *testing.T) {
	fake := &fakeBackend{connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production"}}}
	code, _, stderr := runWithBackend(t, fake, "query", "--conn", "production", "--format", "xlsx", "SELECT 1")
	if code != ExitUsage || fake.querySQL != "" {
		t.Fatalf("query exit=%d sql=%q stderr=%s", code, fake.querySQL, stderr)
	}
}

func TestRunQueryReportsAmbiguousConnectionWithoutExecutingSQL(t *testing.T) {
	fake := &fakeBackend{
		resolveErr: &appcore.AmbiguousConnectionNameError{Name: "production", IDs: []string{"conn-1", "conn-2"}},
	}
	code, _, stderr := runWithBackend(t, fake, "query", "--conn", "production", "SELECT 1")
	if code != ExitConnection || fake.querySQL != "" {
		t.Fatalf("query exit=%d sql=%q stderr=%s", code, fake.querySQL, stderr)
	}
	if !strings.Contains(stderr, `"code":"connection_ambiguous"`) || !strings.Contains(stderr, "conn-1") || !strings.Contains(stderr, "conn-2") {
		t.Fatalf("ambiguous connection report lost structured candidates: %s", stderr)
	}
}

func TestRunQuerySanitizesFailure(t *testing.T) {
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production"}},
		queryResult: connection.QueryResult{Success: false, Message: "connect postgres://alice:driver-secret@example.test/db password=top-secret"},
	}
	code, _, stderr := runWithBackend(t, fake, "query", "--conn", "production", "SELECT 1")
	if code != ExitExecution {
		t.Fatalf("query exit = %d, stderr=%s", code, stderr)
	}
	if strings.Contains(stderr, "driver-secret") || strings.Contains(stderr, "top-secret") {
		t.Fatalf("secret leaked in stderr: %s", stderr)
	}
}

func TestRunQueryMapsStructuredPolicyFailureToExitFour(t *testing.T) {
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production"}},
		queryResult: connection.QueryResult{
			Success: false,
			Message: "SQL is blocked by AI safety level readonly",
			Data:    map[string]any{"errorKind": "policy"},
		},
	}
	code, _, stderr := runWithBackend(t, fake, "query", "--conn", "production", "--allow-write", "UPDATE account SET active = 1")
	if code != ExitPolicyDenied || !strings.Contains(stderr, `"code":"policy_denied"`) {
		t.Fatalf("query policy exit=%d stderr=%s", code, stderr)
	}
}

func TestRunBatchRequiresAcknowledgementBeforeFileOrConnectionAccess(t *testing.T) {
	fake := &fakeBackend{}
	code, _, stderr := runWithBackend(t, fake, "batch", "--conn", "production", "--file", "/missing.sql")
	if code != ExitPolicyDenied {
		t.Fatalf("batch exit = %d, stderr=%s", code, stderr)
	}
	if fake.batchFile != "" {
		t.Fatalf("batch unexpectedly executed %q", fake.batchFile)
	}
}

func TestRunBatchUnknownOutcomeHasDedicatedExitCode(t *testing.T) {
	directory := t.TempDir()
	filePath := filepath.Join(directory, "migration.sql")
	if err := os.WriteFile(filePath, []byte("UPDATE account SET active = 1;"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production", Config: connection.ConnectionConfig{ID: "conn-1"}}},
		batchResult: connection.QueryResult{Success: false, Message: "connection dropped after dispatch", Data: map[string]any{"outcomeUnknown": true}},
	}
	code, _, stderr := runWithBackend(t, fake, "batch", "--conn", "production", "--file", filePath, "--allow-mutating", "--stop-on-error")
	if code != ExitUnknownOutcome || !strings.Contains(stderr, `"code":"outcome_unknown"`) {
		t.Fatalf("batch exit=%d stderr=%s", code, stderr)
	}
	if !fake.batchOptions.AllowMutating || fake.batchOptions.TransactionMode != appcore.HeadlessSQLTransactionModeSingle || fake.batchFile != filePath {
		t.Fatalf("batch options not forwarded: %#v file=%q", fake.batchOptions, fake.batchFile)
	}
}

func TestFailResultUsesStructuredCancellationAndPreservesUnknownOutcomePriority(t *testing.T) {
	tests := []struct {
		name     string
		data     map[string]any
		wantExit int
		wantCode string
	}{
		{
			name:     "cancelled",
			data:     map[string]any{"cancelled": true},
			wantExit: ExitCancelled,
			wantCode: `"code":"cancelled"`,
		},
		{
			name:     "unknown outcome after cancellation",
			data:     map[string]any{"cancelled": true, "outcomeUnknown": true},
			wantExit: ExitUnknownOutcome,
			wantCode: `"code":"outcome_unknown"`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var stderr bytes.Buffer
			code := failResult(context.Background(), &stderr, connection.QueryResult{
				Success: false,
				Message: "执行已取消",
				Data:    test.data,
			})
			if code != test.wantExit || !strings.Contains(stderr.String(), test.wantCode) {
				t.Fatalf("failResult exit=%d stderr=%s, want exit=%d code=%s", code, stderr.String(), test.wantExit, test.wantCode)
			}
		})
	}
}

func TestFailResultPrefersStructuredPolicyOverCancellationText(t *testing.T) {
	var stderr bytes.Buffer
	result := connection.QueryResult{
		Success: false,
		Message: "policy denied: cancellation command is not permitted",
		Data:    map[string]any{"errorKind": "policy"},
	}
	if code := failResult(context.Background(), &stderr, result); code != ExitPolicyDenied {
		t.Fatalf("failResult exit=%d stderr=%s, want policy exit=%d", code, stderr.String(), ExitPolicyDenied)
	}
	if !strings.Contains(stderr.String(), `"code":"policy_denied"`) {
		t.Fatalf("structured policy code missing: %s", stderr.String())
	}
}

func TestFailResultMapsStructuredConnectionFailure(t *testing.T) {
	var stderr bytes.Buffer
	result := connection.QueryResult{
		Success: false,
		Message: "authentication failed",
		Data:    map[string]any{"errorKind": "connection"},
	}
	if code := failResult(context.Background(), &stderr, result); code != ExitConnection {
		t.Fatalf("failResult exit=%d stderr=%s, want connection exit=%d", code, stderr.String(), ExitConnection)
	}
	if !strings.Contains(stderr.String(), `"code":"connection_failed"`) {
		t.Fatalf("structured connection code missing: %s", stderr.String())
	}
}

func TestFailResultDoesNotTreatOrdinaryCancellationTextAsCancellation(t *testing.T) {
	var stderr bytes.Buffer
	result := connection.QueryResult{
		Success: false,
		Message: `column "cancellation_reason" does not exist`,
	}
	if code := failResult(context.Background(), &stderr, result); code != ExitExecution {
		t.Fatalf("failResult exit=%d stderr=%s, want execution exit=%d", code, stderr.String(), ExitExecution)
	}
	if !strings.Contains(stderr.String(), `"code":"execution_failed"`) {
		t.Fatalf("ordinary database error was not classified as execution failure: %s", stderr.String())
	}
}

func TestRunBatchOnlyAllowsContinueOnErrorWithTransactionOff(t *testing.T) {
	fake := &fakeBackend{}
	code, _, stderr := runWithBackend(t, fake,
		"batch", "--conn", "production", "--file", "/missing.sql", "--allow-write", "--continue-on-error",
	)
	if code != ExitUsage || fake.batchFile != "" || !strings.Contains(stderr, "--transaction=off") {
		t.Fatalf("batch exit=%d file=%q stderr=%s", code, fake.batchFile, stderr)
	}
}

func TestRunBatchForwardsTransactionOff(t *testing.T) {
	directory := t.TempDir()
	filePath := filepath.Join(directory, "migration.sql")
	if err := os.WriteFile(filePath, []byte("UPDATE account SET active = 1;"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production"}},
		batchResult: connection.QueryResult{Success: true},
	}
	code, _, stderr := runWithBackend(t, fake,
		"batch", "--conn", "production", "--file", filePath, "--allow-write", "--transaction=off", "--continue-on-error",
	)
	if code != ExitSuccess || !fake.batchOptions.ContinueOnError || fake.batchOptions.TransactionMode != appcore.HeadlessSQLTransactionModeOff {
		t.Fatalf("batch exit=%d options=%#v stderr=%s", code, fake.batchOptions, stderr)
	}
}

func TestRunAuditExportParsesTimestampAndFilters(t *testing.T) {
	fake := &fakeBackend{}
	code, _, stderr := runWithBackend(t, fake,
		"audit", "export", "--output", "audit.json", "--source", "cli", "--from", "2026-08-10T00:00:00Z", "--to", "123",
	)
	if code != ExitSuccess {
		t.Fatalf("audit exit=%d stderr=%s", code, stderr)
	}
	if fake.auditFormat != "json" || fake.auditPath != "audit.json" || fake.auditFilter.Source != "cli" || fake.auditFilter.FromTimestamp == 0 || fake.auditFilter.ToTimestamp != 123 {
		t.Fatalf("audit args not forwarded: format=%q path=%q filter=%#v", fake.auditFormat, fake.auditPath, fake.auditFilter)
	}
}

func TestRunAuditExportRejectsUnsupportedFormatBeforeBackendCall(t *testing.T) {
	fake := &fakeBackend{}
	code, _, stderr := runWithBackend(t, fake, "audit", "export", "--output", "audit.out", "--format", "yaml")
	if code != ExitUsage {
		t.Fatalf("audit exit=%d stderr=%s, want usage exit=%d", code, stderr, ExitUsage)
	}
	if fake.auditFormat != "" {
		t.Fatalf("unsupported audit format reached backend: %q", fake.auditFormat)
	}
	if !strings.Contains(stderr, `"code":"usage"`) {
		t.Fatalf("unsupported audit format was not reported as usage error: %s", stderr)
	}
}

func TestRunMCPMapsInvocationTerminationToCancelledExit(t *testing.T) {
	t.Run("stdio cancellation error", func(t *testing.T) {
		previousStdio := runMCPStdioServer
		t.Cleanup(func() { runMCPStdioServer = previousStdio })
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		runMCPStdioServer = func(received context.Context) error {
			if received != ctx {
				t.Fatal("stdio runner received a different invocation context")
			}
			return received.Err()
		}

		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := runMCP(ctx, []string{"stdio"}, &stdout, &stderr); code != ExitCancelled || !strings.Contains(stderr.String(), `"code":"cancelled"`) {
			t.Fatalf("stdio cancellation exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
		}
	})

	t.Run("http graceful deadline shutdown", func(t *testing.T) {
		previousHTTP := runMCPHTTPServer
		t.Cleanup(func() { runMCPHTTPServer = previousHTTP })
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		defer cancel()
		runMCPHTTPServer = func(received context.Context, _ mcpserver.HTTPServerOptions) error {
			if received != ctx {
				t.Fatal("http runner received a different invocation context")
			}
			// The real HTTP server treats a context-triggered graceful shutdown as
			// a nil server error, which must still map to ExitCancelled.
			return nil
		}

		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := runMCP(ctx, []string{"http", "--token", "test-token"}, &stdout, &stderr); code != ExitCancelled || !strings.Contains(stderr.String(), `"code":"cancelled"`) {
			t.Fatalf("http deadline exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
		}
	})

	t.Run("ordinary server failure remains execution failure", func(t *testing.T) {
		previousStdio := runMCPStdioServer
		t.Cleanup(func() { runMCPStdioServer = previousStdio })
		runMCPStdioServer = func(context.Context) error { return errors.New("MCP transport failed") }
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		if code := runMCP(context.Background(), nil, &stdout, &stderr); code != ExitExecution || !strings.Contains(stderr.String(), `"code":"mcp_failed"`) {
			t.Fatalf("MCP failure exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
		}
	})
}

type failingWriter struct {
	err error
}

func (writer failingWriter) Write([]byte) (int, error) {
	return 0, writer.err
}

func TestRunReportsStdoutWriteFailureOnStderr(t *testing.T) {
	fake := &fakeBackend{
		connections: []connection.SavedConnectionView{{ID: "conn-1", Name: "production"}},
		queryResult: connection.QueryResult{
			Success: true,
			Data:    []connection.ResultSetData{{Columns: []string{"id"}, Rows: []map[string]any{{"id": 1}}}},
		},
	}
	previous := newBackend
	newBackend = func(context.Context, appcore.HeadlessRuntimeOptions) (backend, error) {
		return fake, nil
	}
	t.Cleanup(func() { newBackend = previous })

	var stderr bytes.Buffer
	code := Run(context.Background(), []string{"query", "--conn", "production", "SELECT 1"}, failingWriter{err: errors.New("stdout sink unavailable")}, &stderr)
	if code != ExitExecution {
		t.Fatalf("query exit=%d stderr=%s, want execution exit=%d", code, stderr.String(), ExitExecution)
	}
	if !strings.Contains(stderr.String(), `"code":"output_failed"`) || !strings.Contains(stderr.String(), "stdout sink unavailable") {
		t.Fatalf("stdout failure did not produce a structured stderr diagnostic: %s", stderr.String())
	}
}
