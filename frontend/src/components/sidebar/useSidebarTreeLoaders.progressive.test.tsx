import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedConnection } from '../../types';
import { sidebarSchemaNodeKey } from './sidebarSchemaLoading';
import {
  SIDEBAR_DATABASE_TREE_FIRST_COMMIT_GRACE_MS,
  useSidebarTreeLoaders,
} from './useSidebarTreeLoaders';

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

vi.mock('antd', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  message: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../store', async () => {
  const actual = await vi.importActual<typeof import('../../store')>('../../store');
  const useStore = Object.assign(vi.fn(), { getState: () => mocks.storeState });
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

const flatten = (nodes: any[]): any[] => {
  const out: any[] = [];
  const queue = [...(nodes || [])];
  while (queue.length) {
    const node = queue.shift();
    if (!node) continue;
    out.push(node);
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  return out;
};

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

describe('useSidebarTreeLoaders progressive schema commit', () => {
  let renderer: ReactTestRenderer | null = null;
  const connection = {
    id: 'conn-kb',
    name: 'KingBase',
    dbName: 'lab',
    config: { type: 'kingbase', host: '127.0.0.1', port: 54321, user: 'system', database: 'lab' },
  } as SavedConnection & { dbName: string };

  const mountLoaders = () => {
    let loaders: ReturnType<typeof useSidebarTreeLoaders> | undefined;
    const Harness = () => {
      loaders = useSidebarTreeLoaders({
        savedQueries: [],
        tableSortPreference: {},
        tableAccessCount: {},
        pinnedSidebarTables: [],
        pinnedSidebarDatabases: [],
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
    act(() => { renderer = create(<Harness />); });
    return () => loaders!;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.connections = [connection];
    mocks.replaceTreeNodeChildren.mockImplementation((_key, children) => children || []);
    mocks.dbRefreshTableStats.mockResolvedValue({ success: false });
    mocks.dbGetTables.mockResolvedValue({
      success: true,
      data: [{ Table: 'dbms_job.lab_customers', Rows: '5000' }],
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it('commits the table groups before slow view/routine queries and fills them in later', async () => {
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    mocks.dbQuery.mockImplementation(async (_config, _dbName, sql: string) => {
      if (/FROM pg_namespace|schema_name FROM/i.test(sql) && !/pg_views|proname|sequence_name|trigger_name/i.test(sql)) {
        return { success: true, data: [{ schema_name: 'dbms_job' }] };
      }
      if (/pg_views/i.test(sql)) {
        await slowGate;
        return { success: true, data: [{ schema_name: 'dbms_job', view_name: 'v_customers' }] };
      }
      if (/proname|sequence_name|trigger_name|obj_description/i.test(sql)) {
        await slowGate;
      }
      return { success: true, data: [] };
    });

    const getLoaders = mountLoaders();
    let loadDone = false;
    let loadPromise: Promise<void> | undefined;
    await act(async () => {
      loadPromise = getLoaders().loadTables({ key: sidebarSchemaNodeKey('conn-kb-lab', 'dbms_job'), dataRef: { ...connection, groupKey: 'schema', schemaName: 'dbms_job', schemaLazy: true } }).then(() => { loadDone = true; });
      await sleep(SIDEBAR_DATABASE_TREE_FIRST_COMMIT_GRACE_MS + 60);
    });

    expect(loadDone).toBe(false);
    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(1);
    const provisional = flatten(mocks.replaceTreeNodeChildren.mock.calls[0][1]);
    expect(provisional.some((node) => node.type === 'table' && /lab_customers/.test(String(node.dataRef?.tableName)))).toBe(true);
    expect(provisional.some((node) => node.type === 'view')).toBe(false);

    await act(async () => {
      releaseSlow();
      await loadPromise;
    });
    expect(loadDone).toBe(true);
    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(2);
    const complete = flatten(mocks.replaceTreeNodeChildren.mock.calls[1][1]);
    expect(complete.some((node) => node.type === 'table' && /lab_customers/.test(String(node.dataRef?.tableName)))).toBe(true);
    expect(complete.some((node) => node.type === 'view' && /v_customers/.test(String(node.dataRef?.viewName)))).toBe(true);
    // Keys must be stable across both commits so expansion and selection survive the refill.
    const provisionalKeys = new Set(provisional.map((node) => String(node.key)));
    complete
      .filter((node) => node.type === 'table' || node.dataRef?.groupKey === 'schema' || node.dataRef?.groupKey === 'tables')
      .forEach((node) => { expect(provisionalKeys.has(String(node.key))).toBe(true); });
  });

  it('publishes tables then objects without a grace delay when all requests answer quickly', async () => {
    mocks.dbQuery.mockImplementation(async (_config, _dbName, sql: string) => {
      if (/pg_views/i.test(sql)) return { success: true, data: [{ schema_name: 'dbms_job', view_name: 'v_customers' }] };
      if (/FROM pg_namespace|schema_name FROM/i.test(sql)) return { success: true, data: [{ schema_name: 'dbms_job' }] };
      return { success: true, data: [] };
    });
    const getLoaders = mountLoaders();
    await act(async () => {
      await getLoaders().loadTables({ key: sidebarSchemaNodeKey('conn-kb-lab', 'dbms_job'), dataRef: { ...connection, groupKey: 'schema', schemaName: 'dbms_job', schemaLazy: true } });
    });
    expect(mocks.replaceTreeNodeChildren).toHaveBeenCalledTimes(2);
    const nodes = flatten(mocks.replaceTreeNodeChildren.mock.calls[1][1]);
    expect(nodes.some((node) => node.type === 'view')).toBe(true);
  });
});
