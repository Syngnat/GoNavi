import { describe, expect, it } from 'vitest';

import { findSqlStatementRanges, resolveCurrentSqlStatementRange } from './sqlStatementSelection';

const texts = (sql: string, dbType = 'mysql') => findSqlStatementRanges(sql, dbType).map((range) => range.text);

describe('findSqlStatementRanges without delimiters', () => {
  it('splits statements that omit the trailing semicolon', () => {
    expect(texts('SELECT 1\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(texts('SELECT * FROM users\nSELECT * FROM orders')).toEqual([
      'SELECT * FROM users',
      'SELECT * FROM orders',
    ]);
  });

  it('splits DDL statements separated by semicolons', () => {
    // DDL statements may span multiple lines; the boundary check is
    // conservative (审查 #2: keeps multi-line DDL together) so an explicit
    // `;` is required to split DDLs without delimiters.
    const sql = [
      'ALTER TABLE users ADD COLUMN age INT;',
      'ALTER TABLE users DROP COLUMN nick;',
      'DROP TABLE orders;',
      'TRUNCATE TABLE logs;',
    ].join('\n');

    expect(texts(sql)).toEqual([
      'ALTER TABLE users ADD COLUMN age INT',
      'ALTER TABLE users DROP COLUMN nick',
      'DROP TABLE orders',
      'TRUNCATE TABLE logs',
    ]);
  });

  it('splits a statement that follows a completed parenthesised statement', () => {
    const sql = 'CREATE TABLE t (\n  id INT,\n  name VARCHAR(10)\n)\nINSERT INTO t VALUES (1, \'a\')';

    expect(texts(sql)).toEqual([
      'CREATE TABLE t (\n  id INT,\n  name VARCHAR(10)\n)',
      "INSERT INTO t VALUES (1, 'a')",
    ]);
  });

  it('keeps set operations in one statement', () => {
    expect(texts('SELECT 1\nUNION\nSELECT 2')).toEqual(['SELECT 1\nUNION\nSELECT 2']);
    expect(texts('SELECT 1 UNION ALL\nSELECT 2')).toEqual(['SELECT 1 UNION ALL\nSELECT 2']);
  });

  it('keeps a query body attached to the statement that consumes it', () => {
    expect(texts('INSERT INTO t\nSELECT * FROM s')).toEqual(['INSERT INTO t\nSELECT * FROM s']);
    expect(texts('INSERT INTO t (a, b)\nSELECT a, b FROM s')).toEqual(['INSERT INTO t (a, b)\nSELECT a, b FROM s']);
    expect(texts('CREATE VIEW v AS\nSELECT 1')).toEqual(['CREATE VIEW v AS\nSELECT 1']);
    expect(texts('WITH c AS (SELECT 1)\nSELECT * FROM c')).toEqual(['WITH c AS (SELECT 1)\nSELECT * FROM c']);
    expect(texts('EXPLAIN\nSELECT 1')).toEqual(['EXPLAIN\nSELECT 1']);
  });

  it('keeps subqueries and clause keywords inside the statement', () => {
    const sql = 'SELECT *\nFROM users\nWHERE id IN (\nSELECT user_id FROM orders\n)\nORDER BY id\nDESC';

    expect(texts(sql)).toEqual([sql]);
  });

  it('keeps SET attached to UPDATE but splits session level SET', () => {
    expect(texts('UPDATE t\nSET a = 1\nUPDATE t2\nSET b = 2')).toEqual([
      'UPDATE t\nSET a = 1',
      'UPDATE t2\nSET b = 2',
    ]);
    expect(texts('SET NAMES utf8mb4\nSELECT 1')).toEqual(['SET NAMES utf8mb4', 'SELECT 1']);
  });

  it('ignores keywords inside strings, identifiers and comments', () => {
    expect(texts("SELECT 'a\nSELECT b' AS v")).toEqual(["SELECT 'a\nSELECT b' AS v"]);
    expect(texts('SELECT `a\nSELECT b` FROM t')).toEqual(['SELECT `a\nSELECT b` FROM t']);
    expect(texts('SELECT 1\n-- SELECT 2\nSELECT 3')).toEqual(['SELECT 1', '-- SELECT 2\nSELECT 3']);
    expect(texts('SELECT 1\n/*\nSELECT 2\n*/')).toEqual(['SELECT 1\n/*\nSELECT 2\n*/']);
  });

  it('keeps routine bodies intact', () => {
    const sql = [
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SELECT 1;',
      '  SELECT 2;',
      'END',
    ].join('\n');

    expect(texts(sql)).toEqual([sql]);
  });

  it('only splits on keywords the dialect knows', () => {
    expect(texts('SELECT 1\nPRAGMA foreign_keys', 'sqlite')).toEqual(['SELECT 1', 'PRAGMA foreign_keys']);
    expect(texts('SELECT 1\nPRAGMA foreign_keys', 'mysql')).toEqual(['SELECT 1\nPRAGMA foreign_keys']);
    expect(texts('SELECT 1\nVACUUM', 'postgres')).toEqual(['SELECT 1', 'VACUUM']);
  });

  it('resolves the statement under the cursor without delimiters', () => {
    const sql = 'SELECT * FROM users\nSELECT * FROM orders';

    expect(resolveCurrentSqlStatementRange(sql, sql.indexOf('users'), 'mysql')?.text).toBe('SELECT * FROM users');
    expect(resolveCurrentSqlStatementRange(sql, sql.indexOf('orders'), 'mysql')?.text).toBe('SELECT * FROM orders');
  });

  // ─── Regression:评审 #1319 问题覆盖 ─────────────────────────────────────────

  // #1 SQL Server WITH (NOLOCK) — `WITH` after `SELECT` must not split.
  it('keeps SQL Server WITH (NOLOCK) hints in one statement', () => {
    const sql = 'SELECT * FROM users WITH (NOLOCK)\nSELECT * FROM orders';
    expect(texts(sql, 'sqlserver')).toEqual([sql]);
  });

  it('keeps SQL Server WITH (UPDLOCK) in one statement', () => {
    const sql = 'SELECT id FROM t WHERE x = 1 WITH (UPDLOCK, HOLDLOCK)';
    expect(texts(sql, 'sqlserver')).toEqual([sql]);
  });

  // #2 Multi-line ALTER TABLE ... RENAME COLUMN must not be split.
  it('keeps ALTER TABLE ... RENAME COLUMN in one statement', () => {
    const sql = 'ALTER TABLE users\nRENAME COLUMN nick TO nickname';
    expect(texts(sql)).toEqual([sql]);
  });

  it('keeps ALTER TABLE ... ADD COLUMN in one statement', () => {
    const sql = 'ALTER TABLE users\nADD COLUMN email VARCHAR(255)';
    expect(texts(sql)).toEqual([sql]);
  });

  it('keeps ALTER TABLE ... DROP COLUMN in one statement', () => {
    const sql = 'ALTER TABLE users\nDROP COLUMN nick';
    expect(texts(sql)).toEqual([sql]);
  });

  // #3 Absorption: DELETE/UPDATE/MERGE can consume a following SELECT.
  it('keeps DELETE ... RETURNING SELECT in one statement', () => {
    expect(texts('DELETE FROM t\nSELECT * FROM s')).toEqual(['DELETE FROM t\nSELECT * FROM s']);
  });

  it('keeps UPDATE ... RETURNING SELECT in one statement', () => {
    expect(texts('UPDATE t SET a = 1\nSELECT * FROM s')).toEqual(['UPDATE t SET a = 1\nSELECT * FROM s']);
  });

  it('keeps MERGE ... SELECT in one statement', () => {
    expect(texts('MERGE INTO t\nSELECT * FROM s')).toEqual(['MERGE INTO t\nSELECT * FROM s']);
  });

  // #4 PG data-modifying CTEs must not be split.
  it('keeps PG data-modifying CTEs intact', () => {
    expect(texts('WITH del AS (DELETE FROM t RETURNING *)\nINSERT INTO log SELECT * FROM del', 'postgres')).toEqual([
      'WITH del AS (DELETE FROM t RETURNING *)\nINSERT INTO log SELECT * FROM del',
    ]);
  });

  it('keeps PG CTE INSERT ... SELECT intact', () => {
    expect(texts('WITH ins AS (INSERT INTO t VALUES (1) RETURNING *)\nSELECT * FROM ins', 'postgres')).toEqual([
      'WITH ins AS (INSERT INTO t VALUES (1) RETURNING *)\nSELECT * FROM ins',
    ]);
  });

  // #5 ORDER BY ... DESC must not split on the leading DESC of the next statement.
  it('keeps ORDER BY id DESC together', () => {
    expect(texts('SELECT * FROM t ORDER BY id DESC')).toEqual(['SELECT * FROM t ORDER BY id DESC']);
  });

  it('splits after a complete ORDER BY expression', () => {
    expect(texts('SELECT * FROM t ORDER BY id DESC\nSELECT * FROM t2')).toEqual([
      'SELECT * FROM t ORDER BY id DESC',
      'SELECT * FROM t2',
    ]);
  });

  it('keeps ORDER BY id ASC together', () => {
    expect(texts('SELECT * FROM t ORDER BY id ASC')).toEqual(['SELECT * FROM t ORDER BY id ASC']);
  });

  // #6 LOCK IN SHARE MODE is a clause, not a standalone statement.
  it('does not split on LOCK IN SHARE MODE', () => {
    const sql = 'SELECT * FROM t LOCK IN SHARE MODE\nSELECT * FROM t2';
    expect(texts(sql, 'mysql')).toEqual([sql]);
  });

  it('keeps FOR UPDATE in one statement', () => {
    expect(texts('SELECT * FROM t FOR UPDATE')).toEqual(['SELECT * FROM t FOR UPDATE']);
  });

  // #7 CREATE SEQUENCE ... START WITH must not split on START.
  it('keeps CREATE SEQUENCE ... START WITH in one statement', () => {
    expect(texts('CREATE SEQUENCE s START WITH 1', 'postgres')).toEqual(['CREATE SEQUENCE s START WITH 1']);
  });

  it('keeps CREATE SEQUENCE ... START WITH in one statement (Oracle)', () => {
    expect(texts('CREATE SEQUENCE s START WITH 1', 'oracle')).toEqual(['CREATE SEQUENCE s START WITH 1']);
  });

  it('splits before START TRANSACTION in MySQL (start is not a MySQL keyword)', () => {
    // `start` is not a MySQL statement keyword, so the boundary check returns
    // false and `CREATE SEQUENCE s\nSTART WITH 1` stays in one statement.
    expect(texts('CREATE SEQUENCE s\nSTART WITH 1', 'mysql')).toEqual([
      'CREATE SEQUENCE s\nSTART WITH 1',
    ]);
  });

  // #8 Oracle / terminator must reset parenDepth.
  it('resets parenDepth at the / terminator in Oracle', () => {
    // Inside a PL/SQL block `SELECT MAX(id) FROM t` has parenDepth > 0.
    // The `/` should still end the block correctly.
    const sql = 'BEGIN\nSELECT MAX(id) FROM t;\n/\nSELECT 1';
    expect(texts(sql, 'oracle')).toEqual([
      'BEGIN\nSELECT MAX(id) FROM t;',
      'SELECT 1',
    ]);
  });

  // #9 REPLACE INTO ... SET must keep SET attached.
  it('keeps REPLACE INTO ... SET in one statement', () => {
    expect(texts('REPLACE INTO t SET a = 1')).toEqual(['REPLACE INTO t SET a = 1']);
  });

  it('splits before a second REPLACE after SET', () => {
    expect(texts('REPLACE INTO t SET a = 1\nREPLACE INTO t2 SET b = 2')).toEqual([
      'REPLACE INTO t SET a = 1',
      'REPLACE INTO t2 SET b = 2',
    ]);
  });

  // #10 Column names that collide with statement keywords must not cause spurious splits.
  it('does not split on a column named `start` after ORDER BY', () => {
    expect(texts('SELECT * FROM t ORDER BY start')).toEqual(['SELECT * FROM t ORDER BY start']);
  });

  it('does not split on a column named `lock` after SELECT', () => {
    expect(texts('SELECT lock FROM t')).toEqual(['SELECT lock FROM t']);
  });

  it('does not split on a column named `replace` after INSERT', () => {
    expect(texts('INSERT INTO t (replace) VALUES (1)')).toEqual(['INSERT INTO t (replace) VALUES (1)']);
  });

  // 追加 #3: PG ON CONFLICT ... DO UPDATE/NOTHING must not split on DO.
  it('keeps INSERT ON CONFLICT DO UPDATE in one statement', () => {
    const sql = 'INSERT INTO t (a) VALUES (1)\nON CONFLICT (a)\nDO UPDATE SET a = 2';
    expect(texts(sql, 'postgres')).toEqual([sql]);
  });

  it('keeps INSERT ON CONFLICT DO NOTHING in one statement', () => {
    const sql = 'INSERT INTO t (a) VALUES (1)\nON CONFLICT (a)\nDO NOTHING';
    expect(texts(sql, 'postgres')).toEqual([sql]);
  });

  it('keeps single-line ON CONFLICT DO UPDATE intact', () => {
    expect(texts('INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2', 'postgres')).toEqual([
      'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2',
    ]);
  });

  // 追加 #3: DO as a continuation token allows the statement body to follow.
  it('keeps DO block body attached', () => {
    const sql = 'DO $$\nSELECT 1\n$$';
    expect(texts(sql, 'postgres')).toEqual([sql]);
  });

  // 追加 #3: SAVEPOINT ... SELECT should not split on SELECT after SAVEPOINT.
  it('keeps SAVEPOINT ... SELECT in one statement', () => {
    expect(texts('SAVEPOINT sp\nSELECT 1', 'postgres')).toEqual(['SAVEPOINT sp\nSELECT 1']);
  });

  it('keeps RELEASE SAVEPOINT ... SELECT in one statement', () => {
    expect(texts('RELEASE SAVEPOINT sp\nSELECT 1', 'postgres')).toEqual(['RELEASE SAVEPOINT sp\nSELECT 1']);
  });

  // 追加 #3: Oracle hierarchical queries with START WITH ... CONNECT BY PRIOR.
  it('keeps SELECT ... START WITH ... CONNECT BY PRIOR intact', () => {
    const sql = 'SELECT e FROM emp\nSTART WITH mgr IS NULL\nCONNECT BY PRIOR e = m';
    expect(texts(sql, 'oracle')).toEqual([sql]);
  });
});
