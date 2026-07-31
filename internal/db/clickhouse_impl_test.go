//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"

	chproto "github.com/ClickHouse/ch-go/proto"
	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
	clickhousecolumn "github.com/ClickHouse/clickhouse-go/v2/lib/column"
	clickhouseproto "github.com/ClickHouse/clickhouse-go/v2/lib/proto"
)

const fakeClickHouseDriverName = "gonavi-fake-clickhouse"

var clickHouseProtocolFailureI18nKeys = []string{
	"db.backend.error.clickhouse_http_client_protocol_version_unsupported",
	"db.backend.error.clickhouse_native_protocol_mismatch",
	"db.backend.error.clickhouse_http_protocol_mismatch",
	"db.backend.error.clickhouse_unknown_error",
	"db.backend.error.clickhouse_driver_detail_missing",
	"db.backend.error.clickhouse_attempt_tls_config_failed",
	"db.backend.error.clickhouse_attempt_validation_failed",
	"db.backend.error.clickhouse_validation_failed_manual",
	"db.backend.error.clickhouse_validation_failed_auto",
}

const rawClickHouseCreateStatementNotFoundText = "未找到建表语句"

var (
	registerFakeClickHouseDriverOnce sync.Once
	fakeClickHouseStateMu            sync.Mutex
	fakeClickHouseState              = struct {
		pingErr      error
		queryErr     error
		execErr      error
		queryResults map[string]fakeClickHouseQueryResult
		lastQuery    string
		queries      []string
		lastExec     string
		execQueries  []string
	}{
		lastQuery:    "",
		queryResults: map[string]fakeClickHouseQueryResult{},
		queries:      nil,
		lastExec:     "",
		execQueries:  nil,
	}
)

type fakeClickHouseQueryResult struct {
	columns []string
	rows    [][]driver.Value
	err     error
}

func TestClickHousePingValidatesQueryPath(t *testing.T) {
	registerFakeClickHouseDriverOnce.Do(func() {
		sql.Register(fakeClickHouseDriverName, fakeClickHouseDriver{})
	})

	db, err := sql.Open(fakeClickHouseDriverName, "")
	if err != nil {
		t.Fatalf("open fake clickhouse db failed: %v", err)
	}
	defer db.Close()

	fakeClickHouseStateMu.Lock()
	fakeClickHouseState.pingErr = nil
	fakeClickHouseState.queryErr = errors.New("query path failed")
	fakeClickHouseState.queryResults = map[string]fakeClickHouseQueryResult{}
	fakeClickHouseState.lastQuery = ""
	fakeClickHouseState.queries = nil
	fakeClickHouseStateMu.Unlock()

	client := &ClickHouseDB{
		conn:        db,
		pingTimeout: time.Second,
	}
	err = client.Ping()
	if err == nil {
		t.Fatal("expected Ping to fail when query validation fails")
	}
	if !strings.Contains(err.Error(), "query path failed") {
		t.Fatalf("expected query validation error, got %v", err)
	}

	fakeClickHouseStateMu.Lock()
	lastQuery := fakeClickHouseState.lastQuery
	fakeClickHouseStateMu.Unlock()
	if lastQuery != "SELECT currentDatabase()" {
		t.Fatalf("expected query validation SQL to run, got %q", lastQuery)
	}
}

func TestClickHouseGetDatabasesFallsBackToCurrentDatabase(t *testing.T) {
	registerFakeClickHouseDriverOnce.Do(func() {
		sql.Register(fakeClickHouseDriverName, fakeClickHouseDriver{})
	})

	db, err := sql.Open(fakeClickHouseDriverName, "")
	if err != nil {
		t.Fatalf("open fake clickhouse db failed: %v", err)
	}
	defer db.Close()

	const listSQL = "SELECT name FROM system.databases ORDER BY name"
	const fallbackSQL = "SELECT currentDatabase() AS name"

	fakeClickHouseStateMu.Lock()
	fakeClickHouseState.pingErr = nil
	fakeClickHouseState.queryErr = nil
	fakeClickHouseState.queryResults = map[string]fakeClickHouseQueryResult{
		listSQL: {
			err: errors.New("access denied to system.databases"),
		},
		fallbackSQL: {
			columns: []string{"name"},
			rows: [][]driver.Value{
				{"analytics"},
			},
		},
	}
	fakeClickHouseState.lastQuery = ""
	fakeClickHouseState.queries = nil
	fakeClickHouseStateMu.Unlock()

	client := &ClickHouseDB{conn: db}
	databases, err := client.GetDatabases()
	if err != nil {
		t.Fatalf("expected GetDatabases to fallback, got err=%v", err)
	}
	if len(databases) != 1 || databases[0] != "analytics" {
		t.Fatalf("expected fallback database list, got %v", databases)
	}

	fakeClickHouseStateMu.Lock()
	queries := append([]string(nil), fakeClickHouseState.queries...)
	fakeClickHouseStateMu.Unlock()
	if len(queries) != 2 {
		t.Fatalf("expected two queries, got %v", queries)
	}
	if queries[0] != listSQL || queries[1] != fallbackSQL {
		t.Fatalf("unexpected query order: %v", queries)
	}
}

func TestClickHouseCreateStatementNotFoundUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	tests := []struct {
		name   string
		result fakeClickHouseQueryResult
	}{
		{
			name: "empty rows",
			result: fakeClickHouseQueryResult{
				columns: []string{"statement"},
				rows:    nil,
			},
		},
		{
			name: "row without CREATE statement",
			result: fakeClickHouseQueryResult{
				columns: []string{"note"},
				rows: [][]driver.Value{
					{"SELECT 1"},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			registerFakeClickHouseDriverOnce.Do(func() {
				sql.Register(fakeClickHouseDriverName, fakeClickHouseDriver{})
			})

			conn, err := sql.Open(fakeClickHouseDriverName, "")
			if err != nil {
				t.Fatalf("open fake clickhouse db failed: %v", err)
			}
			t.Cleanup(func() {
				_ = conn.Close()
			})

			const showCreateSQL = "SHOW CREATE TABLE `app`.`orders`"
			fakeClickHouseStateMu.Lock()
			fakeClickHouseState.pingErr = nil
			fakeClickHouseState.queryErr = nil
			fakeClickHouseState.queryResults = map[string]fakeClickHouseQueryResult{
				showCreateSQL: tt.result,
			}
			fakeClickHouseState.lastQuery = ""
			fakeClickHouseState.queries = nil
			fakeClickHouseStateMu.Unlock()

			clickhouseDB := &ClickHouseDB{conn: conn}
			_, err = clickhouseDB.GetCreateStatement("app", "orders")
			if err == nil {
				t.Fatal("expected ClickHouse GetCreateStatement to fail")
			}
			if err.Error() != "The CREATE TABLE statement was not found" {
				t.Fatalf("expected English create-statement error, got %q", err.Error())
			}
			if strings.Contains(err.Error(), rawClickHouseCreateStatementNotFoundText) {
				t.Fatalf("expected no raw Chinese create-statement text, got %q", err.Error())
			}
		})
	}
}


func TestClickHouseApplyChangesErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	registerFakeClickHouseDriverOnce.Do(func() {
		sql.Register(fakeClickHouseDriverName, fakeClickHouseDriver{})
	})

	tests := []struct {
		name         string
		changes      connection.ChangeSet
		wantText     string
		forbiddenRaw []string
	}{
		{
			name: "delete failure",
			changes: connection.ChangeSet{
				Deletes: []map[string]interface{}{
					{"id": int64(42)},
				},
			},
			wantText:     "Failed to delete ClickHouse rows",
			forbiddenRaw: []string{"delete error", "删除失败"},
		},
		{
			name: "update failure",
			changes: connection.ChangeSet{
				Updates: []connection.UpdateRow{
					{
						Keys:   map[string]interface{}{"id": int64(42)},
						Values: map[string]interface{}{"name": "Alice"},
					},
				},
			},
			wantText:     "Failed to update ClickHouse rows",
			forbiddenRaw: []string{"update error", "更新失败"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			conn, err := sql.Open(fakeClickHouseDriverName, "")
			if err != nil {
				t.Fatalf("open fake clickhouse db failed: %v", err)
			}
			t.Cleanup(func() {
				_ = conn.Close()
			})

			fakeClickHouseStateMu.Lock()
			fakeClickHouseState.execErr = errors.New("driver raw failure")
			fakeClickHouseState.lastExec = ""
			fakeClickHouseState.execQueries = nil
			fakeClickHouseStateMu.Unlock()

			clickhouseDB := &ClickHouseDB{conn: conn, database: "analytics"}
			err = clickhouseDB.ApplyChanges("orders", tt.changes)
			if err == nil {
				t.Fatal("expected ApplyChanges to fail")
			}
			got := err.Error()
			if !strings.Contains(got, tt.wantText) {
				t.Fatalf("expected localized wrapper %q, got %q", tt.wantText, got)
			}
			if !strings.Contains(got, "driver raw failure") {
				t.Fatalf("expected raw driver detail to remain, got %q", got)
			}
			if !strings.Contains(got, "ALTER TABLE `analytics`.`orders`") {
				t.Fatalf("expected raw SQL to remain, got %q", got)
			}
			for _, raw := range tt.forbiddenRaw {
				if strings.Contains(got, raw) {
					t.Fatalf("expected no raw wrapper %q, got %q", raw, got)
				}
			}
		})
	}
}

func TestClickHouseTableNameRequiredUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	clickhouseDB := &ClickHouseDB{}
	_, _, err := clickhouseDB.resolveDatabaseAndTable("", " ")
	if err == nil {
		t.Fatal("expected table-name-required error")
	}
	if err.Error() != "Table name is required" {
		t.Fatalf("expected English table-name-required error, got %q", err.Error())
	}
	if strings.Contains(err.Error(), rawClickHouseTableNameRequiredText()) {
		t.Fatalf("expected no raw Chinese table-name-required text, got %q", err.Error())
	}
}


func TestClickHouseApplyChangesCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range clickHouseApplyChangesI18nKeys() {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing ClickHouse ApplyChanges key %q", language, key)
			}
		}
	}
}

func TestDetectClickHouseProtocolTreatsHTTPPortsAsHTTP(t *testing.T) {
	tests := []struct {
		name     string
		config   connection.ConnectionConfig
		expected clickhouse.Protocol
	}{
		{
			name: "http uri",
			config: connection.ConnectionConfig{
				URI: "http://127.0.0.1:8132/default",
			},
			expected: clickhouse.HTTP,
		},
		{
			name: "default http port",
			config: connection.ConnectionConfig{
				Port: 8123,
			},
			expected: clickhouse.HTTP,
		},
		{
			name: "alternate http port 8132",
			config: connection.ConnectionConfig{
				Port: 8132,
			},
			expected: clickhouse.HTTP,
		},
		{
			name: "custom http port 8125",
			config: connection.ConnectionConfig{
				Port: 8125,
			},
			expected: clickhouse.HTTP,
		},
		{
			name: "https port",
			config: connection.ConnectionConfig{
				Port: 8443,
			},
			expected: clickhouse.HTTP,
		},
		{
			name: "native port",
			config: connection.ConnectionConfig{
				Port: 9000,
			},
			expected: clickhouse.Native,
		},
		{
			name: "native tls port",
			config: connection.ConnectionConfig{
				Port: 9440,
			},
			expected: clickhouse.Native,
		},
		{
			name: "host http scheme",
			config: connection.ConnectionConfig{
				Host: "http://clickhouse.example.com",
				Port: 8125,
			},
			expected: clickhouse.HTTP,
		},
		{
			name: "manual http overrides native port",
			config: connection.ConnectionConfig{
				ClickHouseProtocol: "http",
				Port:               9000,
			},
			expected: clickhouse.HTTP,
		},
		{
			name: "manual native overrides http port",
			config: connection.ConnectionConfig{
				ClickHouseProtocol: "native",
				Port:               8123,
			},
			expected: clickhouse.Native,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if protocol := detectClickHouseProtocol(tt.config); protocol != tt.expected {
				t.Fatalf("expected protocol %s, got %s", tt.expected.String(), protocol.String())
			}
		})
	}
}

func TestNormalizeClickHouseConfigParsesHTTPHostScheme(t *testing.T) {
	config := normalizeClickHouseConfig(connection.ConnectionConfig{
		Type:     "clickhouse",
		Host:     "https://clickhouse.example.com:8125/analytics",
		User:     "alice",
		Password: "secret",
	})

	if config.Host != "clickhouse.example.com" {
		t.Fatalf("expected host without scheme, got %q", config.Host)
	}
	if config.Port != 8125 {
		t.Fatalf("expected port 8125, got %d", config.Port)
	}
	if config.Database != "analytics" {
		t.Fatalf("expected database analytics, got %q", config.Database)
	}
	if config.ClickHouseProtocol != "http" {
		t.Fatalf("expected http protocol hint, got %q", config.ClickHouseProtocol)
	}
	if !config.UseSSL || config.SSLMode != sslModeRequired {
		t.Fatalf("expected https host to enable required SSL, got useSSL=%v sslMode=%q", config.UseSSL, config.SSLMode)
	}
}

func TestNormalizeClickHouseConfigKeepsManualNativeWhenHostHasHTTPScheme(t *testing.T) {
	config := normalizeClickHouseConfig(connection.ConnectionConfig{
		Type:               "clickhouse",
		Host:               "http://clickhouse.example.com:9001/analytics",
		ClickHouseProtocol: "native",
		User:               "alice",
		Password:           "secret",
	})

	if config.Host != "clickhouse.example.com" {
		t.Fatalf("expected host without scheme, got %q", config.Host)
	}
	if config.Port != 9001 {
		t.Fatalf("expected user-provided native port 9001, got %d", config.Port)
	}
	if config.Database != "analytics" {
		t.Fatalf("expected database analytics, got %q", config.Database)
	}
	if config.ClickHouseProtocol != "native" {
		t.Fatalf("expected manual native protocol to be preserved, got %q", config.ClickHouseProtocol)
	}
	if config.UseSSL {
		t.Fatalf("manual native protocol should not be forced to HTTP TLS by http scheme")
	}
}

func TestNormalizeClickHouseConfigUsesNativeDefaultPortForManualNativeHTTPScheme(t *testing.T) {
	config := normalizeClickHouseConfig(connection.ConnectionConfig{
		Type:               "clickhouse",
		Host:               "https://clickhouse.example.com/analytics",
		ClickHouseProtocol: "native",
	})

	if config.Host != "clickhouse.example.com" {
		t.Fatalf("expected host without scheme, got %q", config.Host)
	}
	if config.Port != defaultClickHousePort {
		t.Fatalf("expected native default port %d, got %d", defaultClickHousePort, config.Port)
	}
	if config.ClickHouseProtocol != "native" {
		t.Fatalf("expected manual native protocol to be preserved, got %q", config.ClickHouseProtocol)
	}
}

func TestClickHouseProtocolMismatchIncludesHTTPParseBinaryResponse(t *testing.T) {
	err := errors.New("code: 27, message: Cannot parse input: expected '(' before: '\x02\x00\x01\x00'")
	if !isClickHouseProtocolMismatch(err) {
		t.Fatalf("expected binary parse response to be treated as protocol mismatch")
	}

	message := clickHouseAttemptFailureMessage(clickhouse.Native, err)
	if !strings.Contains(message, "不像 Native") || strings.Contains(message, "\x00") {
		t.Fatalf("expected user-facing native mismatch message without binary bytes, got %q", message)
	}
}

func TestClickHouseHTTPClientProtocolVersionUnsupportedEnablesCompatibilityRetry(t *testing.T) {
	err := errors.New(`failed to query server hello: failed to query server hello info: sendQuery: [HTTP 404] response body: "Code: 115. DB::Exception: Unknown setting client_protocol_version. (UNKNOWN_SETTING)"`)
	if !isClickHouseHTTPClientProtocolVersionUnsupported(err) {
		t.Fatalf("expected client_protocol_version unknown setting to be treated as HTTP compatibility issue")
	}
	if !shouldTryNextClickHouseProtocol(clickhouse.HTTP, err) {
		t.Fatalf("expected HTTP client_protocol_version issue to permit protocol fallback")
	}
	if shouldTryNextClickHouseProtocol(clickhouse.Native, err) {
		t.Fatalf("native protocol should not treat HTTP client_protocol_version issue as retryable")
	}

	message := clickHouseAttemptFailureMessage(clickhouse.HTTP, err)
	if !strings.Contains(message, "client_protocol_version") || !strings.Contains(message, "兼容模式") {
		t.Fatalf("expected compatibility retry hint, got %q", message)
	}
}

func TestClickHouseNativeHandshakeTimeoutEnablesAutoProtocolFallback(t *testing.T) {
	err := errors.New("handshake: failed to read packet from clickhouse.local:18123: read: i/o timeout")
	if !isClickHouseNativeHandshakeTimeout(err) {
		t.Fatal("expected Native handshake read timeout to be treated as an inconclusive protocol probe")
	}
	if !shouldTryNextClickHouseProtocol(clickhouse.Native, err) {
		t.Fatal("expected Native handshake read timeout to permit HTTP fallback")
	}
	if shouldTryNextClickHouseProtocol(clickhouse.HTTP, err) {
		t.Fatal("HTTP timeout should not be treated as a Native handshake fallback signal")
	}
	if isClickHouseNativeHandshakeTimeout(errors.New("dial tcp clickhouse.local:18123: i/o timeout")) {
		t.Fatal("dial timeout without a completed connection should not be treated as a protocol probe")
	}
}

func TestClickHouseProtocolFailureMessagesUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	clientProtocolErr := errors.New(`Code: 115. DB::Exception: Unknown setting client_protocol_version. (UNKNOWN_SETTING)`)
	compatMessage := clickHouseAttemptFailureMessage(clickhouse.HTTP, clientProtocolErr)
	if !strings.Contains(compatMessage, "client_protocol_version") || !strings.Contains(compatMessage, "HTTP compatibility mode") {
		t.Fatalf("expected English compatibility hint, got %q", compatMessage)
	}
	if strings.Contains(compatMessage, "兼容模式") || strings.Contains(compatMessage, "当前") {
		t.Fatalf("expected no Chinese compatibility hint, got %q", compatMessage)
	}

	nativeMismatch := clickHouseAttemptFailureMessage(clickhouse.Native, errors.New("code: 27, message: Cannot parse input: expected '(' before: '\x02\x00\x01\x00'"))
	if !strings.Contains(nativeMismatch, "does not look like a Native handshake") {
		t.Fatalf("expected English native mismatch hint, got %q", nativeMismatch)
	}
	if strings.Contains(nativeMismatch, "不像 Native") {
		t.Fatalf("expected no Chinese native mismatch hint, got %q", nativeMismatch)
	}

	httpMismatch := clickHouseAttemptFailureMessage(clickhouse.HTTP, errors.New("malformed HTTP response"))
	if !strings.Contains(httpMismatch, "does not look like an HTTP response") {
		t.Fatalf("expected English HTTP mismatch hint, got %q", httpMismatch)
	}
	if strings.Contains(httpMismatch, "不像 HTTP") {
		t.Fatalf("expected no Chinese HTTP mismatch hint, got %q", httpMismatch)
	}

	unknownMessage := clickHouseAttemptFailureMessage(clickhouse.HTTP, nil)
	if unknownMessage != "Unknown error" {
		t.Fatalf("expected localized unknown error, got %q", unknownMessage)
	}
}

func TestClickHouseConnectFailureSummaryUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	manual := clickHouseConnectFailureSummary(connection.ConnectionConfig{
		Host:               "clickhouse.local",
		Port:               9000,
		ClickHouseProtocol: clickHouseProtocolNative,
	}, []string{"driver raw detail"})
	if !strings.Contains(manual, "ClickHouse connection validation failed") ||
		!strings.Contains(manual, "used user-selected NATIVE protocol") ||
		!strings.Contains(manual, "driver raw detail") {
		t.Fatalf("expected English manual protocol failure summary with raw detail, got %q", manual)
	}
	if strings.Contains(manual, "连接验证失败") || strings.Contains(manual, "用户选择") || strings.Contains(manual, "第1次") {
		t.Fatalf("expected no Chinese manual summary, got %q", manual)
	}

	manualWithMultipleDetails := clickHouseConnectFailureSummary(connection.ConnectionConfig{
		Host:               "clickhouse.local",
		Port:               9000,
		ClickHouseProtocol: clickHouseProtocolNative,
	}, []string{"first raw detail", "second raw detail"})
	if !strings.Contains(manualWithMultipleDetails, "first raw detail; second raw detail") {
		t.Fatalf("expected ASCII separator between raw details, got %q", manualWithMultipleDetails)
	}
	if strings.Contains(manualWithMultipleDetails, "；") {
		t.Fatalf("expected no Chinese separator between raw details, got %q", manualWithMultipleDetails)
	}

	auto := clickHouseConnectFailureSummary(connection.ConnectionConfig{
		Host: "clickhouse.local",
		Port: 8123,
	}, nil)
	if !strings.Contains(auto, "Automatic protocol detection failed") ||
		!strings.Contains(auto, "No driver error details were returned") {
		t.Fatalf("expected English auto protocol failure summary, got %q", auto)
	}
	if strings.Contains(auto, "自动协议探测") || strings.Contains(auto, "未获取到") {
		t.Fatalf("expected no Chinese auto summary, got %q", auto)
	}
}


func TestClickHouseProtocolFailureCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range clickHouseProtocolFailureI18nKeys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing ClickHouse protocol failure key %q", language, key)
			}
		}
	}
}

func TestClickHouseHTTPClientProtocolVersionStripperRemovesDriverQueryParam(t *testing.T) {
	var seenQuery string
	stripper := clickHouseHTTPClientProtocolVersionStripper{
		next: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			seenQuery = req.URL.RawQuery
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		}),
	}
	req, err := http.NewRequest(http.MethodPost, "http://clickhouse.local:8123/?database=default&client_protocol_version=54485", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}

	res, err := stripper.RoundTrip(req)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if res != nil && res.Body != nil {
		res.Body.Close()
	}
	if strings.Contains(seenQuery, "client_protocol_version") {
		t.Fatalf("expected client_protocol_version stripped from query, got %q", seenQuery)
	}
	if !strings.Contains(seenQuery, "database=default") {
		t.Fatalf("expected other query parameters to remain, got %q", seenQuery)
	}
}

func TestClickHouseHTTPServerInfoFunctionUnsupportedEnablesCompatibilityRetry(t *testing.T) {
	err := errors.New(`failed to query server hello: failed to query server hello info: sendQuery: [HTTP 404] response body: "Code: 46. DB::Exception: Unknown function displayName: While processing displayName(), version(), revision(), timezone(). (UNKNOWN_FUNCTION)"`)
	if !isClickHouseHTTPServerInfoFunctionUnsupported(err) {
		t.Fatalf("expected displayName unknown function to be treated as HTTP server-info compatibility issue")
	}
	if !shouldRetryClickHouseHTTPCompatibility(err) {
		t.Fatalf("expected displayName unknown function to permit HTTP compatibility retry")
	}
	if !shouldTryNextClickHouseProtocol(clickhouse.HTTP, err) {
		t.Fatalf("expected HTTP displayName issue to permit protocol fallback")
	}
	if shouldTryNextClickHouseProtocol(clickhouse.Native, err) {
		t.Fatalf("native protocol should not treat HTTP displayName issue as retryable")
	}

	message := clickHouseAttemptFailureMessage(clickhouse.HTTP, err)
	if !strings.Contains(message, "displayName") || !strings.Contains(message, "兼容模式") {
		t.Fatalf("expected displayName compatibility retry hint, got %q", message)
	}
}

func TestIsClickHouseHTTPServerInfoFunctionUnsupportedIgnoresUnrelatedErrors(t *testing.T) {
	if isClickHouseHTTPServerInfoFunctionUnsupported(nil) {
		t.Fatal("nil error should not be treated as server-info function issue")
	}
	if isClickHouseHTTPServerInfoFunctionUnsupported(errors.New("[HTTP 404] page not found")) {
		t.Fatal("plain 404 without displayName signal should not be treated as server-info function issue")
	}
	if isClickHouseHTTPServerInfoFunctionUnsupported(errors.New("Code: 60. DB::Exception: Unknown function someOtherFn")) {
		t.Fatal("unknown function error without displayName should not be treated as server-info function issue")
	}
}

func TestClickHouseHTTPCompatibilityStripperRewritesServerHelloQuery(t *testing.T) {
	var seenBody string
	stripper := clickHouseHTTPClientProtocolVersionStripper{
		next: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.Body != nil {
				data, err := io.ReadAll(req.Body)
				if err != nil {
					return nil, err
				}
				seenBody = string(data)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		}),
	}
	req, err := http.NewRequest(
		http.MethodPost,
		"http://clickhouse.local:8123/?database=default",
		strings.NewReader(clickHouseServerHelloQuery),
	)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}

	res, err := stripper.RoundTrip(req)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if res != nil && res.Body != nil {
		res.Body.Close()
	}
	if strings.Contains(seenBody, "displayName()") {
		t.Fatalf("expected displayName() rewritten out of server hello query, got %q", seenBody)
	}
	if seenBody != clickHouseServerHelloCompatQuery {
		t.Fatalf("expected compatibility server hello query, got %q", seenBody)
	}
}

func TestClickHouseHTTPCompatibilityStripperRewritesServerHelloOnlyOnce(t *testing.T) {
	var seenBodies []string
	stripper := clickHouseHTTPClientProtocolVersionStripper{
		serverHelloRewritten: &atomic.Bool{},
		next: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.Body != nil {
				data, err := io.ReadAll(req.Body)
				if err != nil {
					return nil, err
				}
				seenBodies = append(seenBodies, string(data))
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		}),
	}

	for i := 0; i < 2; i++ {
		req, err := http.NewRequest(
			http.MethodPost,
			"http://clickhouse.local:8123/?database=default",
			strings.NewReader(clickHouseServerHelloQuery),
		)
		if err != nil {
			t.Fatalf("new request %d: %v", i, err)
		}
		res, err := stripper.RoundTrip(req)
		if err != nil {
			t.Fatalf("round trip %d: %v", i, err)
		}
		if res != nil && res.Body != nil {
			res.Body.Close()
		}
	}

	if len(seenBodies) != 2 {
		t.Fatalf("expected two forwarded requests, got %d", len(seenBodies))
	}
	if seenBodies[0] != clickHouseServerHelloCompatQuery {
		t.Fatalf("expected first (handshake) request rewritten, got %q", seenBodies[0])
	}
	if seenBodies[1] != clickHouseServerHelloQuery {
		t.Fatalf("expected second identical query left unchanged after handshake, got %q", seenBodies[1])
	}
}

func TestClickHouseHTTPCompatibilityStripperLeavesOtherBodiesUnchanged(t *testing.T) {
	const userQuery = "SELECT count() FROM system.tables"
	var seenBody string
	stripper := clickHouseHTTPClientProtocolVersionStripper{
		next: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.Body != nil {
				data, err := io.ReadAll(req.Body)
				if err != nil {
					return nil, err
				}
				seenBody = string(data)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
			}, nil
		}),
	}
	req, err := http.NewRequest(
		http.MethodPost,
		"http://clickhouse.local:8123/?database=default",
		strings.NewReader(userQuery),
	)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}

	res, err := stripper.RoundTrip(req)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if res != nil && res.Body != nil {
		res.Body.Close()
	}
	if seenBody != userQuery {
		t.Fatalf("expected user query body untouched, got %q", seenBody)
	}
}

func TestClickHouseConnectFallsBackToLegacyHTTPForRevisionZeroServer(t *testing.T) {
	installClickHouseRuntimeMarkerForTest(t)

	var (
		mu                       sync.Mutex
		sawProtocolVersion       bool
		sawRevisionZeroHandshake bool
		sawLegacyJSONQuery       bool
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		mu.Lock()
		defer mu.Unlock()
		if r.URL.Query().Get("client_protocol_version") != "" {
			sawProtocolVersion = true
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "Code: 115. DB::Exception: Unknown setting client_protocol_version. (UNKNOWN_SETTING)")
			return
		}

		switch strings.TrimSpace(string(body)) {
		case clickHouseServerHelloCompatQuery:
			sawRevisionZeroHandshake = true
			writeClickHouseRevisionZeroHelloBlock(t, w)
		case "SELECT currentDatabase()":
			if r.URL.Query().Get("default_format") != "JSONCompactEachRowWithNamesAndTypes" {
				t.Errorf("legacy query format = %q", r.URL.Query().Get("default_format"))
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			sawLegacyJSONQuery = true
			_, _ = io.WriteString(w, "[\"currentDatabase()\"]\n[\"String\"]\n[\"default\"]\n")
		default:
			t.Errorf("unexpected ClickHouse query: %q", string(body))
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	serverURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse ClickHouse test server URL: %v", err)
	}
	host, portText, err := net.SplitHostPort(serverURL.Host)
	if err != nil {
		t.Fatalf("split ClickHouse test server address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse ClickHouse test server port: %v", err)
	}
	client := &ClickHouseDB{}
	err = client.Connect(connection.ConnectionConfig{
		Type:               "clickhouse",
		Host:               host,
		Port:               port,
		Database:           "default",
		User:               "default",
		ClickHouseProtocol: clickHouseProtocolHTTP,
		Timeout:            2,
	})
	if err != nil {
		t.Fatalf("Connect should fall back to legacy HTTP for ClickHouse 22.8: %v", err)
	}
	defer client.Close()

	mu.Lock()
	defer mu.Unlock()
	if !sawProtocolVersion || !sawRevisionZeroHandshake || !sawLegacyJSONQuery {
		t.Fatalf(
			"expected modern, revision-zero, and legacy requests; modern=%t revisionZero=%t legacy=%t",
			sawProtocolVersion,
			sawRevisionZeroHandshake,
			sawLegacyJSONQuery,
		)
	}
}

func TestClickHouseConnectAutoFallsBackToHTTPAfterNativeHandshakeTimeout(t *testing.T) {
	installClickHouseRuntimeMarkerForTest(t)

	var sawHTTP atomic.Bool
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		sawHTTP.Store(true)

		if r.URL.Query().Get("client_protocol_version") != "" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "Code: 115. DB::Exception: Unknown setting client_protocol_version. (UNKNOWN_SETTING)")
			return
		}

		switch strings.TrimSpace(string(body)) {
		case clickHouseServerHelloCompatQuery:
			writeClickHouseRevisionZeroHelloBlock(t, w)
		case "SELECT currentDatabase()":
			_, _ = io.WriteString(w, "[\"currentDatabase()\"]\n[\"String\"]\n[\"default\"]\n")
		default:
			t.Errorf("unexpected ClickHouse query: %q", string(body))
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	server.Listener = &stallFirstReadListener{Listener: server.Listener}
	server.Start()
	defer server.Close()

	serverURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse ClickHouse test server URL: %v", err)
	}
	host, portText, err := net.SplitHostPort(serverURL.Host)
	if err != nil {
		t.Fatalf("split ClickHouse test server address: %v", err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("parse ClickHouse test server port: %v", err)
	}

	client := &ClickHouseDB{}
	err = client.Connect(connection.ConnectionConfig{
		Type:               "clickhouse",
		Host:               host,
		Port:               port,
		Database:           "default",
		User:               "default",
		ClickHouseProtocol: clickHouseProtocolAuto,
		Timeout:            1,
	})
	if err != nil {
		t.Fatalf("Connect should try HTTP after a Native handshake timeout in auto mode: %v", err)
	}
	defer client.Close()
	if !sawHTTP.Load() {
		t.Fatal("expected HTTP fallback request after the Native handshake timeout")
	}
}

type stallFirstReadListener struct {
	net.Listener
	accepted atomic.Int32
}

func (l *stallFirstReadListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	if l.accepted.Add(1) == 1 {
		return &discardUntilPeerClosesConn{Conn: conn}, nil
	}
	return conn, nil
}

type discardUntilPeerClosesConn struct {
	net.Conn
}

func (c *discardUntilPeerClosesConn) Read(_ []byte) (int, error) {
	buffer := make([]byte, 4096)
	for {
		if _, err := c.Conn.Read(buffer); err != nil {
			return 0, err
		}
	}
}

func installClickHouseRuntimeMarkerForTest(t *testing.T) {
	t.Helper()
	previousRoot := currentExternalDriverDownloadDirectory()
	t.Cleanup(func() { SetExternalDriverDownloadDirectory(previousRoot) })

	root := t.TempDir()
	SetExternalDriverDownloadDirectory(root)
	markerPath, err := ResolveOptionalGoDriverMarkerPath(root, "clickhouse")
	if err != nil {
		t.Fatalf("resolve ClickHouse marker path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(markerPath), 0o755); err != nil {
		t.Fatalf("create ClickHouse marker directory: %v", err)
	}
	if err := os.WriteFile(markerPath, []byte("{}"), 0o644); err != nil {
		t.Fatalf("write ClickHouse marker: %v", err)
	}
	executablePath, err := ResolveOptionalDriverAgentExecutablePath(root, "clickhouse")
	if err != nil {
		t.Fatalf("resolve ClickHouse agent path: %v", err)
	}
	if err := os.WriteFile(executablePath, []byte("test agent placeholder"), 0o755); err != nil {
		t.Fatalf("write ClickHouse agent placeholder: %v", err)
	}
}

func writeClickHouseRevisionZeroHelloBlock(t *testing.T, w http.ResponseWriter) {
	t.Helper()
	block := clickhouseproto.NewBlock()
	for _, column := range []struct {
		name     string
		typeName clickhousecolumn.Type
	}{
		{name: "hostName()", typeName: "String"},
		{name: "version()", typeName: "String"},
		{name: "revision()", typeName: "UInt64"},
		{name: "timezone()", typeName: "String"},
	} {
		if err := block.AddColumn(column.name, column.typeName); err != nil {
			t.Fatalf("add ClickHouse block column: %v", err)
		}
	}
	if err := block.Append("legacy-clickhouse", "22.8.20.11", uint64(54460), "UTC"); err != nil {
		t.Fatalf("append ClickHouse block row: %v", err)
	}
	buffer := &chproto.Buffer{}
	if err := block.Encode(buffer, 0); err != nil {
		t.Fatalf("encode revision-zero ClickHouse block: %v", err)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(buffer.Buf)
}

func TestWithClickHouseProtocolForcesProtocolSelection(t *testing.T) {
	httpConfig := withClickHouseProtocol(connection.ConnectionConfig{
		Type: "clickhouse",
		Host: "clickhouse.example.com",
		Port: 8125,
	}, clickhouse.HTTP)
	if protocol := detectClickHouseProtocol(httpConfig); protocol != clickhouse.HTTP {
		t.Fatalf("expected forced HTTP protocol, got %s", protocol.String())
	}

	nativeConfig := withClickHouseProtocol(connection.ConnectionConfig{
		Type: "clickhouse",
		Host: "http://clickhouse.example.com",
		Port: 8125,
	}, clickhouse.Native)
	if protocol := detectClickHouseProtocol(nativeConfig); protocol != clickhouse.Native {
		t.Fatalf("expected forced Native protocol, got %s", protocol.String())
	}
}

func TestClickHouseProtocolsForAttemptOnlyFallsBackInAutoMode(t *testing.T) {
	tests := []struct {
		name     string
		config   connection.ConnectionConfig
		expected []clickhouse.Protocol
	}{
		{
			name: "auto native falls back to http",
			config: connection.ConnectionConfig{
				Type: "clickhouse",
				Port: 9000,
			},
			expected: []clickhouse.Protocol{clickhouse.Native, clickhouse.HTTP},
		},
		{
			name: "auto http falls back to native",
			config: connection.ConnectionConfig{
				Type: "clickhouse",
				Port: 8125,
			},
			expected: []clickhouse.Protocol{clickhouse.HTTP, clickhouse.Native},
		},
		{
			name: "manual http does not try native",
			config: connection.ConnectionConfig{
				Type:               "clickhouse",
				Port:               9000,
				ClickHouseProtocol: "http",
			},
			expected: []clickhouse.Protocol{clickhouse.HTTP},
		},
		{
			name: "manual native does not try http",
			config: connection.ConnectionConfig{
				Type:               "clickhouse",
				Port:               8125,
				ClickHouseProtocol: "native",
			},
			expected: []clickhouse.Protocol{clickhouse.Native},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := clickHouseProtocolsForAttempt(tt.config)
			if len(got) != len(tt.expected) {
				t.Fatalf("expected protocols %v, got %v", protocolNames(tt.expected), protocolNames(got))
			}
			for idx := range got {
				if got[idx] != tt.expected[idx] {
					t.Fatalf("expected protocols %v, got %v", protocolNames(tt.expected), protocolNames(got))
				}
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func protocolNames(protocols []clickhouse.Protocol) []string {
	names := make([]string, 0, len(protocols))
	for _, protocol := range protocols {
		names = append(names, protocol.String())
	}
	return names
}

func rawClickHouseTableNameRequiredText() string {
	return string([]rune{0x8868, 0x540d, 0x4e0d, 0x80fd, 0x4e3a, 0x7a7a})
}

func clickHouseApplyChangesI18nKeys() []string {
	return []string{
		"db.backend.error.table_name_required",
		"db.backend.error.clickhouse_delete_failed_with_sql",
		"db.backend.error.clickhouse_update_failed_with_sql",
	}
}

type fakeClickHouseDriver struct{}

func (fakeClickHouseDriver) Open(name string) (driver.Conn, error) {
	return fakeClickHouseConn{}, nil
}

type fakeClickHouseConn struct{}

func (fakeClickHouseConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("prepare not implemented")
}

func (fakeClickHouseConn) Close() error {
	return nil
}

func (fakeClickHouseConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions not implemented")
}

func (fakeClickHouseConn) Ping(ctx context.Context) error {
	fakeClickHouseStateMu.Lock()
	defer fakeClickHouseStateMu.Unlock()
	return fakeClickHouseState.pingErr
}

func (fakeClickHouseConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	fakeClickHouseStateMu.Lock()
	defer fakeClickHouseStateMu.Unlock()
	fakeClickHouseState.lastQuery = query
	fakeClickHouseState.queries = append(fakeClickHouseState.queries, query)
	if result, ok := fakeClickHouseState.queryResults[query]; ok {
		if result.err != nil {
			return nil, result.err
		}
		return &fakeClickHouseRows{columns: result.columns, rows: result.rows}, nil
	}
	if fakeClickHouseState.queryErr != nil {
		return nil, fakeClickHouseState.queryErr
	}
	return &fakeClickHouseRows{}, nil
}

func (fakeClickHouseConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	fakeClickHouseStateMu.Lock()
	defer fakeClickHouseStateMu.Unlock()
	fakeClickHouseState.lastExec = query
	fakeClickHouseState.execQueries = append(fakeClickHouseState.execQueries, query)
	if fakeClickHouseState.execErr != nil {
		return nil, fakeClickHouseState.execErr
	}
	return driver.RowsAffected(1), nil
}

type fakeClickHouseRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (r *fakeClickHouseRows) Columns() []string {
	if len(r.columns) > 0 {
		return r.columns
	}
	return []string{"currentDatabase"}
}

func (r *fakeClickHouseRows) Close() error {
	return nil
}

func (r *fakeClickHouseRows) Next(dest []driver.Value) error {
	if r.index < len(r.rows) {
		row := r.rows[r.index]
		for idx := range dest {
			if idx < len(row) {
				dest[idx] = row[idx]
			}
		}
		r.index++
		return nil
	}
	if len(dest) > 0 {
		dest[0] = "default"
	}
	return io.EOF
}
