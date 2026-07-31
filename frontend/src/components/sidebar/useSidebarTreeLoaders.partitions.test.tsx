import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedConnection } from '../../types';
import { useSidebarTreeLoaders } from './useSidebarTreeLoaders';

const mocks = vi.hoisted(() => ({
  dbGetDatabases: vi.fn(),
  dbGetTables: vi.fn(),
  dbQuery: vi.fn(),
  getDriverStatusList: vi.fn(),
  jvmProbeCapabilities: vi.fn(),
  replaceTreeNodeChildren: vi.fn(),
  storeState: {
    connections: [] as Array<SavedConnection & { dbName?: string }>,
    tableSortPreference: {} as Record<string, string>,
    tableAccessCount: {} as Record<string, number>,
    pinnedSidebarTables: [] as string[],
  },
}));

vi.mock('antd', () => ({
  message: {
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../store', async () => {
  const actual = await vi.importActual<typeof import('../../store')>('../../store');
  const useStore = Object.assign(vi.fn(), {
    getState: () => mocks.storeState,
  });
  return { ...actual, useStore };
});

vi.mock('../../../wailsjs/go/app/App', () => ({
  DBGetDatabases: mocks.dbGetDatabases,
  DBGetTables: mocks.dbGetTables,
  DBQuery: mocks.dbQuery,
  GetDriverStatusList: mocks.getDriverStatusList,
  JVMProbeCapabilities: mocks.jvmProbeCapabilities,
}));

describe('useSidebarTreeLoaders PostgreSQL partitions', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.tableSortPreference = {};
    mocks.storeState.tableAccessCount = {};
    mocks.storeState.pinnedSidebarTables = [];
    mocks.replaceTreeNodeChildren.mockImplementation((_key, children) => children || []);
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('builds a Partitions group with clickable table nodes and hides the parent row count', async () => {
    const connection = {
      id: 'conn-pg',
      name: 'PostgreSQL',
      dbName: 'analytics',
      config: {
        type: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        database: 'analytics',
      },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [
        { Table: 'public.orders', Rows: '502' },
        { Table: 'public.orders_2026_01', Rows: '240' },
        { Table: 'public.orders_2026_02', Rows: '262' },
        { Table: 'public.customers', Rows: '18' },
      ],
    });
    mocks.dbQuery.mockImplementation(async (_config, _dbName, sql: string) => {
      if (sql.includes('partition_parent_table')) {
        return {
          success: true,
          data: [
            { table_name: 'public.orders', table_rows: null },
            {
              table_name: 'public.orders_2026_01',
              table_rows: 240,
              partition_parent_table: 'public.orders',
            },
            {
              table_name: 'public.orders_2026_02',
              table_rows: 262,
              partition_parent_table: 'public.orders',
            },
            { table_name: 'public.customers', table_rows: 18 },
          ],
        };
      }
      return { success: true, data: [] };
    });

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        isV2Ui: true,
        loadingNodesRef: { current: new Set<string>() },
        setConnectionStates: vi.fn(),
        setLoadedKeys: vi.fn(),
        replaceTreeNodeChildren: mocks.replaceTreeNodeChildren,
        buildRuntimeConfig: (conn) => conn.config,
        buildJVMRuntimeConfig: (conn) => conn.config,
        buildJVMDiagnosticTreeNodes: () => [],
        resolveSavedQueryDisplayName: (name) => String(name || ''),
      });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      await loaders?.loadTables({
        key: 'conn-pg-analytics',
        dataRef: connection,
      });
    });

    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(1);
    const [, databaseChildren] = mocks.replaceTreeNodeChildren.mock.calls[0];
    const publicSchema = databaseChildren.find(
      (node: any) => node.dataRef?.groupKey === 'schema' && node.dataRef?.schemaName === 'public',
    );
    const tablesGroup = publicSchema.children.find(
      (node: any) => node.dataRef?.groupKey === 'tables',
    );
    const rootTableNames = tablesGroup.children
      .filter((node: any) => node.type === 'table')
      .map((node: any) => node.dataRef.tableName);
    expect(rootTableNames).toEqual(['public.customers', 'public.orders']);

    const ordersNode = tablesGroup.children.find(
      (node: any) => node.dataRef?.tableName === 'public.orders',
    );
    expect(ordersNode.dataRef).not.toHaveProperty('rowCount');
    const partitionsGroup = ordersNode.children.find(
      (node: any) => node.dataRef?.groupKey === 'partitions',
    );
    expect(partitionsGroup.dataRef.partitionCount).toBe(2);
    expect(partitionsGroup.children.map((node: any) => ({
      tableName: node.dataRef.tableName,
      type: node.type,
      rowCount: node.dataRef.rowCount,
    }))).toEqual([
      { tableName: 'public.orders_2026_01', type: 'table', rowCount: 240 },
      { tableName: 'public.orders_2026_02', type: 'table', rowCount: 262 },
    ]);

    const executedSql = mocks.dbQuery.mock.calls.map((call) => String(call[2] || '')).join('\n');
    expect(executedSql).not.toMatch(/COUNT\s*\(/i);
  });
});
