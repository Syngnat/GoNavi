//go:build gonavi_full_drivers || gonavi_dameng_driver

package db

import (
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"sync"
	"testing"
	"GoNavi-Wails/shared/i18n"
)

type damengI18nEmptyRowsDriver struct{}

type damengI18nEmptyRowsConn struct{}

type damengI18nEmptyRowsStmt struct{}

type damengI18nEmptyRowsRows struct{}

var registerDamengI18nEmptyRowsDriverOnce sync.Once

var rawDamengCreateStatementNotFoundText = string([]rune{0x672a, 0x627e, 0x5230, 0x5efa, 0x8868, 0x8bed, 0x53e5})

func (damengI18nEmptyRowsDriver) Open(name string) (driver.Conn, error) {
	return damengI18nEmptyRowsConn{}, nil
}

func (damengI18nEmptyRowsConn) Prepare(query string) (driver.Stmt, error) {
	return damengI18nEmptyRowsStmt{}, nil
}

func (damengI18nEmptyRowsConn) Close() error { return nil }

func (damengI18nEmptyRowsConn) Begin() (driver.Tx, error) {
	return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_not_open", nil)
}

func (damengI18nEmptyRowsStmt) Close() error { return nil }

func (damengI18nEmptyRowsStmt) NumInput() int { return -1 }

func (damengI18nEmptyRowsStmt) Exec(args []driver.Value) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (damengI18nEmptyRowsStmt) Query(args []driver.Value) (driver.Rows, error) {
	return damengI18nEmptyRowsRows{}, nil
}

func (damengI18nEmptyRowsRows) Columns() []string {
	return []string{"DDL"}
}

func (damengI18nEmptyRowsRows) Close() error { return nil }

func (damengI18nEmptyRowsRows) Next(dest []driver.Value) error {
	return io.EOF
}

func openDamengI18nEmptyRowsDB(t *testing.T) *sql.DB {
	t.Helper()

	registerDamengI18nEmptyRowsDriverOnce.Do(func() {
		sql.Register("dameng_i18n_empty_rows", damengI18nEmptyRowsDriver{})
	})

	conn, err := sql.Open("dameng_i18n_empty_rows", "")
	if err != nil {
		t.Fatalf("open dameng_i18n_empty_rows test DB failed: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return conn
}

func TestDamengCreateStatementNotFoundUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	damengDB := &DamengDB{conn: openDamengI18nEmptyRowsDB(t)}

	_, err := damengDB.GetCreateStatement("app", "orders")
	if err == nil {
		t.Fatal("expected Dameng GetCreateStatement to fail")
	}
	if err.Error() != "The CREATE TABLE statement was not found" {
		t.Fatalf("expected English create-statement error, got %q", err.Error())
	}
	if strings.Contains(err.Error(), rawDamengCreateStatementNotFoundText) {
		t.Fatalf("expected no raw Chinese create-statement text, got %q", err.Error())
	}
}

