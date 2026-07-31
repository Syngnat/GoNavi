import { describe, expect, it } from 'vitest';

import { groupSidebarPartitionTableEntries } from './sidebarPartitions';

describe('groupSidebarPartitionTableEntries', () => {
  it('nests PostgreSQL partitions under their parent and hides the parent row estimate', () => {
    const grouped = groupSidebarPartitionTableEntries([
      {
        tableName: 'public.orders',
        schemaName: 'public',
        displayName: 'orders',
        rowCount: 502,
      },
      {
        tableName: 'public.orders_2026_01',
        schemaName: 'public',
        displayName: 'orders_2026_01',
        partitionParentTableName: 'public.orders',
        rowCount: 240,
      },
      {
        tableName: 'public.orders_2026_02',
        schemaName: 'public',
        displayName: 'orders_2026_02',
        partitionParentTableName: 'public.orders',
        rowCount: 262,
      },
      {
        tableName: 'public.customers',
        schemaName: 'public',
        displayName: 'customers',
        rowCount: 18,
      },
    ]);

    expect(grouped.map((entry) => entry.tableName)).toEqual([
      'public.orders',
      'public.customers',
    ]);
    expect(grouped[0]).not.toHaveProperty('rowCount');
    expect(grouped[0].partitionTables?.map((entry) => [entry.tableName, entry.rowCount])).toEqual([
      ['public.orders_2026_01', 240],
      ['public.orders_2026_02', 262],
    ]);
  });

  it('keeps orphaned partition metadata visible instead of dropping a table', () => {
    const grouped = groupSidebarPartitionTableEntries([
      {
        tableName: 'archive.orders_2025',
        schemaName: 'archive',
        displayName: 'orders_2025',
        partitionParentTableName: 'archive.orders',
        rowCount: 91,
      },
    ]);

    expect(grouped).toEqual([
      {
        tableName: 'archive.orders_2025',
        schemaName: 'archive',
        displayName: 'orders_2025',
        partitionParentTableName: 'archive.orders',
        rowCount: 91,
      },
    ]);
  });

  it('supports sub-partition trees without leaking descendants into the root list', () => {
    const grouped = groupSidebarPartitionTableEntries([
      {
        tableName: 'public.events',
        schemaName: 'public',
        displayName: 'events',
        rowCount: 12,
      },
      {
        tableName: 'public.events_2026',
        schemaName: 'public',
        displayName: 'events_2026',
        partitionParentTableName: 'public.events',
        rowCount: 6,
      },
      {
        tableName: 'public.events_2026_07',
        schemaName: 'public',
        displayName: 'events_2026_07',
        partitionParentTableName: 'public.events_2026',
        rowCount: 3,
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).not.toHaveProperty('rowCount');
    expect(grouped[0].partitionTables?.[0]).not.toHaveProperty('rowCount');
    expect(grouped[0].partitionTables?.[0].partitionTables?.[0].tableName)
      .toBe('public.events_2026_07');
  });

  it('prefers the child schema when an unqualified parent name is ambiguous', () => {
    const grouped = groupSidebarPartitionTableEntries([
      {
        tableName: 'public.orders',
        schemaName: 'public',
        displayName: 'orders',
      },
      {
        tableName: 'archive.orders',
        schemaName: 'archive',
        displayName: 'orders',
      },
      {
        tableName: 'archive.orders_2025',
        schemaName: 'archive',
        displayName: 'orders_2025',
        partitionParentTableName: 'orders',
      },
    ]);

    expect(grouped[0].partitionTables).toBeUndefined();
    expect(grouped[1].partitionTables?.map((entry) => entry.tableName)).toEqual([
      'archive.orders_2025',
    ]);
  });

  it('filters schema visibility before nesting cross-schema partitions', () => {
    const entries = [
      {
        tableName: 'public.orders',
        schemaName: 'public',
        displayName: 'orders',
      },
      {
        tableName: 'archive.orders_2025',
        schemaName: 'archive',
        displayName: 'orders_2025',
        partitionParentTableName: 'public.orders',
      },
    ];

    const publicOnly = groupSidebarPartitionTableEntries(entries, {
      isEntryVisible: (entry) => entry.schemaName === 'public',
    });
    expect(publicOnly.map((entry) => entry.tableName)).toEqual(['public.orders']);
    expect(publicOnly[0].partitionTables).toBeUndefined();

    const archiveOnly = groupSidebarPartitionTableEntries(entries, {
      isEntryVisible: (entry) => entry.schemaName === 'archive',
    });
    expect(archiveOnly.map((entry) => entry.tableName)).toEqual(['archive.orders_2025']);
  });

  it('keeps cyclic partition metadata at the root instead of recursing forever', () => {
    const grouped = groupSidebarPartitionTableEntries([
      {
        tableName: 'public.partition_a',
        schemaName: 'public',
        displayName: 'partition_a',
        partitionParentTableName: 'public.partition_b',
      },
      {
        tableName: 'public.partition_b',
        schemaName: 'public',
        displayName: 'partition_b',
        partitionParentTableName: 'public.partition_a',
      },
    ]);

    expect(grouped.map((entry) => entry.tableName)).toEqual([
      'public.partition_a',
      'public.partition_b',
    ]);
    expect(grouped.every((entry) => entry.partitionTables === undefined)).toBe(true);
  });
});
