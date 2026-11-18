import { describe, expect, it } from 'vitest';

import { resolveObjectInfoTarget } from './objectInfoTarget';

describe('object info target', () => {
  it('shows database information when only a database is selected', () => {
    expect(resolveObjectInfoTarget({
      connectionId: 'conn-1',
      dbName: 'front_end_sys_dev',
    }, null)).toEqual({
      kind: 'database',
      connectionId: 'conn-1',
      dbName: 'front_end_sys_dev',
    });
  });

  it('keeps table information when a table is selected', () => {
    expect(resolveObjectInfoTarget({
      connectionId: 'conn-1',
      dbName: 'front_end_sys_dev',
      schemaName: 'public',
      tableName: 'users',
    }, null)).toEqual({
      kind: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys_dev',
      schemaName: 'public',
      tableName: 'users',
    });
  });

  it('prefers the database selected in the active context over a stale table tab', () => {
    expect(resolveObjectInfoTarget({
      connectionId: 'conn-1',
      dbName: 'front_end_sys_dev',
    }, {
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys_dev',
      tableName: 'orders',
    })).toEqual({
      kind: 'database',
      connectionId: 'conn-1',
      dbName: 'front_end_sys_dev',
      schemaName: undefined,
    });
  });

  it('falls back to the active table tab when no context is available', () => {
    expect(resolveObjectInfoTarget(null, {
      type: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys_dev',
      tableName: 'orders',
    })).toEqual({
      kind: 'table',
      connectionId: 'conn-1',
      dbName: 'front_end_sys_dev',
      schemaName: undefined,
      tableName: 'orders',
    });
  });

  it('requires a selected database', () => {
    expect(resolveObjectInfoTarget({ connectionId: 'conn-1' }, null)).toBeNull();
    expect(resolveObjectInfoTarget(null, null)).toBeNull();
  });
});
