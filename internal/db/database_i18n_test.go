package db

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"

	"GoNavi-Wails/shared/i18n"
)

type fakeRowsAffectedResult struct {
	affected int64
	err      error
}

const (
	rawTransactionAlreadyFinishedText = "\u4e8b\u52a1\u5df2\u7ed3\u675f"
	rawTransactionNotOpenText         = "\u4e8b\u52a1\u672a\u6253\u5f00"
)

func (r fakeRowsAffectedResult) LastInsertId() (int64, error) {
	return 0, nil
}

func (r fakeRowsAffectedResult) RowsAffected() (int64, error) {
	if r.err != nil {
		return 0, r.err
	}
	return r.affected, nil
}

func databaseFunctionSource(t *testing.T, source string, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("database.go missing function signature %q", signature)
	}
	rest := source[start+len(signature):]
	end := strings.Index(rest, "\nfunc ")
	if end < 0 {
		return source[start:]
	}
	return source[start : start+len(signature)+end]
}

func TestRequireSingleRowAffectedUsesLocalizedText(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cases := []struct {
		name   string
		result fakeRowsAffectedResult
		action rowMutationAction
		want   string
	}{
		{
			name:   "delete rows affected unavailable",
			result: fakeRowsAffectedResult{err: errors.New("rows affected unsupported")},
			action: rowMutationActionDelete,
			want:   "Delete did not take effect: could not determine affected rows: rows affected unsupported",
		},
		{
			name:   "delete no rows matched",
			result: fakeRowsAffectedResult{affected: 0},
			action: rowMutationActionDelete,
			want:   "Delete did not take effect: no rows matched",
		},
		{
			name:   "update multiple rows affected",
			result: fakeRowsAffectedResult{affected: 2},
			action: rowMutationActionUpdate,
			want:   "Update did not take effect: affected 2 rows; expected exactly 1",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := requireSingleRowAffected(tc.result, tc.action)
			if err == nil {
				t.Fatal("expected row affected validation error")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, err.Error())
			}
		})
	}
}


func TestDatabaseRowAffectedCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.action.delete",
		"db.backend.action.update",
		"db.backend.error.row_action_not_effective_rows_affected_unknown",
		"db.backend.error.row_action_not_effective_no_rows_matched",
		"db.backend.error.row_action_not_effective_multiple_rows",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing database row-affected key %q", language, key)
			}
		}
	}
}

func TestSQLConnStatementExecerUsesCurrentLanguageForConnectionNotOpen(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	execer := &sqlConnStatementExecer{}
	cases := []struct {
		name string
		call func() error
	}{
		{
			name: "exec",
			call: func() error {
				_, err := execer.ExecContext(context.Background(), "SELECT 1")
				return err
			},
		},
		{
			name: "query",
			call: func() error {
				_, _, err := execer.QueryContext(context.Background(), "SELECT 1")
				return err
			},
		},
		{
			name: "query_multi",
			call: func() error {
				_, err := execer.QueryMultiContext(context.Background(), "SELECT 1")
				return err
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatal("expected connection-not-open error")
			}
			if err.Error() != "Connection is not open" {
				t.Fatalf("expected English connection-not-open error, got %q", err.Error())
			}
			if strings.Contains(err.Error(), "连接未打开") {
				t.Fatalf("expected no Chinese connection-not-open text, got %q", err.Error())
			}
		})
	}
}

func TestSQLConnTransactionExecerUsesCurrentLanguageForConnectionNotOpen(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	execer := &sqlConnTransactionExecer{}
	_, err := execer.activeConn()
	if err == nil {
		t.Fatal("expected connection-not-open error")
	}
	if err.Error() != "Connection is not open" {
		t.Fatalf("expected English connection-not-open error, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("expected no Chinese connection-not-open text, got %q", err.Error())
	}
}


func TestDatabaseConnectionNotOpenCatalogKeyExists(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		if strings.TrimSpace(catalog["db.backend.error.connection_not_open"]) == "" {
			t.Fatalf("%s catalog missing database connection-not-open key", language)
		}
	}
}

func TestWrapDatabaseConnectionErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	baseErr := errors.New("driver unavailable")

	cases := []struct {
		name string
		call func(error) error
		want string
	}{
		{
			name: "open",
			call: wrapDatabaseConnectionOpenError,
			want: "Failed to open database connection: driver unavailable",
		},
		{
			name: "verify",
			call: wrapDatabaseConnectionVerifyError,
			want: "Failed to verify the established connection: driver unavailable",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call(baseErr)
			if err == nil {
				t.Fatal("expected wrapped database connection error")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, err.Error())
			}
			if !errors.Is(err, baseErr) {
				t.Fatal("expected wrapped error to preserve cause")
			}
			if strings.Contains(err.Error(), "打开数据库连接失败") || strings.Contains(err.Error(), "连接建立后验证失败") {
				t.Fatalf("expected no raw Chinese connection wrapper text, got %q", err.Error())
			}
		})
	}
}


func TestDatabaseConnectionWrapperSourcesUseI18nHelpers(t *testing.T) {
	type sourceCheck struct {
		path          string
		requiredTexts []string
	}

	checks := []sourceCheck{
		{
			path: "custom_impl.go",
			requiredTexts: []string{
				"wrapDatabaseConnectionOpenError(err)",
				"wrapDatabaseConnectionVerifyError(err)",
			},
		},
		{
			path: "mariadb_impl.go",
			requiredTexts: []string{
				"wrapDatabaseConnectionOpenError(err)",
				"wrapDatabaseConnectionVerifyError(err)",
			},
		},
		{
			path: "sqlite_impl.go",
			requiredTexts: []string{
				"wrapDatabaseConnectionOpenError(err)",
				"wrapDatabaseConnectionVerifyError(err)",
			},
		},
		{
			path: "sqlserver_impl.go",
			requiredTexts: []string{
				"wrapDatabaseConnectionOpenError(err)",
				"wrapDatabaseConnectionVerifyError(err)",
			},
		},
		{
			path: "iris_impl.go",
			requiredTexts: []string{
				"wrapDatabaseConnectionOpenError(err)",
				"wrapDatabaseConnectionVerifyError(err)",
			},
		},
	}

	for _, check := range checks {
		sourceBytes, err := os.ReadFile(check.path)
		if err != nil {
			t.Fatalf("read %s: %v", check.path, err)
		}
		source := string(sourceBytes)
		if strings.Contains(source, `fmt.Errorf("打开数据库连接失败：%w", err)`) {
			t.Fatalf("%s still contains raw open-connection wrapper", check.path)
		}
		if strings.Contains(source, `fmt.Errorf("连接建立后验证失败：%w", err)`) {
			t.Fatalf("%s still contains raw verify-connection wrapper", check.path)
		}
		for _, required := range check.requiredTexts {
			if !strings.Contains(source, required) {
				t.Fatalf("%s does not reference i18n helper %q", check.path, required)
			}
		}
	}
}

func TestDatabaseConnectionWrapperCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.connection_open_failed_prefix",
		"db.backend.error.connection_verify_failed_prefix",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing database connection wrapper key %q", language, key)
			}
		}
	}
}

func TestFormatCustomDriverOpenErrorUsesCurrentLanguageForUnknownDrivers(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cases := []struct {
		name   string
		driver string
		base   error
		want   string
	}{
		{
			name:   "system odbc driver",
			driver: "InterSystems IRIS ODBC35",
			base:   errors.New(`sql: unknown driver "InterSystems IRIS ODBC35" (forgotten import?)`),
			want:   `Failed to open database connection: custom connections do not support entering the system ODBC/JDBC driver name "InterSystems IRIS ODBC35" directly. Enter a Go database/sql driver name already registered by GoNavi. The current build does not register a generic ODBC driver, so connecting to InterSystems IRIS through "InterSystems IRIS ODBC35" is not supported yet: sql: unknown driver "InterSystems IRIS ODBC35" (forgotten import?)`,
		},
		{
			name:   "unregistered go driver",
			driver: "not-a-registered-go-driver",
			base:   errors.New(`sql: unknown driver "not-a-registered-go-driver" (forgotten import?)`),
			want:   `Failed to open database connection: the custom connection driver "not-a-registered-go-driver" is not registered in GoNavi. Enter a registered Go database/sql driver name instead of a system ODBC/JDBC driver name: sql: unknown driver "not-a-registered-go-driver" (forgotten import?)`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := formatCustomDriverOpenError(tc.driver, tc.base)
			if err == nil {
				t.Fatal("expected wrapped custom driver open error")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, err.Error())
			}
			if !errors.Is(err, tc.base) {
				t.Fatal("expected wrapped custom driver error to preserve cause")
			}
			if strings.Contains(err.Error(), "自定义连接") || strings.Contains(err.Error(), "未注册通用 ODBC 驱动") {
				t.Fatalf("expected no raw Chinese custom driver guidance, got %q", err.Error())
			}
		})
	}
}


func TestCustomDriverOpenErrorCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.custom_driver_system_odbc_unsupported_prefix",
		"db.backend.error.custom_driver_unregistered_prefix",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing custom driver open error key %q", language, key)
			}
		}
	}
}

func TestNewDatabaseUnsupportedTypeUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	dbType := "mystery-driver"
	_, err := NewDatabase(dbType)
	if err == nil {
		t.Fatal("expected unsupported database type error")
	}

	want := "Unsupported database type: mystery-driver"
	if err.Error() != want {
		t.Fatalf("expected localized unsupported database type error %q, got %q", want, err.Error())
	}
	rawUnsupportedDatabaseTypeText := "\u4e0d\u652f\u6301\u7684\u6570\u636e\u5e93\u7c7b\u578b"
	if strings.Contains(err.Error(), rawUnsupportedDatabaseTypeText) {
		t.Fatalf("expected no Chinese unsupported database type text, got %q", err.Error())
	}
}


func TestNewDatabaseUnsupportedTypeCatalogKeyExists(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		if strings.TrimSpace(catalog["db.backend.error.unsupported_database_type"]) == "" {
			t.Fatalf("%s catalog missing unsupported database type key", language)
		}
	}
}

func TestTransactionExecerStateErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	cases := []struct {
		name       string
		call       func() error
		want       string
		unexpected string
	}{
		{
			name: "sql conn transaction already finished",
			call: func() error {
				_, err := (&sqlConnTransactionExecer{
					conn: new(sql.Conn),
					done: true,
				}).activeConn()
				return err
			},
			want:       "Transaction has already finished",
			unexpected: rawTransactionAlreadyFinishedText,
		},
		{
			name: "sql tx transaction not open",
			call: func() error {
				_, err := (&sqlTxStatementExecer{}).activeTx()
				return err
			},
			want:       "Transaction is not open",
			unexpected: rawTransactionNotOpenText,
		},
		{
			name: "sql tx transaction already finished",
			call: func() error {
				_, err := (&sqlTxStatementExecer{
					tx:   new(sql.Tx),
					done: true,
				}).activeTx()
				return err
			},
			want:       "Transaction has already finished",
			unexpected: rawTransactionAlreadyFinishedText,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil {
				t.Fatal("expected localized transaction state error")
			}
			if err.Error() != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, err.Error())
			}
			if strings.Contains(err.Error(), tc.unexpected) {
				t.Fatalf("expected no raw Chinese transaction state text, got %q", err.Error())
			}
		})
	}
}


func TestDatabaseTransactionStateCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"db.backend.error.transaction_not_open",
		"db.backend.error.transaction_already_finished",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing database transaction state key %q", language, key)
			}
		}
	}
}
