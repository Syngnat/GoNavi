package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestExecuteSQLFileStreamStopsAfterSingleStatementError(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "CREATE TABLE broken"}
	input := strings.Join([]string{
		"CREATE TABLE broken(id INT);",
		"INSERT INTO demo(id) VALUES (2);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("expected stop-on-error sentinel, got %v", err)
	}
	if result.Executed != 0 || result.Failed != 1 {
		t.Fatalf("expected the first failed statement to stop execution, got %#v", result)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected no later write batch, got %d batch calls", fakeDB.batchCalls)
	}
	if len(fakeDB.execQueries) != 1 || fakeDB.execQueries[0] != "CREATE TABLE broken(id INT)" {
		t.Fatalf("expected only the failing statement to run, got %#v", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamCapsRetainedErrorDetailsInContinueMode(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "CREATE TABLE broken_"}
	statements := make([]string, 25)
	for index := range statements {
		statements[index] = fmt.Sprintf("CREATE TABLE broken_%d(id INT);", index)
	}

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(strings.Join(statements, "\n")), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: true,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 0 || result.Failed != 25 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if len(result.Errors) != sqlFileMaxErrorDetails {
		t.Fatalf("retained %d error details, want cap %d", len(result.Errors), sqlFileMaxErrorDetails)
	}
}

func TestExecuteSQLFileStreamDoesNotRetryFailedOversizedStatement(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failBatch: true}
	largeValue := strings.Repeat("x", 256)
	input := fmt.Sprintf("INSERT INTO demo(value) VALUES ('%s');", largeValue)

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "postgres",
		BatchMaxStatements: 100,
		BatchMaxBytes:      64,
		ContinueOnError:    true,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 0 || result.Failed != 1 {
		t.Fatalf("expected the oversized statement failure to be recorded once, got %#v", result)
	}
	if fakeDB.batchCalls != 1 {
		t.Fatalf("expected one oversized statement attempt, got %d", fakeDB.batchCalls)
	}
	if len(fakeDB.execQueries) != 2 || fakeDB.execQueries[0] != "BEGIN" || fakeDB.execQueries[1] != "ROLLBACK" {
		t.Fatalf("expected no second execution of the oversized statement, got %#v", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamUsesLocalizedStatementFailure(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failBatch: true, failExecSQL: "VALUES (2)"}
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "mysql",
		BatchMaxStatements: 100,
		BatchMaxBytes:      1024,
		ContinueOnError:    true,
		Text: func(key string, params map[string]any) string {
			if key != "file.backend.message.statement_failed" {
				t.Fatalf("unexpected i18n key %q", key)
			}
			return fmt.Sprintf("localized statement %v failed: %v SQL=%v", params["index"], params["detail"], params["sql"])
		},
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if len(result.Errors) != 1 {
		t.Fatalf("expected one localized statement error, got %#v", result.Errors)
	}
	if !strings.Contains(result.Errors[0], "localized statement 2 failed") || !strings.Contains(result.Errors[0], "VALUES (?)") {
		t.Fatalf("expected localized per-statement error with redacted SQL snippet, got %#v", result.Errors)
	}
	if strings.Contains(result.Errors[0], "VALUES (2)") {
		t.Fatalf("expected statement failure to omit SQL literal values, got %#v", result.Errors)
	}
}

func TestExecuteSQLFileStreamDoesNotBatchSessionControlStatements(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"SET FOREIGN_KEY_CHECKS=0;",
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
		"CREATE TABLE demo2(id INT);",
		"INSERT INTO demo2(id) VALUES (3);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "mysql",
		BatchMaxStatements: 100,
		BatchMaxBytes:      1024,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 5 || result.Failed != 0 {
		t.Fatalf("expected 5 executed and 0 failed, got %#v", result)
	}
	if fakeDB.batchCalls != 2 {
		t.Fatalf("expected two DML batch calls split by control/DDL statements, got %d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 6 {
		t.Fatalf("expected SET, CREATE, and transaction wrappers to execute sequentially, got %d", fakeDB.execCalls)
	}
	if fakeDB.execQueries[0] != "SET FOREIGN_KEY_CHECKS=0" || fakeDB.execQueries[3] != "CREATE TABLE demo2(id INT)" {
		t.Fatalf("unexpected sequential statements: %#v", fakeDB.execQueries)
	}
}

type chunkedReader struct {
	data []byte
	step int
}

func (r *chunkedReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := r.step
	if n <= 0 || n > len(r.data) {
		n = len(r.data)
	}
	if n > len(p) {
		n = len(p)
	}
	copy(p, r.data[:n])
	r.data = r.data[n:]
	return n, nil
}

func TestStreamSQLFileHandlesLongSingleLineAcrossChunks(t *testing.T) {
	longValue := strings.Repeat("x", 5*1024*1024)
	input := fmt.Sprintf("INSERT INTO demo(value) VALUES ('%s');SELECT 1;", longValue)
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 257}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%d", count, len(statements))
	}
	if !strings.HasPrefix(statements[0], "INSERT INTO demo(value)") {
		t.Fatalf("expected first statement to be insert, got %.80q", statements[0])
	}
	if statements[1] != "SELECT 1" {
		t.Fatalf("expected second statement SELECT 1, got %q", statements[1])
	}
}

func TestStreamSQLFileHandlesSplitTokenBoundaries(t *testing.T) {
	input := strings.Join([]string{
		"SELECT 1 -- comment; still comment",
		"SELECT 'it''s ok';",
		"SELECT $tag$hello;world$tag$;",
		"SELECT 2；",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 1}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 3 || len(statements) != 3 {
		t.Fatalf("expected 3 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != "SELECT 1 -- comment; still comment\nSELECT 'it''s ok'" {
		t.Fatalf("unexpected first statement: %q", statements[0])
	}
	if statements[1] != "SELECT $tag$hello;world$tag$" {
		t.Fatalf("unexpected dollar-quoted statement: %q", statements[1])
	}
	if statements[2] != "SELECT 2" {
		t.Fatalf("unexpected full-width semicolon statement: %q", statements[2])
	}
}

func TestStreamSQLFileKeepsOracleAnonymousBlockTogether(t *testing.T) {
	input := strings.Join([]string{
		"BEGIN",
		"  INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');",
		"  UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';",
		"  DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';",
		"END;",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 3}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"BEGIN",
		"  INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');",
		"  UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';",
		"  DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';",
		"END;",
	}, "\n") {
		t.Fatalf("unexpected anonymous block statement: %q", statements[0])
	}
	if statements[1] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected second statement: %q", statements[1])
	}
}

func TestStreamSQLFileKeepsOracleCreateProcedureTogether(t *testing.T) {
	input := strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_tally2accept(",
		"  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE,",
		"  out_acceptno OUT t_accept_h.acceptno%TYPE",
		") IS",
		"  v_busno t_tally_accept_h.busno%TYPE;",
		"  v_count PLS_INTEGER;",
		"BEGIN",
		"  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
		"  IF v_count > 0 THEN",
		"    out_acceptno := p_tallyacceptno;",
		"  END IF;",
		"END;",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 5}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_tally2accept(",
		"  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE,",
		"  out_acceptno OUT t_accept_h.acceptno%TYPE",
		") IS",
		"  v_busno t_tally_accept_h.busno%TYPE;",
		"  v_count PLS_INTEGER;",
		"BEGIN",
		"  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
		"  IF v_count > 0 THEN",
		"    out_acceptno := p_tallyacceptno;",
		"  END IF;",
		"END;",
	}, "\n") {
		t.Fatalf("unexpected create procedure statement: %q", statements[0])
	}
	if statements[1] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected second statement: %q", statements[1])
	}
}

func TestStreamSQLFileKeepsOracleCreateProcedureCursorCaseExpressionTogether(t *testing.T) {
	input := strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_accept_to_add(",
		"  p_acceptno IN t_accept_h.acceptno%TYPE",
		") IS",
		"  CURSOR cur_store_same(p_ind s_sys_ini.inipara%TYPE) IS",
		"    SELECT si.compid, si.batid, si.wareid",
		"    FROM t_store_i si",
		"    ORDER BY CASE",
		"      WHEN p_ind = '1' THEN",
		"        to_char(si.invalidate - to_date('19700101', 'yyyymmdd'))",
		"      WHEN p_ind = '2' THEN",
		"        lpad(to_char(floor(si.wareqty)), 10, '0')",
		"      ELSE",
		"        to_char(si.batid)",
		"    END,si.batid;",
		"BEGIN",
		"  NULL;",
		"END;",
		"/",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 4}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_accept_to_add(",
		"  p_acceptno IN t_accept_h.acceptno%TYPE",
		") IS",
		"  CURSOR cur_store_same(p_ind s_sys_ini.inipara%TYPE) IS",
		"    SELECT si.compid, si.batid, si.wareid",
		"    FROM t_store_i si",
		"    ORDER BY CASE",
		"      WHEN p_ind = '1' THEN",
		"        to_char(si.invalidate - to_date('19700101', 'yyyymmdd'))",
		"      WHEN p_ind = '2' THEN",
		"        lpad(to_char(floor(si.wareqty)), 10, '0')",
		"      ELSE",
		"        to_char(si.batid)",
		"    END,si.batid;",
		"BEGIN",
		"  NULL;",
		"END;",
	}, "\n") {
		t.Fatalf("unexpected create procedure statement: %q", statements[0])
	}
	if statements[1] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected second statement: %q", statements[1])
	}
}

func TestStreamSQLFileSkipsOracleSqlPlusSlashDelimiter(t *testing.T) {
	input := strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_tally2accept(",
		"  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE",
		") IS",
		"  v_count PLS_INTEGER;",
		"BEGIN",
		"  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
		"END;",
		"/",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 2}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_tally2accept(",
		"  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE",
		") IS",
		"  v_count PLS_INTEGER;",
		"BEGIN",
		"  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
		"END;",
	}, "\n") {
		t.Fatalf("unexpected create procedure statement: %q", statements[0])
	}
	if statements[1] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected second statement: %q", statements[1])
	}
}

func TestStreamSQLFileKeepsOraclePackageSpecAndBodyTogether(t *testing.T) {
	input := strings.Join([]string{
		"CREATE OR REPLACE PACKAGE pkg_order AS",
		"  PROCEDURE sync_order(p_id IN NUMBER);",
		"END pkg_order;",
		"/",
		"CREATE OR REPLACE PACKAGE BODY pkg_order AS",
		"  PROCEDURE sync_order(p_id IN NUMBER) IS",
		"  BEGIN",
		"    NULL;",
		"  END sync_order;",
		"END pkg_order;",
		"/ -- SQLPlus delimiter from PL/SQL tools",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 3}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 3 || len(statements) != 3 {
		t.Fatalf("expected 3 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"CREATE OR REPLACE PACKAGE pkg_order AS",
		"  PROCEDURE sync_order(p_id IN NUMBER);",
		"END pkg_order;",
	}, "\n") {
		t.Fatalf("unexpected package spec statement: %q", statements[0])
	}
	if statements[1] != strings.Join([]string{
		"CREATE OR REPLACE PACKAGE BODY pkg_order AS",
		"  PROCEDURE sync_order(p_id IN NUMBER) IS",
		"  BEGIN",
		"    NULL;",
		"  END sync_order;",
		"END pkg_order;",
	}, "\n") {
		t.Fatalf("unexpected package body statement: %q", statements[1])
	}
	if statements[2] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected third statement: %q", statements[2])
	}
}
