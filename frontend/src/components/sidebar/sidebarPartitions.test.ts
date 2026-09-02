import { describe, expect, it } from 'vitest';

import { dedupeSidebarTableEntries, getSidebarTableEntryIdentity, groupSidebarPartitionTableEntries } from './sidebarPartitions';

describe('groupSidebarPartitionTableEntries', () => {
  it('deduplicates repeated Kingbase table metadata rows without merging schemas', () => {
    const deduped = dedupeSidebarTableEntries([
      { tableName: 'ldf_server.ldf_application_type', schemaName: 'ldf_server', displayName: 'ldf_application_type' },
      { tableName: 'ldf_server.ldf_application_type', schemaName: 'ldf_server', displayName: 'ldf_application_type' },
      { tableName: 'archive.ldf_application_type', schemaName: 'archive', displayName: 'ldf_application_type' },
      { tableName: 'LDF_SERVER.LDF_APPLICATION_TYPE', schemaName: 'LDF_SERVER', displayName: 'LDF_APPLICATION_TYPE' },
    ]);

    expect(deduped.map((entry) => entry.tableName)).toEqual([
      'ldf_server.ldf_application_type',
      'archive.ldf_application_type',
      'LDF_SERVER.LDF_APPLICATION_TYPE',
    ]);
  });

  it('deduplicates repeated unqualified MySQL-compatible table metadata rows', () => {
    const deduped = dedupeSidebarTableEntries([
      { tableName: 'ldf_application_type', displayName: 'ldf_application_type' },
      { tableName: 'ldf_application_type', displayName: 'ldf_application_type' },
      { tableName: 'md_item_type', displayName: 'md_item_type' },
    ]);

    expect(deduped.map((entry) => entry.tableName)).toEqual([
      'ldf_application_type',
      'md_item_type',
    ]);
  });

  it('keeps case-sensitive schema and object identities distinct', () => {
    expect(getSidebarTableEntryIdentity({
      tableName: 'LDF_SERVER.orders',
      schemaName: 'LDF_SERVER',
    })).not.toBe(getSidebarTableEntryIdentity({
      tableName: 'ldf_server.orders',
      schemaName: 'ldf_server',
    }));
  });

  it('does not merge a quoted PostgreSQL-compatible identifier with an unquoted one', () => {
    expect(getSidebarTableEntryIdentity({
      tableName: 'ldf_server."Orders"',
      schemaName: 'ldf_server',
    })).not.toBe(getSidebarTableEntryIdentity({
      tableName: 'ldf_server.Orders',
      schemaName: 'ldf_server',
    }));
    expect(getSidebarTableEntryIdentity({
      tableName: '"LdfServer".orders',
      schemaName: 'LdfServer',
    })).not.toBe(getSidebarTableEntryIdentity({
      tableName: 'LdfServer.orders',
      schemaName: 'LdfServer',
    }));
    expect(dedupeSidebarTableEntries([
      { tableName: 'ldf_server."Orders"', schemaName: 'ldf_server', displayName: 'Orders' },
      { tableName: 'ldf_server.Orders', schemaName: 'ldf_server', displayName: 'Orders' },
    ])).toHaveLength(2);
  });

  it('deduplicates transport-quoted lowercase identifiers with their bare form', () => {
    const deduped = dedupeSidebarTableEntries([
      {
        tableName: 'public.orders',
        schemaName: 'public',
        displayName: 'orders',
      },
      {
        tableName: '"public"."orders"',
        schemaName: 'public',
        displayName: 'orders',
      },
      {
        tableName: 'public."orders"',
        schemaName: '"public"',
        displayName: 'orders',
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].tableName).toBe('public.orders');
  });

  it('keeps quoted whitespace and mixed-case identifiers distinct', () => {
    const deduped = dedupeSidebarTableEntries([
      { tableName: 'public.orders', schemaName: 'public', displayName: 'orders' },
      { tableName: 'public." orders "', schemaName: 'public', displayName: ' orders ' },
      { tableName: 'public."Orders"', schemaName: 'public', displayName: 'Orders' },
    ]);

    expect(deduped.map((entry) => entry.tableName)).toEqual([
      'public.orders',
      'public." orders "',
      'public."Orders"',
    ]);
  });

  it('keeps SQL-escaped quote characters distinct from a bare identifier', () => {
    const deduped = dedupeSidebarTableEntries([
      { tableName: 'public.orders', schemaName: 'public', displayName: 'orders' },
      { tableName: 'public."""orders"""', schemaName: 'public', displayName: 'orders' },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped.map((entry) => entry.tableName)).toEqual([
      'public.orders',
      'public."""orders"""',
    ]);
  });

  it('does not merge backtick or bracket delimiters with bare identifiers', () => {
    const deduped = dedupeSidebarTableEntries([
      { tableName: 'public.orders', schemaName: 'public', displayName: 'orders' },
      { tableName: 'public.`orders`', schemaName: 'public', displayName: 'orders' },
      { tableName: 'public.[orders]', schemaName: 'public', displayName: 'orders' },
    ]);

    expect(deduped).toHaveLength(3);
  });

  it('deduplicates Unicode lowercase identifiers when transport quotes are added', () => {
    const deduped = dedupeSidebarTableEntries([
      { tableName: 'public.订单', schemaName: 'public', displayName: '订单' },
      { tableName: 'public."订单"', schemaName: 'public', displayName: '订单' },
    ]);

    expect(deduped).toHaveLength(1);
  });

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

  it('falls back to a unique unqualified parent when schema metadata is absent', () => {
    const grouped = groupSidebarPartitionTableEntries([
      {
        tableName: 'orders',
        displayName: 'orders',
      },
      {
        tableName: 'orders_2025',
        displayName: 'orders_2025',
        partitionParentTableName: 'orders',
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].tableName).toBe('orders');
    expect(grouped[0].partitionTables?.map((entry) => entry.tableName)).toEqual([
      'orders_2025',
    ]);
  });

  it('keeps case-sensitive partition parents separate', () => {
    const grouped = groupSidebarPartitionTableEntries([
      {
        tableName: 'LDF_SERVER.orders',
        schemaName: 'LDF_SERVER',
        displayName: 'orders',
      },
      {
        tableName: 'ldf_server.orders',
        schemaName: 'ldf_server',
        displayName: 'orders',
      },
      {
        tableName: 'LDF_SERVER.orders_2026',
        schemaName: 'LDF_SERVER',
        displayName: 'orders_2026',
        partitionParentTableName: 'LDF_SERVER.orders',
      },
      {
        tableName: 'ldf_server.orders_2026',
        schemaName: 'ldf_server',
        displayName: 'orders_2026',
        partitionParentTableName: 'ldf_server.orders',
      },
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0].partitionTables?.map((entry) => entry.tableName)).toEqual([
      'LDF_SERVER.orders_2026',
    ]);
    expect(grouped[1].partitionTables?.map((entry) => entry.tableName)).toEqual([
      'ldf_server.orders_2026',
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
