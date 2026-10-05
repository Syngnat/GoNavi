import type { TabData } from '../types';
import { resolveLiveQueryTab } from './liveQueryTabs';
import { sanitizeTableAccessCount } from './tableAccessCount';
import {
  buildNativeDetachedStoreSnapshot,
  UNSAFE_OBJECT_KEYS,
  resolveArrayRecordById,
  NATIVE_AI_HOST_QUERY_MAX_CHARS,
} from './nativeDetachedStoreSnapshot';
import {
  type NativeDetachedStoreSnapshot,
  type NativeDetachedHostEvent,
  type NativeDetachedThemeContext,
  withNativeDetachedThemeContext,
  NATIVE_DETACHED_HOST_EVENTS_KEY,
  type StoreApiLike,
} from './nativeDetachedWindowTypes';

const mergeNativeDetachedValueDelta = (
  currentValue: unknown,
  previousSourceValue: unknown,
  nextSourceValue: unknown,
  path: string[] = [],
): unknown => {
  if (Array.isArray(previousSourceValue) && Array.isArray(nextSourceValue)) {
    const rootKey = path[0] || '';
    const supportsIdentityMerge = rootKey === 'savedQueries'
      || rootKey === 'recentConnectionTargets'
      || rootKey === 'recentSQLFiles'
      || rootKey === 'tableExportHistories'
      || rootKey === 'pinnedSidebarTables'
      || rootKey === 'aiContexts';
    if (supportsIdentityMerge) {
      const identity = (item: unknown): string | null => {
        if (rootKey === 'pinnedSidebarTables') {
          return typeof item === 'string' && item ? `value:${item}` : null;
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const record = item as Record<string, unknown>;
        if (rootKey === 'savedQueries') {
          const id = String(record.id || '').trim();
          return id ? `id:${id}` : null;
        }
        if (rootKey === 'recentConnectionTargets') {
          const connectionId = String(record.connectionId || '').trim();
          return connectionId
            ? `target:${connectionId}\u0000${String(record.dbName || '')}`
            : null;
        }
        if (rootKey === 'recentSQLFiles') {
          const connectionId = String(record.connectionId || '').trim();
          const filePath = String(record.filePath || '').trim().replace(/\\/g, '/');
          return connectionId && filePath
            ? `file:${connectionId}\u0000${String(record.dbName || '')}\u0000${filePath}`
            : null;
        }
        if (rootKey === 'tableExportHistories') {
          const jobId = String(record.jobId || '').trim();
          return jobId ? `job:${jobId}` : null;
        }
        const dbName = String(record.dbName || '').trim();
        const tableName = String(record.tableName || '').trim();
        return dbName || tableName
          ? `context:${dbName}\u0000${String(record.schemaName || '')}\u0000${tableName}`
          : null;
      };
      const previousIds = previousSourceValue.map(identity);
      const nextIds = nextSourceValue.map(identity);
      if (previousIds.every(Boolean) && nextIds.every(Boolean)) {
        const previousById = new Map(previousIds.map((id, index) => [id!, previousSourceValue[index]]));
        const nextById = new Map(nextIds.map((id, index) => [id!, nextSourceValue[index]]));
        const currentItems = Array.isArray(currentValue) ? currentValue : [];
        const currentById = new Map(
          currentItems.flatMap((item) => {
            const id = identity(item);
            return id ? [[id, item] as const] : [];
          }),
        );
        const changedIds = new Set<string>();
        for (const id of new Set([...previousById.keys(), ...nextById.keys()])) {
          if (!previousById.has(id)
            || !nextById.has(id)
            || JSON.stringify(previousById.get(id)) !== JSON.stringify(nextById.get(id))) {
            changedIds.add(id);
          }
        }
        const merged = nextIds.map((id, index) => (
          changedIds.has(id!) ? nextSourceValue[index] : currentById.get(id!) ?? nextSourceValue[index]
        ));
        const nextIdSet = new Set(nextIds);
        const previousIdSet = new Set(previousIds);
        for (const item of currentItems) {
          const id = identity(item);
          if (id && !previousIdSet.has(id) && !nextIdSet.has(id)) merged.push(item);
        }
        if (rootKey === 'recentConnectionTargets' || rootKey === 'recentSQLFiles') {
          merged.sort((left, right) => {
            const leftAt = Number((left as Record<string, unknown>)?.openedAt || 0);
            const rightAt = Number((right as Record<string, unknown>)?.openedAt || 0);
            return rightAt - leftAt;
          });
        }
        return buildNativeDetachedStoreSnapshot({ value: merged }).value;
      }
    }
  }
  const currentIsRecord = Boolean(currentValue)
    && typeof currentValue === 'object'
    && !Array.isArray(currentValue);
  const previousIsRecord = Boolean(previousSourceValue)
    && typeof previousSourceValue === 'object'
    && !Array.isArray(previousSourceValue);
  const nextIsRecord = Boolean(nextSourceValue)
    && typeof nextSourceValue === 'object'
    && !Array.isArray(nextSourceValue);
  if (!previousIsRecord || !nextIsRecord) {
    return buildNativeDetachedStoreSnapshot({ value: nextSourceValue }).value;
  }

  const current = currentIsRecord
    ? currentValue as Record<string, unknown>
    : {};
  const previous = previousSourceValue as Record<string, unknown>;
  const next = nextSourceValue as Record<string, unknown>;
  const result: Record<string, unknown> = { ...current };
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    const hadBefore = Object.prototype.hasOwnProperty.call(previous, key);
    const hasNext = Object.prototype.hasOwnProperty.call(next, key);
    if (hadBefore === hasNext
      && JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue;
    if (!hasNext) {
      delete result[key];
      continue;
    }
    result[key] = mergeNativeDetachedValueDelta(
      result[key],
      hadBefore ? previous[key] : undefined,
      next[key],
      [...path, key],
    );
  }
  return result;
};

export const mergeNativeDetachedStoreDelta = (
  currentState: NativeDetachedStoreSnapshot,
  previousSource: NativeDetachedStoreSnapshot,
  changedSource: NativeDetachedStoreSnapshot,
): NativeDetachedStoreSnapshot => {
  const nextState = { ...currentState };
  for (const [key, nextSourceValue] of Object.entries(changedSource)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    const mergedValue = mergeNativeDetachedValueDelta(
      currentState[key],
      previousSource[key],
      nextSourceValue,
      [key],
    );
    nextState[key] = key === 'tableAccessCount'
      ? sanitizeTableAccessCount(mergedValue)
      : mergedValue;
  }
  return nextState;
};

export const advanceNativeDetachedStoreSource = (
  previousSource: NativeDetachedStoreSnapshot,
  changedSource: NativeDetachedStoreSnapshot,
): NativeDetachedStoreSnapshot => ({
  ...previousSource,
  ...buildNativeDetachedStoreSnapshot(changedSource),
});

/** Host-owned context sent to a detached AI window after it has started. */
export const buildNativeDetachedAIHostStoreSnapshot = (
  state: object,
  hostEvents: NativeDetachedHostEvent[] = [],
  themeContext?: NativeDetachedThemeContext,
): NativeDetachedStoreSnapshot => {
  const source = state as Record<string, unknown>;
  const activeTabId = typeof source.activeTabId === 'string' && source.activeTabId
    ? source.activeTabId
    : null;
  const storedActiveTab = activeTabId
    ? resolveArrayRecordById(source.tabs, activeTabId)
    : null;
  const activeTabRecord = storedActiveTab
    ? resolveLiveQueryTab(storedActiveTab as unknown as TabData)
    : null;
  const activeTab = activeTabRecord && typeof activeTabRecord.query === 'string'
    && activeTabRecord.query.length > NATIVE_AI_HOST_QUERY_MAX_CHARS
    ? {
        ...activeTabRecord,
        query: `${activeTabRecord.query.slice(0, NATIVE_AI_HOST_QUERY_MAX_CHARS / 2)}\n`
          + '/* ... SQL truncated for detached AI context sync ... */\n'
          + activeTabRecord.query.slice(-NATIVE_AI_HOST_QUERY_MAX_CHARS / 2),
      }
    : activeTabRecord;
  const activeContext = source.activeContext
    && typeof source.activeContext === 'object'
    && !Array.isArray(source.activeContext)
    ? source.activeContext as Record<string, unknown>
    : null;
  const activeConnectionId = String(activeContext?.connectionId || activeTab?.connectionId || '');
  const activeConnection = resolveArrayRecordById(source.connections, activeConnectionId);
  return withNativeDetachedThemeContext(buildNativeDetachedStoreSnapshot({
    // Presentation state is host-owned. Keep a detached AI window aligned with
    // the main window when the user changes appearance after it is opened.
    theme: source.theme,
    themePreference: source.themePreference,
    appearance: source.appearance,
    fontSize: source.fontSize,
    uiScale: source.uiScale,
    activeContext,
    activeTabId,
    activeTab,
    activeConnection,
    aiContexts: source.aiContexts,
    shortcutOptions: source.shortcutOptions,
    ...(hostEvents.length > 0 ? { [NATIVE_DETACHED_HOST_EVENTS_KEY]: hostEvents } : {}),
  }), themeContext);
};

/** Merge bootstrap state without replacing any action currently installed by Zustand. */
export const mergeNativeDetachedStoreState = <TState extends object>(
  currentState: TState,
  snapshot: NativeDetachedStoreSnapshot,
): TState => {
  const nextState = { ...currentState } as Record<string, unknown>;
  const currentRecord = currentState as Record<string, unknown>;
  const safeSnapshot = buildNativeDetachedStoreSnapshot(snapshot);

  for (const [key, value] of Object.entries(safeSnapshot)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(currentRecord, key)) continue;
    if (typeof currentRecord[key] === 'function') continue;
    nextState[key] = value;
  }
  return nextState as TState;
};

export const hydrateNativeDetachedStore = <TState extends object>(
  store: StoreApiLike<TState>,
  snapshot: NativeDetachedStoreSnapshot,
): TState => {
  const nextState = mergeNativeDetachedStoreState(store.getState(), snapshot);
  store.setState(nextState, true);
  return nextState;
};
