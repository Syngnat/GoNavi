package app

import (
	"reflect"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestDBQueryMultiKeepsOracleAnonymousBlockAsSingleStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `BEGIN
    INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');
    UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';
    DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';
END;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-plsql-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected PL/SQL block to skip batch path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != query {
		t.Fatalf("expected PL/SQL block to stay intact, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiExecutesOracleCompileStatementWithoutTrailingDelimiter(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}

	result := app.DBQueryMulti(config, "ORCLPDB1", `ALTER PROCEDURE "APP"."P_REBUILD" COMPILE;`, "oracle-compile-test")
	if !result.Success {
		t.Fatalf("expected Oracle compile statement success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected Oracle DDL to use the direct execution path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one Oracle compile exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if got, want := fakeDB.execQueries[0], `ALTER PROCEDURE "APP"."P_REBUILD" COMPILE`; got != want {
		t.Fatalf("expected trailing delimiter to be removed before Oracle compile execution, got %q", got)
	}
}

func TestDBQueryMultiKeepsOracleCreateProcedureAsSingleStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PROCEDURE proc_tally2accept(
    p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE,
    out_acceptno OUT t_accept_h.acceptno%TYPE
) IS
    v_busno t_tally_accept_h.busno%TYPE;
    v_count PLS_INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;
    IF v_count > 0 THEN
        out_acceptno := p_tallyacceptno;
    END IF;
END;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-create-procedure-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected CREATE PROCEDURE to skip batch path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != query {
		t.Fatalf("expected CREATE PROCEDURE to stay intact, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiKeepsOracleCreateProcedureCursorCaseExpressionAsSingleStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PROCEDURE proc_accept_to_add(
    p_acceptno IN t_accept_h.acceptno%TYPE
) IS
    CURSOR cur_store_same(p_ind s_sys_ini.inipara%TYPE) IS
        SELECT si.compid, si.batid, si.wareid
        FROM   t_store_i si
        ORDER  BY CASE
                      WHEN p_ind = '1' THEN
                       to_char(si.invalidate - to_date('19700101', 'yyyymmdd'))
                      WHEN p_ind = '2' THEN
                       lpad(to_char(floor(si.wareqty)), 10, '0')
                      ELSE
                       to_char(si.batid)
                  END,si.batid;
BEGIN
    NULL;
END;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-create-procedure-cursor-case-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected CREATE PROCEDURE to skip batch path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != query {
		t.Fatalf("expected CREATE PROCEDURE to stay intact, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiSkipsOracleSqlPlusSlashDelimiter(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PROCEDURE proc_tally2accept(
    p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE
) IS
    v_count PLS_INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;
END;
/`
	wantExecuted := `CREATE OR REPLACE PROCEDURE proc_tally2accept(
    p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE
) IS
    v_count PLS_INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;
END;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-sqlplus-slash-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != wantExecuted {
		t.Fatalf("expected slash delimiter to be skipped, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiSkipsOracleSqlPlusSlashDelimiterWithSemicolon(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(
    p_msg_out OUT NVARCHAR2
) AS
BEGIN
    p_msg_out := '';
EXCEPTION
    WHEN OTHERS THEN
        p_msg_out := SQLERRM;
END cproc_tzhssr_order2sale_A1;
/;`
	wantExecuted := `CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(
    p_msg_out OUT NVARCHAR2
) AS
BEGIN
    p_msg_out := '';
EXCEPTION
    WHEN OTHERS THEN
        p_msg_out := SQLERRM;
END cproc_tzhssr_order2sale_A1;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-sqlplus-slash-semicolon-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != wantExecuted {
		t.Fatalf("expected slash delimiter with semicolon to be skipped, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiKeepsOraclePackageSpecAndBodyTogether(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PACKAGE pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER);
END pkg_order;
/
CREATE OR REPLACE PACKAGE BODY pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER) IS
    BEGIN
        NULL;
    END sync_order;
END pkg_order;
/ -- SQLPlus delimiter from PL/SQL tools`
	wantExecuted := []string{
		`CREATE OR REPLACE PACKAGE pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER);
END pkg_order;`,
		`CREATE OR REPLACE PACKAGE BODY pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER) IS
    BEGIN
        NULL;
    END sync_order;
END pkg_order;`,
	}

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-package-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.execCalls != 2 || len(fakeDB.execQueries) != 2 {
		t.Fatalf("expected two sequential exec calls, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if !reflect.DeepEqual(fakeDB.execQueries, wantExecuted) {
		t.Fatalf("expected package spec/body to stay intact, got %#v", fakeDB.execQueries)
	}
}
