import type { TabData } from '../types';
import type { DetachedQueryResultWindow, DetachedQueryResultSnapshot } from './detachedWindow';
import type { QueryEditorResultSessionSnapshot } from './queryEditorResultSessionCache';
import { resolveLiveQueryTab, resolveLiveQueryTabs } from './liveQueryTabs';
import {
  type NativeDetachedStoreSnapshot,
  NATIVE_DETACHED_HOST_EVENT_NAMES,
  type NativeDetachedThemeContext,
  type NativeDetachedWindowPayload,
  withNativeDetachedThemeContext,
} from './nativeDetachedWindowTypes';

export const buildNativeDetachedSyncStoreSnapshot = (
  state: object,
  tabId: string,
  newSqlLogs: unknown[] = [],
): NativeDetachedStoreSnapshot => {
  const record = state as Record<string, unknown>;
  const pending = record.sqlEditorPendingTransactions;
  const pendingRecord = pending && typeof pending === 'object'
    ? pending as Record<string, unknown>
    : {};
  return buildNativeDetachedStoreSnapshot({
    ...(tabId
      ? {
          sqlEditorPendingTransactions: {
            [tabId]: Object.prototype.hasOwnProperty.call(pendingRecord, tabId)
              ? pendingRecord[tabId]
              : null,
          },
        }
      : {}),
    ...(newSqlLogs.length > 0 ? { sqlLogs: newSqlLogs } : {}),
  });
};

const OMIT_VALUE = Symbol('gonavi.native-detached.omit');
export const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const WORKBENCH_BOOTSTRAP_OMITTED_KEYS = new Set([
  'aiChatHistory',
  'aiChatSessions',
  'aiContexts',
  'jvmDiagnosticDrafts',
  'jvmDiagnosticOutputs',
  'tabs',
  'detachedWorkbenchWindows',
  'detachedQueryResultWindows',
  'detachedAIChatWindow',
  'sqlEditorPendingTransactions',
]);
const QUERY_RESULT_BOOTSTRAP_OMITTED_KEYS = new Set([
  ...WORKBENCH_BOOTSTRAP_OMITTED_KEYS,
  'sqlLogs',
]);
const AI_CHAT_BOOTSTRAP_OMITTED_KEYS = new Set([
  'detachedWorkbenchWindows',
  'detachedQueryResultWindows',
  'detachedAIChatWindow',
  'sqlEditorPendingTransactions',
  'jvmDiagnosticOutputs',
]);
const AI_CHAT_SYNC_KEYS = [
  'aiChatHistory',
  'aiChatSessions',
  'aiActiveSessionId',
  'aiContexts',
] as const;
export const NATIVE_AI_HOST_QUERY_MAX_CHARS = 512 * 1024;
export const NATIVE_DETACHED_PROCESSED_EVENT_LIMIT = 256;
export const NATIVE_DETACHED_HOST_EVENT_NAME_SET = new Set<string>(NATIVE_DETACHED_HOST_EVENT_NAMES);
export const NATIVE_DETACHED_WORKBENCH_MUTABLE_KEYS = [
  'activeContext',
  'aiContexts',
  'pinnedSidebarTables',
  'queryOptions',
  'sqlFormatOptions',
  'dataEditTransactionOptions',
  'sqlEditorTransactionOptions',
  'tableColumnOrders',
  'enableColumnOrderMemory',
  'tablePinnedLeftColumns',
  'tableHiddenColumns',
  'enableHiddenColumnMemory',
  'shortcutOptions',
  'savedQueries',
  'recentConnectionTargets',
  'recentSQLFiles',
  'tableExportHistories',
  'tableAccessCount',
  'tableSortPreference',
  'sidebarTreeOrders',
  'jvmDiagnosticDrafts',
  'jvmDiagnosticOutputs',
] as const;

export const resolveArrayRecordById = (
  value: unknown,
  id: string,
): Record<string, unknown> | null => {
  if (!id || !Array.isArray(value)) return null;
  const match = value.find((item) => (
    item
    && typeof item === 'object'
    && !Array.isArray(item)
    && String((item as { id?: unknown }).id || '') === id
  ));
  return match && typeof match === 'object' ? match as Record<string, unknown> : null;
};

const cloneSerializableValue = (
  value: unknown,
  ancestors: WeakSet<object>,
): unknown | typeof OMIT_VALUE => {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return OMIT_VALUE;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'object') {
    return OMIT_VALUE;
  }
  if (ancestors.has(value)) {
    return OMIT_VALUE;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        const cloned = cloneSerializableValue(item, ancestors);
        if (cloned !== OMIT_VALUE) {
          result.push(cloned);
        }
      }
      return result;
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_OBJECT_KEYS.has(key)) continue;
      const cloned = cloneSerializableValue(item, ancestors);
      if (cloned !== OMIT_VALUE) {
        result[key] = cloned;
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
};

/** Build the JSON-safe, data-only part of a Zustand state object. */
export const buildNativeDetachedStoreSnapshot = (
  state: object,
): NativeDetachedStoreSnapshot => {
  const cloned = cloneSerializableValue(state, new WeakSet());
  return cloned && cloned !== OMIT_VALUE && !Array.isArray(cloned)
    ? cloned as NativeDetachedStoreSnapshot
    : {};
};

const buildFilteredStoreSnapshot = (
  state: object,
  omittedKeys: ReadonlySet<string>,
): NativeDetachedStoreSnapshot => {
  const source = state as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (omittedKeys.has(key)) continue;
    filtered[key] = source[key];
  }
  return buildNativeDetachedStoreSnapshot(filtered);
};

export const buildNativeDetachedWorkbenchPayload = (
  state: object,
  tab: TabData,
  resultSession?: QueryEditorResultSessionSnapshot | null,
  themeContext?: NativeDetachedThemeContext,
): NativeDetachedWindowPayload => {
  const liveTab = resolveLiveQueryTab(tab);
  const storeState = buildFilteredStoreSnapshot(state, WORKBENCH_BOOTSTRAP_OMITTED_KEYS);
  const source = state as Record<string, unknown>;
  const allPending = source.sqlEditorPendingTransactions;
  const pendingRecord = allPending && typeof allPending === 'object'
    ? allPending as Record<string, unknown>
    : {};
  storeState.tabs = [liveTab];
  storeState.activeTabId = liveTab.id;
  storeState.detachedWorkbenchWindows = [];
  storeState.detachedQueryResultWindows = [];
  storeState.detachedAIChatWindow = null;
  storeState.sqlEditorPendingTransactions = buildNativeDetachedStoreSnapshot(
    Object.prototype.hasOwnProperty.call(pendingRecord, liveTab.id)
      ? { [liveTab.id]: pendingRecord[liveTab.id] }
      : {},
  );
  storeState.aiContexts = buildNativeDetachedStoreSnapshot({
    value: source.aiContexts,
  }).value ?? {};
  const diagnosticDrafts = source.jvmDiagnosticDrafts;
  const diagnosticOutputs = source.jvmDiagnosticOutputs;
  const diagnosticDraftRecord = diagnosticDrafts && typeof diagnosticDrafts === 'object'
    ? diagnosticDrafts as Record<string, unknown>
    : {};
  const diagnosticOutputRecord = diagnosticOutputs && typeof diagnosticOutputs === 'object'
    ? diagnosticOutputs as Record<string, unknown>
    : {};
  storeState.jvmDiagnosticDrafts = buildNativeDetachedStoreSnapshot(
    Object.prototype.hasOwnProperty.call(diagnosticDraftRecord, liveTab.id)
      ? { [liveTab.id]: diagnosticDraftRecord[liveTab.id] }
      : {},
  );
  storeState.jvmDiagnosticOutputs = buildNativeDetachedStoreSnapshot(
    Object.prototype.hasOwnProperty.call(diagnosticOutputRecord, liveTab.id)
      ? { [liveTab.id]: diagnosticOutputRecord[liveTab.id] }
      : {},
  );
  return {
    storeState: withNativeDetachedThemeContext(storeState, themeContext),
    tab: liveTab,
    resultSession: resultSession ?? null,
  };
};

export const buildNativeDetachedQueryResultPayload = (
  state: object,
  resultWindow: DetachedQueryResultWindow,
  themeContext?: NativeDetachedThemeContext,
): NativeDetachedWindowPayload => {
  const storeState = buildFilteredStoreSnapshot(state, QUERY_RESULT_BOOTSTRAP_OMITTED_KEYS);
  storeState.tabs = [];
  storeState.activeTabId = null;
  storeState.detachedWorkbenchWindows = [];
  storeState.detachedQueryResultWindows = [];
  storeState.detachedAIChatWindow = null;
  storeState.sqlLogs = [];
  storeState.sqlEditorPendingTransactions = {};
  return {
    storeState: withNativeDetachedThemeContext(storeState, themeContext),
    resultWindow: {
      ...resultWindow,
      result: buildNativeDetachedQueryResultSnapshot(resultWindow.result),
    },
  };
};

export const buildNativeDetachedAIChatPayload = (
  state: object,
  themeContext?: NativeDetachedThemeContext,
): NativeDetachedWindowPayload => {
  const storeState = buildFilteredStoreSnapshot(state, AI_CHAT_BOOTSTRAP_OMITTED_KEYS);
  const source = state as Record<string, unknown>;
  if (Array.isArray(source.tabs)) {
    storeState.tabs = buildNativeDetachedStoreSnapshot({
      tabs: resolveLiveQueryTabs(source.tabs as TabData[]),
    }).tabs ?? [];
  }
  storeState.detachedWorkbenchWindows = [];
  storeState.detachedQueryResultWindows = [];
  storeState.detachedAIChatWindow = null;
  storeState.sqlEditorPendingTransactions = {};
  storeState.aiPanelVisible = true;
  storeState.aiChatOpenMode = 'detached';
  return { storeState: withNativeDetachedThemeContext(storeState, themeContext) };
};

export const buildNativeDetachedAIChatSyncStoreSnapshot = (
  state: object,
  newSqlLogs: unknown[] = [],
): NativeDetachedStoreSnapshot => {
  const source = state as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const key of AI_CHAT_SYNC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      snapshot[key] = source[key];
    }
  }
  if (newSqlLogs.length > 0) {
    snapshot.sqlLogs = newSqlLogs;
  }
  return buildNativeDetachedStoreSnapshot(snapshot);
};

export const buildNativeDetachedWorkbenchMutableStoreSnapshot = (
  state: object,
): NativeDetachedStoreSnapshot => {
  const source = state as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const key of NATIVE_DETACHED_WORKBENCH_MUTABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) snapshot[key] = source[key];
  }
  return buildNativeDetachedStoreSnapshot(snapshot);
};

export const buildNativeDetachedChangedWorkbenchStoreSnapshot = (
  state: object,
  previousSource: NativeDetachedStoreSnapshot,
): NativeDetachedStoreSnapshot => {
  const current = buildNativeDetachedWorkbenchMutableStoreSnapshot(state);
  const changed: NativeDetachedStoreSnapshot = {};
  for (const key of NATIVE_DETACHED_WORKBENCH_MUTABLE_KEYS) {
    if (JSON.stringify(current[key]) !== JSON.stringify(previousSource[key])) {
      changed[key] = current[key];
    }
  }
  return changed;
};

export const buildNativeDetachedQueryResultSnapshot = (
  result: DetachedQueryResultSnapshot,
): DetachedQueryResultSnapshot => {
  const cloned = cloneSerializableValue(result, new WeakSet());
  return cloned && cloned !== OMIT_VALUE && !Array.isArray(cloned)
    ? cloned as DetachedQueryResultSnapshot
    : {
        key: '',
        sql: '',
        rows: [],
        columns: [],
        pkColumns: [],
        readOnly: true,
      };
};
