package db

import (
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

type oracleI18nQueryErrorDriver struct{}

type oracleI18nQueryErrorConn struct{}

type oracleI18nEmptyRowsDriver struct{}

type oracleI18nEmptyRowsConn struct{}

type oracleI18nEmptyRowsRows struct{}

var registerOracleI18nQueryErrorDriverOnce sync.Once

var registerOracleI18nEmptyRowsDriverOnce sync.Once

var rawOracleCreateStatementNotFoundText = string([]rune{0x672a, 0x627e, 0x5230, 0x5efa, 0x8868, 0x8bed, 0x53e5})

func (oracleI18nQueryErrorDriver) Open(name string) (driver.Conn, error) {
	return oracleI18nQueryErrorConn{}, nil
}

func (oracleI18nQueryErrorConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not supported in oracle i18n query error test driver")
}

func (oracleI18nQueryErrorConn) Close() error { return nil }

func (oracleI18nQueryErrorConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported in oracle i18n query error test driver")
}

func (oracleI18nQueryErrorConn) Query(query string, args []driver.Value) (driver.Rows, error) {
	return nil, errors.New("oracle metadata probe failed")
}

func (oracleI18nEmptyRowsDriver) Open(name string) (driver.Conn, error) {
	return oracleI18nEmptyRowsConn{}, nil
}

func (oracleI18nEmptyRowsConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not supported in oracle i18n empty rows test driver")
}

func (oracleI18nEmptyRowsConn) Close() error { return nil }

func (oracleI18nEmptyRowsConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported in oracle i18n empty rows test driver")
}

func (oracleI18nEmptyRowsConn) Query(query string, args []driver.Value) (driver.Rows, error) {
	return oracleI18nEmptyRowsRows{}, nil
}

func (oracleI18nEmptyRowsRows) Columns() []string {
	return []string{"DDL"}
}

func (oracleI18nEmptyRowsRows) Close() error { return nil }

func (oracleI18nEmptyRowsRows) Next(dest []driver.Value) error {
	return io.EOF
}

func openOracleI18nQueryErrorDB(t *testing.T) *sql.DB {
	t.Helper()

	registerOracleI18nQueryErrorDriverOnce.Do(func() {
		sql.Register("oracle_i18n_query_error", oracleI18nQueryErrorDriver{})
	})

	conn, err := sql.Open("oracle_i18n_query_error", "")
	if err != nil {
		t.Fatalf("open oracle_i18n_query_error test DB failed: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return conn
}

func openOracleI18nEmptyRowsDB(t *testing.T) *sql.DB {
	t.Helper()

	registerOracleI18nEmptyRowsDriverOnce.Do(func() {
		sql.Register("oracle_i18n_empty_rows", oracleI18nEmptyRowsDriver{})
	})

	conn, err := sql.Open("oracle_i18n_empty_rows", "")
	if err != nil {
		t.Fatalf("open oracle_i18n_empty_rows test DB failed: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return conn
}

func oracleFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("oracle_impl.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

func TestOracleCreateStatementNotFoundUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	oracleDB := &OracleDB{conn: openOracleI18nEmptyRowsDB(t)}

	_, err := oracleDB.GetCreateStatement("APP", "ORDERS")
	if err == nil {
		t.Fatal("expected Oracle GetCreateStatement to fail")
	}
	if err.Error() != "The CREATE TABLE statement was not found" {
		t.Fatalf("expected English create-statement error, got %q", err.Error())
	}
	if strings.Contains(err.Error(), rawOracleCreateStatementNotFoundText) {
		t.Fatalf("expected no raw Chinese create-statement text, got %q", err.Error())
	}
}

func TestOracleMetadataErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	t.Run("indexes table name required", func(t *testing.T) {
		_, err := (&OracleDB{}).GetIndexes("", " ")
		if err == nil {
			t.Fatal("expected Oracle GetIndexes to reject an empty table name")
		}
		if err.Error() != "Table name is required" {
			t.Fatalf("expected English table-name-required error, got %q", err.Error())
		}
	})

	t.Run("apply changes wraps oracle column metadata load failure", func(t *testing.T) {
		oracleDB := &OracleDB{conn: openOracleI18nQueryErrorDB(t)}

		err := oracleDB.ApplyChanges("APP.USERS", connection.ChangeSet{})
		if err == nil {
			t.Fatal("expected Oracle ApplyChanges to surface column metadata load failure")
		}

		want := "Failed to load column metadata (table=APP.USERS): oracle metadata probe failed; check ALL_TAB_COLUMNS query permission and whether the table exists"
		if err.Error() != want {
			t.Fatalf("expected English Oracle column-metadata error %q, got %q", want, err.Error())
		}
		if strings.Contains(err.Error(), "加载列元数据失败") {
			t.Fatalf("expected no legacy Chinese Oracle column-metadata prefix in en-US mode, got %q", err.Error())
		}
	})
}


func TestOracleMetadataCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.create_table_statement_not_found",
		"db.backend.error.table_name_required",
		"db.backend.error.oracle_column_metadata_load_failed",
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing Oracle metadata key %q", language, key)
			}
		}
	}
}
