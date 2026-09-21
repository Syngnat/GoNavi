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

  it('splits DDL statements such as ALTER and DROP', () => {
    const sql = [
      'ALTER TABLE users ADD COLUMN age INT',
      'ALTER TABLE users DROP COLUMN nick',
      'DROP TABLE orders',
      'TRUNCATE TABLE logs',
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
});
