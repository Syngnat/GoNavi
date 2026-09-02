import { useEffect, useMemo, useRef } from 'react';
import { shallow } from 'zustand/shallow';

import { useStore, type SqlLog } from '../../store';
import type { TabData } from '../../types';
import { resolveLiveQueryTabs } from '../../utils/liveQueryTabs';
import {
  getAIRunHarnessService,
  serializeShortcutOptionsForWorkspace,
  updateWorkspaceSnapshot,
  type WorkspaceSnapshotRequest,
} from './aiRunHarnessClient';
import {
  DEFAULT_AI_RUN_RUNTIME_CONFIG,
  normalizeAIRunPolicySnapshot,
} from './aiRunPolicy';

const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_DRAFT_CHARS = 20_000;
const MAX_SQL_ACTIVITY = 50;

const newInstanceID = (): string => {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID();
  return `desktop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

// A source instance owns one monotonically increasing cursor for its lifetime.
// Keeping it outside React prevents remounts (dock/detached transitions) from
// publishing a stale revision.
const sourceInstanceID = newInstanceID();
let nextRevision = 0;

export const getAIWorkspaceSourceInstanceID = (): string => sourceInstanceID;

const text = (value: unknown): string => String(value || '').trim();

const truncate = (value: unknown, limit = MAX_DRAFT_CHARS): string => {
  const result = String(value || '');
  if (result.length <= limit) return result;
  return `${result.slice(0, Math.floor(limit / 2))}\n/* ... snapshot truncated ... */\n${result.slice(-Math.floor(limit / 2))}`;
};

const tabSnapshot = (tab: TabData) => ({
  id: text(tab.id),
  title: text(tab.title),
  kind: text(tab.type),
  connectionId: text(tab.connectionId),
  database: text(tab.dbName),
  object: text(tab.tableName || tab.viewName || tab.routineName || tab.sequenceName),
  draft: truncate(tab.query),
});

const sqlActivitySnapshot = (logs: SqlLog[] | undefined) => (Array.isArray(logs) ? logs : [])
  .filter((log) => log && !log.hiddenFromRecent)
  .slice(-MAX_SQL_ACTIVITY)
  .map((log) => ({
    id: text(log.id),
    statement: truncate(log.sql, 8_000),
    status: text(log.status),
    createdAt: new Date(Number(log.timestamp) || Date.now()).toISOString(),
  }));

/** Build the complete desktop-owned context sent to the Go Harness. */
export const buildDesktopWorkspaceSnapshot = (
  state: Record<string, any>,
  revision: number,
  sourceID = 'desktop',
  instanceID = sourceInstanceID,
): WorkspaceSnapshotRequest => {
  const tabs = resolveLiveQueryTabs(Array.isArray(state.tabs) ? state.tabs : []);
  const activeTabID = text(state.activeTabId);
  const activeContext = state.activeContext && typeof state.activeContext === 'object'
    ? { ...state.activeContext }
    : null;
  const activeTab = tabs.find((tab) => tab.id === activeTabID);
  const contextKey = activeContext?.connectionId
    ? `${activeContext.connectionId}:${activeContext.dbName || ''}`
    : 'default';
  const attachedContext = state.aiContexts && typeof state.aiContexts === 'object'
    ? state.aiContexts[contextKey] || []
    : [];

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sourceKind: 'desktop',
    sourceId: sourceID,
    sourceInstanceId: instanceID,
    revision,
    capturedAt: new Date().toISOString(),
    activeContext: activeContext
      ? { ...activeContext, attachedItems: attachedContext }
      : { attachedItems: attachedContext },
    tabs: tabs.map(tabSnapshot),
    activeTabId: activeTabID || undefined,
    sqlActivity: sqlActivitySnapshot(state.sqlLogs),
    savedQueries: (Array.isArray(state.savedQueries) ? state.savedQueries : []).map((query: any) => ({
      id: text(query.id),
      name: text(query.name),
      content: truncate(query.sql || query.content),
    })),
    snippets: (Array.isArray(state.sqlSnippets) ? state.sqlSnippets : []).map((snippet: any) => ({
      id: text(snippet.id),
      name: text(snippet.name),
      content: truncate(snippet.body || snippet.content),
    })),
    externalSqlDirectories: (Array.isArray(state.externalSQLDirectories)
      ? state.externalSQLDirectories
      : []).map((directory: any) => text(directory.path || directory.name)).filter(Boolean),
    shortcuts: serializeShortcutOptionsForWorkspace(state.shortcutOptions),
    transactionState: {
      pending: state.sqlEditorPendingTransactions && typeof state.sqlEditorPendingTransactions === 'object'
        ? { ...state.sqlEditorPendingTransactions }
        : {},
      editor: state.sqlEditorTransactionOptions && typeof state.sqlEditorTransactionOptions === 'object'
        ? { ...state.sqlEditorTransactionOptions }
        : {},
      dataEdit: state.dataEditTransactionOptions && typeof state.dataEditTransactionOptions === 'object'
        ? { ...state.dataEditTransactionOptions }
        : {},
    },
    diagnostics: {
      activeTab: activeTab ? { id: activeTab.id, type: activeTab.type } : null,
      contextKey,
    },
    capabilities: {
      desktopTabs: true,
      sqlActivity: true,
      savedQueries: true,
      snippets: true,
      transactions: true,
    },
    availability: {
      source: 'online',
      desktopTabs: 'available',
    },
  };
};

export interface UseAIWorkspaceSnapshotOptions {
  enabled?: boolean;
  sourceId?: string;
}

/** Publish a full snapshot whenever the desktop context changes. */
export const useAIWorkspaceSnapshot = ({
  enabled = true,
  sourceId = 'desktop',
}: UseAIWorkspaceSnapshotOptions = {}): void => {
  const snapshotInputs = useStore((state) => ({
    activeContext: state.activeContext,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    aiContexts: state.aiContexts,
    savedQueries: state.savedQueries,
    sqlSnippets: state.sqlSnippets,
    externalSQLDirectories: state.externalSQLDirectories,
    shortcutOptions: state.shortcutOptions,
    sqlEditorPendingTransactions: state.sqlEditorPendingTransactions,
    sqlEditorTransactionOptions: state.sqlEditorTransactionOptions,
    dataEditTransactionOptions: state.dataEditTransactionOptions,
    sqlLogs: state.sqlLogs,
  }), shallow);
  const dependencyKey = useMemo(() => {
    try {
      return JSON.stringify(snapshotInputs);
    } catch {
      return '';
    }
  }, [snapshotInputs]);

  // Keep the latest complete state available to the lease-renewal timer
  // without recreating the timer for every React render.
  const snapshotInputsRef = useRef(snapshotInputs);
  snapshotInputsRef.current = snapshotInputs;

  const publishRef = useRef<() => void>(() => undefined);
  const sourceIDRef = useRef(sourceId);
  sourceIDRef.current = sourceId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  publishRef.current = () => {
    if (!enabledRef.current) return;
    const service = getAIRunHarnessService();
    // Wails bindings can become available after the first React mount. The
    // scheduled renewal will retry publication without requiring a state edit.
    if (!service?.AIUpdateWorkspaceSnapshot) return;
    nextRevision += 1;
    const snapshot = buildDesktopWorkspaceSnapshot(
      snapshotInputsRef.current as unknown as Record<string, any>,
      nextRevision,
      sourceIDRef.current,
      sourceInstanceID,
    );
    void updateWorkspaceSnapshot(snapshot, service).catch((error) => {
      // Snapshot publication must never interrupt editor or chat input.
      console.warn('Failed to publish AI workspace snapshot', error);
    });
  };

  // Context edits publish an updated full snapshot immediately. This effect
  // deliberately owns no timer: the lease cadence below remains stable while
  // the editor, tabs, or SQL log change.
  useEffect(() => {
    if (!enabled || !dependencyKey) return;
    publishRef.current();
  }, [dependencyKey, enabled, sourceId]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof globalThis.setInterval> | undefined;
    let loadGeneration = 0;
    let policyRefreshInFlight = false;
    let policyRefreshQueued = false;

    const stopTimer = () => {
      if (timer === undefined) return;
      globalThis.clearInterval(timer);
      timer = undefined;
    };

    const startTimer = (
      renewIntervalNanoseconds: number,
      refreshPolicyOnRenewal = false,
    ) => {
      stopTimer();
      const renewIntervalMilliseconds = Math.max(1, Math.round(renewIntervalNanoseconds / 1_000_000));
      timer = globalThis.setInterval(() => {
        publishRef.current();
        if (refreshPolicyOnRenewal) void refreshRuntime();
      }, renewIntervalMilliseconds);
    };

    const refreshRuntime = async () => {
      if (policyRefreshInFlight) {
        policyRefreshQueued = true;
        return;
      }
      policyRefreshInFlight = true;
      const generation = ++loadGeneration;
      const service = getAIRunHarnessService();
      if (!service?.AIGetRunPolicy) {
        if (!disposed && generation === loadGeneration) {
          // The binding can arrive after React has mounted. Keep publishing at
          // the safe default cadence and probe again on the next renewal so a
          // transient startup failure cannot pin this source to five seconds.
          startTimer(DEFAULT_AI_RUN_RUNTIME_CONFIG.workspaceSnapshotRenewInterval, true);
        }
        policyRefreshInFlight = false;
        if (policyRefreshQueued && !disposed) {
          policyRefreshQueued = false;
          void refreshRuntime();
        }
        return;
      }
      try {
        const snapshot = normalizeAIRunPolicySnapshot(await service.AIGetRunPolicy());
        if (!disposed && generation === loadGeneration) {
          startTimer(snapshot.runtime.workspaceSnapshotRenewInterval);
        }
      } catch (error) {
        // A policy read is advisory for desktop renewal. Preserve the default
        // cadence when the ledger/service is temporarily unavailable.
        console.warn('Failed to load AI workspace snapshot renewal policy', error);
        if (!disposed && generation === loadGeneration) {
          startTimer(DEFAULT_AI_RUN_RUNTIME_CONFIG.workspaceSnapshotRenewInterval, true);
        }
      } finally {
        policyRefreshInFlight = false;
        if (policyRefreshQueued && !disposed) {
          policyRefreshQueued = false;
          void refreshRuntime();
        }
      }
    };

    void refreshRuntime();
    const handleConfigChanged = () => { void refreshRuntime(); };
    // Native detached-window tests and server rendering do not provide a
    // browser global. Publishing remains harmless there, but subscribing to
    // a browser-only configuration event must be optional.
    const browserWindow = typeof window === 'undefined' ? undefined : window;
    browserWindow?.addEventListener?.('gonavi:ai:config-changed', handleConfigChanged);
    return () => {
      disposed = true;
      loadGeneration += 1;
      stopTimer();
      browserWindow?.removeEventListener?.('gonavi:ai:config-changed', handleConfigChanged);
    };
  }, [enabled, sourceId]);
};

export const resetAIWorkspaceSnapshotCursor = (): void => {
  nextRevision = 0;
};
