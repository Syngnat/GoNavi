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

type oracleCurrentSchemaTestState struct {
	mu          sync.Mutex
	connections []*oracleCurrentSchemaTestConn
	failInit    bool
}

func (s *oracleCurrentSchemaTestState) snapshotConnections() []*oracleCurrentSchemaTestConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*oracleCurrentSchemaTestConn(nil), s.connections...)
}

type oracleCurrentSchemaTestConnector struct {
	state *oracleCurrentSchemaTestState
}

func (c *oracleCurrentSchemaTestConnector) Connect(context.Context) (driver.Conn, error) {
	conn := &oracleCurrentSchemaTestConn{failInit: c.state.failInit}
	c.state.mu.Lock()
	c.state.connections = append(c.state.connections, conn)
	c.state.mu.Unlock()
	return conn, nil
}

func (*oracleCurrentSchemaTestConnector) Driver() driver.Driver {
	return oracleCurrentSchemaTestDriver{}
}

type oracleCurrentSchemaTestDriver struct{}

func (oracleCurrentSchemaTestDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use oracleCurrentSchemaTestConnector")
}

type oracleCurrentSchemaTestConn struct {
	mu            sync.Mutex
	operations    []string
	currentSchema string
	closed        bool
	failInit      bool
}

func (c *oracleCurrentSchemaTestConn) snapshot() ([]string, string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.operations...), c.currentSchema, c.closed
}

func (*oracleCurrentSchemaTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("not implemented")
}

func (c *oracleCurrentSchemaTestConn) Close() error {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	return nil
}

func (*oracleCurrentSchemaTestConn) Begin() (driver.Tx, error) {
	return nil, errors.New("not implemented")
}

func (c *oracleCurrentSchemaTestConn) PrepareContext(context.Context, string) (driver.Stmt, error) {
	return nil, errors.New("not implemented")
}

func (c *oracleCurrentSchemaTestConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return nil, errors.New("not implemented")
}

func (*oracleCurrentSchemaTestConn) Ping(context.Context) error { return nil }

func (*oracleCurrentSchemaTestConn) ResetSession(context.Context) error { return nil }

func (*oracleCurrentSchemaTestConn) CheckNamedValue(*driver.NamedValue) error { return nil }

func (c *oracleCurrentSchemaTestConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.operations = append(c.operations, query)
	const prefix = "ALTER SESSION SET CURRENT_SCHEMA = "
	if strings.HasPrefix(query, prefix) {
		if c.failInit {
			return nil, errors.New("schema rejected")
		}
		c.currentSchema = strings.TrimSpace(strings.TrimPrefix(query, prefix))
		if strings.HasPrefix(c.currentSchema, `"`) && strings.HasSuffix(c.currentSchema, `"`) {
			c.currentSchema = strings.ReplaceAll(c.currentSchema[1:len(c.currentSchema)-1], `""`, `"`)
		}
	}
	return driver.RowsAffected(0), nil
}

func (c *oracleCurrentSchemaTestConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.mu.Lock()
	c.operations = append(c.operations, query)
	currentSchema := c.currentSchema
	c.mu.Unlock()
	return &oracleCurrentSchemaTestRows{
		columns: []string{"CURRENT_SCHEMA"},
		values:  [][]driver.Value{{currentSchema}},
	}, nil
}

type oracleCurrentSchemaTestRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

func (r *oracleCurrentSchemaTestRows) Columns() []string { return r.columns }

func (*oracleCurrentSchemaTestRows) Close() error { return nil }

func (r *oracleCurrentSchemaTestRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

func queryOracleCurrentSchemaForTest(t *testing.T, conn *sql.Conn) string {
	t.Helper()
	var schema string
	if err := conn.QueryRowContext(context.Background(), "SELECT CURRENT_SCHEMA").Scan(&schema); err != nil {
		t.Fatalf("query current schema: %v", err)
	}
	return schema
}

func TestQuoteOracleSchemaIdentifierPreservesExactName(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name string
		raw  string
		want string
	}{
		{name: "uppercase", raw: "PRO", want: `"PRO"`},
		{name: "quoted lowercase owner", raw: "pro", want: `"pro"`},
		{name: "embedded quote", raw: `A"B`, want: `"A""B"`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := QuoteOracleSchemaIdentifier(testCase.raw); got != testCase.want {
				t.Fatalf("QuoteOracleSchemaIdentifier(%q) = %q, want %q", testCase.raw, got, testCase.want)
			}
		})
	}
}

func TestOracleCurrentSchemaConnectorInitializesEveryPhysicalConnection(t *testing.T) {
	state := &oracleCurrentSchemaTestState{}
	dbConn := sql.OpenDB(newOracleCurrentSchemaConnector(
		&oracleCurrentSchemaTestConnector{state: state},
		"PRO",
	))
	dbConn.SetMaxOpenConns(2)
	dbConn.SetMaxIdleConns(2)
	t.Cleanup(func() { _ = dbConn.Close() })

	first, err := dbConn.Conn(context.Background())
	if err != nil {
		t.Fatalf("open first connection: %v", err)
	}
	second, err := dbConn.Conn(context.Background())
	if err != nil {
		_ = first.Close()
		t.Fatalf("open second connection: %v", err)
	}

	if got := queryOracleCurrentSchemaForTest(t, first); got != "PRO" {
		t.Fatalf("first physical connection current schema = %q, want PRO", got)
	}
	if got := queryOracleCurrentSchemaForTest(t, second); got != "PRO" {
		t.Fatalf("second physical connection current schema = %q, want PRO", got)
	}

	dbConn.SetMaxIdleConns(0)
	if err := first.Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatalf("close second connection: %v", err)
	}

	rebuilt, err := dbConn.Conn(context.Background())
	if err != nil {
		t.Fatalf("open rebuilt connection: %v", err)
	}
	if got := queryOracleCurrentSchemaForTest(t, rebuilt); got != "PRO" {
		_ = rebuilt.Close()
		t.Fatalf("rebuilt physical connection current schema = %q, want PRO", got)
	}
	if err := rebuilt.Close(); err != nil {
		t.Fatalf("close rebuilt connection: %v", err)
	}

	connections := state.snapshotConnections()
	if len(connections) != 3 {
		t.Fatalf("physical connection count = %d, want 3", len(connections))
	}
	for index, conn := range connections {
		operations, currentSchema, _ := conn.snapshot()
		want := []string{
			`ALTER SESSION SET CURRENT_SCHEMA = "PRO"`,
			"SELECT CURRENT_SCHEMA",
		}
		if !reflect.DeepEqual(operations, want) {
			t.Fatalf("connection %d operations = %#v, want %#v", index+1, operations, want)
		}
		if currentSchema != "PRO" {
			t.Fatalf("connection %d current schema = %q, want PRO", index+1, currentSchema)
		}
	}
}

func TestOracleCurrentSchemaConnectorRestoresSchemaAfterManualSessionChange(t *testing.T) {
	state := &oracleCurrentSchemaTestState{}
	dbConn := sql.OpenDB(newOracleCurrentSchemaConnector(
		&oracleCurrentSchemaTestConnector{state: state},
		"PRO",
	))
	dbConn.SetMaxOpenConns(1)
	dbConn.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = dbConn.Close() })

	first, err := dbConn.Conn(context.Background())
	if err != nil {
		t.Fatalf("open first connection: %v", err)
	}
	if got := queryOracleCurrentSchemaForTest(t, first); got != "PRO" {
		_ = first.Close()
		t.Fatalf("initial current schema = %q, want PRO", got)
	}
	if _, err := first.ExecContext(context.Background(), "ALTER SESSION SET CURRENT_SCHEMA = OTHER"); err != nil {
		_ = first.Close()
		t.Fatalf("manual session change: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}

	reused, err := dbConn.Conn(context.Background())
	if err != nil {
		t.Fatalf("reuse connection: %v", err)
	}
	if got := queryOracleCurrentSchemaForTest(t, reused); got != "PRO" {
		_ = reused.Close()
		t.Fatalf("reused current schema = %q, want PRO", got)
	}
	if err := reused.Close(); err != nil {
		t.Fatalf("close reused connection: %v", err)
	}

	connections := state.snapshotConnections()
	if len(connections) != 1 {
		t.Fatalf("physical connection count = %d, want 1", len(connections))
	}
	operations, currentSchema, _ := connections[0].snapshot()
	want := []string{
		`ALTER SESSION SET CURRENT_SCHEMA = "PRO"`,
		"SELECT CURRENT_SCHEMA",
		"ALTER SESSION SET CURRENT_SCHEMA = OTHER",
		`ALTER SESSION SET CURRENT_SCHEMA = "PRO"`,
		"SELECT CURRENT_SCHEMA",
	}
	if !reflect.DeepEqual(operations, want) {
		t.Fatalf("operations = %#v, want %#v", operations, want)
	}
	if currentSchema != "PRO" {
		t.Fatalf("current schema after reuse = %q, want PRO", currentSchema)
	}
}

func TestOracleCurrentSchemaConnectorClosesConnectionWhenInitializationFails(t *testing.T) {
	state := &oracleCurrentSchemaTestState{failInit: true}
	connector := newOracleCurrentSchemaConnector(
		&oracleCurrentSchemaTestConnector{state: state},
		"PRO",
	)

	conn, err := connector.Connect(context.Background())
	if err == nil {
		t.Fatal("expected Oracle current schema initialization to fail")
	}
	if conn != nil {
		t.Fatal("failed initialization must not return a usable connection")
	}
	if !strings.Contains(err.Error(), "CURRENT_SCHEMA") {
		t.Fatalf("initialization error should identify CURRENT_SCHEMA, got %q", err.Error())
	}

	connections := state.snapshotConnections()
	if len(connections) != 1 {
		t.Fatalf("physical connection count = %d, want 1", len(connections))
	}
	operations, _, closed := connections[0].snapshot()
	if !reflect.DeepEqual(operations, []string{`ALTER SESSION SET CURRENT_SCHEMA = "PRO"`}) {
		t.Fatalf("unexpected operations after failed initialization: %#v", operations)
	}
	if !closed {
		t.Fatal("failed initialization must close the physical connection")
	}
}

var _ driver.Connector = (*oracleCurrentSchemaConnector)(nil)
var _ driver.ConnPrepareContext = (*oracleCurrentSchemaConn)(nil)
var _ driver.ConnBeginTx = (*oracleCurrentSchemaConn)(nil)
var _ driver.ExecerContext = (*oracleCurrentSchemaConn)(nil)
var _ driver.QueryerContext = (*oracleCurrentSchemaConn)(nil)
var _ driver.NamedValueChecker = (*oracleCurrentSchemaConn)(nil)
var _ driver.Pinger = (*oracleCurrentSchemaConn)(nil)
var _ driver.SessionResetter = (*oracleCurrentSchemaConn)(nil)
var _ driver.ExecerContext = (*oracleCurrentSchemaTestConn)(nil)
var _ driver.QueryerContext = (*oracleCurrentSchemaTestConn)(nil)
var _ driver.Pinger = (*oracleCurrentSchemaTestConn)(nil)
