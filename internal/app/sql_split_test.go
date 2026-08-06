package app

import (
	"reflect"
	"testing"
)

func TestSplitSQLStatements_BasicSplit(t *testing.T) {
	input := "SELECT 1; SELECT 2; SELECT 3"
	got := splitSQLStatements(input)
	want := []string{"SELECT 1", "SELECT 2", "SELECT 3"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_QuotedSemicolon(t *testing.T) {
	input := `SELECT 'hello;world'; SELECT 2`
	got := splitSQLStatements(input)
	want := []string{`SELECT 'hello;world'`, "SELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_LineComment(t *testing.T) {
	input := "SELECT 1; -- this is a comment;\nSELECT 2"
	got := splitSQLStatements(input)
	want := []string{"SELECT 1", "-- this is a comment;\nSELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_DropsCommentOnlyTail(t *testing.T) {
	t.Parallel()

	statement := "DELETE FROM users WHERE id = 1"
	tests := []struct {
		name  string
		query string
	}{
		{name: "bare line comment marker", query: statement + ";--"},
		{name: "line comment", query: statement + "; -- keep this operation pending"},
		{name: "hash comment", query: statement + ";\n# keep this operation pending"},
		{name: "block comment", query: statement + ";\n/* keep this operation pending */"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitSQLStatementsForDialect("mysql", tt.query)
			want := []string{statement}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("splitSQLStatementsForDialect(mysql, %q) = %#v, want %#v", tt.query, got, want)
			}
		})
	}
}

func TestSplitSQLStatements_PreservesExecutableMySQLComment(t *testing.T) {
	t.Parallel()

	query := "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;"
	got := splitSQLStatementsForDialect("mysql", query)
	want := []string{"/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("splitSQLStatementsForDialect(mysql, %q) = %#v, want %#v", query, got, want)
	}
}

func TestSplitSQLStatements_UsesDialectSpecificExecutableCommentRules(t *testing.T) {
	t.Parallel()

	mysqlComment := "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;"
	mariaDBComment := "/*M!100100 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;"
	if got := splitSQLStatementsForDialect("postgres", mysqlComment); len(got) != 0 {
		t.Fatalf("expected PostgreSQL to drop MySQL-only executable comment, got %#v", got)
	}
	if got := splitSQLStatementsForDialect("mysql", mariaDBComment); len(got) != 0 {
		t.Fatalf("expected MySQL to drop MariaDB-only executable comment, got %#v", got)
	}
	want := []string{"/*M!100100 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */"}
	if got := splitSQLStatementsForDialect("mariadb", mariaDBComment); !reflect.DeepEqual(got, want) {
		t.Fatalf("expected MariaDB statements %#v, got %#v", want, got)
	}

	statement := "DELETE FROM users WHERE id = 1"
	want = []string{statement, "#comment"}
	if got := splitSQLStatementsForDialect("postgres", statement+"; #comment"); !reflect.DeepEqual(got, want) {
		t.Fatalf("expected PostgreSQL statements %#v, got %#v", want, got)
	}
}

func TestSplitSQLStatements_BlockComment(t *testing.T) {
	input := "SELECT /* ; */ 1; SELECT 2"
	got := splitSQLStatements(input)
	want := []string{"SELECT /* ; */ 1", "SELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_EmptyInput(t *testing.T) {
	got := splitSQLStatements("")
	if len(got) != 0 {
		t.Errorf("splitSQLStatements(\"\") = %v, want empty slice", got)
	}
}

func TestSplitSQLStatements_SingleStatement(t *testing.T) {
	input := "SELECT * FROM users WHERE id = 1"
	got := splitSQLStatements(input)
	want := []string{"SELECT * FROM users WHERE id = 1"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_DollarQuoting(t *testing.T) {
	input := "SELECT $tag$hello;world$tag$; SELECT 2"
	got := splitSQLStatements(input)
	want := []string{"SELECT $tag$hello;world$tag$", "SELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_PostgresCreateFunctionDollarQuoting(t *testing.T) {
	input := `CREATE OR REPLACE FUNCTION refresh_stats() RETURNS void AS $$
BEGIN
    PERFORM refresh_now();
END;
$$ LANGUAGE plpgsql;
SELECT 2;`
	got := splitSQLStatements(input)
	want := []string{
		`CREATE OR REPLACE FUNCTION refresh_stats() RETURNS void AS $$
BEGIN
    PERFORM refresh_now();
END;
$$ LANGUAGE plpgsql`,
		"SELECT 2",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_FullWidthSemicolon(t *testing.T) {
	input := "SELECT 1；SELECT 2"
	got := splitSQLStatements(input)
	want := []string{"SELECT 1", "SELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_Backtick(t *testing.T) {
	input := "SELECT `col;name` FROM t; SELECT 2"
	got := splitSQLStatements(input)
	want := []string{"SELECT `col;name` FROM t", "SELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_TrailingSemicolon(t *testing.T) {
	input := "SELECT 1; SELECT 2;"
	got := splitSQLStatements(input)
	want := []string{"SELECT 1", "SELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_SQLEscapedQuote(t *testing.T) {
	input := "SELECT 'it''s a test'; SELECT 2"
	got := splitSQLStatements(input)
	want := []string{"SELECT 'it''s a test'", "SELECT 2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_SQLEscapedQuoteMultiple(t *testing.T) {
	input := "INSERT INTO t VALUES ('O''Brien', 'it''s OK'); SELECT 1"
	got := splitSQLStatements(input)
	want := []string{"INSERT INTO t VALUES ('O''Brien', 'it''s OK')", "SELECT 1"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %v, want %v", input, got, want)
	}
}

func TestSplitSQLStatements_OracleAnonymousBlock(t *testing.T) {
	input := `BEGIN
    INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');
    UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';
    DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';
END;
SELECT 1 FROM dual;`
	got := splitSQLStatements(input)
	want := []string{
		`BEGIN
    INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');
    UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';
    DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';
END;`,
		"SELECT 1 FROM dual",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_OracleDeclareBlock(t *testing.T) {
	input := `DECLARE
    v_count NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM t_memcard_reg;
    UPDATE t_memcard_reg SET CARDLEVEL = v_count WHERE MEMCARDNO = '8032277312';
END;
SELECT 1 FROM dual;`
	got := splitSQLStatements(input)
	want := []string{
		`DECLARE
    v_count NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM t_memcard_reg;
    UPDATE t_memcard_reg SET CARDLEVEL = v_count WHERE MEMCARDNO = '8032277312';
END;`,
		"SELECT 1 FROM dual",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_OracleCreateProcedureBlock(t *testing.T) {
	input := `CREATE OR REPLACE PROCEDURE proc_tally2accept(
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
END;
SELECT 1 FROM dual;`
	got := splitSQLStatements(input)
	want := []string{
		`CREATE OR REPLACE PROCEDURE proc_tally2accept(
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
END;`,
		"SELECT 1 FROM dual",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_OracleCreateProcedureSkipsSqlPlusSlashDelimiter(t *testing.T) {
	input := `CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_new(
    p_sourceid IN VARCHAR2
) IS
    v_memcardno VARCHAR2(40);
    v_ecnt NUMBER;
    CURSOR cur_ware IS
        SELECT d.goodsid, d.goodsqty
        FROM t_order_d d
        WHERE d.sourceid = p_sourceid;
BEGIN
    FOR row_ware IN cur_ware LOOP
        v_ecnt := row_ware.goodsqty;
    END LOOP;
END;
/
SELECT 1 FROM dual;`
	got := splitSQLStatements(input)
	want := []string{
		`CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_new(
    p_sourceid IN VARCHAR2
) IS
    v_memcardno VARCHAR2(40);
    v_ecnt NUMBER;
    CURSOR cur_ware IS
        SELECT d.goodsid, d.goodsqty
        FROM t_order_d d
        WHERE d.sourceid = p_sourceid;
BEGIN
    FOR row_ware IN cur_ware LOOP
        v_ecnt := row_ware.goodsqty;
    END LOOP;
END;`,
		"SELECT 1 FROM dual",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_OracleCreateProcedureKeepsCursorCaseExpression(t *testing.T) {
	input := `CREATE OR REPLACE PROCEDURE proc_accept_to_add(
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
END;
/
SELECT 1 FROM dual;`
	got := splitSQLStatements(input)
	want := []string{
		`CREATE OR REPLACE PROCEDURE proc_accept_to_add(
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
END;`,
		"SELECT 1 FROM dual",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_OracleCreateProcedureSkipsCommentedSqlPlusSlashDelimiter(t *testing.T) {
	input := `-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1
-- 请确认语法兼容当前数据库后执行
CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(
    p_sourceid     IN VARCHAR2,
    p_saleno_out   OUT VARCHAR2,
    p_msg_out      OUT NVARCHAR2
) AS
    v_saleno VARCHAR2(40);
    v_ecnt NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_ecnt FROM dual;
    p_saleno_out := v_saleno;
    p_msg_out := 'OK';
EXCEPTION
    WHEN OTHERS THEN
        p_msg_out := SQLERRM;
END cproc_tzhssr_order2sale_A1;
/ -- SQLPlus delimiter from PL/SQL tools
SELECT 1 FROM dual;`
	got := splitSQLStatements(input)
	want := []string{
		`-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1
-- 请确认语法兼容当前数据库后执行
CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(
    p_sourceid     IN VARCHAR2,
    p_saleno_out   OUT VARCHAR2,
    p_msg_out      OUT NVARCHAR2
) AS
    v_saleno VARCHAR2(40);
    v_ecnt NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_ecnt FROM dual;
    p_saleno_out := v_saleno;
    p_msg_out := 'OK';
EXCEPTION
    WHEN OTHERS THEN
        p_msg_out := SQLERRM;
END cproc_tzhssr_order2sale_A1;`,
		"SELECT 1 FROM dual",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_OracleCreateProcedureSkipsSemicolonAfterSqlPlusSlashDelimiter(t *testing.T) {
	input := `-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1
-- 请确认语法兼容当前数据库后执行
CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(
    p_sourceid     IN VARCHAR2,
    p_msg_out      OUT NVARCHAR2
) AS
    v_ecnt NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_ecnt FROM dual;
    p_msg_out := '';
EXCEPTION
    WHEN OTHERS THEN
        p_msg_out := substr('订单核销失败，错误信息：' || SQLERRM || '，错误位置：' ||
                            dbms_utility.format_error_backtrace, 1, 1000);
END cproc_tzhssr_order2sale_A1;
/;
SELECT 1 FROM dual;`
	got := splitSQLStatements(input)
	want := []string{
		`-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1
-- 请确认语法兼容当前数据库后执行
CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(
    p_sourceid     IN VARCHAR2,
    p_msg_out      OUT NVARCHAR2
) AS
    v_ecnt NUMBER;
BEGIN
    SELECT COUNT(*) INTO v_ecnt FROM dual;
    p_msg_out := '';
EXCEPTION
    WHEN OTHERS THEN
        p_msg_out := substr('订单核销失败，错误信息：' || SQLERRM || '，错误位置：' ||
                            dbms_utility.format_error_backtrace, 1, 1000);
END cproc_tzhssr_order2sale_A1;`,
		"SELECT 1 FROM dual",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_OraclePackageSpecAndBodyStayWhole(t *testing.T) {
	input := `CREATE OR REPLACE PACKAGE pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER);
END pkg_order;
/
CREATE OR REPLACE PACKAGE BODY pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER) IS
    BEGIN
        NULL;
    END sync_order;
END pkg_order;
/ -- SQLPlus delimiter from PL/SQL tools
SELECT 1 FROM dual;`
	got := splitSQLStatements(input)
	want := []string{
		`CREATE OR REPLACE PACKAGE pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER);
END pkg_order;`,
		`CREATE OR REPLACE PACKAGE BODY pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER) IS
    BEGIN
        NULL;
    END sync_order;
END pkg_order;`,
		"SELECT 1 FROM dual",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_DoesNotTreatSlashOperatorLineAsDelimiter(t *testing.T) {
	input := "SELECT 10\n/\n2 FROM dual;"
	got := splitSQLStatements(input)
	want := []string{"SELECT 10\n/\n2 FROM dual"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatements_TransactionBeginStillSplits(t *testing.T) {
	input := "BEGIN; UPDATE accounts SET balance = balance - 1 WHERE id = 1; COMMIT;"
	got := splitSQLStatements(input)
	want := []string{
		"BEGIN",
		"UPDATE accounts SET balance = balance - 1 WHERE id = 1",
		"COMMIT",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitSQLStatements(%q) = %#v, want %#v", input, got, want)
	}
}

func TestSplitSQLStatementsForDialect_ElasticsearchPreservesConsoleBatch(t *testing.T) {
	batch := "GET /events/_search\r\n{\"query\":{\"match_all\":{}}}\r\n\r\nPOST /events/_count\r\n{\"query\":{\"term\":{\"level\":\"error\"}}}"
	want := []string{"GET /events/_search\n{\"query\":{\"match_all\":{}}}\n\nPOST /events/_count\n{\"query\":{\"term\":{\"level\":\"error\"}}}"}
	if got := splitSQLStatementsForDialect("elasticsearch", batch); !reflect.DeepEqual(got, want) {
		t.Fatalf("splitSQLStatementsForDialect(elasticsearch) = %#v, want %#v", got, want)
	}
}
