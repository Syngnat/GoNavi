//go:build gonavi_full_drivers || gonavi_mariadb_driver

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

type mariaDBI18nEmptyRowsDriver struct{}

type mariaDBI18nEmptyRowsConn struct{}

type mariaDBI18nEmptyRowsStmt struct{}

type mariaDBI18nEmptyRowsRows struct{}

var registerMariaDBI18nEmptyRowsDriverOnce sync.Once

var rawMariaDBCreateStatementNotFoundText = string([]rune{0x672a, 0x627e, 0x5230, 0x5efa, 0x8868, 0x8bed, 0x53e5})
var rawMariaDBAllColumnsDatabaseRequiredText = string([]rune{0x83b7, 0x53d6, 0x5168, 0x90e8, 0x5217, 0x4fe1, 0x606f, 0x9700, 0x8981, 0x6307, 0x5b9a, 0x6570, 0x636e, 0x5e93, 0x540d, 0x79f0})

func (mariaDBI18nEmptyRowsDriver) Open(name string) (driver.Conn, error) {
	return mariaDBI18nEmptyRowsConn{}, nil
}

func (mariaDBI18nEmptyRowsConn) Prepare(query string) (driver.Stmt, error) {
	return mariaDBI18nEmptyRowsStmt{}, nil
}

func (mariaDBI18nEmptyRowsConn) Close() error { return nil }

func (mariaDBI18nEmptyRowsConn) Begin() (driver.Tx, error) {
	return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_not_open", nil)
}

func (mariaDBI18nEmptyRowsStmt) Close() error { return nil }

func (mariaDBI18nEmptyRowsStmt) NumInput() int { return -1 }

func (mariaDBI18nEmptyRowsStmt) Exec(args []driver.Value) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (mariaDBI18nEmptyRowsStmt) Query(args []driver.Value) (driver.Rows, error) {
	return mariaDBI18nEmptyRowsRows{}, nil
}

func (mariaDBI18nEmptyRowsRows) Columns() []string {
	return []string{"Create Table"}
}

func (mariaDBI18nEmptyRowsRows) Close() error { return nil }

func (mariaDBI18nEmptyRowsRows) Next(dest []driver.Value) error {
	return io.EOF
}

func openMariaDBI18nEmptyRowsDB(t *testing.T) *sql.DB {
	t.Helper()

	registerMariaDBI18nEmptyRowsDriverOnce.Do(func() {
		sql.Register("mariadb_i18n_empty_rows", mariaDBI18nEmptyRowsDriver{})
	})

	conn, err := sql.Open("mariadb_i18n_empty_rows", "")
	if err != nil {
		t.Fatalf("open mariadb_i18n_empty_rows test DB failed: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return conn
}

func TestMariaDBCreateStatementNotFoundUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	mariaDB := &MariaDB{conn: openMariaDBI18nEmptyRowsDB(t)}

	_, err := mariaDB.GetCreateStatement("app", "orders")
	if err == nil {
		t.Fatal("expected MariaDB GetCreateStatement to fail")
	}
	if err.Error() != "The CREATE TABLE statement was not found" {
		t.Fatalf("expected English create-statement error, got %q", err.Error())
	}
	if strings.Contains(err.Error(), rawMariaDBCreateStatementNotFoundText) {
		t.Fatalf("expected no raw Chinese create-statement text, got %q", err.Error())
	}
}


func TestMariaDBGetAllColumnsDatabaseRequiredUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	mariaDB := &MariaDB{}

	_, err := mariaDB.GetAllColumns("")
	if err == nil {
		t.Fatal("expected MariaDB GetAllColumns to fail")
	}
	if err.Error() != "Database name is required" {
		t.Fatalf("expected English database-name error, got %q", err.Error())
	}
	if strings.Contains(err.Error(), rawMariaDBAllColumnsDatabaseRequiredText) {
		t.Fatalf("expected no raw Chinese database-name text, got %q", err.Error())
	}
}

