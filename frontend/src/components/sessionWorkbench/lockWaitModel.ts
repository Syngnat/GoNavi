import { sessionStateTone, type DatabaseSession } from './sessionWorkbenchModel';

export interface LockWaitCapability {
  supported: boolean;
  reasonCode?: string;
}

/** One waiter→blocker edge, mirrored from connection.DatabaseLockWait. */
export interface DatabaseLockWait {
  key: string;
  waitingSessionId: string;
  waitingInstanceId?: string;
  waitingSerialNumber?: string;
  waitingUser?: string;
  waitingStatement?: string;
  waitDurationMs?: number;
  blockingSessionId: string;
  blockingInstanceId?: string;
  blockingSerialNumber?: string;
  blockingUser?: string;
  blockingState?: string;
  blockingStatement?: string;
  blockingDurationMs?: number;
  databaseOrTenant?: string;
  objectName?: string;
  indexName?: string;
  lockType?: string;
  lockMode?: string;
  blockingLockMode?: string;
}

export interface LockWaitPayload {
  engine: string;
  capability: LockWaitCapability;
  waits: DatabaseLockWait[];
  scopedDatabase: string;
}

export interface LockWaitTreeRow {
  /** Path key: a session blocked by two holders appears under both. */
  key: string;
  role: 'root' | 'waiting';
  /** Identity and display fields, shaped for the shared session actions. */
  session: DatabaseSession;
  /** Wait time for a waiting row; open-transaction age for a root blocker. */
  durationMs?: number;
  /** The root is idle inside a transaction, so its statement is the last one it ran. */
  idleHolder: boolean;
  /** Distinct sessions queued behind this row, directly or through others. */
  blockedCount: number;
  /** The edge that put a waiting row under its parent. */
  wait?: DatabaseLockWait;
  /** This session already appears higher on the same chain. */
  cycle: boolean;
  children?: LockWaitTreeRow[];
}

export interface LockWaitSummary {
  waitingSessions: number;
  rootBlockers: number;
  longestWaitMs: number;
  hasCycle: boolean;
}

export interface LockWaitTree {
  rows: LockWaitTreeRow[];
  summary: LockWaitSummary;
  /** Every row key that has children, for "expand all" by default. */
  expandableKeys: string[];
}

const MAX_CHAIN_DEPTH = 32;

const text = (value: unknown): string => String(value ?? '').trim();
const optionalText = (value: unknown): string | undefined => text(value) || undefined;

const numberValue = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' ? value as Record<string, unknown> : {}
);

export const normalizeLockWait = (value: unknown, index: number): DatabaseLockWait => {
  const source = record(value);
  return {
    key: text(source.key) || `lock-wait-${index}`,
    waitingSessionId: text(source.waitingSessionId),
    waitingInstanceId: optionalText(source.waitingInstanceId),
    waitingSerialNumber: optionalText(source.waitingSerialNumber),
    waitingUser: optionalText(source.waitingUser),
    waitingStatement: optionalText(source.waitingStatement),
    waitDurationMs: numberValue(source.waitDurationMs),
    blockingSessionId: text(source.blockingSessionId),
    blockingInstanceId: optionalText(source.blockingInstanceId),
    blockingSerialNumber: optionalText(source.blockingSerialNumber),
    blockingUser: optionalText(source.blockingUser),
    blockingState: optionalText(source.blockingState),
    blockingStatement: optionalText(source.blockingStatement),
    blockingDurationMs: numberValue(source.blockingDurationMs),
    databaseOrTenant: optionalText(source.databaseOrTenant),
    objectName: optionalText(source.objectName),
    indexName: optionalText(source.indexName),
    lockType: optionalText(source.lockType),
    lockMode: optionalText(source.lockMode),
    blockingLockMode: optionalText(source.blockingLockMode),
  };
};

export const normalizeLockWaitPayload = (value: unknown): LockWaitPayload => {
  const source = record(value);
  const capability = record(source.capability);
  const waits = Array.isArray(source.waits) ? source.waits : [];
  return {
    engine: text(source.engine),
    capability: {
      supported: capability.supported === true,
      reasonCode: optionalText(capability.reasonCode),
    },
    waits: waits
      .map(normalizeLockWait)
      .filter((wait) => wait.waitingSessionId && wait.blockingSessionId),
    scopedDatabase: text(source.scopedDatabase),
  };
};

const sessionKey = (sessionId: string, instanceId?: string): string => (
  `${instanceId ?? ''}\u0001${sessionId}`
);

const waiterKey = (wait: DatabaseLockWait): string => (
  sessionKey(wait.waitingSessionId, wait.waitingInstanceId)
);

const blockerKey = (wait: DatabaseLockWait): string => (
  sessionKey(wait.blockingSessionId, wait.blockingInstanceId)
);

const blockerSession = (wait: DatabaseLockWait): DatabaseSession => ({
  key: `lock:${blockerKey(wait)}`,
  sessionId: wait.blockingSessionId,
  instanceId: wait.blockingInstanceId,
  serialNumber: wait.blockingSerialNumber,
  user: wait.blockingUser,
  state: wait.blockingState,
  statement: wait.blockingStatement,
  databaseOrTenant: wait.databaseOrTenant,
});

const waiterSession = (wait: DatabaseLockWait): DatabaseSession => ({
  key: `lock:${waiterKey(wait)}`,
  sessionId: wait.waitingSessionId,
  instanceId: wait.waitingInstanceId,
  serialNumber: wait.waitingSerialNumber,
  user: wait.waitingUser,
  statement: wait.waitingStatement,
  databaseOrTenant: wait.databaseOrTenant,
});

/**
 * A blocker that is not running anything still holds its locks until its
 * transaction ends; that is the usual "forgot to commit" culprit.
 */
export const isIdleLockHolder = (state: string | undefined): boolean => {
  const tone = sessionStateTone(state);
  return tone === 'idle' || (tone === 'busy' && text(state).toLowerCase().includes('idle'));
};

/**
 * Drop a waiter's edge to a blocker it already waits on through another of its
 * blockers. Metadata-lock and lock-tag views pair a waiter with every holder,
 * so a queue A ← B ← C ← D also reports D ← A and D ← B; showing those repeats
 * D under every session ahead of it instead of one readable chain. A waiter
 * always keeps at least one edge (its longest wait), even inside a cycle.
 */
export const dropImpliedLockWaits = (waits: DatabaseLockWait[]): DatabaseLockWait[] => {
  const blockersOf = new Map<string, Set<string>>();
  waits.forEach((wait) => {
    const blockers = blockersOf.get(waiterKey(wait)) ?? new Set<string>();
    blockers.add(blockerKey(wait));
    blockersOf.set(waiterKey(wait), blockers);
  });
  // Does `from` wait, directly or transitively, on `target` without passing
  // through `excluded` (the waiter whose edges are being reduced)?
  const waitsOn = (from: string, target: string, excluded: string): boolean => {
    const stack = [from];
    const seen = new Set<string>([excluded]);
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of blockersOf.get(current) ?? []) {
        if (next === target) return true;
        stack.push(next);
      }
    }
    return false;
  };
  const kept = waits.filter((wait) => {
    const waiter = waiterKey(wait);
    const blocker = blockerKey(wait);
    const blockers = blockersOf.get(waiter);
    if (!blockers || blockers.size < 2) return true;
    return ![...blockers].some((other) => other !== blocker && waitsOn(other, blocker, waiter));
  });
  const keptWaiters = new Set(kept.map(waiterKey));
  const longestDropped = new Map<string, DatabaseLockWait>();
  waits.forEach((wait) => {
    const waiter = waiterKey(wait);
    if (keptWaiters.has(waiter)) return;
    const current = longestDropped.get(waiter);
    if (!current || (wait.waitDurationMs ?? 0) > (current.waitDurationMs ?? 0)) longestDropped.set(waiter, wait);
  });
  return [...kept, ...longestDropped.values()];
};

/** Group edges by blocker, one edge per waiter (the longest wait), longest first. */
const edgesByBlocker = (waits: DatabaseLockWait[]): Map<string, DatabaseLockWait[]> => {
  const grouped = new Map<string, Map<string, DatabaseLockWait>>();
  waits.forEach((wait) => {
    const byWaiter = grouped.get(blockerKey(wait)) ?? new Map<string, DatabaseLockWait>();
    const current = byWaiter.get(waiterKey(wait));
    if (!current || (wait.waitDurationMs ?? 0) > (current.waitDurationMs ?? 0)) {
      byWaiter.set(waiterKey(wait), wait);
    }
    grouped.set(blockerKey(wait), byWaiter);
  });
  const result = new Map<string, DatabaseLockWait[]>();
  grouped.forEach((byWaiter, key) => {
    result.set(key, [...byWaiter.values()].sort(
      (left, right) => (right.waitDurationMs ?? 0) - (left.waitDurationMs ?? 0),
    ));
  });
  return result;
};

interface TreeBuildState {
  edges: Map<string, DatabaseLockWait[]>;
  visited: Set<string>;
  expandableKeys: string[];
  hasCycle: boolean;
}

const buildChildren = (
  state: TreeBuildState,
  parentSessionKey: string,
  parentRowKey: string,
  path: Set<string>,
  depth: number,
): { rows: LockWaitTreeRow[]; blocked: Set<string> } => {
  const blocked = new Set<string>();
  const rows = (state.edges.get(parentSessionKey) ?? []).map((wait): LockWaitTreeRow => {
    const key = waiterKey(wait);
    const rowKey = `${parentRowKey}>${key}`;
    blocked.add(key);
    state.visited.add(key);
    const cycle = path.has(key);
    if (cycle) state.hasCycle = true;
    const row: LockWaitTreeRow = {
      key: rowKey,
      role: 'waiting',
      session: waiterSession(wait),
      durationMs: wait.waitDurationMs,
      idleHolder: false,
      blockedCount: 0,
      wait,
      cycle,
    };
    if (!cycle && depth < MAX_CHAIN_DEPTH && state.edges.has(key)) {
      const nested = buildChildren(state, key, rowKey, new Set([...path, key]), depth + 1);
      if (nested.rows.length > 0) {
        row.children = nested.rows;
        state.expandableKeys.push(rowKey);
      }
      nested.blocked.forEach((value) => blocked.add(value));
      nested.blocked.delete(key);
      row.blockedCount = nested.blocked.size;
    }
    return row;
  });
  return { rows, blocked };
};

const buildRootRow = (state: TreeBuildState, key: string): LockWaitTreeRow => {
  const edges = state.edges.get(key) ?? [];
  const first = edges[0];
  const rowKey = `root:${key}`;
  state.visited.add(key);
  const nested = buildChildren(state, key, rowKey, new Set([key]), 1);
  nested.blocked.delete(key);
  if (nested.rows.length > 0) state.expandableKeys.push(rowKey);
  return {
    key: rowKey,
    role: 'root',
    session: blockerSession(first),
    durationMs: first.blockingDurationMs,
    idleHolder: isIdleLockHolder(first.blockingState),
    blockedCount: nested.blocked.size,
    cycle: false,
    children: nested.rows.length > 0 ? nested.rows : undefined,
  };
};

const rootOrder = (left: LockWaitTreeRow, right: LockWaitTreeRow): number => (
  right.blockedCount - left.blockedCount
    || (right.durationMs ?? 0) - (left.durationMs ?? 0)
);

/**
 * Rebuild blocking chains from waiter→blocker edges. Roots are sessions that
 * block others without waiting themselves: ending one of them releases the
 * whole chain beneath it. Sessions that only block each other in a cycle get
 * a root as well, so no edge is ever hidden.
 */
export const buildLockWaitTree = (waits: DatabaseLockWait[]): LockWaitTree => {
  const state: TreeBuildState = {
    edges: edgesByBlocker(dropImpliedLockWaits(waits)),
    visited: new Set(),
    expandableKeys: [],
    hasCycle: false,
  };
  const waiting = new Set(waits.map(waiterKey));
  const rows = [...state.edges.keys()]
    .filter((key) => !waiting.has(key))
    .map((key) => buildRootRow(state, key));

  const cyclic = [...state.edges.keys()]
    .filter((key) => !state.visited.has(key))
    .sort((left, right) => (state.edges.get(right)?.length ?? 0) - (state.edges.get(left)?.length ?? 0));
  cyclic.forEach((key) => {
    if (state.visited.has(key)) return;
    state.hasCycle = true;
    rows.push({ ...buildRootRow(state, key), cycle: true });
  });

  rows.sort(rootOrder);
  return {
    rows,
    expandableKeys: state.expandableKeys,
    summary: {
      waitingSessions: waiting.size,
      rootBlockers: rows.length,
      longestWaitMs: waits.reduce((longest, wait) => Math.max(longest, wait.waitDurationMs ?? 0), 0),
      hasCycle: state.hasCycle,
    },
  };
};
