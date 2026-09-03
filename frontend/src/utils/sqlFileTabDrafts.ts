import type { TabData } from '../types';

const drafts = new Map<string, string>();
const draftChangeListeners = new Set<(tabId: string) => void>();

export const subscribeQueryTabDraftChanges = (
  listener: (tabId: string) => void,
): (() => void) => {
  draftChangeListeners.add(listener);
  return () => draftChangeListeners.delete(listener);
};

const notifyQueryTabDraftChanged = (tabId: string): void => {
  for (const listener of draftChangeListeners) {
    try {
      listener(tabId);
    } catch {
      // A snapshot observer must never interrupt the editor input path.
    }
  }
};

const QUERY_TAB_DRAFT_SNAPSHOT_STORAGE_KEY = 'gonavi-query-tab-drafts-v1';
const QUERY_TAB_DRAFT_SNAPSHOT_MAX_COUNT = 30;
const QUERY_TAB_DRAFT_SNAPSHOT_MAX_TEXT_LENGTH = 1024 * 1024;
const QUERY_TAB_DRAFT_SNAPSHOT_DEBOUNCE_MS = 160;
const QUERY_TAB_DRAFT_SNAPSHOT_IDLE_TIMEOUT_MS = 1500;
const QUERY_TAB_DRAFT_SNAPSHOT_FALLBACK_DELAY_MS = 500;

type PersistedQueryTabDraftEntry = {
  tabId: string;
  title: string;
  query: string;
  connectionId: string;
  dbName: string;
  filePath?: string;
  savedQueryId?: string;
  readOnly?: boolean;
  updatedAt: number;
};

type QueryTabDraftSnapshotTab = Pick<
  TabData,
  'id' | 'title' | 'connectionId' | 'dbName' | 'filePath' | 'savedQueryId' | 'readOnly'
>;

const persistedDrafts = new Map<string, PersistedQueryTabDraftEntry>();

let persistedDraftsHydrated = false;
let persistTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let persistIdleCallback: number | null = null;
let persistFallbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let persistedDraftRevision = 0;
let flushedPersistedDraftRevision = 0;
let flushListenersBound = false;

const getWindowSchedulingApi = (): {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  requestIdleCallback: typeof window.requestIdleCallback | null;
  cancelIdleCallback: typeof window.cancelIdleCallback | null;
} | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const setTimeoutImpl = typeof window.setTimeout === 'function' ? window.setTimeout.bind(window) : globalThis.setTimeout;
  const clearTimeoutImpl = typeof window.clearTimeout === 'function' ? window.clearTimeout.bind(window) : globalThis.clearTimeout;
  if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
    return null;
  }
  return {
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    requestIdleCallback: typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback.bind(window)
      : null,
    cancelIdleCallback: typeof window.cancelIdleCallback === 'function'
      ? window.cancelIdleCallback.bind(window)
      : null,
  };
};

const toTabId = (value: unknown): string => String(value ?? '').trim();

const toTrimmedString = (value: unknown, fallback = ''): string => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const getDraftSnapshotStorage = (): Storage | null => {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  return localStorage;
};

const normalizePersistedDraftEntry = (
  value: unknown,
): PersistedQueryTabDraftEntry | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const tabId = toTabId(raw.tabId);
  if (!tabId) {
    return null;
  }
  const query = String(raw.query ?? '').slice(0, QUERY_TAB_DRAFT_SNAPSHOT_MAX_TEXT_LENGTH);
  const filePath = toTrimmedString(raw.filePath);
  const savedQueryId = toTrimmedString(raw.savedQueryId);
  if (!query.trim() && !filePath && !savedQueryId) {
    return null;
  }
  const updatedAt = Number(raw.updatedAt);
  return {
    tabId,
    title: toTrimmedString(raw.title, 'SQL Query'),
    query,
    connectionId: toTrimmedString(raw.connectionId),
    dbName: toTrimmedString(raw.dbName),
    filePath: filePath || undefined,
    savedQueryId: savedQueryId || undefined,
    readOnly: raw.readOnly === true,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.trunc(updatedAt) : Date.now(),
  };
};

const ensurePersistedDraftsHydrated = (): void => {
  if (persistedDraftsHydrated) {
    return;
  }
  persistedDraftsHydrated = true;
  const storage = getDraftSnapshotStorage();
  if (!storage) {
    return;
  }
  try {
    const raw = storage.getItem(QUERY_TAB_DRAFT_SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }
    parsed
      .map((entry) => normalizePersistedDraftEntry(entry))
      .filter((entry): entry is PersistedQueryTabDraftEntry => !!entry)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, QUERY_TAB_DRAFT_SNAPSHOT_MAX_COUNT)
      .forEach((entry) => {
        persistedDrafts.set(entry.tabId, entry);
        drafts.set(entry.tabId, entry.query);
      });
  } catch {
    // ignore invalid crash-recovery payloads
  }
};

const cancelScheduledPersistedDraftFlush = (): void => {
  const schedulingApi = getWindowSchedulingApi();
  if (persistTimer !== null && schedulingApi) {
    schedulingApi.clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistFallbackTimer !== null && schedulingApi) {
    schedulingApi.clearTimeout(persistFallbackTimer);
    persistFallbackTimer = null;
  }
  if (persistIdleCallback !== null && schedulingApi?.cancelIdleCallback) {
    schedulingApi.cancelIdleCallback(persistIdleCallback);
    persistIdleCallback = null;
  }
};

const flushPersistedDrafts = (): void => {
  cancelScheduledPersistedDraftFlush();
  if (flushedPersistedDraftRevision === persistedDraftRevision) {
    return;
  }
  const revision = persistedDraftRevision;
  const storage = getDraftSnapshotStorage();
  if (!storage) {
    flushedPersistedDraftRevision = revision;
    return;
  }
  try {
    if (persistedDrafts.size === 0) {
      storage.removeItem(QUERY_TAB_DRAFT_SNAPSHOT_STORAGE_KEY);
      flushedPersistedDraftRevision = revision;
      return;
    }
    const payload = Array.from(persistedDrafts.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, QUERY_TAB_DRAFT_SNAPSHOT_MAX_COUNT);
    storage.setItem(
      QUERY_TAB_DRAFT_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(payload),
    );
    flushedPersistedDraftRevision = revision;
  } catch {
    // ignore storage quota or serialization failures
  }
};

const bindFlushListeners = (): void => {
  if (flushListenersBound || typeof window === 'undefined') {
    return;
  }
  flushListenersBound = true;
  const handleFlush = () => {
    flushPersistedDrafts();
  };
  window.addEventListener('pagehide', handleFlush, { capture: true });
  window.addEventListener('beforeunload', handleFlush, { capture: true });
  if (typeof document !== 'undefined') {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPersistedDrafts();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
};

const schedulePersistedDraftFlush = (): void => {
  bindFlushListeners();
  persistedDraftRevision += 1;
  const schedulingApi = getWindowSchedulingApi();
  if (!schedulingApi) {
    flushPersistedDrafts();
    return;
  }
  if (persistTimer !== null) {
    schedulingApi.clearTimeout(persistTimer);
  }
  if (persistFallbackTimer !== null) {
    schedulingApi.clearTimeout(persistFallbackTimer);
    persistFallbackTimer = null;
  }
  if (persistIdleCallback !== null && schedulingApi.cancelIdleCallback) {
    schedulingApi.cancelIdleCallback(persistIdleCallback);
    persistIdleCallback = null;
  }
  persistTimer = schedulingApi.setTimeout(() => {
    persistTimer = null;
    // The snapshot can approach 30 MiB. Keep its JSON serialization and the
    // synchronous localStorage write out of the editor's debounce callback.
    if (schedulingApi.requestIdleCallback) {
      if (persistIdleCallback !== null) {
        return;
      }
      persistIdleCallback = schedulingApi.requestIdleCallback(() => {
        persistIdleCallback = null;
        if (persistTimer !== null) {
          return;
        }
        flushPersistedDrafts();
      }, { timeout: QUERY_TAB_DRAFT_SNAPSHOT_IDLE_TIMEOUT_MS });
      return;
    }
    persistFallbackTimer = schedulingApi.setTimeout(() => {
      persistFallbackTimer = null;
      flushPersistedDrafts();
    }, QUERY_TAB_DRAFT_SNAPSHOT_FALLBACK_DELAY_MS);
  }, QUERY_TAB_DRAFT_SNAPSHOT_DEBOUNCE_MS);
};

const upsertPersistedDraftEntry = (
  tab: QueryTabDraftSnapshotTab,
  content: string,
  overrides?: { connectionId?: string; dbName?: string },
): void => {
  ensurePersistedDraftsHydrated();
  const tabId = toTabId(tab.id);
  if (!tabId) {
    return;
  }
  const query = String(content ?? '').slice(0, QUERY_TAB_DRAFT_SNAPSHOT_MAX_TEXT_LENGTH);
  const filePath = toTrimmedString(tab.filePath);
  const savedQueryId = toTrimmedString(tab.savedQueryId);
  const shouldKeep = Boolean(query.trim() || filePath || savedQueryId);
  if (!shouldKeep) {
    persistedDrafts.delete(tabId);
    schedulePersistedDraftFlush();
    return;
  }
  // An override is allowed to intentionally clear a context value (for
  // example a connection-scoped SQLite tab has no database name). Only fall
  // back to the tab snapshot when the property was not supplied at all.
  const hasOverride = (key: 'connectionId' | 'dbName'): boolean => (
    !!overrides && Object.prototype.hasOwnProperty.call(overrides, key)
  );
  const resolvedConnectionId = hasOverride('connectionId')
    ? String(overrides?.connectionId ?? '').trim()
    : toTrimmedString(tab.connectionId);
  const resolvedDbName = hasOverride('dbName')
    ? String(overrides?.dbName ?? '').trim()
    : toTrimmedString(tab.dbName);
  persistedDrafts.set(tabId, {
    tabId,
    title: toTrimmedString(tab.title, 'SQL Query'),
    query,
    connectionId: resolvedConnectionId,
    dbName: resolvedDbName,
    filePath: filePath || undefined,
    savedQueryId: savedQueryId || undefined,
    readOnly: tab.readOnly === true,
    updatedAt: Date.now(),
  });
  schedulePersistedDraftFlush();
};

export const setQueryTabDraft = (tabId: string, content: string): void => {
  ensurePersistedDraftsHydrated();
  const id = toTabId(tabId);
  if (!id) return;
  const nextContent = String(content ?? '');
  if (drafts.has(id) && drafts.get(id) === nextContent) return;
  drafts.set(id, nextContent);
  notifyQueryTabDraftChanged(id);
};

export const getQueryTabDraft = (tabId: string, fallback = ''): string => {
  ensurePersistedDraftsHydrated();
  const id = toTabId(tabId);
  if (!id || !drafts.has(id)) {
    return fallback;
  }
  return drafts.get(id) ?? fallback;
};

export const clearQueryTabDraft = (tabId: string): void => {
  ensurePersistedDraftsHydrated();
  const id = toTabId(tabId);
  if (!id) return;
  const draftChanged = drafts.delete(id);
  if (persistedDrafts.delete(id)) {
    schedulePersistedDraftFlush();
  }
  if (draftChanged) notifyQueryTabDraftChanged(id);
};

export const hasQueryTabDraft = (tabId: string): boolean => {
  ensurePersistedDraftsHydrated();
  const id = toTabId(tabId);
  return Boolean(id && drafts.has(id));
};

export const persistQueryTabDraftSnapshot = (
  tab: QueryTabDraftSnapshotTab,
  content: string,
  overrides?: { connectionId?: string; dbName?: string },
): void => {
  const tabId = toTabId(tab.id);
  if (!tabId) {
    return;
  }
  setQueryTabDraft(tabId, content);
  upsertPersistedDraftEntry(tab, content, overrides);
};

export const getPersistedQueryTabDraftEntry = (
  tabId: string,
): PersistedQueryTabDraftEntry | null => {
  ensurePersistedDraftsHydrated();
  const id = toTabId(tabId);
  if (!id) {
    return null;
  }
  return persistedDrafts.get(id) || null;
};

export const listPersistedQueryTabDraftEntries = (): PersistedQueryTabDraftEntry[] => {
  ensurePersistedDraftsHydrated();
  return Array.from(persistedDrafts.values()).sort((a, b) => b.updatedAt - a.updatedAt);
};

export const flushQueryTabDraftSnapshots = (): void => {
  flushPersistedDrafts();
};

export const setSQLFileTabDraft = (tabId: string, content: string): void => {
  setQueryTabDraft(tabId, content);
};

export const getSQLFileTabDraft = (tabId: string, fallback = ''): string => {
  return getQueryTabDraft(tabId, fallback);
};

export const clearSQLFileTabDraft = (tabId: string): void => {
  clearQueryTabDraft(tabId);
};

export const hasSQLFileTabDraft = (tabId: string): boolean => {
  return hasQueryTabDraft(tabId);
};
