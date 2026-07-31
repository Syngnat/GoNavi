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
			if err.Error() != "Table name is required" {
				t.Fatalf("expected English table-name-required error, got %q", err.Error())
			}
			if strings.Contains(err.Error(), rawSQLServerTableNameRequiredText) {
				t.Fatalf("expected no raw Chinese SQL Server metadata text, got %q", err.Error())
			}
		})
	}
}

