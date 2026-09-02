import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from 'antd';

import type { SavedConnection } from '../../types';
import { buildSidebarDatabasePinKey } from '../../store';
import { t } from '../../i18n';
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

const flattenTreeNodes = (nodes: any[]): any[] => {
  const result: any[] = [];
  const pending = [...(nodes || [])];
  while (pending.length > 0) {
    const node = pending.shift();
    if (!node) continue;
    result.push(node);
    if (Array.isArray(node.children)) pending.push(...node.children);
  }
  return result;
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

  it('trims and deduplicates database metadata while preserving response order', async () => {
    const connection = {
      id: 'conn-database-dedupe',
      name: 'MySQL',
      config: {
        type: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
      },
    } as SavedConnection;
    mocks.storeState.connections = [connection];
    mocks.dbGetDatabases.mockResolvedValue({
      success: true,
      data: [
        { Database: '  analytics  ' },
        { database: 'analytics' },
        { Database: '   ' },
        { Database: 'archive' },
        { Database: ' archive ' },
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
        isV2Ui: false,
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
    expect(databaseNodes.map((node: any) => node.title)).toEqual([
      'analytics',
      'archive',
    ]);
    expect(new Set(databaseNodes.map((node: any) => node.key)).size).toBe(2);
  });

  it('reports a successful empty Elasticsearch cluster as no indices instead of a permission problem', async () => {
    const connection = {
      id: 'conn-elasticsearch-empty',
      name: 'Elasticsearch',
      config: {
        type: 'elasticsearch',
        host: '127.0.0.1',
        port: 9200,
      },
    } as SavedConnection;
    mocks.storeState.connections = [connection];
    mocks.dbGetDatabases.mockResolvedValue({ success: true, data: [] });

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        pinnedSidebarDatabases: [],
        isV2Ui: false,
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

    expect(message.info).toHaveBeenCalledWith({
      content: t('sidebar.message.elasticsearch_no_indices'),
      key: `conn-${connection.id}-dbs`,
    });
    expect(message.warning).not.toHaveBeenCalled();
    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledWith(
      connection.id,
      undefined,
      connection,
    );
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

  it('matches PostgreSQL status metadata when the table list omits its schema', async () => {
    const connection = {
      id: 'conn-pg-unqualified-metadata',
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
      data: [{ Table: 'orders' }],
    });
    mocks.dbQuery.mockImplementation(async (_config, _dbName, sql: string) => {
      if (sql.includes('partition_parent_table')) {
        return {
          success: true,
          data: [{
            table_name: 'public.orders',
            table_rows: 42,
            table_comment: 'orders metadata',
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
        key: 'conn-pg-unqualified-metadata-analytics',
        dataRef: connection,
      });
    });

    const [, databaseChildren] = mocks.replaceTreeNodeChildren.mock.calls[0];
    const findTableNode = (nodes: any[]): any => {
      for (const node of nodes || []) {
        if (node.type === 'table' && node.dataRef?.tableName === 'orders') return node;
        const nested = findTableNode(node.children || []);
        if (nested) return nested;
      }
      return undefined;
    };
    const ordersNode = findTableNode(databaseChildren);
    expect(ordersNode?.dataRef).toMatchObject({
      rowCount: 42,
      tableComment: 'orders metadata',
    });
  });

  it('renders a repeated Kingbase table once while preserving the same table in another schema', async () => {
    const connection = {
      id: 'conn-kingbase',
      name: 'Kingbase',
      dbName: 'ldf_server_dbs_dev',
      config: {
        type: 'kingbase',
        host: '127.0.0.1',
        port: 54321,
        user: 'system',
        database: 'ldf_server_dbs_dev',
      },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [
        { Table: 'ldf_server.ldf_application_type' },
        { Table: 'ldf_server.ldf_application_type' },
        { Table: 'LDF_SERVER.LDF_APPLICATION_TYPE' },
        { Table: 'archive.ldf_application_type' },
      ],
    });
    mocks.dbQuery.mockResolvedValue({ success: true, data: [] });

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
        key: 'conn-kingbase-ldf_server_dbs_dev',
        dataRef: connection,
      });
    });

    const [, databaseChildren] = mocks.replaceTreeNodeChildren.mock.calls[0];
    const findSchemaTables = (schemaName: string) => {
      const schemaNode = databaseChildren.find(
        (node: any) => node.dataRef?.groupKey === 'schema' && node.dataRef?.schemaName === schemaName,
      );
      return schemaNode.children.find((node: any) => node.dataRef?.groupKey === 'tables');
    };
    const ldfTables = findSchemaTables('ldf_server');
    const upperLdfTables = findSchemaTables('LDF_SERVER');
    const archiveTables = findSchemaTables('archive');
    const ldfNodes = ldfTables.children.filter((node: any) => node.type === 'table');
    const upperLdfNodes = upperLdfTables.children.filter((node: any) => node.type === 'table');
    const archiveNodes = archiveTables.children.filter((node: any) => node.type === 'table');

    expect(ldfNodes).toHaveLength(1);
    expect(ldfNodes[0].dataRef.tableName).toBe('ldf_server.ldf_application_type');
    expect(upperLdfNodes).toHaveLength(1);
    expect(upperLdfNodes[0].dataRef.tableName).toBe('LDF_SERVER.LDF_APPLICATION_TYPE');
    expect(archiveNodes).toHaveLength(1);
    expect(archiveNodes[0].dataRef.tableName).toBe('archive.ldf_application_type');
    expect(ldfNodes[0].key).not.toBe(archiveNodes[0].key);
    expect(ldfNodes[0].key).not.toBe(upperLdfNodes[0].key);
  });

  it('keeps every key unique across a complete Kingbase object fixture', async () => {
    const connection = {
      id: 'conn-kingbase-complete',
      name: 'Kingbase complete fixture',
      dbName: 'analytics',
      config: {
        type: 'kingbase',
        host: '127.0.0.1',
        port: 54321,
        user: 'system',
        database: 'analytics',
      },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [
        { Table: 'public.orders' },
        { Table: 'public.orders' },
        { Table: 'public.customers' },
      ],
    });
    mocks.dbQuery.mockImplementation(async (_config, _dbName, sql: string) => {
      if (sql.includes('obj_description(c.oid')) {
        return {
          success: true,
          data: [
            { table_name: 'public.orders', table_rows: 12 },
            { table_name: 'public.customers', table_rows: 4 },
          ],
        };
      }
      if (sql.includes('FROM pg_namespace')) {
        return { success: true, data: [{ schema_name: 'public' }, { schema_name: 'public' }] };
      }
      if (sql.includes('pg_catalog.pg_views')) {
        return {
          success: true,
          data: [
            { schema_name: 'public', view_name: 'orders_view' },
            { schema_name: 'public', view_name: 'orders_view' },
          ],
        };
      }
      if (sql.includes('FROM pg_proc')) {
        return {
          success: true,
          data: [
            { schema_name: 'public', routine_name: 'refresh_orders', routine_type: 'FUNCTION' },
            { schema_name: 'public', routine_name: 'refresh_orders', routine_type: 'FUNCTION' },
          ],
        };
      }
      if (sql.includes('information_schema.triggers')) {
        return {
          success: true,
          data: [
            { schema_name: 'public', table_name: 'orders', trigger_name: 'orders_audit' },
            { schema_name: 'public', table_name: 'orders', trigger_name: 'orders_audit' },
          ],
        };
      }
      if (sql.includes('information_schema.sequences')) {
        return {
          success: true,
          data: [
            { schema_name: 'public', sequence_name: 'orders_id_seq' },
            { schema_name: 'public', sequence_name: 'orders_id_seq' },
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
        key: 'conn-kingbase-complete-analytics',
        dataRef: connection,
      });
    });

    const [, databaseChildren] = mocks.replaceTreeNodeChildren.mock.calls[0];
    const nodes = flattenTreeNodes(databaseChildren);
    const keys = nodes.map((node) => String(node.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(nodes.filter((node) => node.type === 'table')).toHaveLength(2);
    expect(nodes.filter((node) => node.type === 'view')).toHaveLength(1);
    expect(nodes.filter((node) => node.type === 'routine')).toHaveLength(1);
    expect(nodes.filter((node) => node.type === 'db-trigger')).toHaveLength(1);
    expect(nodes.filter((node) => node.type === 'sequence')).toHaveLength(1);
  });

  it('keeps an empty schema bucket distinct from a schema literally named default', async () => {
    const connection = {
      id: 'conn-pg-default-schema',
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
        { Table: 'unscoped_orders' },
        { Table: 'default.orders' },
      ],
    });
    mocks.dbQuery.mockResolvedValue({ success: true, data: [] });

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
        key: 'conn-pg-default-schema-analytics',
        dataRef: connection,
      });
    });

    const [, databaseChildren] = mocks.replaceTreeNodeChildren.mock.calls[0];
    const schemaNodes = databaseChildren.filter((node: any) => node.dataRef?.groupKey === 'schema');
    const emptySchema = schemaNodes.find((node: any) => node.dataRef?.schemaName === '');
    const defaultSchema = schemaNodes.find((node: any) => node.dataRef?.schemaName === 'default');
    const getTableNames = (schemaNode: any) => schemaNode.children
      .find((node: any) => node.dataRef?.groupKey === 'tables').children
      .filter((node: any) => node.type === 'table')
      .map((node: any) => node.dataRef.tableName);

    expect(emptySchema).toBeDefined();
    expect(defaultSchema).toBeDefined();
    expect(emptySchema.key).not.toBe(defaultSchema.key);
    expect(new Set(schemaNodes.map((node: any) => node.key)).size).toBe(schemaNodes.length);
    expect(getTableNames(emptySchema)).toEqual(['unscoped_orders']);
    expect(getTableNames(defaultSchema)).toEqual(['default.orders']);
  });

  it('uses distinct keys for case-sensitive schemas even when the database name matches one schema', async () => {
    const connection = {
      id: 'conn-case-sensitive-kingbase',
      name: 'Kingbase case-sensitive',
      dbName: 'LDF_SERVER',
      config: {
        type: 'kingbase',
        host: '127.0.0.1',
        port: 54321,
        user: 'system',
        database: 'LDF_SERVER',
      },
    } as SavedConnection & { dbName: string };
    mocks.storeState.connections = [connection];
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [
        { Table: 'LDF_SERVER.orders' },
        { Table: 'ldf_server.orders' },
      ],
    });
    mocks.dbQuery.mockResolvedValue({ success: true, data: [] });

    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        pinnedSidebarDatabases: [],
        isV2Ui: false,
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
        key: 'conn-case-sensitive-kingbase-LDF_SERVER',
        dataRef: connection,
      });
    });

    const [, databaseChildren] = mocks.replaceTreeNodeChildren.mock.calls[0];
    const tableNodes = databaseChildren
      .flatMap((node: any) => node.children || [])
      .flatMap((node: any) => node.children || [])
      .filter((node: any) => node.type === 'table');
    expect(tableNodes.map((node: any) => node.dataRef.tableName)).toEqual([
      'LDF_SERVER.orders',
      'ldf_server.orders',
    ]);
    expect(tableNodes[0].key).not.toBe(tableNodes[1].key);
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
