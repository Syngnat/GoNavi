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

type mysqlI18nEmptyRowsDriver struct{}

type mysqlI18nEmptyRowsConn struct{}

type mysqlI18nEmptyRowsStmt struct{}

type mysqlI18nEmptyRowsRows struct{}

var registerMySQLI18nEmptyRowsDriverOnce sync.Once

var rawMySQLCreateStatementNotFoundText = string([]rune{0x672a, 0x627e, 0x5230, 0x5efa, 0x8868, 0x8bed, 0x53e5})
var rawMySQLAllColumnsDatabaseRequiredText = string([]rune{0x83b7, 0x53d6, 0x5168, 0x90e8, 0x5217, 0x4fe1, 0x606f, 0x9700, 0x8981, 0x6307, 0x5b9a, 0x6570, 0x636e, 0x5e93, 0x540d, 0x79f0})

func (mysqlI18nEmptyRowsDriver) Open(name string) (driver.Conn, error) {
	return mysqlI18nEmptyRowsConn{}, nil
}

func (mysqlI18nEmptyRowsConn) Prepare(query string) (driver.Stmt, error) {
	return mysqlI18nEmptyRowsStmt{}, nil
}

func (mysqlI18nEmptyRowsConn) Close() error { return nil }

func (mysqlI18nEmptyRowsConn) Begin() (driver.Tx, error) {
	return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_not_open", nil)
}

func (mysqlI18nEmptyRowsStmt) Close() error { return nil }

func (mysqlI18nEmptyRowsStmt) NumInput() int { return -1 }

func (mysqlI18nEmptyRowsStmt) Exec(args []driver.Value) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (mysqlI18nEmptyRowsStmt) Query(args []driver.Value) (driver.Rows, error) {
	return mysqlI18nEmptyRowsRows{}, nil
}

func (mysqlI18nEmptyRowsRows) Columns() []string {
	return []string{"Create Table"}
}

func (mysqlI18nEmptyRowsRows) Close() error { return nil }

func (mysqlI18nEmptyRowsRows) Next(dest []driver.Value) error {
	return io.EOF
}

func openMySQLI18nEmptyRowsDB(t *testing.T) *sql.DB {
	t.Helper()

	registerMySQLI18nEmptyRowsDriverOnce.Do(func() {
		sql.Register("mysql_i18n_empty_rows", mysqlI18nEmptyRowsDriver{})
	})

	conn, err := sql.Open("mysql_i18n_empty_rows", "")
	if err != nil {
		t.Fatalf("open mysql_i18n_empty_rows test DB failed: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return conn
}

func TestMySQLCreateStatementNotFoundUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	mysqlDB := &MySQLDB{conn: openMySQLI18nEmptyRowsDB(t)}

	_, err := mysqlDB.GetCreateStatement("app", "orders")
	if err == nil {
		t.Fatal("expected MySQL GetCreateStatement to fail")
	}
	if err.Error() != "The CREATE TABLE statement was not found" {
		t.Fatalf("expected English create-statement error, got %q", err.Error())
	}
	if strings.Contains(err.Error(), rawMySQLCreateStatementNotFoundText) {
		t.Fatalf("expected no raw Chinese create-statement text, got %q", err.Error())
	}
}


func TestMySQLGetAllColumnsDatabaseRequiredUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	mysqlDB := &MySQLDB{}

	_, err := mysqlDB.GetAllColumns("")
	if err == nil {
		t.Fatal("expected MySQL GetAllColumns to fail")
	}
	if err.Error() != "Database name is required" {
		t.Fatalf("expected English database-name error, got %q", err.Error())
	}
	if strings.Contains(err.Error(), rawMySQLAllColumnsDatabaseRequiredText) {
		t.Fatalf("expected no raw Chinese database-name text, got %q", err.Error())
	}
}

