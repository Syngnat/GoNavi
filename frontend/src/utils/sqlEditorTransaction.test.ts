import { describe, expect, it } from 'vitest';

import {
  canReusePendingSqlEditorTransactionForType,
  hasTopLevelSqlEditorForUpdate,
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

  it('detects only top-level SELECT FOR UPDATE clauses', () => {
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM users FOR UPDATE')).toBe(true);
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM users FOR /* lock */ UPDATE')).toBe(true);
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM users FOR JSON AUTO FOR UPDATE')).toBe(true);
    expect(hasTopLevelSqlEditorForUpdate("SELECT 'FOR UPDATE' AS marker FROM users")).toBe(false);
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM (SELECT * FROM users FOR UPDATE) source')).toBe(false);
    expect(hasTopLevelSqlEditorForUpdate('SELECT * FROM users -- FOR UPDATE')).toBe(false);
    expect(hasTopLevelSqlEditorForUpdate('UPDATE users SET locked = 1')).toBe(false);
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
});
