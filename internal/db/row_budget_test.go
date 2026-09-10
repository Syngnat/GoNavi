package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"sync/atomic"
	"testing"
)

// 行预算停读测试使用计数 fake driver：DriverRows 记录 Next/Close 次数，
// 断言达到预算后不再继续读取并释放 Rows（连接随 rows.Close 归还池）。
type rowBudgetFakeCounter struct {
	nextCalls  atomic.Int64
	closeCalls atomic.Int64
}

type rowBudgetFakeConnector struct {
	counter *rowBudgetFakeCounter
	sets    []int // 每个结果集的行数
}

func (c *rowBudgetFakeConnector) Connect(context.Context) (driver.Conn, error) {
	return &rowBudgetFakeConn{counter: c.counter, sets: c.sets}, nil
}

func (c *rowBudgetFakeConnector) Driver() driver.Driver {
	return rowBudgetFakeDriver{}
}

type rowBudgetFakeDriver struct{}

func (rowBudgetFakeDriver) Open(string) (driver.Conn, error) {
	return nil, driver.ErrSkip
}

type rowBudgetFakeConn struct {
	counter *rowBudgetFakeCounter
	sets    []int
}

func (c *rowBudgetFakeConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *rowBudgetFakeConn) Close() error                        { return nil }
func (c *rowBudgetFakeConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }
func (c *rowBudgetFakeConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return nil, driver.ErrSkip
}

func (c *rowBudgetFakeConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return &rowBudgetFakeRows{counter: c.counter, sets: c.sets}, nil
}

type rowBudgetFakeRows struct {
	counter *rowBudgetFakeCounter
	sets    []int
	setIdx  int
	rowIdx  int
}

func (r *rowBudgetFakeRows) Columns() []string { return []string{"n"} }

func (r *rowBudgetFakeRows) Close() error {
	r.counter.closeCalls.Add(1)
	return nil
}

func (r *rowBudgetFakeRows) Next(dest []driver.Value) error {
	r.counter.nextCalls.Add(1)
	if r.rowIdx >= r.sets[r.setIdx] {
		return io.EOF
	}
	dest[0] = int64(r.rowIdx + 1)
	r.rowIdx++
	return nil
}

func (r *rowBudgetFakeRows) HasNextResultSet() bool { return r.setIdx < len(r.sets)-1 }

func (r *rowBudgetFakeRows) NextResultSet() error {
	if !r.HasNextResultSet() {
		return io.EOF
	}
	r.setIdx++
	r.rowIdx = 0
	return nil
}

func openRowBudgetFakeDB(t *testing.T, counter *rowBudgetFakeCounter, sets ...int) *sql.DB {
	t.Helper()
	db := sql.OpenDB(&rowBudgetFakeConnector{counter: counter, sets: sets})
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func openRowBudgetFakeRows(t *testing.T, db *sql.DB, query string) *sql.Rows {
	t.Helper()
	rows, err := db.QueryContext(context.Background(), query)
	if err != nil {
		t.Fatalf("query fake db: %v", err)
	}
	return rows
}

func budgetContext(maxRows int) context.Context {
	return ContextWithRowBudget(context.Background(), NewRowBudget(maxRows))
}

func TestScanMultiRowsStopsReadingAtRowBudget(t *testing.T) {
	counter := &rowBudgetFakeCounter{}
	rows := openRowBudgetFakeRows(t, openRowBudgetFakeDB(t, counter, 300), "SELECT n")

	results, err := scanMultiRowsForDialectContext(budgetContext(50), rows, "")
	if err != nil {
		t.Fatalf("scanMultiRowsForDialectContext: %v", err)
	}
	if len(results) != 1 || len(results[0].Rows) != 50 {
		t.Fatalf("expected 1 result set with 50 rows, got %#v", results)
	}
	if !results[0].Truncated {
		t.Fatalf("expected result set marked truncated")
	}
	if !counter.nextCalls.CompareAndSwap(51, 51) {
		t.Fatalf("expected 51 Next calls (50 rows + 1 overflow probe), got %d", counter.nextCalls.Load())
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("close rows: %v", err)
	}
	if counter.closeCalls.Load() != 1 {
		t.Fatalf("expected rows to be closed exactly once, got %d", counter.closeCalls.Load())
	}
}

func TestScanMultiRowsKeepsExactBudgetResultComplete(t *testing.T) {
	counter := &rowBudgetFakeCounter{}
	rows := openRowBudgetFakeRows(t, openRowBudgetFakeDB(t, counter, 50), "SELECT n")

	results, err := scanMultiRowsForDialectContext(budgetContext(50), rows, "")
	if err != nil {
		t.Fatalf("scanMultiRowsForDialectContext: %v", err)
	}
	if len(results) != 1 || len(results[0].Rows) != 50 {
		t.Fatalf("expected complete 50-row result set, got %#v", results)
	}
	if results[0].Truncated {
		t.Fatalf("result set with exactly the budget row count must not be marked truncated")
	}
}

func TestScanMultiRowsWithoutBudgetMaterializesAllRows(t *testing.T) {
	counter := &rowBudgetFakeCounter{}
	rows := openRowBudgetFakeRows(t, openRowBudgetFakeDB(t, counter, 300), "SELECT n")

	results, err := scanMultiRowsForDialectContext(context.Background(), rows, "")
	if err != nil {
		t.Fatalf("scanMultiRowsForDialectContext: %v", err)
	}
	if len(results) != 1 || len(results[0].Rows) != 300 || results[0].Truncated {
		t.Fatalf("expected complete 300-row result set, got %#v", results)
	}
}

func TestScanMultiRowsBudgetStopsAfterTruncatedResultSet(t *testing.T) {
	counter := &rowBudgetFakeCounter{}
	rows := openRowBudgetFakeRows(t, openRowBudgetFakeDB(t, counter, 10, 100), "SELECT n; SELECT n")

	results, err := scanMultiRowsForDialectContext(budgetContext(50), rows, "")
	if err != nil {
		t.Fatalf("scanMultiRowsForDialectContext: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 result sets, got %d", len(results))
	}
	if len(results[0].Rows) != 10 || results[0].Truncated {
		t.Fatalf("expected first result set complete with 10 rows, got %#v", results[0])
	}
	if len(results[1].Rows) != 50 || !results[1].Truncated {
		t.Fatalf("expected second result set truncated at 50 rows, got %#v", results[1])
	}
	// 第一个结果集耗尽需要 10 次 Next + 1 次 EOF；第二个结果集在读取
	// 50 行后通过 1 次溢出探测确认截断，之后不再读取。
	if counter.nextCalls.Load() != 62 {
		t.Fatalf("expected 62 Next calls, got %d", counter.nextCalls.Load())
	}
}

func TestScanRowsContextMarksRowBudgetOnSingleResultSet(t *testing.T) {
	counter := &rowBudgetFakeCounter{}
	rows := openRowBudgetFakeRows(t, openRowBudgetFakeDB(t, counter, 300), "SELECT n")

	budget := NewRowBudget(50)
	ctx := ContextWithRowBudget(context.Background(), budget)
	data, _, err := scanRowsContext(ctx, rows)
	if err != nil {
		t.Fatalf("scanRowsContext: %v", err)
	}
	if len(data) != 50 {
		t.Fatalf("expected 50 rows, got %d", len(data))
	}
	if !budget.Truncated() {
		t.Fatalf("expected budget to be marked truncated")
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("close rows: %v", err)
	}
	if counter.closeCalls.Load() != 1 {
		t.Fatalf("expected rows closed once, got %d", counter.closeCalls.Load())
	}
}
