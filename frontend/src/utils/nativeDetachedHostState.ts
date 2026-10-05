import { isNativeDetachedWindowRoute } from './nativeDetachedWindowRoute';
import { setQueryTabDraft } from './sqlFileTabDrafts';
import {
  type NativeDetachedStoreSnapshot,
  type NativeDetachedHostEvent,
  NATIVE_DETACHED_HOST_EVENTS_KEY,
  type NativeDetachedHostEventName,
  type StoreApiLike,
  type NativeDetachedHostStateCommand,
} from './nativeDetachedWindowTypes';
import {
  buildNativeDetachedStoreSnapshot,
  NATIVE_DETACHED_HOST_EVENT_NAME_SET,
  NATIVE_DETACHED_PROCESSED_EVENT_LIMIT,
} from './nativeDetachedStoreSnapshot';
import { mergeNativeDetachedStoreState } from './nativeDetachedStoreDelta';

/** Apply only host-owned AI context while preserving child actions and conversation state. */
type NativeDetachedAIContexts = Record<string, unknown[]>;

const normalizeNativeDetachedAIContexts = (value: unknown): NativeDetachedAIContexts => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: NativeDetachedAIContexts = {};
  for (const [key, items] of Object.entries(value)) {
    if (Array.isArray(items)) result[key] = items;
  }
  return result;
};

const nativeDetachedAIContextIdentity = (item: unknown): string => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return JSON.stringify(item);
  const record = item as Record<string, unknown>;
  return `${String(record.dbName || '')}\u0000${String(record.tableName || '')}`;
};

/**
 * Apply only changes made by one process since its last snapshot. Unrelated
 * additions from the other process survive, while removals still propagate.
 */
export const mergeNativeDetachedAIContextsDelta = (
  currentValue: unknown,
  previousSourceValue: unknown,
  nextSourceValue: unknown,
): NativeDetachedAIContexts => {
  const current = normalizeNativeDetachedAIContexts(currentValue);
  const previousSource = normalizeNativeDetachedAIContexts(previousSourceValue);
  const nextSource = normalizeNativeDetachedAIContexts(nextSourceValue);
  const result: NativeDetachedAIContexts = Object.fromEntries(
    Object.entries(current).map(([key, items]) => [key, [...items]]),
  );
  const connectionKeys = new Set([
    ...Object.keys(previousSource),
    ...Object.keys(nextSource),
  ]);

  for (const connectionKey of connectionKeys) {
    const before = previousSource[connectionKey] || [];
    const after = nextSource[connectionKey] || [];
    const beforeByIdentity = new Map(before.map((item) => [nativeDetachedAIContextIdentity(item), item]));
    const afterByIdentity = new Map(after.map((item) => [nativeDetachedAIContextIdentity(item), item]));
    const changedIdentities = new Set<string>();
    for (const [identity, item] of beforeByIdentity) {
      if (!afterByIdentity.has(identity)
        || JSON.stringify(afterByIdentity.get(identity)) !== JSON.stringify(item)) {
        changedIdentities.add(identity);
      }
    }
    for (const [identity, item] of afterByIdentity) {
      if (!beforeByIdentity.has(identity)
        || JSON.stringify(beforeByIdentity.get(identity)) !== JSON.stringify(item)) {
        changedIdentities.add(identity);
      }
    }
    if (changedIdentities.size === 0) continue;

    const currentItems = result[connectionKey] || [];
    const retained = currentItems.filter(
      (item) => !changedIdentities.has(nativeDetachedAIContextIdentity(item)),
    );
    const changedNextItems = after.filter(
      (item) => changedIdentities.has(nativeDetachedAIContextIdentity(item)),
    );
    const merged = [...retained, ...changedNextItems];
    if (merged.length > 0) result[connectionKey] = merged;
    else delete result[connectionKey];
  }
  return result;
};

export const applyNativeDetachedHostStateSync = <TState extends object>(
  currentState: TState,
  snapshot: NativeDetachedStoreSnapshot,
  previousHostAIContexts?: unknown,
): TState => {
  const safe = buildNativeDetachedStoreSnapshot(snapshot);
  const hostStatePatch: NativeDetachedStoreSnapshot = {};
  for (const key of ['theme', 'themePreference', 'appearance', 'fontSize', 'uiScale'] as const) {
    if (Object.prototype.hasOwnProperty.call(safe, key)) {
      hostStatePatch[key] = safe[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(safe, 'activeContext')) {
    hostStatePatch.activeContext = safe.activeContext ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(safe, 'activeTabId')) {
    hostStatePatch.activeTabId = safe.activeTabId ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(safe, 'shortcutOptions')) {
    hostStatePatch.shortcutOptions = safe.shortcutOptions;
  }
  const next = mergeNativeDetachedStoreState(currentState, hostStatePatch) as Record<string, unknown>;

  const mergeById = (key: 'tabs' | 'connections', incoming: unknown): void => {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return;
    const id = String((incoming as { id?: unknown }).id || '').trim();
    const current = next[key];
    if (!id || !Array.isArray(current)) return;
    const index = current.findIndex((item) => (
      item && typeof item === 'object' && String((item as { id?: unknown }).id || '') === id
    ));
    next[key] = index >= 0
      ? current.map((item, itemIndex) => itemIndex === index ? incoming : item)
      : [...current, incoming];
  };

  mergeById('tabs', safe.activeTab);
  mergeById('connections', safe.activeConnection);
  if (Object.prototype.hasOwnProperty.call(safe, 'aiContexts')) {
    next.aiContexts = mergeNativeDetachedAIContextsDelta(
      next.aiContexts,
      previousHostAIContexts ?? next.aiContexts,
      safe.aiContexts,
    );
  }
  return next as TState;
};

export type NativeDetachedHostStateApplyOptions = {
  processedEventIds?: Set<string>;
  previousHostAIContextsRef?: { current: unknown };
  dispatchHostEvent?: (event: NativeDetachedHostEvent) => void;
};

const readNativeDetachedHostEvents = (
  snapshot: NativeDetachedStoreSnapshot,
): NativeDetachedHostEvent[] => {
  const rawEvents = snapshot[NATIVE_DETACHED_HOST_EVENTS_KEY];
  if (!Array.isArray(rawEvents)) return [];
  return rawEvents.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = String(record.id || '').trim();
    const name = String(record.name || '').trim();
    if (!id || !NATIVE_DETACHED_HOST_EVENT_NAME_SET.has(name)) return [];
    return [{
      id,
      name: name as NativeDetachedHostEventName,
      ...(Object.prototype.hasOwnProperty.call(record, 'detail') ? { detail: record.detail } : {}),
    }];
  });
};

export const applyNativeDetachedHostStateCommand = <TState extends object>(
  store: StoreApiLike<TState>,
  currentWindowId: string,
  currentRevision: number,
  command: NativeDetachedHostStateCommand,
  options: NativeDetachedHostStateApplyOptions = {},
): number => {
  const revision = Math.trunc(Number(command?.payload?.revision));
  if (
    command?.action !== 'sync-host-state'
    || String(command?.id || '') !== String(currentWindowId || '')
    || !Number.isFinite(revision)
    || revision <= currentRevision
    || !command.payload?.storeState
    || typeof command.payload.storeState !== 'object'
    || Array.isArray(command.payload.storeState)
  ) {
    return currentRevision;
  }
  const safeSnapshot = buildNativeDetachedStoreSnapshot(command.payload.storeState);
  const activeTab = safeSnapshot.activeTab;
  if (
    activeTab
    && typeof activeTab === 'object'
    && !Array.isArray(activeTab)
    && (activeTab as Record<string, unknown>).type === 'query'
    && typeof (activeTab as Record<string, unknown>).id === 'string'
    && typeof (activeTab as Record<string, unknown>).query === 'string'
  ) {
    const queryTab = activeTab as Record<string, unknown>;
    setQueryTabDraft(queryTab.id as string, queryTab.query as string);
  }
  store.setState(applyNativeDetachedHostStateSync(
    store.getState(),
    safeSnapshot,
    options.previousHostAIContextsRef?.current,
  ), true);
  if (Object.prototype.hasOwnProperty.call(safeSnapshot, 'aiContexts')
    && options.previousHostAIContextsRef) {
    options.previousHostAIContextsRef.current = safeSnapshot.aiContexts;
  }
  const processedIds = options.processedEventIds;
  for (const event of readNativeDetachedHostEvents(safeSnapshot)) {
    if (processedIds?.has(event.id)) continue;
    processedIds?.add(event.id);
    while (processedIds && processedIds.size > NATIVE_DETACHED_PROCESSED_EVENT_LIMIT) {
      const oldest = processedIds.values().next().value;
      if (typeof oldest !== 'string') break;
      processedIds.delete(oldest);
    }
    options.dispatchHostEvent?.(event);
  }
  return revision;
};

export const isNativeDetachedWindow = (
  locationLike?: Pick<Location, 'pathname' | 'search'>,
): boolean => isNativeDetachedWindowRoute(undefined, locationLike);
