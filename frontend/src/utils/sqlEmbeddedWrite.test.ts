import { describe, expect, it } from 'vitest';

import { hasEmbeddedWriteStatement } from './sqlEmbeddedWrite';

describe('sqlEmbeddedWrite', () => {
  // issue #1308：ORDER BY 与 DELETE 之间缺少分号，切分器切不出边界。
  it('detects a semicolon-less write across dialects', () => {
    const cases: Array<[string, string]> = [
      ['mysql', 'SELECT * FROM t ORDER BY id DESC\nDELETE FROM t WHERE id = 1'],
      ['mysql', 'SELECT * FROM t\nUPDATE t SET a = 1'],
      ['mysql', 'SELECT * FROM t\nINSERT INTO t VALUES (1)'],
      ['mysql', 'SELECT * FROM t\nDROP TABLE t'],
      ['mysql', 'SELECT * FROM t\nTRUNCATE TABLE t'],
      ['mysql', 'SELECT * FROM t\nALTER TABLE t ADD COLUMN c INT'],
      ['sqlserver', 'SELECT * FROM t\nRENAME COLUMN a TO b'],
      ['postgres', 'SELECT * FROM t\nGRANT SELECT ON t TO demo'],
      ['oracle', 'SELECT * FROM t\nREVOKE SELECT ON t FROM demo'],
      // `FOR UPDATE` 是只读行锁语法，但紧随其后的 DELETE 必须被检出。
      ['mysql', 'SELECT * FROM t FOR UPDATE DELETE FROM t'],
      // EXPLAIN ANALYZE 会真实执行语句，此处按写操作处理（与 Go 侧
      // explainAnalyzeMayWrite 的结论一致，宁可收紧不可放行）。
      ['postgres', 'EXPLAIN ANALYZE DELETE FROM t'],
    ];

    for (const [dbType, sql] of cases) {
      expect(hasEmbeddedWriteStatement(sql, dbType), `${dbType}: ${sql}`).toBe(true);
    }
  });

  // 防误杀：写关键字只出现在标识符、字面量或注释中时必须保持只读。
  it('ignores write keywords hidden in literals, identifiers and comments', () => {
    const cases: Array<[string, string]> = [
      ['mysql', 'SELECT * FROM delete_log'],
      ['mysql', 'SELECT drop_count FROM t'],
      ['mysql', "SELECT 'DELETE FROM t' AS note"],
      ['mysql', 'SELECT 1 -- DELETE FROM t'],
      ['mysql', 'SELECT 1 # DELETE FROM t'],
      ['mysql', 'SELECT 1 /* DELETE FROM t */'],
      ['mysql', 'SELECT `delete` FROM t'],
      ['postgres', 'SELECT "delete" FROM t'],
      ['postgres', 'SELECT $$ DELETE FROM t $$'],
      ['postgres', 'SELECT $tag$ DELETE FROM t $tag$'],
      ['sqlserver', 'SELECT [delete] FROM t'],
      ['mysql', 'SELECT setting FROM t'],
      ['mysql', 'SELECT REPLACE(a, b, c) FROM t'],
      ['postgres', 'WITH x AS (SELECT 1) SELECT * FROM x'],
      ['mysql', 'SELECT id, name FROM users WHERE status = 1'],
      // FOR UPDATE 是行锁语义，其 update 不应被当作写操作。
      ['mysql', 'SELECT * FROM t WHERE id = 1 FOR UPDATE'],
      ['postgres', 'SELECT * FROM t WHERE id = 1 FOR UPDATE OF t NOWAIT'],
      ['postgres', 'SELECT * FROM t FOR NO KEY UPDATE'],
      ['postgres', 'SELECT * FROM t FOR NO KEY UPDATE OF t SKIP LOCKED'],
      ['mysql', 'WITH x AS (SELECT 1) SELECT * FROM x FOR UPDATE'],
    ];

    for (const [dbType, sql] of cases) {
      expect(hasEmbeddedWriteStatement(sql, dbType), `${dbType}: ${sql}`).toBe(false);
    }
  });

  // SHOW CREATE 是 GoNavi 自身生成并执行的表结构查看语句；
  // 不带 ANALYZE 的 EXPLAIN 只出计划不改数据。两者必须豁免，否则大面积误杀。
  it('exempts SHOW CREATE and plain EXPLAIN read-only contexts', () => {
    const cases: Array<[string, string]> = [
      ['mysql', 'SHOW CREATE TABLE users'],
      ['mysql', 'SHOW CREATE VIEW v_users'],
      ['mysql', 'EXPLAIN SELECT * FROM t'],
      ['mysql', 'EXPLAIN DELETE FROM t'],
    ];

    for (const [dbType, sql] of cases) {
      expect(hasEmbeddedWriteStatement(sql, dbType), `${dbType}: ${sql}`).toBe(false);
    }
  });

  // `DESC` 是 `ORDER BY x DESC` 的高频排序修饰词；一旦豁免，
  // 事故 SQL 原文形状会被直接放行。
  it('does not treat ORDER BY ... DESC as a DESCRIBE prefix', () => {
    expect(hasEmbeddedWriteStatement(
      'SELECT * FROM t ORDER BY id DESC DELETE FROM t',
      'mysql',
    )).toBe(true);
    expect(hasEmbeddedWriteStatement('SELECT * FROM t ORDER BY id DESC', 'mysql')).toBe(false);
    expect(hasEmbeddedWriteStatement('DESC users', 'mysql')).toBe(false);
  });

  it('treats write keywords after EXPLAIN-looking text as executable', () => {
    // EXPLAIN 只豁免紧随其后的第一个写关键字，不能豁免整条语句。
    expect(hasEmbeddedWriteStatement(
      'EXPLAIN SELECT 1 DELETE FROM t',
      'mysql',
    )).toBe(true);
  });
});
