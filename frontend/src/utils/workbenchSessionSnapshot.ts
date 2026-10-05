import type { WorkbenchTabType } from '../tabTypes';
import type { TabData } from '../types';

/**
 * What GoNavi remembers of the workbench between runs, beyond what the store keeps for
 * SQL editors (their text lives in the store and in the query-draft snapshots): which tabs
 * were open and in what order, which one was in front, whether the AI panel was open, and
 * which AI conversation it was on (the conversation itself is kept by the agent's ledger).
 *
 * A tab is stored by identity only. Anything that was a one-off request when the tab was
 * opened (a launch key, a running flag, an export scope) is left out, so a restored tab
 * opens the way a freshly opened one does.
 */
export const WORKBENCH_SESSION_STORAGE_KEY = 'gonavi-workbench-session-v1';

const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_TABS = 60;
const MAX_TEXT_LENGTH = 512;
const MAX_TITLE_LENGTH = 256;
const MAX_REDIS_DB = 65_535;

/**
 * Whether a tab comes back after a restart. Spelled out for every type, so a new tab type
 * cannot be added without deciding. `false` is for tabs that exist to carry out one request
 * (an export, an import, a script run, an analysis of a given statement): reopened empty
 * they would only confuse.
 */
const COMES_BACK_AFTER_RESTART: Record<WorkbenchTabType, boolean> = {
  query: true,
  table: true,
  design: true,
  'table-overview': true,
  'user-management': true,
  'data-sync': true,
  'sql-audit': true,
  'dml-snapshot': true,
  'driver-manager': true,
  'settings-center': true,
  'request-diagnostics': true,
  'message-queue': true,
  'redis-keys': true,
  'redis-command': true,
  'redis-monitor': true,
  'nacos-config': true,
  'nacos-services': true,
  trigger: true,
  'view-def': true,
  'event-def': true,
  'routine-def': true,
  'sequence-def': true,
  'package-def': true,
  'database-link-def': true,
  'jvm-overview': true,
  'jvm-resource': true,
  'jvm-audit': true,
  'jvm-diagnostic': true,
  'jvm-monitoring': true,
  'session-workbench': true,
  'sql-file-execution': false,
  'sql-analysis': false,
  'table-export': false,
  'data-import': false,
};

const TEXT_FIELDS = [
  'dbName',
  'schemaName',
  'tableName',
  'initialTab',
  'resourcePath',
  'resourceKind',
  'nacosNamespaceId',
  'nacosNamespaceName',
  'nacosGroup',
  'triggerName',
  'triggerTableName',
  'viewName',
  'eventName',
  'routineName',
  'routineType',
  'sequenceName',
  'packageName',
  'databaseLinkName',
  'sidebarLocateKey',
  'messageQueueTarget',
] as const satisfies readonly (keyof TabData)[];

const CHOICE_FIELDS = {
  providerMode: ['jmx', 'endpoint', 'agent'],
  objectType: ['table', 'view', 'materialized-view'],
  viewKind: ['view', 'materialized'],
  dataSyncEntryMode: ['sync', 'compare', 'schemaCompare', 'dataCompare'],
  sqlAuditView: ['audit', 'query-history'],
  messageQueueObjectKind: ['topic-filter', 'topic', 'queue', 'exchange'],
} as const satisfies Partial<Record<keyof TabData, readonly string[]>>;

const FLAG_FIELDS = ['readOnly', 'preserveUnboundConnection'] as const satisfies readonly (keyof TabData)[];

const text = (value: unknown, max: number): string => (
  typeof value === 'string' ? value.trim().slice(0, max) : ''
);

/** One entry of the remembered tab strip, in order. SQL editors only keep their place here. */
export type SnapshotEntry =
  | { kind: 'query-slot'; id: string }
  | { kind: 'tab'; tab: TabData };

export interface WorkbenchSessionSnapshot {
  version: typeof SNAPSHOT_VERSION;
  entries: SnapshotEntry[];
  activeTabId: string | null;
  /** The AI panel was open, docked beside the workbench. */
  aiPanelDocked: boolean;
  /** The conversation the AI panel was on; a placeholder that was never used is remembered too. */
  aiSessionId: string | null;
}

/** A tab reduced to what identifies it; null when it does not come back or is unusable. */
export const toSnapshotTab = (value: unknown): TabData | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const type = raw.type as WorkbenchTabType;
  if (type === 'query' || COMES_BACK_AFTER_RESTART[type] !== true) return null;
  const id = text(raw.id, MAX_TEXT_LENGTH);
  if (!id) return null;

  const tab: Record<string, unknown> = {
    id,
    type,
    connectionId: text(raw.connectionId, MAX_TEXT_LENGTH),
  };
  TEXT_FIELDS.forEach((field) => {
    const fieldText = text(raw[field], MAX_TEXT_LENGTH);
    if (fieldText) tab[field] = fieldText;
  });
  (Object.keys(CHOICE_FIELDS) as Array<keyof typeof CHOICE_FIELDS>).forEach((field) => {
    const choices: readonly string[] = CHOICE_FIELDS[field];
    if (typeof raw[field] === 'string' && choices.includes(raw[field] as string)) tab[field] = raw[field];
  });
  FLAG_FIELDS.forEach((field) => {
    if (raw[field] === true) tab[field] = true;
  });
  const redisDB = Number(raw.redisDB);
  if (raw.redisDB !== undefined && raw.redisDB !== null && Number.isInteger(redisDB) && redisDB >= 0 && redisDB <= MAX_REDIS_DB) {
    tab.redisDB = redisDB;
  }
  tab.title = text(raw.title, MAX_TITLE_LENGTH) || String(tab.tableName ?? '') || id;
  return tab as unknown as TabData;
};

/** The snapshot of the workbench as it is now. */
export const buildWorkbenchSessionSnapshot = (state: {
  tabs: readonly TabData[];
  activeTabId: string | null;
  aiPanelVisible: boolean;
  detachedAIChatWindow: unknown;
  aiActiveSessionId: string | null;
}): WorkbenchSessionSnapshot => {
  const seen = new Set<string>();
  const entries: SnapshotEntry[] = [];
  for (const tab of state.tabs) {
    if (entries.length >= MAX_SNAPSHOT_TABS) break;
    if (!tab || seen.has(tab.id)) continue;
    if (tab.type === 'query') {
      seen.add(tab.id);
      entries.push({ kind: 'query-slot', id: tab.id });
      continue;
    }
    const snapshotTab = toSnapshotTab(tab);
    if (!snapshotTab) continue;
    seen.add(snapshotTab.id);
    entries.push({ kind: 'tab', tab: snapshotTab });
  }
  const activeTabId = state.activeTabId && seen.has(state.activeTabId) ? state.activeTabId : null;
  // A detached AI window is a window of its own and, like every floating window, is not remembered.
  return {
    version: SNAPSHOT_VERSION,
    entries,
    activeTabId,
    aiPanelDocked: state.aiPanelVisible && !state.detachedAIChatWindow,
    aiSessionId: text(state.aiActiveSessionId, MAX_TEXT_LENGTH) || null,
  };
};

/** Reads what was stored, trusting none of it. Null when there is nothing usable. */
export const parseWorkbenchSessionSnapshot = (stored: string | null): WorkbenchSessionSnapshot | null => {
  if (!stored) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== SNAPSHOT_VERSION || !Array.isArray(record.entries)) return null;

  const seen = new Set<string>();
  const entries: SnapshotEntry[] = [];
  for (const entry of record.entries) {
    if (entries.length >= MAX_SNAPSHOT_TABS) break;
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (item.kind === 'query-slot') {
      const id = text(item.id, MAX_TEXT_LENGTH);
      if (id && !seen.has(id)) {
        seen.add(id);
        entries.push({ kind: 'query-slot', id });
      }
    } else if (item.kind === 'tab') {
      const tab = toSnapshotTab(item.tab);
      if (tab && !seen.has(tab.id)) {
        seen.add(tab.id);
        entries.push({ kind: 'tab', tab });
      }
    }
  }
  const activeTabId = text(record.activeTabId, MAX_TEXT_LENGTH);
  return {
    version: SNAPSHOT_VERSION,
    entries,
    activeTabId: activeTabId && seen.has(activeTabId) ? activeTabId : null,
    aiPanelDocked: record.aiPanelDocked === true,
    aiSessionId: text(record.aiSessionId, MAX_TEXT_LENGTH) || null,
  };
};

export interface WorkbenchRestorePlan {
  tabs: TabData[];
  /** The tab to bring to the front; null leaves the current one alone. */
  activeTabId: string | null;
  openAIPanel: boolean;
}

/**
 * Lays the remembered tab strip over the tabs the store already holds (the SQL editors, which
 * come back with their text on their own). A tab whose connection no longer exists is dropped,
 * and so is one for a type that came back from an older snapshot but must not. Tabs open now
 * and not in the snapshot stay, after the remembered ones.
 */
export const planWorkbenchSessionRestore = (
  snapshot: WorkbenchSessionSnapshot,
  current: { tabs: readonly TabData[]; aiPanelVisible: boolean },
  connectionIds: ReadonlySet<string>,
): WorkbenchRestorePlan => {
  const open = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const placed = new Set<string>();
  const tabs: TabData[] = [];
  const place = (tab: TabData | undefined) => {
    if (!tab || placed.has(tab.id)) return;
    placed.add(tab.id);
    tabs.push(tab);
  };

  for (const entry of snapshot.entries) {
    if (entry.kind === 'query-slot') {
      place(open.get(entry.id));
      continue;
    }
    const { tab } = entry;
    const needsConnection = tab.connectionId !== '' && tab.preserveUnboundConnection !== true;
    if (needsConnection && !connectionIds.has(tab.connectionId)) continue;
    place(open.get(tab.id) ?? tab);
  }
  current.tabs.forEach((tab) => place(tab));

  return {
    tabs,
    activeTabId: snapshot.activeTabId && placed.has(snapshot.activeTabId) ? snapshot.activeTabId : null,
    openAIPanel: snapshot.aiPanelDocked && !current.aiPanelVisible,
  };
};
