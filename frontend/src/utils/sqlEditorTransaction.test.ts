import { describe, expect, it } from 'vitest';

import {
  canReusePendingSqlEditorTransactionForType,
  hasTopLevelSqlEditorForUpdate,
  isSqlEditorNonDataMaintenanceStatement,
  isSqlEditorNonDataStatement,
  isSqlEditorSchemaChangingStatement,
  isSqlEditorSessionResetStatement,
  isSqlEditorSessionScopedNonDataStatement,
  resolveSqlEditorOperationKeyword,
  shouldUseSqlEditorManagedTransaction,
  shouldUseSqlEditorManagedTransactionForType,
} from './sqlEditorTransaction';
import { getDataSourceCapabilityContract } from './dataSourceCapabilities';
import { findSqlStatementRanges } from './sqlStatementSelection';

describe('sqlEditorTransaction', () => {
  it('keeps regular DML in a managed transaction', () => {
    expect(shouldUseSqlEditorManagedTransaction(['UPDATE users SET name = "n" WHERE id = 1'])).toBe(true);
    expect(shouldUseSqlEditorManagedTransaction(['INSERT INTO users(id) VALUES (1)'])).toBe(true);
    expect(shouldUseSqlEditorManagedTransaction(['DELETE FROM users WHERE id = 1'])).toBe(true);
  });

  it('keeps DML with a trailing line comment in a managed transaction', () => {
    const sql = 'DELETE FROM users WHERE id = 1; -- keep this operation pending';
    const statements = findSqlStatementRanges(sql).map((range) => range.text);

    expect(statements).toEqual(['DELETE FROM users WHERE id = 1']);
    expect(shouldUseSqlEditorManagedTransactionForType('mysql', statements)).toBe(true);
  });

  it('uses dialect-specific rules for compact line comments', () => {
    const sql = 'DELETE FROM users WHERE id = 1;--comment';
    const postgresStatements = findSqlStatementRanges(sql, 'postgres').map((range) => range.text);
    const mysqlStatements = findSqlStatementRanges(sql, 'mysql').map((range) => range.text);

    expect(postgresStatements).toEqual(['DELETE FROM users WHERE id = 1']);
    expect(shouldUseSqlEditorManagedTransactionForType('postgres', postgresStatements)).toBe(true);
    expect(mysqlStatements).toEqual(['DELETE FROM users WHERE id = 1', '--comment']);
    expect(shouldUseSqlEditorManagedTransactionForType('mysql', mysqlStatements)).toBe(false);
  });

  it('classifies WITH statements by their top-level operation', () => {
    expect(resolveSqlEditorOperationKeyword('WITH target AS (SELECT id FROM users) SELECT * FROM target')).toBe('select');
    expect(resolveSqlEditorOperationKeyword('WITH target AS (SELECT id FROM users) UPDATE users SET synced = 1')).toBe('update');
    expect(resolveSqlEditorOperationKeyword('WITH target AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM target)')).toBe('delete');
  });

  it('recognizes only schema-changing statements for metadata invalidation', () => {
    expect(isSqlEditorSchemaChangingStatement('-- apply schema\nALTER TABLE users ADD COLUMN email VARCHAR(128)')).toBe(true);
    expect(isSqlEditorSchemaChangingStatement('CREATE OR REPLACE VIEW active_users AS SELECT * FROM users')).toBe(true);
    expect(isSqlEditorSchemaChangingStatement('TRUNCATE TABLE users')).toBe(false);
    expect(isSqlEditorSchemaChangingStatement("SELECT 'DROP TABLE users' AS note")).toBe(false);
    expect(isSqlEditorSchemaChangingStatement('BEGIN\n  ALTER TABLE users ADD COLUMN archived BOOLEAN;\nEND;')).toBe(true);
    expect(isSqlEditorSchemaChangingStatement('BEGIN\n  INSERT INTO audit_log(id) VALUES (1);\nEND;')).toBe(false);
    expect(isSqlEditorSchemaChangingStatement("BEGIN\n  EXECUTE IMMEDIATE 'CREATE TABLE audit_log(id bigint)';\nEND;")).toBe(true);
    expect(isSqlEditorSchemaChangingStatement('DO $$ BEGIN CREATE TABLE audit_log(id bigint); END $$;')).toBe(true);
    expect(isSqlEditorSchemaChangingStatement('SELECT [create;table] FROM [audit]];log]')).toBe(false);
  });

  it('uses SQLite first-bracket closure while preserving SQL Server escaped brackets', () => {
    const sqliteSql = 'BEGIN\n  SELECT [value]]; CREATE TABLE created(id INTEGER);\nEND';
    expect(isSqlEditorSchemaChangingStatement(sqliteSql, 'sqlite')).toBe(true);

    const sqlServerSql = 'BEGIN\n  SELECT [value]]; CREATE TABLE created(id INT);\nEND';
    expect(isSqlEditorSchemaChangingStatement(sqlServerSql, 'sqlserver')).toBe(false);
  });

  it('detects only top-level SELECT FOR UPDATE clauses', () => {
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM users FOR UPDATE')).toBe(true);
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM users FOR /* lock */ UPDATE')).toBe(true);
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM users FOR JSON AUTO FOR UPDATE')).toBe(true);
    expect(hasTopLevelSqlEditorForUpdate("SELECT 'FOR UPDATE' AS marker FROM users")).toBe(false);
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM (SELECT * FROM users FOR UPDATE) source')).toBe(false);
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM users -- FOR UPDATE')).toBe(false);
    expect(hasTopLevelSqlEditorForUpdate('UPDATE users SET locked = 1')).toBe(false);
    expect(hasTopLevelSqlEditorForUpdate('SELECT a[b[1]] FROM t FOR UPDATE', 'postgres')).toBe(true);
    expect(hasTopLevelSqlEditorForUpdate('SELECT [[1,2],[3]] FROM t FOR UPDATE', 'clickhouse')).toBe(true);
  });

  it('does not treat a column named comment as schema-changing inside a block', () => {
    expect(isSqlEditorSchemaChangingStatement('BEGIN INSERT INTO t(comment) VALUES (1); END', 'postgres')).toBe(false);
    expect(isSqlEditorSchemaChangingStatement('BEGIN SELECT comment FROM t; END', 'postgres')).toBe(false);
  });

  it('uses managed transactions for WITH DML but not WITH SELECT', () => {
    expect(shouldUseSqlEditorManagedTransaction([
      'WITH target AS (SELECT id FROM users) UPDATE users SET synced = 1 WHERE id IN (SELECT id FROM target)',
    ])).toBe(true);
    expect(shouldUseSqlEditorManagedTransaction([
      'WITH target AS (SELECT id FROM users) SELECT * FROM target',
    ])).toBe(false);
  });

  it('uses managed transactions for data-changing CTEs even when the top-level operation is SELECT', () => {
    const sql = 'WITH moved AS (DELETE FROM audit_logs WHERE created_at < NOW() RETURNING id) SELECT * FROM moved';
    expect(resolveSqlEditorOperationKeyword(sql)).toBe('select');
    expect(shouldUseSqlEditorManagedTransaction([sql])).toBe(true);
  });

  it('does not wrap user-authored explicit transactions', () => {
    expect(shouldUseSqlEditorManagedTransaction([
      'BEGIN',
      'UPDATE users SET name = "n" WHERE id = 1',
      'COMMIT',
    ])).toBe(false);
    expect(shouldUseSqlEditorManagedTransaction([
      'START TRANSACTION',
      'DELETE FROM users WHERE id = 1',
    ])).toBe(false);
  });

  it('keeps DML inside anonymous BEGIN...END blocks in a managed transaction', () => {
    const sqlServerBlock = [
      'BEGIN',
      "  PRINT 'DELETE is text here';",
      '  -- INSERT INTO audit_logs(id) VALUES (1);',
      "  UPDATE users SET name = 'new' WHERE id = 1;",
      'END;',
    ].join('\n');
    const oracleBlock = [
      'BEGIN',
      "  UPDATE users SET name = 'new' WHERE id = 1;",
      'END;',
    ].join('\n');

    expect(shouldUseSqlEditorManagedTransactionForType(
      'sqlserver',
      findSqlStatementRanges(sqlServerBlock, 'sqlserver').map((range) => range.text),
    )).toBe(true);
    expect(shouldUseSqlEditorManagedTransactionForType(
      'oracle',
      findSqlStatementRanges(oracleBlock, 'oracle').map((range) => range.text),
    )).toBe(true);
  });

  it('does not wrap BEGIN TRANSACTION as an anonymous block', () => {
    expect(shouldUseSqlEditorManagedTransactionForType('sqlserver', [
      "BEGIN TRANSACTION; UPDATE users SET name = 'new' WHERE id = 1; COMMIT TRANSACTION;",
    ])).toBe(false);
  });

  it.each([
    ['trino', 'UPDATE hive.default.orders SET status = \'done\''],
    ['tdengine', 'INSERT INTO meters(ts, current) VALUES (NOW, 10.2)'],
    ['clickhouse', 'INSERT INTO events FORMAT JSONEachRow {"id":1}'],
    ['iotdb', 'INSERT INTO root.ln.wf01.wt01(timestamp,status) VALUES(1,true)'],
  ])('keeps %s writes on the plain multi-statement execution path', (dbType, sql) => {
    expect(getDataSourceCapabilityContract({ type: dbType }).transaction.supported).toBe(false);
    expect(shouldUseSqlEditorManagedTransactionForType(dbType, [sql])).toBe(false);
    expect(canReusePendingSqlEditorTransactionForType(dbType, [
      'SELECT * FROM users WHERE id = 1',
    ])).toBe(false);
  });

  it('reuses a pending managed transaction only for read-only follow-up SQL', () => {
    expect(canReusePendingSqlEditorTransactionForType('mysql', [
      'SELECT * FROM users WHERE id = 1',
    ])).toBe(true);
    expect(canReusePendingSqlEditorTransactionForType('mysql', [
      'WITH target AS (SELECT id FROM users) SELECT * FROM target',
    ])).toBe(true);
    expect(canReusePendingSqlEditorTransactionForType('mysql', [
      'UPDATE users SET name = "n" WHERE id = 1',
    ])).toBe(false);
    expect(canReusePendingSqlEditorTransactionForType('mysql', [
      'COMMIT',
    ])).toBe(false);
  });

  it('reads the shared transaction capability while retaining runtime-probed custom drivers', () => {
    const sql = 'UPDATE demo SET enabled = true';
    expect(shouldUseSqlEditorManagedTransactionForType('future-driver', [sql])).toBe(false);
    expect(shouldUseSqlEditorManagedTransactionForType(
      'future-driver',
      [sql],
      { type: 'custom', driver: 'future-driver' },
    )).toBe(true);
  });

  // issue #1308：缺分号时切分器切不出边界，整段被当成一条以 select 开头的读语句，
  // 于是不走托管事务、以 autocommit 直接下发，数据库侧再无事务可回滚。
  it('uses a managed transaction when a read statement embeds a semicolon-less write (issue #1308)', () => {
    const incidentSql = [
      'SELECT',
      '    *',
      'FROM',
      '    t_bank_payment',
      'WHERE',
      "    f_bank_name = '安徽农商银行'",
      'ORDER BY',
      '    id DESC',
      'DELETE FROM t_bank_payment',
      'WHERE',
      "    f_bank_name = '安徽农商银行'",
    ].join('\n');

    expect(shouldUseSqlEditorManagedTransactionForType('mysql', [incidentSql])).toBe(true);
    // 该语句含 DELETE，不得被视为可复用待提交事务的只读后续语句。
    expect(canReusePendingSqlEditorTransactionForType('mysql', [incidentSql])).toBe(false);
  });

  // 内嵌写扫描的关键字集合为覆盖 #1308 额外收录了 DDL。若托管事务判定不先确认
  // 「首关键字为读」就打这个扫描，首关键字本身即 DDL 的语句（存储过程、触发器等）
  // 会因命中 create/drop 被判成"可托管写"，被路由到 DBQueryMultiTransactional，
  // 从而绕过非托管路径上的失败补偿恢复逻辑，并与后端 isBatchableWriteSQLStatement
  // 的 DML-only 口径漂移。这组用例把该边界钉死。
  it('keeps DDL on the non-transactional path even though the embedded scan lists DDL keywords', () => {
    const ddlCases: Array<[string, string]> = [
      ['oracle', 'CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;'],
      ['mysql', 'CREATE TABLE x (id INT)'],
      ['mysql', 'ALTER TABLE users ADD COLUMN nickname VARCHAR(64)'],
      ['postgres', 'DROP TRIGGER IF EXISTS users_bi ON users'],
      ['postgres', 'CREATE FUNCTION users_bi_fn() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql'],
      ['mysql', 'TRUNCATE TABLE t_order'],
    ];

    for (const [dbType, sql] of ddlCases) {
      expect(
        shouldUseSqlEditorManagedTransactionForType(dbType, [sql]),
        `${dbType}: ${sql}`,
      ).toBe(false);
      // DDL 同样不是可复用待提交事务的只读后续语句。
      expect(
        canReusePendingSqlEditorTransactionForType(dbType, [sql]),
        `${dbType}: ${sql}`,
      ).toBe(false);
    }

    // 反向钉子：首关键字为读、体内缺分号埋着 DDL 时仍必须拦截，
    // 否则 #1308 的只读防线会在 DDL 方向重新被绕过。
    expect(
      shouldUseSqlEditorManagedTransactionForType('mysql', ['SELECT 1\nDROP TABLE t']),
    ).toBe(false);
  });

  it('keeps read-only statements on the non-transactional path (issue #1308)', () => {
    const readOnlyCases: Array<[string, string]> = [
      ['mysql', 'SELECT * FROM delete_log'],
      ['mysql', "SELECT 'DELETE FROM t' AS note"],
      ['mysql', 'SELECT 1 -- DELETE FROM t'],
      ['mysql', 'SHOW CREATE TABLE users'],
      ['mysql', 'SELECT * FROM t WHERE id = 1 FOR UPDATE'],
      ['postgres', 'SELECT $$ DELETE FROM t $$'],
    ];

    for (const [dbType, sql] of readOnlyCases) {
      expect(
        shouldUseSqlEditorManagedTransactionForType(dbType, [sql]),
        `${dbType}: ${sql}`,
      ).toBe(false);
      expect(
        canReusePendingSqlEditorTransactionForType(dbType, [sql]),
        `${dbType}: ${sql}`,
      ).toBe(true);
    }
  });
});

describe('sqlEditorTransaction non-data statements', () => {
  it('treats non-sensitive session commands as non-data', () => {
    const cases = [
      ['mysql', 'SET SESSION group_concat_max_len = 16777216'],
      ['mysql', 'SET NAMES utf8mb4'],
      ['mysql', 'SET @visit_count = 1'],
      ['postgres', 'SET search_path TO app, public'],
      ['sqlserver', 'SET NOCOUNT ON'],
      ['mysql', 'USE demo'],
    ];
    for (const [dbType, sql] of cases) {
      expect(isSqlEditorSessionScopedNonDataStatement(sql, dbType), `${dbType}: ${sql}`).toBe(true);
    }
  });

  it('keeps sensitive or server-scoped SET out of the non-data bucket', () => {
    const cases = [
      ['mysql', 'SET GLOBAL max_connections = 1000'],
      ['mysql', 'SET PERSIST max_connections = 1000'],
      ['mysql', "SET PASSWORD = 'secret'"],
      ['mysql', 'SET ROLE app_role'],
      ['mysql', 'SET DEFAULT ROLE app_role TO u'],
      ['mysql', 'SET autocommit = 0'],
      ['mysql', "SET SESSION sql_mode = ''"],
      ['mysql', 'SET SESSION AUTHORIZATION admin'],
      ['mysql', 'SET @@SESSION.sql_log_bin = 0'],
      ['mysql', 'SET foreign_key_checks = 0'],
    ];
    for (const [dbType, sql] of cases) {
      expect(isSqlEditorSessionScopedNonDataStatement(sql, dbType), `${dbType}: ${sql}`).toBe(false);
    }
  });

  it('guards session commands against a missing-semicolon trailing write', () => {
    const cases = [
      'SET @x = 1 DELETE FROM t',
      'SET @x = 1 CALL p_write()',
      "USE demo LOAD DATA INFILE '/tmp/a' INTO TABLE t",
      'USE demo EXEC p_write',
      'SET @x = 1 PREPARE stmt FROM @sql',
    ];
    for (const sql of cases) {
      expect(isSqlEditorSessionScopedNonDataStatement(sql, 'mysql'), sql).toBe(false);
      expect(isSqlEditorNonDataStatement(sql, 'mysql'), sql).toBe(false);
    }
  });

  it('recognizes pure maintenance and session reset statements', () => {
    const maintenance = [
      'ANALYZE TABLE t',
      'ANALYZE t',
      'CHECK TABLE t',
      'CHECKSUM TABLE t',
      'CHECKPOINT',
      'VACUUM t',
      'CACHE INDEX t IN cache1',
      'LOAD INDEX INTO CACHE t',
      'UPDATE STATISTICS t',
    ];
    for (const sql of maintenance) {
      expect(isSqlEditorNonDataMaintenanceStatement(sql, 'mysql'), sql).toBe(true);
    }
    expect(isSqlEditorNonDataMaintenanceStatement('VACUUM FULL t', 'postgres')).toBe(false);
    expect(isSqlEditorNonDataMaintenanceStatement('LOAD DATA INFILE \'/tmp/a\' INTO TABLE t', 'mysql')).toBe(false);
    expect(isSqlEditorNonDataMaintenanceStatement('UPDATE statistics SET c = 1', 'mysql')).toBe(false);

    expect(isSqlEditorSessionResetStatement('RESET ALL', 'postgres')).toBe(true);
    expect(isSqlEditorSessionResetStatement('DISCARD ALL', 'postgres')).toBe(true);
    expect(isSqlEditorSessionResetStatement('DEALLOCATE p', 'postgres')).toBe(true);
    expect(isSqlEditorSessionResetStatement('LISTEN events', 'postgres')).toBe(true);
    expect(isSqlEditorSessionResetStatement('RESET MASTER', 'mysql')).toBe(false);
    expect(isSqlEditorSessionResetStatement("PREPARE TRANSACTION 'x'", 'postgres')).toBe(false);
  });

  it('treats transaction control as non-data without hiding a trailing DML', () => {
    expect(isSqlEditorNonDataStatement('BEGIN', 'mysql')).toBe(true);
    expect(isSqlEditorNonDataStatement('COMMIT', 'mysql')).toBe(true);
    expect(isSqlEditorNonDataStatement('ROLLBACK', 'postgres')).toBe(true);
    expect(isSqlEditorNonDataStatement('ABORT', 'postgres')).toBe(true);
    expect(isSqlEditorNonDataStatement('XA START \'x\'', 'mysql')).toBe(true);
    expect(isSqlEditorNonDataStatement('COMMIT DELETE FROM t', 'mysql')).toBe(false);
  });
});
