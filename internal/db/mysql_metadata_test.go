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
)

const mysqlTableCatalogDriverName = "gonavi-mysql-table-catalog"

var (
	registerMySQLTableCatalogDriverOnce sync.Once
	mysqlTableCatalogStateMu            sync.Mutex
	mysqlTableCatalogLastQuery          string
)

type mysqlTableCatalogDriver struct{}

type mysqlTableCatalogConn struct{}

type mysqlTableCatalogRows struct {
	index int
}

func (mysqlTableCatalogDriver) Open(string) (driver.Conn, error) {
	return mysqlTableCatalogConn{}, nil
}

func (mysqlTableCatalogConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (mysqlTableCatalogConn) Close() error { return nil }

func (mysqlTableCatalogConn) Begin() (driver.Tx, error) {
	return nil, driver.ErrSkip
}

func (mysqlTableCatalogConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	mysqlTableCatalogStateMu.Lock()
	mysqlTableCatalogLastQuery = query
	mysqlTableCatalogStateMu.Unlock()
	return &mysqlTableCatalogRows{}, nil
}

func (r *mysqlTableCatalogRows) Columns() []string {
	return []string{"TABLE_NAME"}
}

func (r *mysqlTableCatalogRows) Close() error { return nil }

func (r *mysqlTableCatalogRows) Next(dest []driver.Value) error {
	rows := [][]driver.Value{
		{"ldf_application_type"},
		{"ldf_application_type"},
		{"md_item_type"},
	}
	if r.index >= len(rows) {
		return io.EOF
	}
	dest[0] = rows[r.index][0]
	r.index++
	return nil
}

func TestCollectMySQLDatabaseNames_FallsBackToCurrentDatabase(t *testing.T) {
	t.Parallel()

	got, err := collectMySQLDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		switch query {
		case mysqlDatabaseQueries[0]:
			return nil, nil, errors.New("Error 1227 (42000): Access denied; you need (at least one of) the SHOW DATABASES privilege(s) for this operation")
		case mysqlDatabaseQueries[1]:
			return []map[string]interface{}{
				{"database_name": "biz_app"},
			}, []string{"database_name"}, nil
		default:
			return nil, nil, errors.New("unexpected query")
		}
	})
	if err != nil {
		t.Fatalf("collectMySQLDatabaseNames 返回错误: %v", err)
	}

	want := []string{"biz_app"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected database names, got=%v want=%v", got, want)
	}
}

func TestMySQLGetTablesDeduplicatesMySQLCompatibleCatalogRows(t *testing.T) {
	registerMySQLTableCatalogDriverOnce.Do(func() {
		sql.Register(mysqlTableCatalogDriverName, mysqlTableCatalogDriver{})
	})

	mysqlTableCatalogStateMu.Lock()
	mysqlTableCatalogLastQuery = ""
	mysqlTableCatalogStateMu.Unlock()

	conn, err := sql.Open(mysqlTableCatalogDriverName, "")
	if err != nil {
		t.Fatalf("open MySQL catalog test database: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})

	tables, err := (&MySQLDB{conn: conn}).GetTables("ldf_server_dbs_dev")
	if err != nil {
		t.Fatalf("GetTables returned error: %v", err)
	}
	want := []string{"ldf_application_type", "md_item_type"}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("GetTables returned %v, want %v", tables, want)
	}

	mysqlTableCatalogStateMu.Lock()
	lastQuery := mysqlTableCatalogLastQuery
	mysqlTableCatalogStateMu.Unlock()
	if !strings.Contains(lastQuery, "SELECT TABLE_NAME FROM information_schema.tables") {
		t.Fatalf("GetTables query should preserve raw catalog rows, got %s", lastQuery)
	}
}

func TestCollectMySQLDatabaseNames_AcceptsMyCATStyleSchemaColumn(t *testing.T) {
	t.Parallel()

	got, err := collectMySQLDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		switch query {
		case mysqlDatabaseQueries[0]:
			return []map[string]interface{}{
				{"SCHEMA": "analytics"},
			}, []string{"SCHEMA"}, nil
		case mysqlDatabaseQueries[1]:
			return []map[string]interface{}{
				{"Database": "should_not_be_used"},
			}, []string{"Database"}, nil
		default:
			return nil, nil, errors.New("unexpected query")
		}
	})
	if err != nil {
		t.Fatalf("collectMySQLDatabaseNames 返回错误: %v", err)
	}

	want := []string{"analytics"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected database names, got=%v want=%v", got, want)
	}
}

func TestCollectMySQLDatabaseNames_PrefersShowDatabasesWhenAvailable(t *testing.T) {
	t.Parallel()

	got, err := collectMySQLDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		switch query {
		case mysqlDatabaseQueries[0]:
			return []map[string]interface{}{
				{"Database": "analytics"},
				{"database": "audit"},
			}, nil, nil
		case mysqlDatabaseQueries[1]:
			return []map[string]interface{}{
				{"Database": "should_not_be_used"},
			}, nil, nil
		default:
			return nil, nil, errors.New("unexpected query")
		}
	})
	if err != nil {
		t.Fatalf("collectMySQLDatabaseNames 返回错误: %v", err)
	}

	want := []string{"analytics", "audit"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected database names, got=%v want=%v", got, want)
	}
}

func TestCollectMySQLDatabaseNames_ReturnsOriginalErrorWhenNoDatabaseResolved(t *testing.T) {
	t.Parallel()

	expectErr := errors.New("show databases denied")
	got, err := collectMySQLDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		switch query {
		case mysqlDatabaseQueries[0]:
			return nil, nil, expectErr
		case mysqlDatabaseQueries[1]:
			return []map[string]interface{}{
				{"Database": nil},
			}, nil, nil
		case mysqlDatabaseQueries[2]:
			return []map[string]interface{}{
				{"database_name": nil},
			}, nil, nil
		default:
			return nil, nil, errors.New("unexpected query")
		}
	})
	if err == nil {
		t.Fatalf("期望返回错误，实际 got=%v", got)
	}
	if !errors.Is(err, expectErr) {
		t.Fatalf("错误不符合预期: %v", err)
	}
}

func TestCollectMySQLDatabaseNames_FallsBackToInformationSchemaSchemata(t *testing.T) {
	t.Parallel()

	got, err := collectMySQLDatabaseNames(func(query string) ([]map[string]interface{}, []string, error) {
		switch query {
		case mysqlDatabaseQueries[0]:
			return nil, nil, errors.New("show databases denied")
		case mysqlDatabaseQueries[1]:
			return []map[string]interface{}{
				{"Database": nil},
			}, nil, nil
		case mysqlDatabaseQueries[2]:
			return []map[string]interface{}{
				{"SCHEMA_NAME": "leite-finance"},
				{"database_name": "analytics"},
			}, []string{"SCHEMA_NAME", "database_name"}, nil
		default:
			return nil, nil, errors.New("unexpected query")
		}
	})
	if err != nil {
		t.Fatalf("collectMySQLDatabaseNames 返回错误: %v", err)
	}

	want := []string{"leite-finance", "analytics"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected database names, got=%v want=%v", got, want)
	}
}

func TestBuildMySQLColumnDefinitionPreservesDefaultAndCollation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		row            map[string]interface{}
		wantDefault    *string
		wantHasDefault bool
		wantCharset    string
		wantCollation  string
	}{
		{
			name: "empty string default",
			row: map[string]interface{}{
				"Field": "nickname", "Type": "varchar(64)", "Null": "YES", "Key": "",
				"Default": "", "Extra": "", "Comment": "", "Collation": "utf8mb4_unicode_ci",
			},
			wantDefault:    stringPointer(""),
			wantHasDefault: true,
			wantCharset:    "utf8mb4",
			wantCollation:  "utf8mb4_unicode_ci",
		},
		{
			name: "ordinary default",
			row: map[string]interface{}{
				"Field": "status", "Type": "varchar(16)", "Null": "NO", "Key": "",
				"Default": "active", "Extra": "", "Comment": "", "Collation": "utf8_general_ci",
			},
			wantDefault:    stringPointer("active"),
			wantHasDefault: true,
			wantCharset:    "utf8",
			wantCollation:  "utf8_general_ci",
		},
		{
			name: "no default or collation",
			row: map[string]interface{}{
				"Field": "id", "Type": "bigint", "Null": "NO", "Key": "PRI",
				"Default": nil, "Extra": "auto_increment", "Comment": "", "Collation": nil,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildMySQLColumnDefinition(tt.row)
			if !reflect.DeepEqual(got.Default, tt.wantDefault) {
				t.Fatalf("default got=%v want=%v", got.Default, tt.wantDefault)
			}
			if got.HasDefault != tt.wantHasDefault {
				t.Fatalf("hasDefault got=%v want=%v", got.HasDefault, tt.wantHasDefault)
			}
			if got.Charset != tt.wantCharset || got.Collation != tt.wantCollation {
				t.Fatalf("charset/collation got=%q/%q want=%q/%q", got.Charset, got.Collation, tt.wantCharset, tt.wantCollation)
			}
		})
	}
}

func stringPointer(value string) *string {
	return &value
}

func TestBuildMySQLShowCreateTableQueryNormalizesQuotedIdentifiers(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		dbName    string
		tableName string
		want      string
	}{
		{
			name:      "plain db and quoted table",
			dbName:    "app",
			tableName: `"activate_record"`,
			want:      "SHOW CREATE TABLE `app`.`activate_record`",
		},
		{
			name:      "escaped quoted qualified table overrides db",
			dbName:    "ignored",
			tableName: `\"crm\".\"activate_record\"`,
			want:      "SHOW CREATE TABLE `crm`.`activate_record`",
		},
		{
			name:      "backtick escaping",
			dbName:    "app`prod",
			tableName: "`audit``log`",
			want:      "SHOW CREATE TABLE `app``prod`.`audit``log`",
		},
		{
			name:      "quoted table containing dot is not split",
			dbName:    "app",
			tableName: `"activate.record"`,
			want:      "SHOW CREATE TABLE `app`.`activate.record`",
		},
		{
			name:      "qualified quoted table containing dot is not split",
			dbName:    "ignored",
			tableName: "app.`activate.record`",
			want:      "SHOW CREATE TABLE `app`.`activate.record`",
		},
		{
			name:      "mixed quote artifact from UI row value",
			dbName:    "app",
			tableName: `'activate_record"`,
			want:      "SHOW CREATE TABLE `app`.`activate_record`",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := buildMySQLShowCreateTableQuery(tt.dbName, tt.tableName); got != tt.want {
				t.Fatalf("buildMySQLShowCreateTableQuery(%q,%q)=%q,want=%q", tt.dbName, tt.tableName, got, tt.want)
			}
		})
	}
}

func TestBuildMySQLShowFullColumnsQueryEscapesIdentifiers(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		dbName    string
		tableName string
		want      string
	}{
		{
			name:      "plain qualified table",
			dbName:    "app",
			tableName: "users",
			want:      "SHOW FULL COLUMNS FROM `app`.`users`",
		},
		{
			name:      "backticks cannot terminate identifiers",
			dbName:    "app`prod",
			tableName: "audit`log",
			want:      "SHOW FULL COLUMNS FROM `app``prod`.`audit``log`",
		},
		{
			name:      "quoted qualified table overrides database",
			dbName:    "ignored",
			tableName: `"sales.region"."daily.order"`,
			want:      "SHOW FULL COLUMNS FROM `sales.region`.`daily.order`",
		},
		{
			name:      "quoted dotted table remains one identifier",
			dbName:    "app",
			tableName: "`audit.logs`",
			want:      "SHOW FULL COLUMNS FROM `app`.`audit.logs`",
		},
		{
			name:      "table without database",
			tableName: "standalone",
			want:      "SHOW FULL COLUMNS FROM `standalone`",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := buildMySQLShowFullColumnsQuery(tt.dbName, tt.tableName); got != tt.want {
				t.Fatalf("buildMySQLShowFullColumnsQuery(%q,%q)=%q,want=%q", tt.dbName, tt.tableName, got, tt.want)
			}
		})
	}
}

type mysqlMetadataQuotingCapture struct {
	queries []string
	args    [][]driver.NamedValue
}

type mysqlMetadataQuotingConnector struct {
	capture *mysqlMetadataQuotingCapture
}

func (c mysqlMetadataQuotingConnector) Connect(context.Context) (driver.Conn, error) {
	return &mysqlMetadataQuotingConn{capture: c.capture}, nil
}

func (mysqlMetadataQuotingConnector) Driver() driver.Driver { return mysqlMetadataQuotingDriver{} }

type mysqlMetadataQuotingDriver struct{}

func (mysqlMetadataQuotingDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use sql.OpenDB with the test connector")
}

type mysqlMetadataQuotingConn struct {
	capture *mysqlMetadataQuotingCapture
}

func (mysqlMetadataQuotingConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepared statements are not supported by this test driver")
}

func (mysqlMetadataQuotingConn) Close() error { return nil }

func (mysqlMetadataQuotingConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported by this test driver")
}

func (c *mysqlMetadataQuotingConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.capture.queries = append(c.capture.queries, query)
	c.capture.args = append(c.capture.args, append([]driver.NamedValue(nil), args...))
	return mysqlMetadataQuotingRows{}, nil
}

var _ driver.QueryerContext = (*mysqlMetadataQuotingConn)(nil)

type mysqlMetadataQuotingRows struct{}

func (mysqlMetadataQuotingRows) Columns() []string { return []string{"unused"} }
func (mysqlMetadataQuotingRows) Close() error      { return nil }
func (mysqlMetadataQuotingRows) Next([]driver.Value) error {
	return io.EOF
}

func TestMySQLCompatibleMetadataQueriesQuoteIdentifiersAndBindNames(t *testing.T) {
	const schema = "app`prod"
	const table = "order'items"

	capture := &mysqlMetadataQuotingCapture{}
	conn := sql.OpenDB(mysqlMetadataQuotingConnector{capture: capture})
	t.Cleanup(func() { _ = conn.Close() })
	db := &MySQLDB{conn: conn}
	if _, err := db.GetIndexes(schema, table); err != nil {
		t.Fatalf("GetIndexes returned error: %v", err)
	}
	if _, err := db.GetForeignKeys(schema, table); err != nil {
		t.Fatalf("GetForeignKeys returned error: %v", err)
	}
	if _, err := db.GetTriggers(schema, table); err != nil {
		t.Fatalf("GetTriggers returned error: %v", err)
	}
	assertMySQLCompatibleMetadataQueryCapture(t, capture, schema, table)
}

func assertMySQLCompatibleMetadataQueryCapture(t *testing.T, capture *mysqlMetadataQuotingCapture, schema, table string) {
	t.Helper()
	wantQueries := []string{
		"SHOW INDEX FROM `app``prod`.`order'items`",
		buildMySQLForeignKeysQuery(),
		"SHOW TRIGGERS FROM `app``prod` WHERE `Table` = ?",
	}
	wantArgs := [][]driver.NamedValue{
		nil,
		{{Ordinal: 1, Value: schema}, {Ordinal: 2, Value: table}},
		{{Ordinal: 1, Value: table}},
	}
	if !reflect.DeepEqual(capture.queries, wantQueries) {
		t.Fatalf("queries = %#v, want %#v", capture.queries, wantQueries)
	}
	if !reflect.DeepEqual(capture.args, wantArgs) {
		t.Fatalf("args = %#v, want %#v", capture.args, wantArgs)
	}
}

func TestMySQLMetadataKeepsSQLServerBracketCharactersLiteral(t *testing.T) {
	schema, table := mysqlMetadataTableParts("app", "[weird]]name]")
	if schema != "app" || table != "[weird]]name]" {
		t.Fatalf("mysqlMetadataTableParts()=(%q,%q), want literal bracket name", schema, table)
	}

	if got := buildMySQLShowCreateTableQuery("app", "[weird]]name]"); got != "SHOW CREATE TABLE `app`.`[weird]]name]`" {
		t.Fatalf("buildMySQLShowCreateTableQuery()=%q, want literal bracket name", got)
	}
}
