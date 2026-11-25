import { describe, expect, it, vi } from 'vitest';

import {
  buildSidebarMultiTableRenameEntries,
  buildSidebarMultiTableRenamePlan,
} from './sidebarMultiTableRename';

vi.mock('../../../wailsjs/go/app/App', () => ({
  RenameTable: vi.fn(),
}));

const extractObjectName = (name: string) => name.split('.').pop() || name;

describe('sidebar multi-table rename', () => {
  it('builds one replacement row per selected table and keeps database context', () => {
    const entries = buildSidebarMultiTableRenameEntries([
      {
        key: 'table-a',
        title: 'orders',
        dataRef: { id: 'conn-1', name: 'Sales DB', dbName: 'sales', tableName: 'orders' },
      },
      {
        key: 'table-b',
        title: 'customers',
        dataRef: {
          id: 'conn-1',
          dbName: 'sales',
          schemaName: 'public',
          tableName: 'public.customers',
        },
      },
    ], extractObjectName);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      dbName: 'sales',
      oldTableName: 'orders',
      newTableName: 'orders',
      databaseLabel: 'Sales DB / sales',
    });
    expect(entries[1]).toMatchObject({
      schemaName: 'public',
      oldTableName: 'public.customers',
      newTableName: 'customers',
      databaseLabel: 'sales.public',
    });
  });

  it('skips unchanged rows and groups changed tables by database', () => {
    const entries = buildSidebarMultiTableRenameEntries([
      {
        key: 'table-a',
        dataRef: { id: 'conn-1', dbName: 'sales', tableName: 'orders' },
      },
      {
        key: 'table-b',
        dataRef: { id: 'conn-1', dbName: 'sales', tableName: 'customers' },
      },
      {
        key: 'table-c',
        dataRef: { id: 'conn-1', dbName: 'archive', tableName: 'events' },
      },
    ], extractObjectName);

    const plan = buildSidebarMultiTableRenamePlan(
      entries,
      ['orders_v2', 'customers', 'events_2026'],
      extractObjectName,
    );

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.total).toBe(2);
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0]).toMatchObject({
      dbName: 'sales',
      changes: [{ oldTableName: 'orders', nextTableName: 'orders_v2' }],
    });
    expect(plan.groups[1]).toMatchObject({
      dbName: 'archive',
      changes: [{ oldTableName: 'events', nextTableName: 'events_2026' }],
    });
  });

  it('rejects empty rows and selections where every name is unchanged', () => {
    const entries = buildSidebarMultiTableRenameEntries([
      {
        key: 'table-a',
        dataRef: { id: 'conn-1', dbName: 'sales', tableName: 'orders' },
      },
    ], extractObjectName);

    expect(buildSidebarMultiTableRenamePlan(entries, ['  '], extractObjectName))
      .toEqual({ ok: false, reason: 'required' });
    expect(buildSidebarMultiTableRenamePlan(entries, ['orders'], extractObjectName))
      .toEqual({ ok: false, reason: 'unchanged' });
  });
});
