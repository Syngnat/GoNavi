//go:build gonavi_full_drivers || gonavi_dameng_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

const damengIdentityInsertDriverName = "gonavi_dameng_identity_insert"

var (
	registerDamengIdentityInsertDriverOnce sync.Once
	damengIdentityInsertStateMu            sync.Mutex
	damengIdentityInsertStateSeq           int
	damengIdentityInsertStates             = map[string]*damengIdentityInsertState{}
)

type damengIdentityInsertState struct {
	mu                    sync.Mutex
	statements            []string
	hideIdentityMetadata  bool
	requireIdentityInsert bool
	identityInsertOn      bool
	failRollback          bool
}

type damengIdentityInsertDriver struct{}

type damengIdentityInsertConn struct {
	state *damengIdentityInsertState
}

type damengIdentityInsertRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

type damengIdentityInsertTx struct {
	state *damengIdentityInsertState
}

func (damengIdentityInsertDriver) Open(name string) (driver.Conn, error) {
	damengIdentityInsertStateMu.Lock()
	state := damengIdentityInsertStates[name]
	damengIdentityInsertStateMu.Unlock()
	if state == nil {
		return nil, fmt.Errorf("dameng identity insert test state not found: %s", name)
	}
	return &damengIdentityInsertConn{state: state}, nil
}

func (*damengIdentityInsertConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (*damengIdentityInsertConn) Close() error                        { return nil }
func (conn *damengIdentityInsertConn) Begin() (driver.Tx, error) {
	return damengIdentityInsertTx{state: conn.state}, nil
}
func (conn *damengIdentityInsertConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return damengIdentityInsertTx{state: conn.state}, nil
}

func (conn *damengIdentityInsertConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	conn.state.mu.Lock()
	conn.state.statements = append(conn.state.statements, query)
	upper := strings.ToUpper(strings.TrimSpace(query))
	if strings.Contains(upper, "SET IDENTITY_INSERT") {
		conn.state.identityInsertOn = strings.HasSuffix(upper, " ON")
	}
	requireIdentityInsert := conn.state.requireIdentityInsert
	identityInsertOn := conn.state.identityInsertOn
	conn.state.mu.Unlock()
	if requireIdentityInsert && strings.Contains(upper, "INSERT INTO") && !identityInsertOn {
		return nil, errors.New("Error -2723: 仅当指定列列表，且SET IDENTITY_INSERT为ON时，才能对自增列赋值")
	}
	return driver.RowsAffected(1), nil
}

func (conn *damengIdentityInsertConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	conn.state.mu.Lock()
	conn.state.statements = append(conn.state.statements, query)
	conn.state.mu.Unlock()

	switch {
	case strings.Contains(query, "SYS.SYSCOLUMNCOMMENTS"):
		return &damengIdentityInsertRows{columns: []string{"COLUMN_NAME", "COL_COMMENT"}}, nil
	case strings.Contains(query, "SYS.SYSCOLUMNS"):
		conn.state.mu.Lock()
		hideIdentityMetadata := conn.state.hideIdentityMetadata
		conn.state.mu.Unlock()
		if hideIdentityMetadata {
			return &damengIdentityInsertRows{columns: []string{"COLUMN_NAME"}}, nil
		}
		return &damengIdentityInsertRows{columns: []string{"COLUMN_NAME"}, values: [][]driver.Value{{"ID"}}}, nil
	default:
		return &damengIdentityInsertRows{
			columns: []string{"COLUMN_NAME", "DATA_TYPE", "DATA_LENGTH", "CHAR_LENGTH", "DATA_PRECISION", "DATA_SCALE", "NULLABLE", "DATA_DEFAULT", "COL_COMMENT", "COLUMN_KEY"},
			values: [][]driver.Value{
				{"ID", "BIGINT", nil, nil, int64(19), int64(0), "N", nil, "", "PRI"},
				{"NAME", "VARCHAR2", int64(64), int64(64), nil, nil, "Y", nil, "", ""},
			},
		}, nil
	}
}

func (damengIdentityInsertTx) Commit() error { return nil }
func (tx damengIdentityInsertTx) Rollback() error {
	tx.state.mu.Lock()
	failRollback := tx.state.failRollback
	tx.state.mu.Unlock()
	if failRollback {
		return errors.New("rollback connection lost")
	}
	return nil
}

func (rows *damengIdentityInsertRows) Columns() []string { return rows.columns }
func (*damengIdentityInsertRows) Close() error           { return nil }
func (rows *damengIdentityInsertRows) Next(dest []driver.Value) error {
	if rows.index >= len(rows.values) {
		return io.EOF
	}
	copy(dest, rows.values[rows.index])
	rows.index++
	return nil
}

func openDamengIdentityInsertDB(t *testing.T) (*DamengDB, *damengIdentityInsertState) {
	t.Helper()
	registerDamengIdentityInsertDriverOnce.Do(func() {
		sql.Register(damengIdentityInsertDriverName, damengIdentityInsertDriver{})
	})
	state := &damengIdentityInsertState{}
	damengIdentityInsertStateMu.Lock()
	damengIdentityInsertStateSeq++
	dsn := fmt.Sprintf("dameng-identity-insert-%d", damengIdentityInsertStateSeq)
	damengIdentityInsertStates[dsn] = state
	damengIdentityInsertStateMu.Unlock()
	database, err := sql.Open(damengIdentityInsertDriverName, dsn)
	if err != nil {
		t.Fatalf("open dameng identity insert test DB: %v", err)
	}
	database.SetMaxOpenConns(1)
	t.Cleanup(func() {
		_ = database.Close()
		damengIdentityInsertStateMu.Lock()
		delete(damengIdentityInsertStates, dsn)
		damengIdentityInsertStateMu.Unlock()
	})
	return &DamengDB{conn: database}, state
}

func (state *damengIdentityInsertState) statementsSnapshot() []string {
	state.mu.Lock()
	defer state.mu.Unlock()
	return append([]string(nil), state.statements...)
}

func TestDamengApplyChangesEnablesIdentityInsertForExplicitIdentityValues(t *testing.T) {
	database, state := openDamengIdentityInsertDB(t)
	err := database.ApplyChangesContext(context.Background(), `"BIZ"."ORDERS"`, connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": int64(7), "name": "Ada"}},
	})
	if err != nil {
		t.Fatalf("ApplyChangesContext returned error: %v", err)
	}

	statements := strings.Join(state.statementsSnapshot(), "\n")
	on := `SET IDENTITY_INSERT "BIZ"."ORDERS" ON`
	off := `SET IDENTITY_INSERT "BIZ"."ORDERS" OFF`
	onAt, insertAt, offAt := strings.Index(statements, on), strings.Index(statements, "INSERT INTO"), strings.Index(statements, off)
	if onAt < 0 || insertAt < 0 || offAt < 0 || !(onAt < insertAt && insertAt < offAt) {
		t.Fatalf("identity insert must bracket the explicit insert, statements=%s", statements)
	}
}

func TestDamengApplyChangesSkipsIdentityInsertWhenIdentityColumnIsAbsent(t *testing.T) {
	database, state := openDamengIdentityInsertDB(t)
	err := database.ApplyChangesContext(context.Background(), `"BIZ"."ORDERS"`, connection.ChangeSet{
		Inserts: []map[string]interface{}{{"name": "Ada"}},
	})
	if err != nil {
		t.Fatalf("ApplyChangesContext returned error: %v", err)
	}
	if strings.Contains(strings.Join(state.statementsSnapshot(), "\n"), "SET IDENTITY_INSERT") {
		t.Fatalf("identity insert must not be enabled without an explicit identity value: %v", state.statementsSnapshot())
	}
}

func TestDamengApplyChangesRetriesWhenIdentityMetadataIsUnavailable(t *testing.T) {
	database, state := openDamengIdentityInsertDB(t)
	state.mu.Lock()
	state.hideIdentityMetadata = true
	state.requireIdentityInsert = true
	state.mu.Unlock()

	err := database.ApplyChangesContext(context.Background(), `"BIZ"."ORDERS"`, connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": int64(7), "name": "Ada"}},
	})
	if err != nil {
		t.Fatalf("ApplyChangesContext should retry a rolled-back identity rejection: %v", err)
	}
	statements := state.statementsSnapshot()
	joined := strings.Join(statements, "\n")
	if strings.Count(joined, "INSERT INTO") != 2 {
		t.Fatalf("expected one failed insert and one retried insert, statements=%v", statements)
	}
	onAt := strings.Index(joined, `SET IDENTITY_INSERT "BIZ"."ORDERS" ON`)
	secondInsertAt := strings.LastIndex(joined, "INSERT INTO")
	offAt := strings.LastIndex(joined, `SET IDENTITY_INSERT "BIZ"."ORDERS" OFF`)
	if onAt < 0 || secondInsertAt < 0 || offAt < 0 || !(onAt < secondInsertAt && secondInsertAt < offAt) {
		t.Fatalf("retry must execute with identity insert enabled, statements=%v", statements)
	}
}

func TestDamengApplyChangesDoesNotRetryIdentityErrorAfterRollbackFailure(t *testing.T) {
	database, state := openDamengIdentityInsertDB(t)
	state.mu.Lock()
	state.hideIdentityMetadata = true
	state.requireIdentityInsert = true
	state.failRollback = true
	state.mu.Unlock()

	err := database.ApplyChangesContext(context.Background(), `"BIZ"."ORDERS"`, connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": int64(7), "name": "Ada"}},
	})
	if err == nil || !IsWriteOutcomeUnknown(err) {
		t.Fatalf("rollback failure must make the write outcome unknown without retry, got %v", err)
	}
	statements := strings.Join(state.statementsSnapshot(), "\n")
	if strings.Count(statements, "INSERT INTO") != 1 {
		t.Fatalf("must not replay identity rejection after rollback failure, statements=%s", statements)
	}
	if strings.Contains(statements, `SET IDENTITY_INSERT "BIZ"."ORDERS" ON`) {
		t.Fatalf("must not open identity insert for an outcome-unknown retry, statements=%s", statements)
	}
}
