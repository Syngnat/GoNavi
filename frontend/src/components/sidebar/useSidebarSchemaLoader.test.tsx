import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedConnection, SavedQuery } from '../../types';
import { useSidebarTreeLoaders } from './useSidebarTreeLoaders';
import { buildSidebarSchemaTableEntries, sidebarSchemaLoadKey, sidebarSchemaNodeKey } from './sidebarSchemaLoading';
import { shouldLoadSidebarNodeOnExpand } from './sidebarHelpers';
import { shouldLoadSidebarNodeOnExpand as shouldLoadV2Node } from './sidebarV2TreeNodes';
import { resolveSidebarSwitcherLoadKey } from './sidebarSwitcherState';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), tables: vi.fn(), databases: vi.fn(),
  state: { connections: [] as SavedConnection[], tableSortPreference: {}, tableAccessCount: {}, pinnedSidebarTables: [], pinnedSidebarDatabases: [] },
}));
vi.mock('../../../wailsjs/go/app/App', () => ({
  DBQuery: mocks.query, DBGetTables: mocks.tables, DBGetDatabases: mocks.databases,
  DBRefreshTableStats: vi.fn(), GetDriverStatusList: vi.fn(), JVMProbeCapabilities: vi.fn(),
}));
vi.mock('antd', () => ({ message: { error: vi.fn(), warning: vi.fn(), info: vi.fn() }, Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock('../../store', async () => ({ ...(await vi.importActual<typeof import('../../store')>('../../store')), useStore: Object.assign(vi.fn(), { getState: () => mocks.state }) }));

describe('sidebar schema lazy loading', () => {
  let renderer: ReactTestRenderer;
  let loaders: ReturnType<typeof useSidebarTreeLoaders>;
  let tree: any[];
  let expanded: string[];
  let loading: Set<string>;
  let loadedKeys: React.Key[];
  let savedQueries: SavedQuery[];
  let redraw: () => void;
  const connection = { id: 'pg', name: 'PG', config: { type: 'postgres', database: 'app', host: 'localhost', port: 5432 } } as SavedConnection;
  const find = (key: string, nodes = tree): any => {
    for (const node of nodes) { if (node.key === key) return node; const child = find(key, node.children || []); if (child) return child; }
  };
  const mount = () => {
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries, tableSortPreference: {}, tableAccessCount: {}, pinnedSidebarTables: [], pinnedSidebarDatabases: [],
        loadingNodesRef: { current: loading }, setConnectionStates: vi.fn(), setLoadedKeys: (next) => { loadedKeys = typeof next === 'function' ? next(loadedKeys) : next; },
        replaceTreeNodeChildren: (key, children, dataRef) => {
          const node = find(String(key)); node.children = children; if (dataRef) node.dataRef = dataRef;
          return tree;
        },
        buildRuntimeConfig: (conn) => conn.config, buildJVMRuntimeConfig: (conn) => conn.config,
        buildJVMDiagnosticTreeNodes: () => [], resolveSavedQueryDisplayName: (name) => String(name),
        getTree: () => tree, setExpandedKeys: (next) => { expanded = (typeof next === 'function' ? next(expanded) : next).map(String); },
      });
      return null;
    };
    act(() => { renderer = create(<Harness />); });
    redraw = () => { act(() => renderer.update(<Harness />)); };
  };
  beforeEach(() => {
    vi.clearAllMocks(); loading = new Set(); expanded = []; loadedKeys = []; savedQueries = [];
    mocks.state.connections = [connection];
    tree = [{ key: 'pg-app', type: 'database', dataRef: { ...connection, dbName: 'app' } }];
    mocks.query.mockImplementation(async (_config, _database, sql: string) => ({ success: true, data: sql.includes('FROM pg_namespace WHERE') ? [{ schema_name: 'public' }, { schema_name: 'sales' }] : [] }));
    mocks.tables.mockImplementation(async (config) => ({ success: true, data: [{ Table: `${config.metadataScope?.schemas.names[0] || 'public'}.users` }] }));
  });
  afterEach(() => { act(() => renderer?.unmount()); });

  it('shows schema nodes without requesting tables, objects or relation sizes', async () => {
    mount();
    await act(async () => { await loaders.loadTables(tree[0]); });
    expect(mocks.tables).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const schemas = tree[0].children.filter((node: any) => node.dataRef?.groupKey === 'schema');
    expect(schemas.map((node: any) => node.title)).toEqual(['public', 'sales']);
    for (const node of schemas) {
      expect(node.isLeaf).toBe(false); expect(node.children).toBeUndefined();
      expect(shouldLoadSidebarNodeOnExpand(node)).toBe(true);
      expect(shouldLoadV2Node(node)).toBe(true);
      expect(resolveSidebarSwitcherLoadKey({ data: node })).toBe(sidebarSchemaLoadKey('pg', 'app', node.title));
    }
  });

  it('requests only the expanded schema and does not wait for relation statistics to display tables', async () => {
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const schema = tree[0].children.find((node: any) => node.title === 'sales');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.query.mockImplementation(async (_config, _database, sql: string) => {
      if (sql.includes('pg_total_relation_size')) await gate;
      return { success: true, data: sql.includes('pg_total_relation_size') ? [{ table_name: 'sales.users', table_rows: 4, table_size: 8192 }] : [] };
    });
    let task!: Promise<void>;
    await act(async () => { task = loaders.loadTables(schema); await new Promise((resolve) => setTimeout(resolve, 20)); });
    try {
      expect(mocks.tables.mock.calls[0][0].metadataScope.schemas.names).toEqual(['sales']);
      expect(schema.children.some((node: any) => node.dataRef.groupKey === 'tables')).toBe(true);
      const group = schema.children.find((node: any) => node.dataRef.groupKey === 'tables');
      expect(group.dataRef.schemaLazy).toBe(true);
      for (const [, , sql] of mocks.query.mock.calls.slice(1)) expect(sql).toContain("IN ('sales')");
    } finally { await act(async () => { release(); await task; }); }
    const table = schema.children.find((node: any) => node.dataRef.groupKey === 'tables').children[0];
    expect(table.dataRef.tableSize).toBe(8192);
    expect(loading.size).toBe(0);
  });

  it('refreshes a single schema without reloading its sibling', async () => {
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const publicNode = tree[0].children.find((node: any) => node.title === 'public');
    const salesNode = tree[0].children.find((node: any) => node.title === 'sales');
    await act(async () => { await loaders.loadTables(publicNode); await loaders.loadTables(salesNode); });
    const publicChildren = publicNode.children;
    mocks.tables.mockClear();
    await act(async () => { await loaders.loadTables(salesNode, { ensureFresh: true }); });
    expect(mocks.tables).toHaveBeenCalledTimes(1);
    expect(publicNode.children).toBe(publicChildren);
  });

  it('database refresh only discovers schema names even when schema expansion was remembered', async () => {
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const publicNode = tree[0].children.find((node: any) => node.title === 'public');
    const salesNode = tree[0].children.find((node: any) => node.title === 'sales');
    await act(async () => { await loaders.loadTables(publicNode); await loaders.loadTables(salesNode); });
    expanded = [tree[0].key, salesNode.key]; mocks.tables.mockClear();
    await act(async () => { await loaders.loadTables(tree[0], { ensureFresh: true }); });
    expect(mocks.tables).not.toHaveBeenCalled();
    expect(find(publicNode.key).children).toBeUndefined();
    expect(find(salesNode.key).children).toBeUndefined();
    expect(expanded).toEqual([tree[0].key]);
    await act(async () => { await loaders.loadTables(find(salesNode.key)); });
    expect(mocks.tables).toHaveBeenCalledTimes(1);
    expect(mocks.tables.mock.calls[0][0].metadataScope.schemas.names).toEqual(['sales']);
  });

  it('initial database expansion loads only schema names even with persisted schema keys', async () => {
    const otherDatabase = 'pg-app-schema-backup';
    const otherSchema = sidebarSchemaNodeKey(otherDatabase, 'public');
    expanded = ['pg-app', sidebarSchemaNodeKey('pg-app', 'sales'), otherDatabase, otherSchema];
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    expect(mocks.tables).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(expanded).toEqual(['pg-app', otherDatabase, otherSchema]);
  });

  it('updating saved queries preserves expanded schema contents without querying metadata', async () => {
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const schema = tree[0].children.find((node: any) => node.title === 'sales');
    await act(async () => { await loaders.loadTables(schema); });
    expanded = ['pg-app', schema.key]; const children = schema.children;
    savedQueries = [{ id: 'query-1', name: 'Saved query', connectionId: 'pg', dbName: 'app', sql: 'SELECT 1', createdAt: Date.now() }];
    redraw(); mocks.tables.mockClear(); mocks.query.mockClear();
    await act(async () => { await loaders.loadTables(tree[0], { ensureFresh: true, savedQueriesOnly: true }); });
    expect(mocks.tables).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
    expect(find(schema.key).children).toBe(children);
    expect(expanded).toEqual(['pg-app', schema.key]);
    expect(tree[0].children.find((node: any) => node.type === 'queries-folder').children[0].title).toBe('Saved query');
  });

  it('preserves table details expanded before the statistics response arrives', async () => {
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const schema = tree[0].children.find((node: any) => node.title === 'sales');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.query.mockImplementation(async (_config, _database, sql: string) => {
      if (sql.includes('pg_total_relation_size')) await gate;
      return { success: true, data: sql.includes('pg_total_relation_size') ? [{ table_name: 'sales.users', table_size: 8192 }] : [] };
    });
    let task!: Promise<void>;
    await act(async () => { task = loaders.loadTables(schema); await new Promise((resolve) => setTimeout(resolve, 20)); });
    const table = schema.children.find((node: any) => node.dataRef.groupKey === 'tables').children[0];
    table.children = [{ key: `${table.key}-columns`, type: 'folder-columns', children: [{ key: 'id', type: 'column' }] }];
    try {
      await act(async () => { release(); await task; await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(find(table.key).children[0].children[0].key).toBe('id');
      expect(find(table.key).dataRef.tableSize).toBe(8192);
    } finally { release(); }
  });

  it('starts a fresh schema request without waiting for old statistics and discards its response', async () => {
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const schema = tree[0].children.find((node: any) => node.title === 'sales');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let stats = 0;
    mocks.query.mockImplementation(async (_config, _database, sql: string) => {
      if (!sql.includes('pg_total_relation_size')) return { success: true, data: [] };
      const first = stats++ === 0;
      if (first) await gate;
      return { success: true, data: [{ table_name: 'sales.users', table_size: first ? 1 : 2 }] };
    });
    let task!: Promise<void>; let fresh!: Promise<void>;
    await act(async () => { task = loaders.loadTables(schema); await new Promise((resolve) => setTimeout(resolve, 20)); });
    try {
      await act(async () => { fresh = loaders.loadTables(schema, { ensureFresh: true }); await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(mocks.tables).toHaveBeenCalledTimes(2);
    } finally { await act(async () => { release(); await task; await fresh; await new Promise((resolve) => setTimeout(resolve, 20)); }); }
    expect(schema.children.find((node: any) => node.dataRef.groupKey === 'tables').children[0].dataRef.tableSize).toBe(2);
  });

  it.each([
    ['postgres', 'sales.eu', '"sales.eu"."order.items"'],
    ['sqlserver', 'dbo', '[dbo].[order.items]'],
  ])('matches %s quoted catalog names to separate statistics identifiers', (type, schema, tableName) => {
    const scoped = { ...connection, config: { ...connection.config, type } } as SavedConnection;
    const entries = buildSidebarSchemaTableEntries(scoped, schema, [{ Table: tableName }], [
      { schema_name: schema, object_name: 'order.items', table_rows: 42, table_size: 8192 },
      { schema_name: 'other', object_name: 'order.items', table_rows: 99 },
    ]);
    expect(entries[0].rowCount).toBe(42);
    expect(entries[0].tableSize).toBe(8192);
  });

  it('retains partition grouping and distinct case-sensitive schemas in the lazy path', async () => {
    mocks.query.mockImplementation(async (_config, _database, sql: string) => ({ success: true, data: sql.includes('FROM pg_namespace WHERE') ? [{ schema_name: 'Public' }, { schema_name: 'public' }] : sql.includes('pg_total_relation_size') ? [{ table_name: 'public.orders_1', partition_parent_table: 'public.orders', table_rows: 3 }] : [] }));
    mocks.tables.mockImplementation(async (config) => ({ success: true, data: config.metadataScope.schemas.names[0] === 'public' ? [{ Table: 'public.orders' }, { Table: 'public.orders_1' }] : [{ Table: 'Public.orders' }] }));
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const upper = tree[0].children.find((node: any) => node.title === 'Public');
    const lower = tree[0].children.find((node: any) => node.title === 'public');
    await act(async () => { await loaders.loadTables(upper); await loaders.loadTables(lower); });
    expect(upper.key).not.toBe(lower.key);
    const upperTable = upper.children.find((node: any) => node.dataRef.groupKey === 'tables').children[0];
    const parent = lower.children.find((node: any) => node.dataRef.groupKey === 'tables').children[0];
    expect(upperTable.key).not.toBe(parent.key);
    expect(parent.children.find((node: any) => node.dataRef.groupKey === 'partitions').children[0].dataRef.rowCount).toBe(3);
  });

  it('clears loaded table keys when refreshing their schema while retaining sibling keys', async () => {
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const schema = tree[0].children.find((node: any) => node.title === 'sales');
    await act(async () => { await loaders.loadTables(schema); });
    const table = schema.children.find((node: any) => node.dataRef.groupKey === 'tables').children[0];
    table.children = [{ key: `${table.key}-columns`, type: 'folder-columns' }];
    loadedKeys = [schema.key, table.key, table.children[0].key, 'public-table'];
    await act(async () => { await loaders.loadTables(schema, { ensureFresh: true }); });
    expect(loadedKeys).toEqual(['public-table']);
  });

  it('does not revive a removed connection after a delayed table response', async () => {
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const schema = tree[0].children.find((node: any) => node.title === 'sales');
    let release!: (value: unknown) => void;
    mocks.tables.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    let task!: Promise<void>;
    await act(async () => { task = loaders.loadTables(schema); await Promise.resolve(); });
    loaders.invalidateConnectionLoads('pg'); tree[0].children = undefined;
    await act(async () => { release({ success: true, data: [{ Table: 'sales.users' }] }); await task; });
    expect(tree[0].children).toBeUndefined();
    expect(loading.size).toBe(0);
  });

  it('does not repopulate a database placeholder from pre-refresh schema statistics', async () => {
    mount(); await act(async () => { await loaders.loadTables(tree[0]); });
    const schema = tree[0].children.find((node: any) => node.title === 'sales');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.query.mockImplementation(async (_config, _database, sql: string) => {
      if (sql.includes('pg_total_relation_size')) await gate;
      return { success: true, data: sql.includes('FROM pg_namespace WHERE') ? [{ schema_name: 'sales' }] : sql.includes('pg_total_relation_size') ? [{ table_name: 'sales.users', table_size: 1 }] : [] };
    });
    let task!: Promise<void>;
    await act(async () => { task = loaders.loadTables(schema); await new Promise((resolve) => setTimeout(resolve, 20)); });
    try { await act(async () => { await loaders.loadTables(tree[0], { ensureFresh: true }); }); }
    finally { await act(async () => { release(); await task; }); }
    expect(find(schema.key).children).toBeUndefined();
    expect(find(schema.key).dataRef.schemaLoaded).toBe(false);
    expect(loading.size).toBe(0);
  });
});
