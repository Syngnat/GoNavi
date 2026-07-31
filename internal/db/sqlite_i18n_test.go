//go:build gonavi_full_drivers || gonavi_sqlite_driver

package db

import (
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"sync"
	"testing"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

type sqliteI18nEmptyRowsDriver struct{}

type sqliteI18nEmptyRowsConn struct{}

type sqliteI18nEmptyRowsStmt struct{}

type sqliteI18nEmptyRowsRows struct{}

var registerSQLiteI18nEmptyRowsDriverOnce sync.Once

var (
	rawSQLiteCreateStatementNotFoundText = string([]rune{0x672a, 0x627e, 0x5230, 0x5efa, 0x8868, 0x8bed, 0x53e5})
	rawSQLiteTableNameRequiredText       = string([]rune{0x8868, 0x540d, 0x4e0d, 0x80fd, 0x4e3a, 0x7a7a})
	rawSQLiteFilePathRequiredText        = "SQLite " + string([]rune{0x9700, 0x8981, 0x672c, 0x5730, 0x6570, 0x636e, 0x5e93, 0x6587, 0x4ef6, 0x8def, 0x5f84})
	rawSQLiteHostAddressHintText         = string([]rune{0x5f53, 0x524d, 0x8f93, 0x5165, 0x770b, 0x8d77, 0x6765, 0x662f, 0x4e3b, 0x673a, 0x5730, 0x5740})
)

func (sqliteI18nEmptyRowsDriver) Open(name string) (driver.Conn, error) {
	return sqliteI18nEmptyRowsConn{}, nil
}

func (sqliteI18nEmptyRowsConn) Prepare(query string) (driver.Stmt, error) {
	return sqliteI18nEmptyRowsStmt{}, nil
}

func (sqliteI18nEmptyRowsConn) Close() error { return nil }

func (sqliteI18nEmptyRowsConn) Begin() (driver.Tx, error) {
	return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_not_open", nil)
}

func (sqliteI18nEmptyRowsStmt) Close() error { return nil }

func (sqliteI18nEmptyRowsStmt) NumInput() int { return -1 }

func (sqliteI18nEmptyRowsStmt) Exec(args []driver.Value) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (sqliteI18nEmptyRowsStmt) Query(args []driver.Value) (driver.Rows, error) {
	return sqliteI18nEmptyRowsRows{}, nil
}

func (sqliteI18nEmptyRowsRows) Columns() []string {
	return []string{"sql"}
}

func (sqliteI18nEmptyRowsRows) Close() error { return nil }

func (sqliteI18nEmptyRowsRows) Next(dest []driver.Value) error {
	return io.EOF
}

func openSQLiteI18nEmptyRowsDB(t *testing.T) *sql.DB {
	t.Helper()

	registerSQLiteI18nEmptyRowsDriverOnce.Do(func() {
		sql.Register("sqlite_i18n_empty_rows", sqliteI18nEmptyRowsDriver{})
	})

	conn, err := sql.Open("sqlite_i18n_empty_rows", "")
	if err != nil {
		t.Fatalf("open sqlite_i18n_empty_rows test DB failed: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return conn
}

func TestSQLiteMetadataErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	sqlite := &SQLiteDB{}
	tests := []struct {
		name       string
		call       func() error
		want       string
		unexpected string
	}{
		{
			name: "create statement not found",
			call: func() error {
				_, err := (&SQLiteDB{conn: openSQLiteI18nEmptyRowsDB(t)}).GetCreateStatement("main", "orders")
				return err
			},
			want:       "The CREATE TABLE statement was not found",
			unexpected: rawSQLiteCreateStatementNotFoundText,
		},
		{
			name: "columns table name required",
			call: func() error {
				_, err := sqlite.GetColumns("", " ")
				return err
			},
			want:       "Table name is required",
			unexpected: rawSQLiteTableNameRequiredText,
		},
		{
			name: "indexes table name required",
			call: func() error {
				_, err := sqlite.GetIndexes("", " ")
				return err
			},
			want:       "Table name is required",
			unexpected: rawSQLiteTableNameRequiredText,
		},
		{
			name: "foreign keys table name required",
			call: func() error {
				_, err := sqlite.GetForeignKeys("", " ")
				return err
			},
			want:       "Table name is required",
			unexpected: rawSQLiteTableNameRequiredText,
		},
		{
			name: "triggers table name required",
			call: func() error {
				_, err := sqlite.GetTriggers("", " ")
				return err
			},
			want:       "Table name is required",
			unexpected: rawSQLiteTableNameRequiredText,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatal("expected SQLite metadata call to fail")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), tc.unexpected) {
				t.Fatalf("expected no raw Chinese SQLite metadata text, got %q", err.Error())
			}
		})
	}
}

func TestSQLiteDSNValidationErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	tests := []struct {
		name       string
		config     connection.ConnectionConfig
		want       string
		unexpected string
	}{
		{
			name:       "empty path",
			config:     connection.ConnectionConfig{Type: "sqlite"},
			want:       "SQLite requires a local database file path (for example /path/to/demo.sqlite)",
			unexpected: rawSQLiteFilePathRequiredText,
		},
		{
			name:       "host port",
			config:     connection.ConnectionConfig{Type: "sqlite", Host: "localhost:3306"},
			want:       "SQLite requires a local database file path; the current input looks like a host address: localhost:3306",
			unexpected: rawSQLiteHostAddressHintText,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := (&SQLiteDB{}).Connect(tc.config)
			if err == nil {
				t.Fatal("expected SQLite DSN validation error")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), tc.unexpected) {
				t.Fatalf("expected no raw Chinese SQLite DSN validation text, got %q", err.Error())
			}
		})
	}
}



func TestSQLiteDSNValidationErrorCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.sqlite_file_path_required",
		"db.backend.error.sqlite_host_port_not_file_path",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing SQLite DSN validation key %q", language, key)
			}
		}
	}
}
