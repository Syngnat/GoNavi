import { describe, expect, it } from 'vitest';

import { findSqlStatementRanges, resolveCurrentSqlStatementRange, resolveExecutableSql, stripLeadingSqlTrivia } from './sqlStatementSelection';

describe('sqlStatementSelection', () => {
  it('resolves the statement containing the cursor', () => {
    const sql = 'select 1;\n\nselect 2 from users;\nselect 3';

    expect(resolveCurrentSqlStatementRange(sql, sql.indexOf('1'))?.text).toBe('select 1');
    expect(resolveCurrentSqlStatementRange(sql, sql.indexOf('users'))?.text).toBe('select 2 from users');
    expect(resolveCurrentSqlStatementRange(sql, sql.indexOf('3'))?.text).toBe('select 3');
  });

  it('ignores semicolons inside strings and comments', () => {
    const sql = [
      "select ';' as semi;",
      "-- comment ;",
      "select 'a; b' as text;",
      "select $$a; b$$ as body;",
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toEqual([
      "select ';' as semi",
      "-- comment ;\nselect 'a; b' as text",
      "select $$a; b$$ as body",
    ]);
  });

  it('ignores semicolons inside escaped delimited identifiers', () => {
    const sql = [
      'SELECT * FROM "a"";b";',
      'SELECT * FROM `a``;b`;',
      'SELECT * FROM [a]];b];',
      'SELECT 1;',
    ].join('\n');

    expect(findSqlStatementRanges(sql, 'sqlserver').map((range) => range.text)).toEqual([
      'SELECT * FROM "a"";b"',
      'SELECT * FROM `a``;b`',
      'SELECT * FROM [a]];b]',
      'SELECT 1',
    ]);
  });

  it('ignores semicolons inside SQLite bracket identifiers without SQL Server escaping', () => {
    const sql = 'SELECT * FROM [a;b]; SELECT 2;';

    expect(findSqlStatementRanges(sql, 'sqlite').map((range) => range.text)).toEqual([
      'SELECT * FROM [a;b]',
      'SELECT 2',
    ]);
  });

  it.each([
    ['postgres', 'SELECT ARRAY[[1,2],[3,4]]; DROP TABLE users;'],
    ['clickhouse', 'SELECT [[1],[2]]; DROP TABLE users;'],
    ['duckdb', 'SELECT [[1],[2]]; DROP TABLE users;'],
  ])('splits array brackets as syntax for %s', (dbType, sql) => {
    expect(findSqlStatementRanges(sql, dbType).map((range) => range.text)).toEqual([
      sql.slice(0, sql.indexOf(';')),
      'DROP TABLE users',
    ]);
  });

  it('does not let a backslash in a MySQL backtick identifier swallow the next statement', () => {
    const sql = 'SELECT `C:\\temp\\` FROM t;\nDROP TABLE t;';
    expect(findSqlStatementRanges(sql, 'mysql').map((range) => range.text)).toEqual([
      'SELECT `C:\\temp\\` FROM t',
      'DROP TABLE t',
    ]);
  });

  it('keeps backslash-escaped double-quoted MySQL strings intact', () => {
    const sql = 'SELECT "a\\\";b" AS value; SELECT 1;';
    expect(findSqlStatementRanges(sql, 'mysql').map((range) => range.text)).toEqual([
      'SELECT "a\\\";b" AS value',
      'SELECT 1',
    ]);
  });

  it('drops comment-only ranges after a terminated statement', () => {
    const sql = [
      'DELETE FROM users WHERE id = 1; -- keep this operation pending',
      '/* trailing explanation */',
    ].join('\n');

    expect(findSqlStatementRanges(sql).map((range) => range.text)).toEqual([
      'DELETE FROM users WHERE id = 1',
    ]);
    expect(findSqlStatementRanges('DELETE FROM users WHERE id = 1;--').map((range) => range.text)).toEqual([
      'DELETE FROM users WHERE id = 1',
    ]);
  });

  it('keeps executable MySQL comments as statements', () => {
    const sql = '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;';

    expect(findSqlStatementRanges(sql, 'mysql').map((range) => range.text)).toEqual([
      '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */',
    ]);
  });

  it('uses dialect-specific executable block comment rules', () => {
    const mysqlComment = '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;';
    const mariaDbComment = '/*M!100100 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;';

    expect(findSqlStatementRanges(mysqlComment, 'postgres')).toEqual([]);
    expect(findSqlStatementRanges(mariaDbComment, 'mysql')).toEqual([]);
    expect(findSqlStatementRanges(mariaDbComment, 'mariadb').map((range) => range.text)).toEqual([
      '/*M!100100 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */',
    ]);
  });

  it('uses dialect-specific hash comment rules', () => {
    const sql = 'DELETE FROM users WHERE id = 1; #comment';

    expect(findSqlStatementRanges(sql, 'mysql').map((range) => range.text)).toEqual([
      'DELETE FROM users WHERE id = 1',
    ]);
    expect(findSqlStatementRanges(sql, 'postgres').map((range) => range.text)).toEqual([
      'DELETE FROM users WHERE id = 1',
      '#comment',
    ]);
  });

  it('keeps Oracle anonymous PL/SQL blocks as one executable statement', () => {
    const plsql = [
      'BEGIN',
      "  INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');",
      "  UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';",
      "  DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';",
      'END;',
      'SELECT 1 FROM dual;',
    ].join('\n');

    const ranges = findSqlStatementRanges(plsql).map((range) => range.text);

    expect(ranges).toEqual([
      [
        'BEGIN',
        "  INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');",
        "  UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';",
        "  DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';",
        'END;',
      ].join('\n'),
      'SELECT 1 FROM dual',
    ]);
    expect(resolveExecutableSql(plsql, plsql.indexOf('UPDATE'))).toEqual({
      sql: ranges[0],
      source: 'statement',
    });
  });

  it('keeps Oracle DECLARE blocks as one executable statement', () => {
    const sql = [
      'DECLARE',
      '  v_count NUMBER;',
      'BEGIN',
      '  SELECT COUNT(*) INTO v_count FROM t_memcard_reg;',
      "  UPDATE t_memcard_reg SET CARDLEVEL = v_count WHERE MEMCARDNO = '8032277312';",
      'END;',
      'SELECT 1 FROM dual;',
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toEqual([
      [
        'DECLARE',
        '  v_count NUMBER;',
        'BEGIN',
        '  SELECT COUNT(*) INTO v_count FROM t_memcard_reg;',
        "  UPDATE t_memcard_reg SET CARDLEVEL = v_count WHERE MEMCARDNO = '8032277312';",
        'END;',
      ].join('\n'),
      'SELECT 1 FROM dual',
    ]);
    expect(resolveExecutableSql(sql, sql.indexOf('UPDATE'))).toEqual({
      sql: ranges[0],
      source: 'statement',
    });
  });

  it('keeps Oracle CREATE PROCEDURE definitions as one executable statement', () => {
    const sql = [
      'CREATE OR REPLACE PROCEDURE proc_tally2accept(',
      '  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE,',
      '  out_acceptno OUT t_accept_h.acceptno%TYPE',
      ') IS',
      '  v_busno t_tally_accept_h.busno%TYPE;',
      '  v_count PLS_INTEGER;',
      'BEGIN',
      "  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
      '  IF v_count > 0 THEN',
      '    out_acceptno := p_tallyacceptno;',
      '  END IF;',
      'END;',
      'SELECT 1 FROM dual;',
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toEqual([
      [
        'CREATE OR REPLACE PROCEDURE proc_tally2accept(',
        '  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE,',
        '  out_acceptno OUT t_accept_h.acceptno%TYPE',
        ') IS',
        '  v_busno t_tally_accept_h.busno%TYPE;',
        '  v_count PLS_INTEGER;',
        'BEGIN',
        "  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
        '  IF v_count > 0 THEN',
        '    out_acceptno := p_tallyacceptno;',
        '  END IF;',
        'END;',
      ].join('\n'),
      'SELECT 1 FROM dual',
    ]);
    expect(resolveExecutableSql(sql, sql.indexOf('v_busno'))).toEqual({
      sql: ranges[0],
      source: 'statement',
    });
  });

  it('skips standalone SQL*Plus slash delimiters after Oracle CREATE PROCEDURE definitions', () => {
    const sql = [
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_new(',
      '  p_sourceid IN VARCHAR2',
      ') IS',
      '  v_memcardno VARCHAR2(40);',
      '  v_ecnt NUMBER;',
      '  CURSOR cur_ware IS',
      '    SELECT d.goodsid, d.goodsqty',
      '    FROM t_order_d d',
      '    WHERE d.sourceid = p_sourceid;',
      'BEGIN',
      '  FOR row_ware IN cur_ware LOOP',
      '    v_ecnt := row_ware.goodsqty;',
      '  END LOOP;',
      'END;',
      '/',
      'SELECT 1 FROM dual;',
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toEqual([
      [
        'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_new(',
        '  p_sourceid IN VARCHAR2',
        ') IS',
        '  v_memcardno VARCHAR2(40);',
        '  v_ecnt NUMBER;',
        '  CURSOR cur_ware IS',
        '    SELECT d.goodsid, d.goodsqty',
        '    FROM t_order_d d',
        '    WHERE d.sourceid = p_sourceid;',
        'BEGIN',
        '  FOR row_ware IN cur_ware LOOP',
        '    v_ecnt := row_ware.goodsqty;',
        '  END LOOP;',
        'END;',
      ].join('\n'),
      'SELECT 1 FROM dual',
    ]);
    expect(resolveExecutableSql(sql, sql.indexOf('v_memcardno'))).toEqual({
      sql: ranges[0],
      source: 'statement',
    });
  });

  it('keeps Oracle CREATE PROCEDURE cursor CASE expressions as one executable statement', () => {
    const sql = [
      'CREATE OR REPLACE PROCEDURE proc_accept_to_add(',
      '  p_acceptno IN t_accept_h.acceptno%TYPE',
      ') IS',
      '  CURSOR cur_store_same(p_ind s_sys_ini.inipara%TYPE) IS',
      '    SELECT si.compid, si.batid, si.wareid',
      '    FROM t_store_i si',
      '    ORDER BY CASE',
      "      WHEN p_ind = '1' THEN",
      "        to_char(si.invalidate - to_date('19700101', 'yyyymmdd'))",
      "      WHEN p_ind = '2' THEN",
      "        lpad(to_char(floor(si.wareqty)), 10, '0')",
      '      ELSE',
      '        to_char(si.batid)',
      '    END,si.batid;',
      'BEGIN',
      '  NULL;',
      'END;',
      '/',
      'SELECT 1 FROM dual;',
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toEqual([
      [
        'CREATE OR REPLACE PROCEDURE proc_accept_to_add(',
        '  p_acceptno IN t_accept_h.acceptno%TYPE',
        ') IS',
        '  CURSOR cur_store_same(p_ind s_sys_ini.inipara%TYPE) IS',
        '    SELECT si.compid, si.batid, si.wareid',
        '    FROM t_store_i si',
        '    ORDER BY CASE',
        "      WHEN p_ind = '1' THEN",
        "        to_char(si.invalidate - to_date('19700101', 'yyyymmdd'))",
        "      WHEN p_ind = '2' THEN",
        "        lpad(to_char(floor(si.wareqty)), 10, '0')",
        '      ELSE',
        '        to_char(si.batid)',
        '    END,si.batid;',
        'BEGIN',
        '  NULL;',
        'END;',
      ].join('\n'),
      'SELECT 1 FROM dual',
    ]);
    expect(resolveExecutableSql(sql, sql.indexOf('ORDER BY CASE'))).toEqual({
      sql: ranges[0],
      source: 'statement',
    });
    expect(resolveExecutableSql(sql, sql.indexOf('NULL'))).toEqual({
      sql: ranges[0],
      source: 'statement',
    });
  });

  it('skips SQL*Plus slash delimiter comments after named Oracle procedure endings', () => {
    const sql = [
      '-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1',
      '-- 请确认语法兼容当前数据库后执行',
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(',
      '  p_sourceid IN VARCHAR2,',
      '  p_msg_out OUT NVARCHAR2',
      ') AS',
      '  v_saleno VARCHAR2(40);',
      '  v_ecnt NUMBER;',
      'BEGIN',
      '  SELECT COUNT(*) INTO v_ecnt FROM dual;',
      "  p_msg_out := 'OK';",
      'EXCEPTION',
      '  WHEN OTHERS THEN',
      '    p_msg_out := SQLERRM;',
      'END cproc_tzhssr_order2sale_A1;',
      '/ -- SQLPlus delimiter from PL/SQL tools',
      'SELECT 1 FROM dual;',
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toEqual([
      [
        '-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1',
        '-- 请确认语法兼容当前数据库后执行',
        'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(',
        '  p_sourceid IN VARCHAR2,',
        '  p_msg_out OUT NVARCHAR2',
        ') AS',
        '  v_saleno VARCHAR2(40);',
        '  v_ecnt NUMBER;',
        'BEGIN',
        '  SELECT COUNT(*) INTO v_ecnt FROM dual;',
        "  p_msg_out := 'OK';",
        'EXCEPTION',
        '  WHEN OTHERS THEN',
        '    p_msg_out := SQLERRM;',
        'END cproc_tzhssr_order2sale_A1;',
      ].join('\n'),
      'SELECT 1 FROM dual',
    ]);
    expect(resolveExecutableSql(sql, sql.indexOf('CREATE OR REPLACE'))).toMatchObject({ source: 'statement' });
    expect(resolveExecutableSql(sql, sql.indexOf('CREATE OR REPLACE'))?.sql).toBe(ranges[0].replace(/^--[^\n]*\n--[^\n]*\n/, ''));
    expect(resolveExecutableSql(sql, sql.indexOf('p_msg_out := SQLERRM'))?.sql).toBe(ranges[0].replace(/^--[^\n]*\n--[^\n]*\n/, ''));
  });

  it('keeps large Oracle procedures intact when the cursor is in the exception tail', () => {
    const sql = [
      '-- 修改函数/存储过程：H2.cproc_tzhssr_order2sale_A1',
      '-- 请确认语法兼容当前数据库后执行',
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(',
      '  p_sourceid IN VARCHAR2,',
      '  p_msg_out OUT NVARCHAR2',
      ') AS',
      '  v_ecnt NUMBER;',
      '  CURSOR cur_ware IS',
      '    SELECT d.goodsid, d.goodsqty',
      '    FROM t_order_d d',
      '    ORDER BY CASE',
      "      WHEN d.goodsqty > 0 THEN '1'",
      "      ELSE '2'",
      '    END, d.goodsid;',
      'BEGIN',
      '  FOR row_ware IN cur_ware LOOP',
      '    IF row_ware.goodsqty > 0 THEN',
      '      BEGIN',
      '        SELECT COUNT(*) INTO v_ecnt FROM dual;',
      '      EXCEPTION',
      '        WHEN no_data_found THEN',
      '          v_ecnt := 0;',
      '      END;',
      '    ELSE',
      '      BEGIN',
      '        v_ecnt := 0;',
      '      END;',
      '    END IF;',
      '  END LOOP;',
      "  p_msg_out := '';",
      'EXCEPTION',
      '  WHEN OTHERS THEN',
      "    p_msg_out := substr('订单核销失败，错误信息：' || SQLERRM || '，错误位置：' ||",
      '                        dbms_utility.format_error_backtrace, 1, 1000);',
      'END cproc_tzhssr_order2sale_A1;',
      '/ -- SQLPlus delimiter from PL/SQL tools',
      'SELECT 1 FROM dual;',
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toContain('CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1');
    expect(ranges[0]).toContain('p_msg_out OUT NVARCHAR2');
    expect(ranges[0]).toContain('EXCEPTION');
    expect(ranges[0]).toContain('END cproc_tzhssr_order2sale_A1;');
    expect(ranges[1]).toBe('SELECT 1 FROM dual');
    expect(resolveExecutableSql(sql, sql.indexOf('p_msg_out := substr'))).toMatchObject({ source: 'statement' });
    expect(resolveExecutableSql(sql, sql.indexOf('p_msg_out := substr'))?.sql).toBe(ranges[0].replace(/^--[^\n]*\n--[^\n]*\n/, ''));
    expect(resolveExecutableSql(sql, sql.indexOf('/ -- SQLPlus delimiter'))).toEqual({
      sql: ranges[0].replace(/^--[^\n]*\n--[^\n]*\n/, ''),
      source: 'statement',
    });
    expect(resolveCurrentSqlStatementRange(sql, sql.indexOf('/ -- SQLPlus delimiter'))?.text).toBe(ranges[0]);
  });

  it('skips optional semicolons after SQL*Plus slash delimiters', () => {
    const sql = [
      'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(',
      '  p_msg_out OUT NVARCHAR2',
      ') AS',
      'BEGIN',
      "  p_msg_out := '';",
      'EXCEPTION',
      '  WHEN OTHERS THEN',
      '    p_msg_out := SQLERRM;',
      'END cproc_tzhssr_order2sale_A1;',
      '/;',
      'SELECT 1 FROM dual;',
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toEqual([
      [
        'CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(',
        '  p_msg_out OUT NVARCHAR2',
        ') AS',
        'BEGIN',
        "  p_msg_out := '';",
        'EXCEPTION',
        '  WHEN OTHERS THEN',
        '    p_msg_out := SQLERRM;',
        'END cproc_tzhssr_order2sale_A1;',
      ].join('\n'),
      'SELECT 1 FROM dual',
    ]);
    expect(resolveExecutableSql(sql, sql.indexOf('/;'))).toEqual({
      sql: ranges[0],
      source: 'statement',
    });
  });

  it('keeps Oracle PACKAGE specification and body definitions as complete executable statements', () => {
    const sql = [
      'CREATE OR REPLACE PACKAGE pkg_order AS',
      '  PROCEDURE sync_order(p_id IN NUMBER);',
      'END pkg_order;',
      '/',
      'CREATE OR REPLACE PACKAGE BODY pkg_order AS',
      '  PROCEDURE sync_order(p_id IN NUMBER) IS',
      '  BEGIN',
      '    NULL;',
      '  END sync_order;',
      'END pkg_order;',
      '/ -- SQLPlus delimiter from PL/SQL tools',
      'SELECT 1 FROM dual;',
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toEqual([
      [
        'CREATE OR REPLACE PACKAGE pkg_order AS',
        '  PROCEDURE sync_order(p_id IN NUMBER);',
        'END pkg_order;',
      ].join('\n'),
      [
        'CREATE OR REPLACE PACKAGE BODY pkg_order AS',
        '  PROCEDURE sync_order(p_id IN NUMBER) IS',
        '  BEGIN',
        '    NULL;',
        '  END sync_order;',
        'END pkg_order;',
      ].join('\n'),
      'SELECT 1 FROM dual',
    ]);
    expect(resolveExecutableSql(sql, sql.indexOf('PROCEDURE sync_order'))).toEqual({
      sql: ranges[0],
      source: 'statement',
    });
    expect(resolveExecutableSql(sql, sql.indexOf('NULL'))).toEqual({
      sql: ranges[1],
      source: 'statement',
    });
  });

  it('does not treat a slash operator line as a SQL*Plus delimiter', () => {
    const sql = 'SELECT 10\n/\n2 FROM dual;';

    expect(findSqlStatementRanges(sql).map((range) => range.text)).toEqual([
      'SELECT 10\n/\n2 FROM dual',
    ]);
  });

  it('keeps PostgreSQL dollar-quoted CREATE FUNCTION definitions as one executable statement', () => {
    const sql = [
      'CREATE OR REPLACE FUNCTION refresh_stats() RETURNS void AS $$',
      'BEGIN',
      '  PERFORM refresh_now();',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'SELECT 2;',
    ].join('\n');

    const ranges = findSqlStatementRanges(sql).map((range) => range.text);

    expect(ranges).toEqual([
      [
        'CREATE OR REPLACE FUNCTION refresh_stats() RETURNS void AS $$',
        'BEGIN',
        '  PERFORM refresh_now();',
        'END;',
        '$$ LANGUAGE plpgsql',
      ].join('\n'),
      'SELECT 2',
    ]);
  });

  it('still splits transaction BEGIN statements', () => {
    const sql = 'BEGIN; UPDATE accounts SET balance = balance - 1 WHERE id = 1; COMMIT;';

    expect(findSqlStatementRanges(sql).map((range) => range.text)).toEqual([
      'BEGIN',
      'UPDATE accounts SET balance = balance - 1 WHERE id = 1',
      'COMMIT',
    ]);
  });

  it('selects the next statement when the cursor is on whitespace before it', () => {
    const sql = 'select 1;\n\n  select 2;';
    const range = resolveCurrentSqlStatementRange(sql, sql.indexOf('  select 2'));

    expect(range?.text).toBe('select 2');
  });

  it('returns null when there is no statement', () => {
    expect(resolveCurrentSqlStatementRange('  \n\t  ', 0)).toBeNull();
  });

  it('prefers a non-empty selection for executable SQL', () => {
    const sql = 'select 1;\nselect 2;';

    expect(resolveExecutableSql(sql, sql.indexOf('1'), '  select selected  ')?.sql).toBe('  select selected  ');
    expect(resolveExecutableSql(sql, sql.indexOf('1'), '  select selected  ')?.source).toBe('selection');
  });

  it('uses the statement containing the cursor for executable SQL', () => {
    const sql = 'select 1;\n\nselect 2 from users;\nselect 3';

    expect(resolveExecutableSql(sql, sql.indexOf('users'))).toEqual({
      sql: 'select 2 from users',
      source: 'statement',
    });
  });

  it('keeps execution on the statement when the cursor lands after its semicolon', () => {
    const sql = 'select 1 as a;\nselect 2 as b;\n\nselect 3 as c;';
    const afterSecondSemicolon = sql.indexOf('select 2 as b') + 'select 2 as b;'.length;

    expect(resolveExecutableSql(sql, afterSecondSemicolon)).toEqual({
      sql: 'select 2 as b',
      source: 'statement',
    });
  });

  it('falls back to all SQL when the cursor is on a blank line between statements', () => {
    const sql = 'select 1;\n\n  select 2';

    expect(resolveExecutableSql(sql, sql.indexOf('\n\n') + 1)).toEqual({
      sql,
      source: 'all',
    });
    expect(resolveExecutableSql(sql, sql.indexOf('  select 2'))).toEqual({
      sql: 'select 2',
      source: 'statement',
    });
  });

  it('falls back to all SQL when the cursor is on a trailing blank line', () => {
    const sql = 'select 1;\nselect 2;\n';

    expect(resolveExecutableSql(sql, sql.length)).toEqual({
      sql,
      source: 'all',
    });
  });

  it('returns null for empty or comment-only SQL', () => {
    expect(resolveExecutableSql('  \n\t  ', 0)).toBeNull();
    expect(resolveExecutableSql('-- nothing to execute\n\n/* still nothing */', 3)).toBeNull();
  });

  it('does not send detached leading comments when executing the cursor statement', () => {
    const sql = '-- exported row\n-- exported batch\nSELECT * FROM contract WHERE contract_code = \'YEC202608039\';';
    const cursorAtSemicolon = sql.length - 1;
    expect(resolveExecutableSql(sql, cursorAtSemicolon)).toEqual({
      sql: "SELECT * FROM contract WHERE contract_code = 'YEC202608039'",
      source: 'statement',
    });
    expect(stripLeadingSqlTrivia('/* documentation */\n# mysql note\nSELECT * FROM users', 'mysql'))
      .toBe('SELECT * FROM users');
  });

  it('keeps executable and optimizer hint comments at the start of a statement', () => {
    expect(stripLeadingSqlTrivia('/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */ SELECT * FROM users', 'mysql'))
      .toBe('/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */ SELECT * FROM users');
    expect(stripLeadingSqlTrivia('/*+ parallel(4) */ SELECT * FROM users', 'oracle'))
      .toBe('/*+ parallel(4) */ SELECT * FROM users');
  });
});
