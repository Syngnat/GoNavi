import { describe, expect, it } from 'vitest';

import { buildSqlEditorTransactionLog } from './sqlEditorTransactionLog';

describe('buildSqlEditorTransactionLog', () => {
  it('renders a complete MySQL commit transaction', () => {
    expect(buildSqlEditorTransactionLog({
      dbType: 'mysql',
      statements: ["UPDATE users SET name = 'new' WHERE id = 1"],
      action: 'commit',
    })).toBe("START TRANSACTION;\nUPDATE users SET name = 'new' WHERE id = 1;\nCOMMIT;");
  });

  it('uses SQL Server transaction boundaries for rollback', () => {
    expect(buildSqlEditorTransactionLog({
      dbType: 'sqlserver',
      statements: ['DELETE FROM audit_log WHERE id = 7;'],
      action: 'rollback',
    })).toBe('BEGIN TRANSACTION;\nDELETE FROM audit_log WHERE id = 7;\nROLLBACK TRANSACTION;');
  });

  it('describes Oracle implicit begin without inventing a BEGIN statement', () => {
    const result = buildSqlEditorTransactionLog({
      dbType: 'oracle',
      statements: ['UPDATE users SET active = 1 WHERE id = 9'],
      action: 'commit',
    });

    expect(result).toContain('Oracle starts the transaction implicitly');
    expect(result).toContain('UPDATE users SET active = 1 WHERE id = 9;');
    expect(result).toContain('COMMIT;');
    expect(result).not.toContain('BEGIN;');
  });

  it('uses explicit Caché transaction boundaries', () => {
    expect(buildSqlEditorTransactionLog({
      dbType: 'cache',
      statements: ["UPDATE Sample.Person SET Name = 'next' WHERE ID = 1"],
      action: 'rollback',
    })).toBe("BEGIN;\nUPDATE Sample.Person SET Name = 'next' WHERE ID = 1;\nROLLBACK;");
  });
});
