import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from 'antd';

import type { SavedConnection } from '../../types';
import { buildSidebarDatabasePinKey } from '../../store';
import { useSidebarTreeLoaders } from './useSidebarTreeLoaders';

const mocks = vi.hoisted(() => ({
  dbGetDatabases: vi.fn(),
  dbGetTables: vi.fn(),
  dbRefreshTableStats: vi.fn(),
  dbQuery: vi.fn(),
  getDriverStatusList: vi.fn(),
  jvmProbeCapabilities: vi.fn(),
  replaceTreeNodeChildren: vi.fn(),
  storeState: {
    connections: [] as Array<SavedConnection & { dbName?: string }>,
    tableSortPreference: {} as Record<string, string>,
    tableAccessCount: {} as Record<string, number>,
    pinnedSidebarTables: [] as string[],
    pinnedSidebarDatabases: [] as string[],
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

vi.mock('antd', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
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
  DBRefreshTableStats: mocks.dbRefreshTableStats,
  DBQuery: mocks.dbQuery,
  GetDriverStatusList: mocks.getDriverStatusList,
  JVMProbeCapabilities: mocks.jvmProbeCapabilities,
}));

describe('useSidebarTreeLoaders PostgreSQL partitions', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.connections = [];
    mocks.storeState.tableSortPreference = {};
    mocks.storeState.tableAccessCount = {};
    mocks.storeState.pinnedSidebarTables = [];
    mocks.storeState.pinnedSidebarDatabases = [];
    mocks.replaceTreeNodeChildren.mockImplementation((_key, children) => children || []);
    mocks.dbRefreshTableStats.mockResolvedValue({ success: false });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('loads pinned databases first from the latest persisted pin state', async () => {
    const connection = {
      id: 'conn-mysql',
      name: 'MySQL',
      config: {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
      },
    } as SavedConnection;
    mocks.storeState.connections = [connection];
    mocks.storeState.pinnedSidebarDatabases = [
      buildSidebarDatabasePinKey(connection.id, 'analytics'),
    ];
    mocks.dbGetDatabases.mockResolvedValue({
      success: true,
      data: [
        { Database: 'archive' },
        { Database: 'analytics' },
        { Database: 'system' },
      ],
    });

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        pinnedSidebarDatabases: [],
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
      await loaders?.loadDatabases({ key: connection.id, dataRef: connection });
    });

    const [, databaseNodes] = mocks.replaceTreeNodeChildren.mock.calls[0];
    expect(databaseNodes.map((node: any) => node.type)).toEqual([
      'v2-database-section',
      'database',
      'v2-database-section',
      'database',
      'database',
    ]);
    expect(databaseNodes
      .filter((node: any) => node.type === 'database')
      .map((node: any) => node.title)).toEqual([
      'analytics',
      'archive',
      'system',
    ]);
    expect(databaseNodes[1].dataRef.pinnedSidebarDatabase).toBe(true);
    expect(databaseNodes[3].dataRef.pinnedSidebarDatabase).toBeUndefined();
  });

  it('discards an older database response and keeps the latest visibility rules', async () => {
    const staleResponse = deferred<any>();
    const currentResponse = deferred<any>();
    mocks.dbGetDatabases
      .mockReturnValueOnce(staleResponse.promise)
      .mockReturnValueOnce(currentResponse.promise);

    const staleConnection = {
      id: 'conn-race',
      name: 'MySQL',
      includeDatabasePatterns: ['old%'],
      config: {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
      },
    } as SavedConnection;
    const currentConnection = {
      ...staleConnection,
      includeDatabasePatterns: ['new%'],
      excludeDatabasePatterns: ['new_archive'],
    } as SavedConnection;
    mocks.storeState.connections = [staleConnection];

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const loadingNodesRef = { current: new Set<string>() };
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        pinnedSidebarDatabases: [],
        isV2Ui: false,
        loadingNodesRef,
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

    const staleLoad = loaders!.loadDatabases({
      key: staleConnection.id,
      dataRef: staleConnection,
    });
    mocks.storeState.connections = [currentConnection];
    // Connection signature invalidation clears the old marker before reloading.
    loadingNodesRef.current.delete(`dbs-${staleConnection.id}`);
    const currentLoad = loaders!.loadDatabases({
      key: currentConnection.id,
      dataRef: currentConnection,
    });

    staleResponse.resolve({
      success: true,
      data: [{ Database: 'old_db' }, { Database: 'new_db' }],
    });
    await act(async () => {
      await staleLoad;
    });

    expect(mocks.replaceTreeNodeChildren).not.toHaveBeenCalled();
    expect(loadingNodesRef.current.has(`dbs-${currentConnection.id}`)).toBe(true);

    currentResponse.resolve({
      success: true,
      data: [
        { Database: 'old_db' },
        { Database: 'new_db' },
        { Database: 'new_archive' },
      ],
    });
    await act(async () => {
      await currentLoad;
    });

    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(1);
    const [, databaseNodes, persistedConnection] = mocks.replaceTreeNodeChildren.mock.calls[0];
    expect(databaseNodes.map((node: any) => node.title)).toEqual(['new_db']);
    expect(databaseNodes[0].dataRef.includeDatabasePatterns).toEqual(['new%']);
    expect(persistedConnection).toBe(currentConnection);
    expect(loadingNodesRef.current.size).toBe(0);
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
        pinnedSidebarDatabases: [],
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

  it('does not expose an estimated zero row count for MySQL InnoDB tables', async () => {
    const connection = {
      id: 'conn-mysql',
      name: 'MySQL',
      dbName: 'sales',
      config: {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
      },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'orders', Rows: '0' }],
    });
    mocks.dbQuery.mockImplementation(async (_config, _dbName, sql: string) => {
      if (sql.includes('information_schema.tables')) {
        return {
          success: true,
          data: [{
            table_name: 'orders',
            table_rows: 0,
            table_engine: 'InnoDB',
          }],
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
        pinnedSidebarDatabases: [],
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
        key: 'conn-mysql-sales',
        dataRef: connection,
      });
    });

    const [, databaseChildren] = mocks.replaceTreeNodeChildren.mock.calls[0];
    const tablesGroup = databaseChildren.find(
      (node: any) => node.dataRef?.groupKey === 'tables',
    );
    const ordersNode = tablesGroup.children.find(
      (node: any) => node.dataRef?.tableName === 'orders',
    );
    expect(ordersNode.dataRef).not.toHaveProperty('rowCount');
  });

  it('waits for an in-flight table load before running an ensureFresh load', async () => {
    const staleResponse = deferred<any>();
    const freshResponse = deferred<any>();
    mocks.dbGetTables
      .mockReturnValueOnce(staleResponse.promise)
      .mockReturnValueOnce(freshResponse.promise);
    mocks.dbQuery.mockResolvedValue({ success: false, data: [] });

    const connection = {
      id: 'conn-mysql',
      name: 'MySQL',
      dbName: 'app',
      config: {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: 'app',
      },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const loadingNodesRef = { current: new Set<string>() };
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        pinnedSidebarDatabases: [],
        isV2Ui: true,
        loadingNodesRef,
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

    const node = { key: 'conn-mysql-app', dataRef: connection };
    const staleLoad = loaders!.loadTables(node);
    let freshLoadResolved = false;
    const freshLoad = loaders!.loadTables(node, { ensureFresh: true }).then(() => {
      freshLoadResolved = true;
    });

    expect(mocks.dbGetTables).toHaveBeenCalledTimes(1);
    expect(freshLoadResolved).toBe(false);

    staleResponse.resolve({ success: true, data: [{ Table: 'old_table' }] });
    await act(async () => {
      await staleLoad;
      await Promise.resolve();
    });

    expect(mocks.dbGetTables).toHaveBeenCalledTimes(2);
    expect(freshLoadResolved).toBe(false);

    freshResponse.resolve({ success: true, data: [{ Table: 'new_table' }] });
    await act(async () => {
      await freshLoad;
    });

    expect(freshLoadResolved).toBe(true);
    expect(loadingNodesRef.current.size).toBe(0);
  });

  it('renders cached sqlite table stats before applying the asynchronous refresh', async () => {
    const refresh = deferred<any>();
    const connection = {
      id: 'conn-sqlite',
      name: 'SQLite',
      dbName: 'main',
      config: {
        id: 'conn-sqlite',
        type: 'sqlite',
        database: 'E:\\data\\app.db',
      },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'orders', Rows: '5', Data_length: '1024' }],
    });
    mocks.dbQuery.mockResolvedValue({ success: true, data: [] });
    mocks.dbRefreshTableStats.mockReturnValue(refresh.promise);

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        pinnedSidebarDatabases: [],
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
    const load = loaders!.loadTables({ key: 'conn-sqlite-main', dataRef: connection });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(1);
    const initialChildren = mocks.replaceTreeNodeChildren.mock.calls[0][1];
    const findTableNode = (nodes: any[]): any => {
      for (const node of nodes || []) {
        if (node.type === 'table' && node.dataRef?.tableName === 'orders') return node;
        const nested = findTableNode(node.children || []);
        if (nested) return nested;
      }
      return undefined;
    };
    expect(findTableNode(initialChildren).dataRef).toMatchObject({ rowCount: 5, tableSize: 1024 });

    refresh.resolve({
      success: true,
      data: [{ Table: 'orders', Rows: '9', Data_length: '2048' }],
    });
    await act(async () => {
      await load;
    });

    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(2);
    const refreshedChildren = mocks.replaceTreeNodeChildren.mock.calls[1][1];
    expect(findTableNode(refreshedChildren).dataRef).toMatchObject({ rowCount: 9, tableSize: 2048 });
  });

  it('warns and exposes a retry action when extension metadata is incomplete', async () => {
    const connection = {
      id: 'conn-mysql',
      name: 'MySQL',
      dbName: 'app',
      config: { type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', database: 'app' },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];
    mocks.dbGetTables.mockResolvedValue({ success: true, data: [{ Table: 'users' }] });
    mocks.dbQuery.mockResolvedValue({ success: false, message: 'metadata permission denied', data: [] });

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [], tableSortPreference: {}, tableAccessCount: {}, pinnedSidebarTables: [], pinnedSidebarDatabases: [],
        isV2Ui: true, loadingNodesRef: { current: new Set<string>() }, setConnectionStates: vi.fn(), setLoadedKeys: vi.fn(),
        replaceTreeNodeChildren: mocks.replaceTreeNodeChildren, buildRuntimeConfig: (conn) => conn.config,
        buildJVMRuntimeConfig: (conn) => conn.config, buildJVMDiagnosticTreeNodes: () => [], resolveSavedQueryDisplayName: (name) => String(name || ''),
      });
      return null;
    };

    act(() => { renderer = create(<Harness />); });
    await act(async () => {
      await loaders?.loadTables({ key: 'conn-mysql-app', dataRef: connection });
    });

    expect(message.warning).toHaveBeenCalledWith(expect.objectContaining({
      key: 'db-conn-mysql-app-metadata-partial',
      content: expect.anything(),
    }));

    const warningContent = (message.warning as any).mock.calls[0][0].content as React.ReactElement<any>;
    const retryButton = React.Children.toArray(warningContent.props.children)
      .find((child: any) => React.isValidElement(child) && typeof (child as React.ReactElement<any>).props.onClick === 'function') as React.ReactElement<any>;
    expect(retryButton).toBeDefined();
    await act(async () => {
      retryButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.dbGetTables).toHaveBeenCalledTimes(2);
  });

  it('shows a retry action and clears loaded state when base table metadata fails', async () => {
    const connection = {
      id: 'conn-mysql',
      name: 'MySQL',
      dbName: 'app',
      config: { type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', database: 'app' },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];
    mocks.dbGetTables
      .mockResolvedValueOnce({ success: false, message: 'table metadata permission denied' })
      .mockResolvedValueOnce({ success: true, data: [{ Table: 'users' }] });
    const setLoadedKeys = vi.fn();

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [], tableSortPreference: {}, tableAccessCount: {}, pinnedSidebarTables: [], pinnedSidebarDatabases: [],
        isV2Ui: true, loadingNodesRef: { current: new Set<string>() }, setConnectionStates: vi.fn(), setLoadedKeys,
        replaceTreeNodeChildren: mocks.replaceTreeNodeChildren, buildRuntimeConfig: (conn) => conn.config,
        buildJVMRuntimeConfig: (conn) => conn.config, buildJVMDiagnosticTreeNodes: () => [], resolveSavedQueryDisplayName: (name) => String(name || ''),
      });
      return null;
    };

    act(() => { renderer = create(<Harness />); });
    const node = { key: 'conn-mysql-app', dataRef: connection };
    await act(async () => {
      await loaders?.loadTables(node);
    });

    expect(setLoadedKeys).toHaveBeenCalled();
    expect(message.error).toHaveBeenCalledWith(expect.objectContaining({
      key: 'db-conn-mysql-app-tables',
      content: expect.anything(),
    }));
    const errorContent = (message.error as any).mock.calls[0][0].content as React.ReactElement<any>;
    const retryButton = React.Children.toArray(errorContent.props.children)
      .find((child: any) => React.isValidElement(child) && typeof (child as React.ReactElement<any>).props.onClick === 'function') as React.ReactElement<any>;
    expect(retryButton).toBeDefined();
    await act(async () => {
      retryButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dbGetTables).toHaveBeenCalledTimes(2);
    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(1);
  });

  it('warns when table metadata scanning is truncated', async () => {
    const connection = {
      id: 'conn-redis',
      name: 'Redis',
      dbName: '0',
      config: { type: 'redis', host: '127.0.0.1', port: 6379, database: '0' },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'orders' }],
      partial: true,
      truncated: true,
      scannedCount: 1,
      message: 'Redis key scan truncated after 1 keys: invalid cursor',
    });

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [], tableSortPreference: {}, tableAccessCount: {}, pinnedSidebarTables: [], pinnedSidebarDatabases: [],
        isV2Ui: true, loadingNodesRef: { current: new Set<string>() }, setConnectionStates: vi.fn(), setLoadedKeys: vi.fn(),
        replaceTreeNodeChildren: mocks.replaceTreeNodeChildren, buildRuntimeConfig: (conn) => conn.config,
        buildJVMRuntimeConfig: (conn) => conn.config, buildJVMDiagnosticTreeNodes: () => [], resolveSavedQueryDisplayName: (name) => String(name || ''),
      });
      return null;
    };

    act(() => { renderer = create(<Harness />); });
    await act(async () => {
      await loaders?.loadTables({ key: 'conn-redis-0', dataRef: connection });
    });

    expect(message.warning).toHaveBeenCalledWith(expect.objectContaining({
      key: 'db-conn-redis-0-tables-partial',
      content: expect.anything(),
    }));
  });
});
