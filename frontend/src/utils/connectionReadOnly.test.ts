import { describe, expect, it } from 'vitest';

import {
  findConnectionMutatingStatements,
  findPotentiallyMutatingConnectionStatements,
  isConnectionDataEditRestricted,
  isConnectionDataImportRestricted,
  isConnectionScriptExecutionRestricted,
  isConnectionStructureEditRestricted,
  isSingleReadOnlyConnectionQuery,
  resolveConnectionProtectionConfig,
  supportsConnectionKeepAliveSQL,
  supportsConnectionReadOnlyMode,
} from './connectionReadOnly';

describe('connectionReadOnly', () => {
  it('accepts only one read-only SQL query for custom keepalive', () => {
    const config = { type: 'mysql' } as any;

    expect(supportsConnectionKeepAliveSQL(config)).toBe(true);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT 1')).toBe(true);
    expect(isSingleReadOnlyConnectionQuery(config, 'WITH probe AS (SELECT 1) SELECT * FROM probe')).toBe(true);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT 1; SELECT 2')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, 'DELETE FROM accounts')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, '/*!50000 DELETE FROM accounts */ SELECT 1')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT /*!50000 SQL_NO_CACHE */ 1')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, "SELECT ';' AS probe")).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT 1 /* ; */')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT 1; -- probe')).toBe(true);
    expect(supportsConnectionKeepAliveSQL({ type: 'redis' } as any)).toBe(false);
  });

  it('supports Nacos production protection without treating it as a SQL keepalive source', () => {
    const config = { type: 'nacos' } as any;

    expect(supportsConnectionReadOnlyMode(config)).toBe(true);
    expect(supportsConnectionKeepAliveSQL(config)).toBe(false);
  });

  it('supports Elasticsearch production protection without treating it as a SQL keepalive source', () => {
    const config = { type: 'elasticsearch' } as any;

    expect(supportsConnectionReadOnlyMode(config)).toBe(true);
    expect(supportsConnectionKeepAliveSQL(config)).toBe(false);
  });

  it.each([
    ['dm', { type: 'dm' }],
    ['dm8', { type: 'dm8' }],
    ['custom dm8', { type: 'custom', driver: 'dm8' }],
    ['kingbasees', { type: 'kingbasees' }],
    ['custom kingbasees', { type: 'custom', driver: 'kingbasees' }],
    ['greatdb', { type: 'greatdb' }],
    ['gdb', { type: 'gdb' }],
    ['custom greatdb', { type: 'custom', driver: 'greatdb' }],
    ['apache-iotdb', { type: 'apache-iotdb' }],
    ['apache_iotdb', { type: 'apache_iotdb' }],
    ['custom apache-iotdb', { type: 'custom', driver: 'apache-iotdb' }],
    ['OceanBase Oracle tenant', { type: 'oceanbase', oceanBaseProtocol: 'oracle' }],
    ['custom OceanBase Oracle tenant', {
      type: 'custom',
      driver: 'oceanbase',
      oceanBaseProtocol: 'oracle',
    }],
  ])('recognizes read-only protection alias: %s', (_name, config) => {
    expect(supportsConnectionReadOnlyMode(config as any)).toBe(true);
  });

  it('supports IoTDB production protection and SQL keepalive checks', () => {
    const config = { type: 'iotdb' } as any;

    expect(supportsConnectionReadOnlyMode(config)).toBe(true);
    expect(supportsConnectionKeepAliveSQL(config)).toBe(true);
  });

  it('supports Caché production protection and SQL keepalive checks', () => {
    const config = { type: 'cache' } as any;

    expect(supportsConnectionReadOnlyMode(config)).toBe(true);
    expect(supportsConnectionKeepAliveSQL(config)).toBe(true);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT 1')).toBe(true);
    expect(isSingleReadOnlyConnectionQuery(config, 'UPDATE Sample.Person SET Name = \'next\'')).toBe(false);
  });

  it('maps legacy readOnly connections to the full production protection set', () => {
    expect(resolveConnectionProtectionConfig({
      type: 'postgres',
      readOnly: true,
    })).toEqual({
      restrictDataEdit: true,
      restrictStructureEdit: true,
      restrictScriptExecution: true,
      restrictDataImport: true,
    });
  });

  it('keeps partial protection flags isolated from each other', () => {
    const config = {
      type: 'postgres',
      protection: {
        restrictDataEdit: true,
        restrictDataImport: true,
      },
    };

    expect(isConnectionDataEditRestricted(config)).toBe(true);
    expect(isConnectionDataImportRestricted(config)).toBe(true);
    expect(isConnectionStructureEditRestricted(config)).toBe(false);
    expect(isConnectionScriptExecutionRestricted(config)).toBe(false);
  });

  it('only blocks mutating SQL when script execution protection is enabled', () => {
    expect(findConnectionMutatingStatements({
      type: 'postgres',
      protection: {
        restrictScriptExecution: true,
      },
    }, "SELECT * FROM users; UPDATE users SET name = 'next';")).toEqual([
      "UPDATE users SET name = 'next'",
    ]);

    expect(findConnectionMutatingStatements({
      type: 'postgres',
      protection: {
        restrictDataEdit: true,
      },
    }, "UPDATE users SET name = 'next';")).toEqual([]);
  });

  it('detects potentially mutating SQL even when protection is disabled', () => {
    const config = { type: 'postgres' } as any;

    expect(findPotentiallyMutatingConnectionStatements(
      config,
      'SELECT * FROM users;',
    )).toEqual([]);
    expect(findPotentiallyMutatingConnectionStatements(
      config,
      "SELECT * FROM users; UPDATE users SET name = 'next';",
    )).toEqual(["UPDATE users SET name = 'next'"]);
  });

  it('does not treat literals, comments, or quoted identifiers as SELECT INTO', () => {
    const config = { type: 'postgres' } as any;
    const sql = [
      "SELECT 'into' AS marker",
      'SELECT 1 /* INTO should stay a comment */',
      'SELECT [into] FROM records',
    ].join(';');

    expect(findPotentiallyMutatingConnectionStatements(config, sql)).toEqual([]);
    expect(findPotentiallyMutatingConnectionStatements(
      config,
      'SELECT value INTO archive FROM records',
    )).toEqual(['SELECT value INTO archive FROM records']);
  });

  it('does not treat text in a CTE literal or comment as a mutating keyword', () => {
    const config = { type: 'postgres' } as any;

    expect(findPotentiallyMutatingConnectionStatements(
      config,
      "WITH probe AS (SELECT 'update' AS operation /* delete */) SELECT * FROM probe",
    )).toEqual([]);
    expect(findPotentiallyMutatingConnectionStatements(
      config,
      'WITH changed AS (UPDATE accounts SET active = true RETURNING *) SELECT * FROM changed',
    )).toEqual([
      'WITH changed AS (UPDATE accounts SET active = true RETURNING *) SELECT * FROM changed',
    ]);
    expect(findPotentiallyMutatingConnectionStatements(
      config,
      'WITH source AS (SELECT id FROM accounts) SELECT id INTO archived_accounts FROM source',
    )).toEqual([
      'WITH source AS (SELECT id FROM accounts) SELECT id INTO archived_accounts FROM source',
    ]);
  });

  it('does not treat SQL Server REPLACE functions in a read-only CTE as writes', () => {
    const config = { type: 'sqlserver' } as any;
    const sql = `WITH OracleData_CTE AS (
      SELECT
        T.c.value('c[1]', 'INT') AS ID,
        T.c.value('c[2]', 'DATE') AS OrderDate,
        T.c.value('c[3]', 'DECIMAL(18,2)') AS Amount,
        T.c.value('c[4]', 'NVARCHAR(2)') AS rn
      FROM (
        SELECT CAST(
          '<root><r><c>' +
          REPLACE(REPLACE('101|2026-01-01|500|1', '||', '</c></r><r><c>'), '|', '</c><c>') +
          '</c></r></root>' AS XML
        ) AS XmlData
      ) x
      CROSS APPLY x.XmlData.nodes('/root/r') AS T(c)
    )
    SELECT O.ID, O.OrderDate, O.Amount, O.rn
    FROM OracleData_CTE O`;

    expect(findPotentiallyMutatingConnectionStatements(config, sql)).toEqual([]);
  });

  it('uses the connection dialect when filtering comment-only statements', () => {
    expect(findConnectionMutatingStatements({
      type: 'postgres',
      protection: {
        restrictScriptExecution: true,
      },
    }, 'SELECT * FROM users; /*! MySQL-only comment */')).toEqual([]);

    expect(findConnectionMutatingStatements({
      type: 'mysql',
      protection: {
        restrictScriptExecution: true,
      },
    }, 'SELECT * FROM users;--compact')).toEqual(['--compact']);
  });

  it('allows MongoDB distinct and read-only aggregate shell commands', () => {
    const config = {
      type: 'mongodb',
      protection: { restrictScriptExecution: true },
    };

    expect(findConnectionMutatingStatements(
      config,
      'db.users.distinct("status", { active: true }); db.users.aggregate([{ $match: { active: true } }])',
    )).toEqual([]);
  });

  it('keeps aggregate pipelines with write stages protected', () => {
    const config = {
      type: 'mongodb',
      protection: { restrictScriptExecution: true },
    };
    const statement = 'db.users.aggregate([{ $match: {} }, { $out: "archive" }])';

    expect(findConnectionMutatingStatements(config, statement)).toEqual([statement]);
    expect(findConnectionMutatingStatements(
      config,
      'db.users.aggregate([{ $match: {} }, { $merge: { into: "archive" } }])',
    )).toEqual(['db.users.aggregate([{ $match: {} }, { $merge: { into: "archive" } }])']);
  });

  // issue #1308：ORDER BY 与 DELETE 之间缺少分号，切分器切不出语句边界，
  // 整段曾被当成一条只读查询，导致生产保护与只读保护同时被绕过。
  it('treats a semicolon-less statement as mutating when it embeds a write (issue #1308)', () => {
    const config = {
      type: 'mysql',
      protection: { restrictScriptExecution: true, restrictDataEdit: true },
    };
    const incidentSql = [
      'SELECT',
      '    *',
      'FROM',
      '    t_bank_payment',
      'WHERE',
      "    f_bank_name = '安徽农商银行'",
      "    AND f_create_time >= '2026-09-20 00:00:00'",
      'ORDER BY',
      '    id DESC',
      'DELETE FROM t_bank_payment',
      'WHERE',
      "    f_bank_name = '安徽农商银行'",
      "    AND f_create_time >= '2026-09-20 00:00:00'",
    ].join('\n');

    expect(findPotentiallyMutatingConnectionStatements(config, incidentSql)).toEqual([
      incidentSql,
    ]);
    expect(findConnectionMutatingStatements(config, incidentSql)).toEqual([incidentSql]);
    expect(isSingleReadOnlyConnectionQuery(config, incidentSql)).toBe(false);
  });

  it('detects embedded writes without a semicolon across dialects', () => {
    const cases: Array<[string, string]> = [
      ['mysql', 'SELECT * FROM t ORDER BY id DESC\nDELETE FROM t WHERE id = 1'],
      ['mysql', 'SELECT * FROM t\nUPDATE t SET a = 1'],
      ['mysql', 'SELECT * FROM t\nINSERT INTO t VALUES (1)'],
      ['mysql', 'SELECT * FROM t\nDROP TABLE t'],
      ['mysql', 'SELECT * FROM t\nTRUNCATE TABLE t'],
      ['mysql', 'SELECT * FROM t\nALTER TABLE t ADD COLUMN c INT'],
      ['mysql', 'SELECT * FROM t FOR UPDATE DELETE FROM t'],
      ['postgres', 'SELECT * FROM t\nGRANT SELECT ON t TO demo'],
    ];

    for (const [type, sql] of cases) {
      const config = { type, protection: { restrictScriptExecution: true } };
      expect(
        findPotentiallyMutatingConnectionStatements(config, sql),
        `${type}: ${sql}`,
      ).not.toEqual([]);
    }
  });

  // 防误杀：这些输入的"写关键字"只出现在标识符、字面量或注释中，必须保持只读。
  it('keeps read-only statements read-only when write keywords are not executable (issue #1308)', () => {
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
      ['postgres', 'WITH x AS (SELECT 1) SELECT * FROM x'],
      ['mysql', 'SELECT id, name FROM users WHERE status = 1'],
      ['mysql', 'SHOW CREATE TABLE users'],
      ['mysql', 'SHOW CREATE VIEW v_users'],
      ['mysql', 'EXPLAIN SELECT * FROM t'],
      ['mysql', 'EXPLAIN DELETE FROM t'],
      ['mysql', 'SELECT * FROM t WHERE id = 1 FOR UPDATE'],
    ];

    for (const [type, sql] of cases) {
      const config = { type, protection: { restrictScriptExecution: true } };
      expect(
        findPotentiallyMutatingConnectionStatements(config, sql),
        `${type}: ${sql}`,
      ).toEqual([]);
    }
  });
});
