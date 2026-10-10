import {
  collectSidebarLocateExpandKeys,
  findSidebarNodePathByKey,
  findSidebarNodePathForLocate,
  type SidebarLocateDatabaseObjectRequest,
  type SidebarLocateTarget,
  type SidebarLocateTreeNodeLike,
} from '../../utils/sidebarLocate';
import { sidebarSchemaLoadKey } from './sidebarSchemaLoading';

export const SIDEBAR_LOCATE_LOAD_WAIT_INTERVAL_MS = 50;
export const SIDEBAR_LOCATE_LOAD_WAIT_ATTEMPTS = 160;

export type SidebarLocateRevealStage = 'connection' | 'database' | 'object';

export type SidebarLocateDatabaseObjectMessage = {
  level: 'warning' | 'info';
  key: string;
  params?: Record<string, string>;
};

export type SidebarLocateDatabaseObjectOutcome =
  | { status: 'located'; path: string[]; targetKey: string }
  | { status: 'failed'; message: SidebarLocateDatabaseObjectMessage };

type LocateNode = SidebarLocateTreeNodeLike | null;

export type RunSidebarLocateDatabaseObjectArgs = {
  request: SidebarLocateDatabaseObjectRequest;
  target: SidebarLocateTarget;
  objectLabel: string;
  getTree: () => SidebarLocateTreeNodeLike[];
  findNode: (key: string) => LocateNode;
  mergeExpandedTreeKeys: (keys: Array<string | number>) => void;
  revealNode: (key: string, node: LocateNode, stage: SidebarLocateRevealStage) => void;
  loadDatabases: (node: SidebarLocateTreeNodeLike) => Promise<void>;
  loadTables: (node: SidebarLocateTreeNodeLike) => Promise<void>;
  isLoadPending: (loadKey: string) => boolean;
  poll?: SidebarLocatePollOptions;
};

export type SidebarLocatePollOptions = {
  intervalMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const failLocate = (
  key: string,
  params?: Record<string, string>,
): SidebarLocateDatabaseObjectOutcome => ({
  status: 'failed',
  message: { level: 'warning', key, params },
});

const infoLocate = (
  key: string,
  params?: Record<string, string>,
): SidebarLocateDatabaseObjectOutcome => ({
  status: 'failed',
  message: { level: 'info', key, params },
});

export const waitForSidebarLocateLoadKey = async (
  loadKey: string,
  isLoadPending: (loadKey: string) => boolean,
  options?: {
    intervalMs?: number;
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> => {
  const intervalMs = options?.intervalMs ?? SIDEBAR_LOCATE_LOAD_WAIT_INTERVAL_MS;
  const attempts = options?.attempts ?? SIDEBAR_LOCATE_LOAD_WAIT_ATTEMPTS;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
    schedule(resolve, ms);
  }));
  for (let attempt = 0; attempt < attempts && isLoadPending(loadKey); attempt += 1) {
    await sleep(intervalMs);
  }
  return !isLoadPending(loadKey);
};

export const revealSidebarLocateStage = (
  tree: SidebarLocateTreeNodeLike[],
  targetKey: string,
  stage: SidebarLocateRevealStage,
  mergeExpandedTreeKeys: (keys: Array<string | number>) => void,
): string[] => {
  const keys = collectSidebarLocateExpandKeys(tree, targetKey, {
    includeSelf: stage !== 'object',
  });
  mergeExpandedTreeKeys(keys);
  return keys;
};

/**
 * Waits until the target node exists in the tree. The database loader commits the
 * table groups before the slower object kinds arrive, so this polls for presence
 * instead of waiting for the whole load to settle; a load that finishes without the
 * node yields 'missing', and one that outlives the attempt budget yields 'timeout'.
 */
export const ensureSidebarLocatePresent = async ({
  isPresent,
  loadKey,
  isLoadPending,
  startLoad,
  intervalMs = SIDEBAR_LOCATE_LOAD_WAIT_INTERVAL_MS,
  attempts = SIDEBAR_LOCATE_LOAD_WAIT_ATTEMPTS,
  sleep = (ms: number) => new Promise<void>((resolve) => {
    const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
    schedule(resolve, ms);
  }),
}: {
  isPresent: () => boolean;
  loadKey: string;
  isLoadPending: (loadKey: string) => boolean;
  startLoad: () => Promise<void>;
  intervalMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<'ready' | 'timeout' | 'missing'> => {
  if (isPresent()) {
    return 'ready';
  }
  let ownLoadSettled = false;
  let ownLoad: Promise<void> | null = null;
  if (!isLoadPending(loadKey)) {
    ownLoad = startLoad().catch(() => undefined).then(() => {
      ownLoadSettled = true;
    });
  }
  const loadInFlight = () => (ownLoad ? !ownLoadSettled : isLoadPending(loadKey));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isPresent()) {
      return 'ready';
    }
    if (!loadInFlight()) {
      break;
    }
    await sleep(intervalMs);
  }
  if (isPresent()) {
    return 'ready';
  }
  return loadInFlight() ? 'timeout' : 'missing';
};

export const runSidebarLocateDatabaseObject = async (
  args: RunSidebarLocateDatabaseObjectArgs,
): Promise<SidebarLocateDatabaseObjectOutcome> => {
  const {
    request,
    target,
    objectLabel,
    getTree,
    findNode,
    mergeExpandedTreeKeys,
    revealNode,
    loadDatabases,
    loadTables,
    isLoadPending,
    poll,
  } = args;

  const connectionNode = findNode(target.connectionKey);
  if (!connectionNode) {
    return failLocate('sidebar.message.locate_connection_not_in_tree');
  }

  revealSidebarLocateStage(getTree(), target.connectionKey, 'connection', mergeExpandedTreeKeys);
  revealNode(target.connectionKey, connectionNode, 'connection');

  const dbStatus = await ensureSidebarLocatePresent({
    isPresent: () => Boolean(findSidebarNodePathByKey(getTree(), target.databaseKey)),
    loadKey: `dbs-${request.connectionId}`,
    isLoadPending,
    startLoad: () => loadDatabases(connectionNode),
    ...poll,
  });
  if (dbStatus === 'timeout') {
    return infoLocate('sidebar.message.locate_database_loading', { database: request.dbName });
  }
  const dbNode = findNode(target.databaseKey);
  if (dbStatus !== 'ready' || !dbNode) {
    return failLocate('sidebar.message.locate_database_not_found', { database: request.dbName });
  }

  revealSidebarLocateStage(getTree(), target.databaseKey, 'database', mergeExpandedTreeKeys);
  revealNode(target.databaseKey, dbNode, 'database');

  if (target.schemaKey && !findNode(target.schemaKey)) {
    await ensureSidebarLocatePresent({
      isPresent: () => Boolean(findNode(target.schemaKey!)),
      loadKey: `tables-${request.connectionId}-${request.dbName}`,
      isLoadPending, startLoad: () => loadTables(dbNode), ...poll,
    });
  }
  const schemaNode = target.schemaKey ? findNode(target.schemaKey) : null;
  const schemaLoadNode = schemaNode?.dataRef?.schemaLazy ? schemaNode : null;
  if (schemaLoadNode && target.schemaKey) {
    revealSidebarLocateStage(getTree(), target.schemaKey, 'database', mergeExpandedTreeKeys);
  }

  const objectStatus = await ensureSidebarLocatePresent({
    isPresent: () => Boolean(findSidebarNodePathForLocate(getTree(), target)),
    loadKey: schemaLoadNode ? sidebarSchemaLoadKey(request.connectionId, request.dbName, String(schemaLoadNode.dataRef?.schemaName || '')) : `tables-${request.connectionId}-${request.dbName}`,
    isLoadPending,
    startLoad: () => loadTables(schemaLoadNode || dbNode),
    ...poll,
  });
  if (objectStatus === 'timeout') {
    return infoLocate('sidebar.message.locate_object_loading', {
      object: objectLabel,
      database: request.dbName,
    });
  }
  const path = findSidebarNodePathForLocate(getTree(), target);
  if (objectStatus !== 'ready' || !path) {
    return failLocate('sidebar.message.locate_object_not_found', {
      object: objectLabel,
      name: request.tableName,
    });
  }

  const targetKey = path[path.length - 1];
  revealSidebarLocateStage(getTree(), targetKey, 'object', mergeExpandedTreeKeys);
  revealNode(targetKey, findNode(targetKey), 'object');
  return { status: 'located', path, targetKey };
};
