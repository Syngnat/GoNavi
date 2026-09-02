package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

const customMySQLDSNRecordingDriverName = "custom-mysql-dsn-recording"

var customMySQLDSNRecordingLastDSN string

const customApplyChangesI18nDriverName = "custom-applychanges-i18n"

const customGetTablesDriverName = "custom-get-tables"

var (
	registerCustomApplyChangesI18nDriverOnce sync.Once
	customApplyChangesI18nStateMu            sync.Mutex
	customApplyChangesI18nState              = struct {
		failPrefix string
		err        error
	}{}
)

var (
	registerCustomGetTablesDriverOnce sync.Once
	customGetTablesStateMu            sync.Mutex
	customGetTablesState              = struct {
		lastQuery string
		columns   []string
		rows      [][]driver.Value
	}{}
)

type customMySQLDSNRecordingDriver struct{}

func (d customMySQLDSNRecordingDriver) Open(name string) (driver.Conn, error) {
	customMySQLDSNRecordingLastDSN = name
	return customMySQLDSNRecordingConn{}, nil
}

type customMySQLDSNRecordingConn struct{}

func (c customMySQLDSNRecordingConn) Prepare(query string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (c customMySQLDSNRecordingConn) Close() error {
	return nil
}

func (c customMySQLDSNRecordingConn) Begin() (driver.Tx, error) {
	return nil, driver.ErrSkip
}

type customApplyChangesI18nDriver struct{}

type customApplyChangesI18nConn struct{}

type customApplyChangesI18nTx struct{}

type customGetTablesDriver struct{}

type customGetTablesConn struct{}

type customGetTablesRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (customGetTablesDriver) Open(string) (driver.Conn, error) {
	return customGetTablesConn{}, nil
}

func (customGetTablesConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (customGetTablesConn) Close() error { return nil }

func (customGetTablesConn) Begin() (driver.Tx, error) {
	return nil, driver.ErrSkip
}

func (customGetTablesConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	customGetTablesStateMu.Lock()
	defer customGetTablesStateMu.Unlock()
	customGetTablesState.lastQuery = query
	return &customGetTablesRows{
		columns: append([]string(nil), customGetTablesState.columns...),
		rows:    append([][]driver.Value(nil), customGetTablesState.rows...),
	}, nil
}

func (r *customGetTablesRows) Columns() []string {
	return append([]string(nil), r.columns...)
}

func (r *customGetTablesRows) Close() error { return nil }

func (r *customGetTablesRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.index]
	for index := range dest {
		if index < len(row) {
			dest[index] = row[index]
		}
	}
	r.index++
	return nil
}

func (d customApplyChangesI18nDriver) Open(name string) (driver.Conn, error) {
	return customApplyChangesI18nConn{}, nil
}

func (c customApplyChangesI18nConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("prepare not implemented")
}

func (c customApplyChangesI18nConn) Close() error {
	return nil
}

func (c customApplyChangesI18nConn) Begin() (driver.Tx, error) {
	return customApplyChangesI18nTx{}, nil
}

func (c customApplyChangesI18nConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	return customApplyChangesI18nTx{}, nil
}

func (c customApplyChangesI18nConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	customApplyChangesI18nStateMu.Lock()
	defer customApplyChangesI18nStateMu.Unlock()

	normalizedQuery := strings.ToUpper(strings.TrimSpace(query))
	if customApplyChangesI18nState.err != nil && strings.HasPrefix(normalizedQuery, customApplyChangesI18nState.failPrefix) {
		return nil, customApplyChangesI18nState.err
	}
	return driver.RowsAffected(1), nil
}

func (tx customApplyChangesI18nTx) Commit() error {
	return nil
}

func (tx customApplyChangesI18nTx) Rollback() error {
	return nil
}

func init() {
	sql.Register(customMySQLDSNRecordingDriverName, customMySQLDSNRecordingDriver{})
}

func openCustomApplyChangesI18nDB(t *testing.T, failPrefix string, err error) *sql.DB {
	t.Helper()

	registerCustomApplyChangesI18nDriverOnce.Do(func() {
		sql.Register(customApplyChangesI18nDriverName, customApplyChangesI18nDriver{})
	})

	customApplyChangesI18nStateMu.Lock()
	customApplyChangesI18nState.failPrefix = failPrefix
	customApplyChangesI18nState.err = err
	customApplyChangesI18nStateMu.Unlock()

	db, openErr := sql.Open(customApplyChangesI18nDriverName, "")
	if openErr != nil {
		t.Fatalf("open custom ApplyChanges i18n test DB failed: %v", openErr)
	}
	t.Cleanup(func() {
		_ = db.Close()
		customApplyChangesI18nStateMu.Lock()
		customApplyChangesI18nState.failPrefix = ""
		customApplyChangesI18nState.err = nil
		customApplyChangesI18nStateMu.Unlock()
	})
	return db
}

func TestCustomDBApplyChangesErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	rawConnectionNotOpenText := string([]rune{0x8fde, 0x63a5, 0x672a, 0x6253, 0x5f00})
	rawDeleteFailedText := string([]rune{0x5220, 0x9664, 0x5931, 0x8d25})
	rawUpdateKeyConditionsRequiredText := string([]rune{0x66f4, 0x65b0, 0x64cd, 0x4f5c, 0x9700, 0x8981, 0x4e3b, 0x952e, 0x6761, 0x4ef6})
	rawUpdateFailedText := string([]rune{0x66f4, 0x65b0, 0x5931, 0x8d25})

	t.Run("connection not open", func(t *testing.T) {
		err := (&CustomDB{}).ApplyChanges("orders", connection.ChangeSet{})
		if err == nil {
			t.Fatal("expected connection-not-open error")
		}
		if err.Error() != "Connection is not open" {
			t.Fatalf("expected English connection-not-open error, got %q", err.Error())
		}
		if strings.Contains(err.Error(), rawConnectionNotOpenText) {
			t.Fatalf("expected no raw connection-not-open text, got %q", err.Error())
		}
	})

	t.Run("delete failure", func(t *testing.T) {
		rawErr := errors.New("driver raw delete failure")
		customDB := &CustomDB{conn: openCustomApplyChangesI18nDB(t, "DELETE", rawErr), driver: "mysql"}

		err := customDB.ApplyChanges("orders", connection.ChangeSet{
			Deletes: []map[string]interface{}{
				{"id": int64(42)},
			},
		})
		if err == nil {
			t.Fatal("expected delete failure")
		}
		if err.Error() != "Delete failed: driver raw delete failure" {
			t.Fatalf("expected English delete failure, got %q", err.Error())
		}
		if strings.Contains(err.Error(), rawDeleteFailedText) {
			t.Fatalf("expected no raw delete wrapper, got %q", err.Error())
		}
	})

	t.Run("update key condition required", func(t *testing.T) {
		customDB := &CustomDB{conn: openCustomApplyChangesI18nDB(t, "", nil), driver: "mysql"}

		err := customDB.ApplyChanges("orders", connection.ChangeSet{
			Updates: []connection.UpdateRow{{
				Values: map[string]interface{}{
					"name": "Alice",
				},
			}},
		})
		if err == nil {
			t.Fatal("expected update-key-condition error")
		}
		if err.Error() != "Update operation requires key conditions" {
			t.Fatalf("expected English update-key-condition error, got %q", err.Error())
		}
		if strings.Contains(err.Error(), rawUpdateKeyConditionsRequiredText) {
			t.Fatalf("expected no raw update-key-condition text, got %q", err.Error())
		}
	})

	t.Run("update failure", func(t *testing.T) {
		rawErr := errors.New("driver raw update failure")
		customDB := &CustomDB{conn: openCustomApplyChangesI18nDB(t, "UPDATE", rawErr), driver: "mysql"}

		err := customDB.ApplyChanges("orders", connection.ChangeSet{
			Updates: []connection.UpdateRow{{
				Keys: map[string]interface{}{
					"id": int64(42),
				},
				Values: map[string]interface{}{
					"name": "Alice",
				},
			}},
		})
		if err == nil {
			t.Fatal("expected update failure")
		}
		if err.Error() != "Update failed: driver raw update failure" {
			t.Fatalf("expected English update failure, got %q", err.Error())
		}
		if strings.Contains(err.Error(), rawUpdateFailedText) {
			t.Fatalf("expected no raw update wrapper, got %q", err.Error())
		}
	})
}

func TestCustomDBApplyChangesCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range customDBApplyChangesI18nKeys() {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing CustomDB ApplyChanges key %q", language, key)
			}
		}
	}
}

func customDBApplyChangesI18nKeys() []string {
	return []string{
		"db.backend.error.connection_not_open",
		"db.backend.error.row_delete_failed",
		"db.backend.error.row_update_key_conditions_required",
		"db.backend.error.row_update_failed",
	}
}

func TestCustomDBBasicExecutionConnectionNotOpenUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	rawConnectionNotOpenText := string([]rune{0x8fde, 0x63a5, 0x672a, 0x6253, 0x5f00})
	customDB := &CustomDB{}

	cases := []struct {
		name string
		run  func() error
	}{
		{
			name: "Ping",
			run:  customDB.Ping,
		},
		{
			name: "Query",
			run: func() error {
				_, _, err := customDB.Query("SELECT 1")
				return err
			},
		},
		{
			name: "QueryContext",
			run: func() error {
				_, _, err := customDB.QueryContext(context.Background(), "SELECT 1")
				return err
			},
		},
		{
			name: "Exec",
			run: func() error {
				_, err := customDB.Exec("UPDATE demo SET name = 'raw'")
				return err
			},
		},
		{
			name: "ExecContext",
			run: func() error {
				_, err := customDB.ExecContext(context.Background(), "UPDATE demo SET name = 'raw'")
				return err
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			if err == nil {
				t.Fatal("expected connection-not-open error")
			}
			if err.Error() != "Connection is not open" {
				t.Fatalf("expected English connection-not-open error, got %q", err.Error())
			}
			if strings.Contains(err.Error(), rawConnectionNotOpenText) {
				t.Fatalf("expected no raw connection-not-open text, got %q", err.Error())
			}
		})
	}
}

func TestCustomDBConnectReportsUnsupportedODBCDriverName(t *testing.T) {
	db := &CustomDB{}

	err := db.Connect(connection.ConnectionConfig{
		Driver: "InterSystems IRIS ODBC35",
		DSN:    "Driver={InterSystems IRIS ODBC35};Server=127.0.0.1;Port=1972;Database=USER;",
	})
	if err == nil {
		t.Fatal("expected unsupported ODBC driver error, got nil")
	}

	message := err.Error()
	for _, want := range []string{
		"ODBC/JDBC",
		"Go database/sql",
		"暂不支持",
		"InterSystems IRIS",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("expected error to contain %q, got %q", want, message)
		}
	}
}

func TestCustomDBConnectReportsUnregisteredGoDriver(t *testing.T) {
	db := &CustomDB{}

	err := db.Connect(connection.ConnectionConfig{
		Driver: "not-a-registered-go-driver",
		DSN:    "demo",
	})
	if err == nil {
		t.Fatal("expected unregistered Go driver error, got nil")
	}

	message := err.Error()
	for _, want := range []string{
		"未在 GoNavi 中注册",
		"Go database/sql",
	} {
		if !strings.Contains(message, want) {
			t.Fatalf("expected error to contain %q, got %q", want, message)
		}
	}
}

func TestNormalizeMySQLRawDSNCompatibilityParamsMapsAllowMultiQueries(t *testing.T) {
	got := normalizeMySQLRawDSNCompatibilityParams(
		"root:pass@tcp(127.0.0.1:3306)/app?charset=utf8mb4&allowMultiQueries=true#debug",
	)
	if strings.Contains(got, "allowMultiQueries") {
		t.Fatalf("allowMultiQueries should not remain in DSN: %s", got)
	}
	if !strings.Contains(got, "multiStatements=true") {
		t.Fatalf("allowMultiQueries=true should map to multiStatements=true: %s", got)
	}
	if !strings.HasSuffix(got, "#debug") {
		t.Fatalf("fragment should be preserved: %s", got)
	}
}

func TestNormalizeMySQLRawDSNCompatibilityParamsPreservesExplicitMultiStatements(t *testing.T) {
	got := normalizeMySQLRawDSNCompatibilityParams(
		"root:pass@tcp(127.0.0.1:3306)/app?allowMultiQueries=true&multiStatements=false",
	)
	if strings.Contains(got, "allowMultiQueries") {
		t.Fatalf("allowMultiQueries should not remain in DSN: %s", got)
	}
	if !strings.Contains(got, "multiStatements=false") {
		t.Fatalf("explicit multiStatements should win: %s", got)
	}
}

func TestNormalizeMySQLRawDSNCompatibilityParamsPreservesCharsetFallbackComma(t *testing.T) {
	got := normalizeMySQLRawDSNCompatibilityParams(
		"root:pass@tcp(127.0.0.1:3306)/app?charset=utf8mb4,utf8&allowMultiQueries=true",
	)
	if strings.Contains(got, "%2C") || strings.Contains(got, "%2c") {
		t.Fatalf("charset fallback comma should stay unescaped for mysql driver, got %q", got)
	}
	if !strings.Contains(got, "charset=utf8mb4,utf8") {
		t.Fatalf("charset fallback list should be preserved, got %q", got)
	}
}

func TestCustomDBOnlyNormalizesBuiltInMySQLDriverDSN(t *testing.T) {
	customMySQLDSNRecordingLastDSN = ""
	rawDSN := "root:pass@tcp(127.0.0.1:3306)/app?allowMultiQueries=true"

	db := &CustomDB{}
	err := db.Connect(connection.ConnectionConfig{
		Driver: customMySQLDSNRecordingDriverName,
		DSN:    rawDSN,
	})
	if err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	if customMySQLDSNRecordingLastDSN != rawDSN {
		t.Fatalf("non-mysql custom driver DSN should stay untouched, got %q", customMySQLDSNRecordingLastDSN)
	}
}

func TestCustomDBGetTablesDeduplicatesExactKingbaseMetadataRows(t *testing.T) {
	registerCustomGetTablesDriverOnce.Do(func() {
		sql.Register(customGetTablesDriverName, customGetTablesDriver{})
	})

	customGetTablesStateMu.Lock()
	customGetTablesState.lastQuery = ""
	customGetTablesState.columns = []string{"SCHEMANAME", "TABLENAME"}
	customGetTablesState.rows = [][]driver.Value{
		{"ldf_server", "ldf_application_type"},
		{"ldf_server", "ldf_application_type"},
		{"LDF_SERVER", "LDF_APPLICATION_TYPE"},
		{"archive", "ldf_application_type"},
	}
	customGetTablesStateMu.Unlock()
	t.Cleanup(func() {
		customGetTablesStateMu.Lock()
		customGetTablesState.lastQuery = ""
		customGetTablesState.columns = nil
		customGetTablesState.rows = nil
		customGetTablesStateMu.Unlock()
	})

	conn, err := sql.Open(customGetTablesDriverName, "")
	if err != nil {
		t.Fatalf("open custom metadata test database: %v", err)
	}
	defer conn.Close()

	tables, err := (&CustomDB{conn: conn, driver: "Kingbase"}).GetTables("ldf_server_dbs_dev")
	if err != nil {
		t.Fatalf("GetTables returned error: %v", err)
	}
	want := []string{
		"ldf_server.ldf_application_type",
		"LDF_SERVER.LDF_APPLICATION_TYPE",
		"archive.ldf_application_type",
	}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("GetTables returned %v, want %v", tables, want)
	}

	customGetTablesStateMu.Lock()
	lastQuery := customGetTablesState.lastQuery
	customGetTablesStateMu.Unlock()
	if !strings.Contains(lastQuery, "SELECT DISTINCT table_schema AS schemaname") {
		t.Fatalf("expected DISTINCT Kingbase metadata query, got %s", lastQuery)
	}
}

func TestCustomDBGetTablesTrimsAndDeduplicatesGenericMetadataRows(t *testing.T) {
	registerCustomGetTablesDriverOnce.Do(func() {
		sql.Register(customGetTablesDriverName, customGetTablesDriver{})
	})

	customGetTablesStateMu.Lock()
	customGetTablesState.lastQuery = ""
	customGetTablesState.columns = []string{"TABLE_NAME"}
	customGetTablesState.rows = [][]driver.Value{
		{" orders "},
		{"orders"},
		{"\torders\n"},
		{"customers"},
		{nil},
		{"   "},
	}
	customGetTablesStateMu.Unlock()
	t.Cleanup(func() {
		customGetTablesStateMu.Lock()
		customGetTablesState.lastQuery = ""
		customGetTablesState.columns = nil
		customGetTablesState.rows = nil
		customGetTablesStateMu.Unlock()
	})

	conn, err := sql.Open(customGetTablesDriverName, "")
	if err != nil {
		t.Fatalf("open custom metadata test database: %v", err)
	}
	defer conn.Close()

	tables, err := (&CustomDB{conn: conn, driver: "sqlite"}).GetTables("")
	if err != nil {
		t.Fatalf("GetTables returned error: %v", err)
	}
	want := []string{"orders", "customers"}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("GetTables returned %v, want %v", tables, want)
	}
}

func TestCustomDBGetTablesEscapesPGLikeSchemaLiteral(t *testing.T) {
	registerCustomGetTablesDriverOnce.Do(func() {
		sql.Register(customGetTablesDriverName, customGetTablesDriver{})
	})

	customGetTablesStateMu.Lock()
	customGetTablesState.lastQuery = ""
	customGetTablesState.columns = []string{"SCHEMANAME", "TABLENAME"}
	customGetTablesState.rows = nil
	customGetTablesStateMu.Unlock()
	t.Cleanup(func() {
		customGetTablesStateMu.Lock()
		customGetTablesState.lastQuery = ""
		customGetTablesState.columns = nil
		customGetTablesState.rows = nil
		customGetTablesStateMu.Unlock()
	})

	conn, err := sql.Open(customGetTablesDriverName, "")
	if err != nil {
		t.Fatalf("open custom metadata test database: %v", err)
	}
	defer conn.Close()

	if _, err := (&CustomDB{conn: conn, driver: "kingbase"}).GetTables("tenant's"); err != nil {
		t.Fatalf("GetTables returned error: %v", err)
	}

	customGetTablesStateMu.Lock()
	lastQuery := customGetTablesState.lastQuery
	customGetTablesStateMu.Unlock()
	if !strings.Contains(lastQuery, "AND table_schema = 'tenant''s'") {
		t.Fatalf("expected escaped Kingbase schema literal, got %s", lastQuery)
	}
}

func TestCustomDBGetTablesPreservesPGLikeQualifiedIdentifierEscaping(t *testing.T) {
	registerCustomGetTablesDriverOnce.Do(func() {
		sql.Register(customGetTablesDriverName, customGetTablesDriver{})
	})

	customGetTablesStateMu.Lock()
	customGetTablesState.columns = []string{"SCHEMANAME", "TABLENAME"}
	customGetTablesState.rows = [][]driver.Value{{"ldf.server", "application.type"}}
	customGetTablesStateMu.Unlock()
	t.Cleanup(func() {
		customGetTablesStateMu.Lock()
		customGetTablesState.columns = nil
		customGetTablesState.rows = nil
		customGetTablesStateMu.Unlock()
	})

	conn, err := sql.Open(customGetTablesDriverName, "")
	if err != nil {
		t.Fatalf("open custom metadata test database: %v", err)
	}
	defer conn.Close()

	tables, err := (&CustomDB{conn: conn, driver: "kingbase"}).GetTables("ldf_server_dbs_dev")
	if err != nil {
		t.Fatalf("GetTables returned error: %v", err)
	}
	if want := []string{`"ldf.server"."application.type"`}; !reflect.DeepEqual(tables, want) {
		t.Fatalf("GetTables returned %v, want %v", tables, want)
	}
}

func TestBuildCustomColumnDefinitionPrefersCompleteColumnType(t *testing.T) {
	col := buildCustomColumnDefinition(map[string]interface{}{
		"COLUMN_NAME": "USER_NAME",
		"DATA_TYPE":   "varchar",
		"COLUMN_TYPE": "varchar(64)",
		"IS_NULLABLE": "NO",
	})

	if col.Name != "USER_NAME" {
		t.Fatalf("expected name USER_NAME, got %q", col.Name)
	}
	if col.Type != "varchar(64)" {
		t.Fatalf("expected complete type varchar(64), got %q", col.Type)
	}
	if col.Nullable != "NO" {
		t.Fatalf("expected nullable NO, got %q", col.Nullable)
	}
}

func TestBuildCustomColumnDefinitionBuildsTypeFromLengthAndPrecision(t *testing.T) {
	nameCol := buildCustomColumnDefinition(map[string]interface{}{
		"column_name":              "display_name",
		"data_type":                "varchar",
		"character_maximum_length": int64(128),
		"is_nullable":              "YES",
	})
	if nameCol.Type != "varchar(128)" {
		t.Fatalf("expected varchar(128), got %q", nameCol.Type)
	}

	amountCol := buildCustomColumnDefinition(map[string]interface{}{
		"column_name":       "amount",
		"data_type":         "decimal",
		"numeric_precision": float64(10),
		"numeric_scale":     float64(2),
	})
	if amountCol.Type != "decimal(10,2)" {
		t.Fatalf("expected decimal(10,2), got %q", amountCol.Type)
	}
}
