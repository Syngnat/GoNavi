package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"
	"testing"
)

const searchPathPoolExpected = `"Tenant.Schema", "tenant_b", "public"`

type searchPathPoolState struct {
	mu                  sync.Mutex
	executedStatements  []string
	expectedSearchPath  string
	pathSearchPaths     []string
	baseConnectionCount int
	pathConnectionCount int
	rejectSearchPath    bool
}

func newSearchPathPoolState(rejectSearchPath bool) *searchPathPoolState {
	return &searchPathPoolState{
		expectedSearchPath: searchPathPoolExpected,
		rejectSearchPath:   rejectSearchPath,
	}
}

func (s *searchPathPoolState) open(_ string, dsn string) (*sql.DB, error) {
	return sql.OpenDB(searchPathPoolConnector{state: s, dsn: dsn}), nil
}

func (s *searchPathPoolState) recordConnection(searchPath string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if searchPath == "" {
		s.baseConnectionCount++
		return
	}
	s.pathConnectionCount++
	s.pathSearchPaths = append(s.pathSearchPaths, searchPath)
}

func (s *searchPathPoolState) recordExecution(query string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.executedStatements = append(s.executedStatements, query)
}

func (s *searchPathPoolState) assertNoSessionSearchPath(t *testing.T) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, statement := range s.executedStatements {
		if strings.Contains(strings.ToLower(statement), "set search_path") {
			t.Fatalf("不应对连接池执行会话级 search_path 设置: %q", statement)
		}
	}
}

func (s *searchPathPoolState) assertPoolUsedTwoPhysicalConnections(t *testing.T) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	connectionCount := s.baseConnectionCount + s.pathConnectionCount
	if connectionCount < 2 {
		t.Fatalf("回归场景应至少使用两个物理连接，实际=%d", connectionCount)
	}
}

func (s *searchPathPoolState) assertAllPathConnectionsInitialized(t *testing.T, wantAtLeast int) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pathConnectionCount < wantAtLeast {
		t.Fatalf("应至少建立 %d 个带 search_path 的物理连接，实际=%d", wantAtLeast, s.pathConnectionCount)
	}
	for _, searchPath := range s.pathSearchPaths {
		if searchPath != s.expectedSearchPath {
			t.Fatalf("物理连接未使用目标 search_path，实际=%q，期望=%q", searchPath, s.expectedSearchPath)
		}
	}
}

type searchPathPoolConnector struct {
	state *searchPathPoolState
	dsn   string
}

func (c searchPathPoolConnector) Connect(context.Context) (driver.Conn, error) {
	searchPath := searchPathFromTestDSN(c.dsn)
	c.state.recordConnection(searchPath)
	return &searchPathPoolConn{
		state:      c.state,
		searchPath: searchPath,
		pingErr:    c.state.rejectSearchPath && searchPath != "",
	}, nil
}

func (c searchPathPoolConnector) Driver() driver.Driver {
	return searchPathPoolDriver{}
}

type searchPathPoolDriver struct{}

func (searchPathPoolDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("请使用 searchPathPoolConnector")
}

type searchPathPoolConn struct {
	state      *searchPathPoolState
	searchPath string
	pingErr    bool
}

func (c *searchPathPoolConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("未实现")
}

func (c *searchPathPoolConn) Close() error { return nil }

func (c *searchPathPoolConn) Begin() (driver.Tx, error) {
	return nil, errors.New("未实现")
}

func (c *searchPathPoolConn) Ping(context.Context) error {
	if c.pingErr {
		return errors.New("DSN search_path 初始化失败")
	}
	return nil
}

func (c *searchPathPoolConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	switch {
	case strings.Contains(strings.ToLower(query), "from pg_namespace"):
		return &searchPathPoolRows{columns: []string{"nspname"}, values: [][]driver.Value{{"Tenant.Schema"}, {"tenant_b"}}}, nil
	case strings.Contains(strings.ToLower(query), "from duplicate_objects"):
		if c.searchPath != c.state.expectedSearchPath {
			return nil, fmt.Errorf("未限定对象解析到了错误 schema，search_path=%q", c.searchPath)
		}
		return &searchPathPoolRows{columns: []string{"table_schema"}, values: [][]driver.Value{{"Tenant.Schema"}}}, nil
	default:
		return &searchPathPoolRows{columns: []string{"value"}}, nil
	}
}

func (c *searchPathPoolConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.state.recordExecution(query)
	return driver.RowsAffected(0), nil
}

type searchPathPoolRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

func (r searchPathPoolRows) Columns() []string { return r.columns }

func (r searchPathPoolRows) Close() error { return nil }

func (r *searchPathPoolRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

func searchPathFromTestDSN(dsn string) string {
	if parsed, err := url.Parse(dsn); err == nil && parsed.Scheme != "" {
		return parsed.Query().Get("search_path")
	}

	const key = "search_path="
	index := strings.Index(strings.ToLower(dsn), key)
	if index < 0 {
		return ""
	}
	value := strings.TrimSpace(dsn[index+len(key):])
	if len(value) >= 2 && value[0] == '\'' {
		if end := strings.LastIndex(value[1:], "'"); end >= 0 {
			return value[1 : end+1]
		}
	}
	if end := strings.IndexAny(value, " \t\r\n"); end >= 0 {
		return value[:end]
	}
	return value
}

func assertUnqualifiedDuplicateObjectUsesTargetSchema(t *testing.T, conn *sql.Conn) {
	t.Helper()
	var schema string
	if err := conn.QueryRowContext(context.Background(), "SELECT table_schema FROM duplicate_objects").Scan(&schema); err != nil {
		t.Fatalf("查询未限定的同名对象失败: %v", err)
	}
	if schema != "Tenant.Schema" {
		t.Fatalf("未限定的同名对象应解析到 Tenant.Schema，实际=%q", schema)
	}
}
