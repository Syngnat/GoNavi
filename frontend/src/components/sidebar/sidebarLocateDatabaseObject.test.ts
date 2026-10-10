import { describe, expect, it, vi } from 'vitest';

import {
  collectSidebarLocateExpandKeys,
  normalizeSidebarLocateObjectRequest,
  resolveSidebarLocateTarget,
  type SidebarLocateDatabaseObjectRequest,
  type SidebarLocateTreeNodeLike,
} from '../../utils/sidebarLocate';
import {
  ensureSidebarLocatePresent,
  revealSidebarLocateStage,
  runSidebarLocateDatabaseObject,
  waitForSidebarLocateLoadKey,
} from './sidebarLocateDatabaseObject';

const findNodeByKey = (
  nodes: SidebarLocateTreeNodeLike[],
  targetKey: string,
): SidebarLocateTreeNodeLike | null => {
  for (const node of nodes) {
    if (String(node.key) === targetKey) {
      return node;
    }
    if (node.children) {
      const child = findNodeByKey(node.children, targetKey);
      if (child) {
        return child;
      }
    }
  }
  return null;
};

const buildCollapsedHostTree = (): SidebarLocateTreeNodeLike[] => ([
  {
    key: 'group-lab',
    children: [
      {
        key: 'conn-kb',
        type: 'connection',
        dataRef: { id: 'conn-kb' },
      },
    ],
  },
]);

const attachDatabase = (tree: SidebarLocateTreeNodeLike[]) => {
  const connection = findNodeByKey(tree, 'conn-kb');
  if (!connection) {
    throw new Error('missing connection node');
  }
  connection.children = [{
    key: 'conn-kb-dbms_job',
    type: 'database',
    dataRef: { id: 'conn-kb', dbName: 'dbms_job' },
  }];
};

const attachTable = (tree: SidebarLocateTreeNodeLike[]) => {
  const database = findNodeByKey(tree, 'conn-kb-dbms_job');
  if (!database) {
    throw new Error('missing database node');
  }
  database.children = [{
    key: 'conn-kb-dbms_job-tables',
    type: 'object-group',
    children: [{
      key: 'conn-kb-dbms_job-lab_customers',
      type: 'table',
      dataRef: {
        id: 'conn-kb',
        dbName: 'dbms_job',
        tableName: 'lab_customers',
      },
    }],
  }];
};

const buildLocateRequest = (): SidebarLocateDatabaseObjectRequest => {
  const request = normalizeSidebarLocateObjectRequest({
    connectionId: 'conn-kb',
    dbName: 'dbms_job',
    tableName: 'lab_customers',
    objectGroup: 'tables',
  });
  if (!request || request.objectGroup !== 'tables') {
    throw new Error('expected table locate request');
  }
  return request;
};

describe('sidebarLocateDatabaseObject', () => {
  it('loads the target schema before locating a table in an unexpanded schema', async () => {
    const tree = buildCollapsedHostTree();
    attachDatabase(tree);
    const request = { ...buildLocateRequest(), tableName: 'public.lab_customers', schemaName: 'public' };
    const target = resolveSidebarLocateTarget(request, { groupBySchema: true });
    const dbNode = findNodeByKey(tree, target.databaseKey)!;
    const calls: string[] = [];
    const outcome = await runSidebarLocateDatabaseObject({
      request, target, objectLabel: 'table', getTree: () => tree, findNode: (key) => findNodeByKey(tree, key),
      mergeExpandedTreeKeys: vi.fn(), revealNode: vi.fn(), loadDatabases: vi.fn(), isLoadPending: () => false,
      loadTables: async (node) => {
        calls.push(String(node.key));
        if (node.key === target.databaseKey) {
          dbNode.children = [{ key: target.schemaKey!, type: 'object-group', dataRef: { groupKey: 'schema', schemaName: 'public', schemaLazy: true } }];
        } else if (node.key === target.schemaKey) {
          node.children = [{ key: target.objectGroupKey, type: 'object-group', dataRef: { groupKey: 'tables' }, children: [{
            key: target.targetKey, type: 'table', dataRef: { id: request.connectionId, dbName: request.dbName, schemaName: 'public', tableName: request.tableName },
          }] }];
        }
      },
      poll: { attempts: 2, sleep: async () => undefined },
    });
    expect(outcome.status).toBe('located');
    expect(calls).toEqual([target.databaseKey, target.schemaKey]);
  });
  it('expands grouped hosts including the connection itself', () => {
    const tree = buildCollapsedHostTree();
    expect(collectSidebarLocateExpandKeys(tree, 'conn-kb')).toEqual([
      'group-lab',
      'conn-kb',
    ]);
    expect(collectSidebarLocateExpandKeys(tree, 'conn-kb', { includeSelf: false })).toEqual([
      'group-lab',
    ]);
  });

  it('reveals the host path before waiting for databases', () => {
    const tree = buildCollapsedHostTree();
    const expanded: string[][] = [];
    const keys = revealSidebarLocateStage(
      tree,
      'conn-kb',
      'connection',
      (nextKeys) => {
        expanded.push(nextKeys.map(String));
      },
    );
    expect(keys).toEqual(['group-lab', 'conn-kb']);
    expect(expanded).toEqual([['group-lab', 'conn-kb']]);
  });

  it('waits for an in-flight load instead of treating a no-op start as ready', async () => {
    const pending = new Set(['dbs-conn-kb']);
    const status = await ensureSidebarLocatePresent({
      isPresent: () => false,
      loadKey: 'dbs-conn-kb',
      isLoadPending: (loadKey) => pending.has(loadKey),
      startLoad: async () => undefined,
      attempts: 20,
      sleep: async () => undefined,
    });
    expect(status).toBe('timeout');
  });

  it('returns once a pending load finishes', async () => {
    let present = false;
    const pending = new Set(['dbs-conn-kb']);
    const statusPromise = ensureSidebarLocatePresent({
      isPresent: () => present,
      loadKey: 'dbs-conn-kb',
      isLoadPending: (loadKey) => pending.has(loadKey),
      startLoad: async () => undefined,
      attempts: 200,
      sleep: async () => undefined,
    });
    pending.delete('dbs-conn-kb');
    present = true;
    await expect(statusPromise).resolves.toBe('ready');
  });

  it('expands the target host and shows connecting before tables exist', async () => {
    const tree = buildCollapsedHostTree();
    const request = buildLocateRequest();
    const target = resolveSidebarLocateTarget(request, { groupBySchema: false });
    const expanded: string[][] = [];
    const revealed: Array<{ key: string; stage: string }> = [];
    const pending = new Set<string>();
    let releaseDatabases: () => void = () => undefined;
    let releaseTables: () => void = () => undefined;
    const databasesGate = new Promise<void>((resolve) => {
      releaseDatabases = resolve;
    });
    const tablesGate = new Promise<void>((resolve) => {
      releaseTables = resolve;
    });

    const outcomePromise = runSidebarLocateDatabaseObject({
      request,
      target,
      objectLabel: 'table',
      getTree: () => tree,
      findNode: (key) => findNodeByKey(tree, key),
      mergeExpandedTreeKeys: (keys) => {
        expanded.push(keys.map(String));
      },
      revealNode: (key, _node, stage) => {
        revealed.push({ key, stage });
      },
      loadDatabases: async () => {
        pending.add('dbs-conn-kb');
        await databasesGate;
        attachDatabase(tree);
        pending.delete('dbs-conn-kb');
      },
      loadTables: async () => {
        pending.add('tables-conn-kb-dbms_job');
        await tablesGate;
        attachTable(tree);
        pending.delete('tables-conn-kb-dbms_job');
      },
      isLoadPending: (loadKey) => pending.has(loadKey),
      poll: { intervalMs: 1, attempts: 200, sleep: async () => undefined },
    });

    expect(expanded[0]).toEqual(['group-lab', 'conn-kb']);
    expect(revealed).toEqual([{ key: 'conn-kb', stage: 'connection' }]);
    expect(findNodeByKey(tree, 'conn-kb-dbms_job')).toBeNull();

    releaseDatabases();
    releaseTables();
    const outcome = await outcomePromise;
    expect(outcome).toMatchObject({
      status: 'located',
      targetKey: 'conn-kb-dbms_job-lab_customers',
    });
    expect(revealed.map((item) => item.stage)).toEqual(['connection', 'database', 'object']);
    expect(expanded[expanded.length - 1]).toEqual([
      'group-lab',
      'conn-kb',
      'conn-kb-dbms_job',
      'conn-kb-dbms_job-tables',
    ]);
  });

  it('still waits when an in-flight database load returns immediately', async () => {
    const tree = buildCollapsedHostTree();
    const request = buildLocateRequest();
    const target = resolveSidebarLocateTarget(request, { groupBySchema: false });
    const pending = new Set(['dbs-conn-kb']);
    const revealed: string[] = [];
    let releaseDatabases: () => void = () => undefined;
    const databasesGate = new Promise<void>((resolve) => {
      releaseDatabases = resolve;
    });

    const outcomePromise = runSidebarLocateDatabaseObject({
      request,
      target,
      objectLabel: 'table',
      getTree: () => tree,
      findNode: (key) => findNodeByKey(tree, key),
      mergeExpandedTreeKeys: vi.fn(),
      revealNode: (key) => {
        revealed.push(key);
      },
      loadDatabases: async () => undefined,
      loadTables: async () => {
        attachTable(tree);
      },
      isLoadPending: (loadKey) => pending.has(loadKey),
      poll: { intervalMs: 1, attempts: 200, sleep: async () => undefined },
    });

    await Promise.resolve();
    expect(revealed).toEqual(['conn-kb']);
    attachDatabase(tree);
    pending.delete('dbs-conn-kb');
    releaseDatabases();
    await expect(outcomePromise).resolves.toMatchObject({
      status: 'located',
      targetKey: 'conn-kb-dbms_job-lab_customers',
    });
  });
});
