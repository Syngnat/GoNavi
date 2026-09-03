//go:build gonavi_full_drivers || gonavi_sqlserver_driver

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
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"

	"github.com/golang-sql/sqlexp"
	_ "modernc.org/sqlite"
)

var rawSQLServerTableNameRequiredText = string([]rune{0x8868, 0x540d, 0x4e0d, 0x80fd, 0x4e3a, 0x7a7a})

const sqlServerPrintOnlyDriverName = "gonavi-sqlserver-print-only"

var registerSQLServerPrintOnlyDriver sync.Once

type sqlServerPrintOnlyDriver struct{}

type sqlServerPrintOnlyConn struct {
	retmsg *sqlexp.ReturnMessage
}

type sqlServerPrintOnlyRows struct {
	remainingBoundaries int
	drained             bool
}

type sqlServerPrintOnlyNotice string

func (sqlServerPrintOnlyDriver) Open(string) (driver.Conn, error) {
	return &sqlServerPrintOnlyConn{}, nil
}

func (c *sqlServerPrintOnlyConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("not implemented")
}

func (c *sqlServerPrintOnlyConn) Close() error {
	return nil
}

func (c *sqlServerPrintOnlyConn) Begin() (driver.Tx, error) {
	return nil, errors.New("not implemented")
}

func (c *sqlServerPrintOnlyConn) CheckNamedValue(value *driver.NamedValue) error {
	retmsg, ok := value.Value.(*sqlexp.ReturnMessage)
	if !ok {
		return nil
	}
	sqlexp.ReturnMessageInit(retmsg)
	c.retmsg = retmsg
	return driver.ErrRemoveArgument
}

func (c *sqlServerPrintOnlyConn) QueryContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Rows, error) {
	for _, message := range []sqlexp.RawMessage{
		sqlexp.MsgNextResultSet{},
		sqlexp.MsgNotice{Message: sqlServerPrintOnlyNotice("INSERT c_user(userid) values('168')")},
		sqlexp.MsgNextResultSet{},
		sqlexp.MsgNotice{Message: sqlServerPrintOnlyNotice("INSERT c_user(userid) values('169')")},
		sqlexp.MsgNextResultSet{},
		sqlexp.MsgNextResultSet{},
	} {
		if err := sqlexp.ReturnMessageEnqueue(ctx, c.retmsg, message); err != nil {
			return nil, err
		}
	}
	return &sqlServerPrintOnlyRows{remainingBoundaries: 3}, nil
}

func (r *sqlServerPrintOnlyRows) Columns() []string {
	// go-mssqldb Rowsq.Columns drains all empty DONE boundaries when no column
	// metadata exists. Calling it before the message loop ends loses later PRINTs.
	r.drained = true
	r.remainingBoundaries = 0
	return []string{}
}

func (*sqlServerPrintOnlyRows) Close() error {
	return nil
}

func (*sqlServerPrintOnlyRows) Next([]driver.Value) error {
	return io.EOF
}

func (*sqlServerPrintOnlyRows) HasNextResultSet() bool {
	return true
}

func (r *sqlServerPrintOnlyRows) NextResultSet() error {
	if r.drained || r.remainingBoundaries == 0 {
		return io.EOF
	}
	r.remainingBoundaries--
	return nil
}

func (m sqlServerPrintOnlyNotice) String() string {
	return string(m)
}

type fakeSQLServerExecResult struct {
	affected int64
	rowErr   error
}

type sqlServerApplyChangesContextState struct {
	execStarted chan struct{}
	execRelease chan struct{}
}

type sqlServerApplyChangesContextConnector struct {
	state *sqlServerApplyChangesContextState
}

type sqlServerApplyChangesContextDriver struct{}

type sqlServerApplyChangesContextConn struct {
	state *sqlServerApplyChangesContextState
}

type sqlServerApplyChangesContextTx struct{}

func (c sqlServerApplyChangesContextConnector) Connect(context.Context) (driver.Conn, error) {
	return &sqlServerApplyChangesContextConn{state: c.state}, nil
}

func (sqlServerApplyChangesContextConnector) Driver() driver.Driver {
	return sqlServerApplyChangesContextDriver{}
}

func (sqlServerApplyChangesContextDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use connector")
}

func (*sqlServerApplyChangesContextConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (*sqlServerApplyChangesContextConn) Close() error { return nil }

func (*sqlServerApplyChangesContextConn) Begin() (driver.Tx, error) {
	return nil, errors.New("legacy Begin must not be used")
}

func (*sqlServerApplyChangesContextConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return sqlServerApplyChangesContextTx{}, nil
}

func (c *sqlServerApplyChangesContextConn) ExecContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Result, error) {
	select {
	case c.state.execStarted <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.state.execRelease:
		return nil, errors.New("execution released without cancellation")
	}
}

func (sqlServerApplyChangesContextTx) Commit() error   { return nil }
func (sqlServerApplyChangesContextTx) Rollback() error { return nil }

func TestSQLServerApplyChangesContextCancelsInFlightBatchInsert(t *testing.T) {
	state := &sqlServerApplyChangesContextState{
		execStarted: make(chan struct{}, 1),
		execRelease: make(chan struct{}),
	}
	dbConn := sql.OpenDB(sqlServerApplyChangesContextConnector{state: state})
	t.Cleanup(func() { _ = dbConn.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- (&SqlServerDB{conn: dbConn}).ApplyChangesContext(ctx, "dbo.orders", connection.ChangeSet{
			Inserts: []map[string]interface{}{{"id": 42, "status": "pending"}},
		})
	}()

	select {
	case <-state.execStarted:
		cancel()
	case <-time.After(time.Second):
		cancel()
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not reach the context-aware batch insert path")
	}

	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), context.Canceled.Error()) {
			t.Fatalf("ApplyChangesContext error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not return after cancellation")
	}
}

var _ BatchApplierContext = (*SqlServerDB)(nil)

func (r fakeSQLServerExecResult) LastInsertId() (int64, error) {
	return 0, errors.New("not implemented")
}

func (r fakeSQLServerExecResult) RowsAffected() (int64, error) {
	if r.rowErr != nil {
		return 0, r.rowErr
	}
	return r.affected, nil
}

func TestSQLServerRowsAffectedIgnoresTransactionControlErrors(t *testing.T) {
	rowErr := errors.New("不支持的方法")
	for _, query := range []string{
		"BEGIN TRANSACTION",
		"COMMIT TRANSACTION",
		"ROLLBACK TRANSACTION",
		"SAVE TRANSACTION before_update",
		"BEGIN TRY\nSELECT 1\nEND TRY",
	} {
		affected, err := sqlServerRowsAffected(query, fakeSQLServerExecResult{rowErr: rowErr})
		if err != nil {
			t.Fatalf("sqlServerRowsAffected(%q) returned unexpected error: %v", query, err)
		}
		if affected != 0 {
			t.Fatalf("sqlServerRowsAffected(%q) = %d, want 0", query, affected)
		}
	}
}

func TestSQLServerRowsAffectedPreservesDMLCount(t *testing.T) {
	affected, err := sqlServerRowsAffected(
		"UPDATE dbo.users SET name = 'neo' WHERE id = 1",
		fakeSQLServerExecResult{affected: 3},
	)
	if err != nil {
		t.Fatalf("sqlServerRowsAffected returned unexpected error: %v", err)
	}
	if affected != 3 {
		t.Fatalf("sqlServerRowsAffected = %d, want 3", affected)
	}
}

func TestSQLServerRowsAffectedDoesNotHideDMLRowsAffectedErrors(t *testing.T) {
	rowErr := errors.New("rows affected unsupported")
	_, err := sqlServerRowsAffected(
		"UPDATE dbo.users SET name = 'neo' WHERE id = 1",
		fakeSQLServerExecResult{rowErr: rowErr},
	)
	if !errors.Is(err, rowErr) {
		t.Fatalf("expected rows affected error to propagate for DML, got %v", err)
	}
}

func TestSQLServerSessionExecerDiscardEvictsPhysicalConnection(t *testing.T) {
	dbConn := openConfiguredPoolForTest(t, "sqlserver")

	conn, err := dbConn.Conn(context.Background())
	if err != nil {
		t.Fatalf("acquire pinned SQL Server connection: %v", err)
	}
	session := &sqlServerSessionExecer{conn: conn}
	var _ StatementExecerDiscarter = session

	if err := session.Discard(); err != nil {
		t.Fatalf("discard pinned SQL Server connection: %v", err)
	}
	if session.conn != nil {
		t.Fatal("discard must clear the wrapper connection reference")
	}
	if got := poolRecordingCloseCount.Load(); got != 1 {
		t.Fatalf("discard must close the contaminated physical connection, closed %d", got)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("deferred close after discard must be harmless: %v", err)
	}

	if err := dbConn.PingContext(context.Background()); err != nil {
		t.Fatalf("ping after discard: %v", err)
	}
	if got := poolRecordingOpenCount.Load(); got != 2 {
		t.Fatalf("pool must open a fresh physical connection after discard, opened %d", got)
	}
}

func TestScanSQLServerRowsWithMessagesPreservesRowsFromMsgNext(t *testing.T) {
	dbConn, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		_ = dbConn.Close()
	})

	rows, err := dbConn.Query("SELECT 'config:roomType:add' AS menuName")
	if err != nil {
		t.Fatalf("query rows: %v", err)
	}
	defer rows.Close()

	ctx := context.Background()
	retmsg := &sqlexp.ReturnMessage{}
	sqlexp.ReturnMessageInit(retmsg)
	for _, message := range []sqlexp.RawMessage{
		sqlexp.MsgNext{},
		sqlexp.MsgRowsAffected{Count: 1},
		sqlexp.MsgNextResultSet{},
	} {
		if err := sqlexp.ReturnMessageEnqueue(ctx, retmsg, message); err != nil {
			t.Fatalf("enqueue SQL Server message: %v", err)
		}
	}

	resultSets, messages, err := scanSQLServerRowsWithMessages(ctx, rows, retmsg)
	if err != nil {
		t.Fatalf("scanSQLServerRowsWithMessages returned error: %v", err)
	}
	if len(messages) != 0 {
		t.Fatalf("expected no SQL Server notices, got %#v", messages)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected SELECT rows plus affected-row status, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"menuName"}) ||
		len(resultSets[0].Rows) != 1 ||
		resultSets[0].Rows[0]["menuName"] != "config:roomType:add" {
		t.Fatalf("expected SELECT rows first, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[1].Columns, []string{"affectedRows"}) ||
		len(resultSets[1].Rows) != 1 ||
		resultSets[1].Rows[0]["affectedRows"] != int64(1) {
		t.Fatalf("expected affected-row status after SELECT rows, got %#v", resultSets)
	}
}

func TestSQLServerQueryMultiWithMessagesPreservesPrintsAfterEmptyResultBoundaries(t *testing.T) {
	registerSQLServerPrintOnlyDriver.Do(func() {
		sql.Register(sqlServerPrintOnlyDriverName, sqlServerPrintOnlyDriver{})
	})
	dbConn, err := sql.Open(sqlServerPrintOnlyDriverName, "")
	if err != nil {
		t.Fatalf("open print-only SQL Server driver: %v", err)
	}
	t.Cleanup(func() {
		_ = dbConn.Close()
	})

	dbInst := &SqlServerDB{conn: dbConn}
	resultSets, messages, err := dbInst.QueryMultiWithMessages("p_get_select 'c_user','1=1',1")
	if err != nil {
		t.Fatalf("QueryMultiWithMessages returned error: %v", err)
	}
	wantMessages := []string{
		"INSERT c_user(userid) values('168')",
		"INSERT c_user(userid) values('169')",
	}
	if !reflect.DeepEqual(messages, wantMessages) {
		t.Fatalf("expected all PRINT messages, got %#v", messages)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one message-only result set, got %#v", resultSets)
	}
	if len(resultSets[0].Rows) != 0 || len(resultSets[0].Columns) != 0 {
		t.Fatalf("expected message-only result set without tabular data, got %#v", resultSets[0])
	}
	if !reflect.DeepEqual(resultSets[0].Messages, wantMessages) {
		t.Fatalf("expected result set to preserve all PRINT messages, got %#v", resultSets[0].Messages)
	}
}

func TestSQLServerMetadataErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	sqlServer := &SqlServerDB{}
	tests := []struct {
		name string
		call func() error
	}{
		{
			name: "create statement unsupported",
			call: func() error {
				_, err := sqlServer.GetCreateStatement("dbo", "orders")
				return err
			},
		},
		{
			name: "columns table name required",
			call: func() error {
				_, err := sqlServer.GetColumns("", " ")
				return err
			},
		},
		{
			name: "indexes table name required",
			call: func() error {
				_, err := sqlServer.GetIndexes("", " ")
				return err
			},
		},
		{
			name: "foreign keys table name required",
			call: func() error {
				_, err := sqlServer.GetForeignKeys("", " ")
				return err
			},
		},
		{
			name: "triggers table name required",
			call: func() error {
				_, err := sqlServer.GetTriggers("", " ")
				return err
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatal("expected SQL Server metadata call to fail")
			}
			if tc.name == "create statement unsupported" {
				if err.Error() != "Viewing SQL Server table DDL is not supported by the current backend" {
					t.Fatalf("expected English unsupported DDL error, got %q", err.Error())
				}
				return
			}
			if err.Error() != "Table name is required" {
				t.Fatalf("expected English table-name-required error, got %q", err.Error())
			}
			if strings.Contains(err.Error(), rawSQLServerTableNameRequiredText) {
				t.Fatalf("expected no raw Chinese SQL Server metadata text, got %q", err.Error())
			}
		})
	}
}

func TestSplitSQLServerTableNamePreservesDelimitedDots(t *testing.T) {
	tests := []struct {
		name       string
		input      string
		wantSchema string
		wantTable  string
	}{
		{name: "plain qualified", input: "audit.users", wantSchema: "audit", wantTable: "users"},
		{name: "bracketed dotted table", input: "[Sales.Data]", wantSchema: "dbo", wantTable: "Sales.Data"},
		{name: "bracketed schema and table", input: "[audit].[Sales.Data]", wantSchema: "audit", wantTable: "Sales.Data"},
		{name: "quoted schema and table", input: `"audit"."Sales.Data"`, wantSchema: "audit", wantTable: "Sales.Data"},
		{name: "bracketed whitespace table", input: "[audit].[ id ]", wantSchema: "audit", wantTable: " id "},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			schema, table := splitSQLServerTableName(test.input)
			if schema != test.wantSchema || table != test.wantTable {
				t.Fatalf("splitSQLServerTableName(%q)=(%q,%q), want (%q,%q)", test.input, schema, table, test.wantSchema, test.wantTable)
			}
		})
	}
}

func TestFormatSQLServerTableMetadataNameQuotesAmbiguousParts(t *testing.T) {
	tests := []struct {
		name   string
		schema string
		table  string
		want   string
	}{
		{name: "plain", schema: "audit", table: "users", want: "audit.users"},
		{name: "dotted table", schema: "audit", table: "order.items", want: "[audit].[order.items]"},
		{name: "escaped bracket", schema: "audit]ops", table: "order]items", want: "[audit]]ops].[order]]items]"},
		{name: "whitespace table", schema: "audit", table: " id ", want: "[audit].[ id ]"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := formatSQLServerTableMetadataName(test.schema, test.table); got != test.want {
				t.Fatalf("formatSQLServerTableMetadataName(%q,%q)=%q, want %q", test.schema, test.table, got, test.want)
			}
		})
	}
}

func TestQuoteSQLServerChangeIdentifierOnlyUnquotesOneBracketPair(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "users", want: "[users]"},
		{input: "[users]", want: "[users]"},
		{input: "[a]]b]", want: "[a]]b]"},
		{input: "]x[", want: "[]]x[]"},
		{input: " id ", want: "[ id ]"},
		{input: " [ id ] ", want: "[ id ]"},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			if got := quoteSQLServerChangeIdentifier(test.input); got != test.want {
				t.Fatalf("quoteSQLServerChangeIdentifier(%q)=%q, want %q", test.input, got, test.want)
			}
		})
	}
}
