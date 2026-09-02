import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TabData } from '../types';
import type { DetachedQueryResultWindow } from './detachedWindow';
import {
  attachNativeDetachedWindow,
  applyNativeDetachedHostStateSync,
  applyNativeDetachedHostStateCommand,
  buildNativeDetachedAIChatPayload,
  buildNativeDetachedAIHostStoreSnapshot,
  buildNativeDetachedAIChatSyncStoreSnapshot,
  buildNativeDetachedChangedWorkbenchStoreSnapshot,
  buildNativeDetachedQueryResultPayload,
  buildNativeDetachedStoreSnapshot,
  buildNativeDetachedSyncStoreSnapshot,
  buildNativeDetachedWorkbenchMutableStoreSnapshot,
  buildNativeDetachedWorkbenchPayload,
  NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY,
  closeCurrentNativeDetachedWindow,
  fetchNativeDetachedWindowBootstrap,
  hideCurrentNativeDetachedWindow,
  hideCurrentNativeDetachedWindowForAISettings,
  hideNativeDetachedWindow,
  hydrateNativeDetachedStore,
  isNativeDetachedWindow,
  mergeNativeDetachedAIContextsDelta,
  mergeNativeDetachedStoreDelta,
  openNativeDetachedAISettings,
  presentCurrentNativeDetachedWindow,
  readNativeDetachedThemeContext,
} from './nativeDetachedWindowClient';
import {
  clearQueryTabDraft,
  getQueryTabDraft,
  setQueryTabDraft,
} from './sqlFileTabDrafts';
import { MAX_TABLE_ACCESS_COUNT_ENTRIES } from './tableAccessCount';

const queryTab: TabData = {
  id: 'query-1',
  title: 'Query 1',
  type: 'query',
  connectionId: 'connection-1',
  dbName: 'main',
  query: 'select 1',
};

describe('nativeDetachedWindowClient', () => {
  afterEach(() => {
    clearQueryTabDraft('query-1');
    clearQueryTabDraft('query-2');
  });

  it('uses the live editor draft in workbench and AI native snapshots', () => {
    setQueryTabDraft(queryTab.id, 'select live draft');
    const state = {
      tabs: [queryTab],
      activeTabId: queryTab.id,
      connections: [],
      activeContext: null,
    };

    const workbench = buildNativeDetachedWorkbenchPayload(state, queryTab);
    const aiBootstrap = buildNativeDetachedAIChatPayload(state);
    const aiHost = buildNativeDetachedAIHostStoreSnapshot(state);

    expect(workbench.tab?.query).toBe('select live draft');
    expect((workbench.storeState.tabs as TabData[])[0]?.query).toBe('select live draft');
    expect((aiBootstrap.storeState.tabs as TabData[])[0]?.query).toBe('select live draft');
    expect((aiHost.activeTab as TabData).query).toBe('select live draft');
    expect(queryTab.query).toBe('select 1');
  });

  it('carries the resolved custom theme into detached bootstrap and host snapshots', () => {
    const theme = {
      schemaVersion: 1 as const,
      id: 'theme-detached-sync',
      name: 'Detached sync',
      sourceFileName: 'detached-sync.css',
      baseMode: 'light' as const,
      css: 'body[data-custom-theme] { --gn-bg-panel: #e8f5ee; --gn-monaco-bg: #e8f5ee; --gn-accent: #287a58; }',
      createdAt: 1,
      updatedAt: 2,
    };
    const state = { tabs: [queryTab], activeTabId: queryTab.id };

    const payload = buildNativeDetachedAIChatPayload(state, theme);
    const hostSnapshot = buildNativeDetachedAIHostStoreSnapshot(state, [], theme);

    expect(payload.storeState[NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY]).toEqual(theme);
    expect(hostSnapshot[NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY]).toEqual(theme);
    expect(readNativeDetachedThemeContext(payload.storeState)).toEqual(theme);
    expect(readNativeDetachedThemeContext({
      [NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY]: null,
    })).toBeNull();
    expect(readNativeDetachedThemeContext({})).toBeUndefined();
  });

  it('builds a workbench payload without Zustand actions or nested functions', () => {
    const state = {
      tabs: [queryTab],
      theme: 'dark',
      updateQueryTabDraft: () => undefined,
      nested: {
        value: 42,
        callback: () => undefined,
      },
      sqlLogs: [{ id: 'log-1', sql: 'select 1' }],
    };

    const payload = buildNativeDetachedWorkbenchPayload(state, queryTab, {
      resultSets: [],
      activeResultKey: '',
      isResultPanelVisible: true,
    });

    expect(payload.tab).toEqual(queryTab);
    expect(payload.storeState).toEqual({
      tabs: [queryTab],
      activeTabId: queryTab.id,
      detachedWorkbenchWindows: [],
      detachedQueryResultWindows: [],
      detachedAIChatWindow: null,
      theme: 'dark',
      nested: { value: 42 },
      aiContexts: {},
      jvmDiagnosticDrafts: {},
      jvmDiagnosticOutputs: {},
      sqlLogs: [{ id: 'log-1', sql: 'select 1' }],
      sqlEditorPendingTransactions: {},
    });
    expect(JSON.stringify(payload)).not.toContain('updateQueryTabDraft');
    expect(JSON.stringify(payload)).not.toContain('callback');
  });

  it('skips heavyweight runtime state before recursively cloning a workbench snapshot', () => {
    const state: Record<string, unknown> = {
      tabs: [queryTab],
      theme: 'dark',
    };
    for (const key of ['aiChatHistory']) {
      Object.defineProperty(state, key, {
        enumerable: true,
        get: () => {
          throw new Error(`${key} should not be read`);
        },
      });
    }

    const payload = buildNativeDetachedWorkbenchPayload(state, queryTab);

    expect(payload.storeState.theme).toBe('dark');
    expect(payload.storeState).not.toHaveProperty('aiChatHistory');
    expect(payload.storeState.aiContexts).toEqual({});
    expect(payload.storeState.jvmDiagnosticOutputs).toEqual({});
  });

  it('hydrates snapshot data while retaining the current store actions', () => {
    const currentAction = vi.fn();
    let currentState = {
      theme: 'light',
      tabs: [] as TabData[],
      updateQueryTabDraft: currentAction,
    };
    const store = {
      getState: () => currentState,
      setState: (nextState: typeof currentState) => {
        currentState = nextState;
      },
    };

    hydrateNativeDetachedStore(store, {
      theme: 'dark',
      tabs: [queryTab],
      updateQueryTabDraft: 'remote action must not replace the local function',
      unknownKey: 'ignored',
    });

    expect(currentState.theme).toBe('dark');
    expect(currentState.tabs).toEqual([queryTab]);
    expect(currentState.updateQueryTabDraft).toBe(currentAction);
    expect(currentState).not.toHaveProperty('unknownKey');
  });

  it('syncs editor preferences and transaction state without resending all tabs', () => {
    expect(buildNativeDetachedSyncStoreSnapshot({
      tabs: [queryTab],
      queryOptions: { showQueryResultsPanel: true },
      sqlEditorPendingTransactions: { [queryTab.id]: { transactionId: 'tx-1' } },
      sqlLogs: [{ sql: 'select 1' }],
      closeTab: () => undefined,
    }, queryTab.id)).toEqual({
      sqlEditorPendingTransactions: { [queryTab.id]: { transactionId: 'tx-1' } },
    });

    expect(buildNativeDetachedSyncStoreSnapshot({
      sqlEditorPendingTransactions: {},
    }, queryTab.id, [{ id: 'log-new', sql: 'select 2' }])).toEqual({
      sqlEditorPendingTransactions: { [queryTab.id]: null },
      sqlLogs: [{ id: 'log-new', sql: 'select 2' }],
    });
  });

  it('builds a scoped workbench delta for every persisted setting changed in a child', () => {
    const previous = buildNativeDetachedWorkbenchMutableStoreSnapshot({
      queryOptions: { maxRows: 500 },
      sqlFormatOptions: { keywordCase: 'upper' },
      sqlEditorTransactionOptions: { mode: 'manual' },
      tableHiddenColumns: { users: ['password'] },
      savedQueries: [{ id: 'saved-1', name: 'Old' }],
    });

    expect(buildNativeDetachedChangedWorkbenchStoreSnapshot({
      queryOptions: { maxRows: 1000 },
      sqlFormatOptions: { keywordCase: 'lower' },
      sqlEditorTransactionOptions: { mode: 'auto' },
      tableHiddenColumns: { users: ['password'] },
      savedQueries: [{ id: 'saved-1', name: 'New' }],
    }, previous)).toEqual({
      queryOptions: { maxRows: 1000 },
      sqlFormatOptions: { keywordCase: 'lower' },
      sqlEditorTransactionOptions: { mode: 'auto' },
      savedQueries: [{ id: 'saved-1', name: 'New' }],
    });
  });

  it('merges one child record delta without deleting concurrent changes from another window', () => {
    expect(mergeNativeDetachedStoreDelta(
      {
        tableHiddenColumns: {
          users: ['password'],
          orders: ['internal_note'],
        },
      },
      { tableHiddenColumns: { users: ['password'] } },
      { tableHiddenColumns: { users: ['password', 'email'] } },
    )).toEqual({
      tableHiddenColumns: {
        users: ['password', 'email'],
        orders: ['internal_note'],
      },
    });
  });

  it('bounds table access counts merged from detached workbench windows', () => {
    const current = Object.fromEntries(
      Array.from(
        { length: MAX_TABLE_ACCESS_COUNT_ENTRIES },
        (_, index) => [`current-${index}`, index + 2],
      ),
    );
    const merged = mergeNativeDetachedStoreDelta(
      { tableAccessCount: current },
      { tableAccessCount: {} },
      { tableAccessCount: { 'child-new': 1 } },
    );

    expect(Object.keys(merged.tableAccessCount as object)).toHaveLength(
      MAX_TABLE_ACCESS_COUNT_ENTRIES,
    );
    expect((merged.tableAccessCount as Record<string, number>)['current-0']).toBe(2);
    expect((merged.tableAccessCount as Record<string, number>)['child-new']).toBeUndefined();
  });

  it('merges identity-based array deltas without deleting concurrent peer additions', () => {
    expect(mergeNativeDetachedStoreDelta(
      {
        savedQueries: [
          { id: 'saved-base', name: 'Base' },
          { id: 'saved-peer', name: 'Peer' },
        ],
        pinnedSidebarTables: ['users', 'orders'],
      },
      {
        savedQueries: [{ id: 'saved-base', name: 'Base' }],
        pinnedSidebarTables: ['users'],
      },
      {
        savedQueries: [
          { id: 'saved-base', name: 'Base updated' },
          { id: 'saved-child', name: 'Child' },
        ],
        pinnedSidebarTables: ['users', 'payments'],
      },
    )).toEqual({
      savedQueries: [
        { id: 'saved-base', name: 'Base updated' },
        { id: 'saved-child', name: 'Child' },
        { id: 'saved-peer', name: 'Peer' },
      ],
      pinnedSidebarTables: ['users', 'payments', 'orders'],
    });
  });

  it('includes existing AI context and only the active JVM diagnostic state in workbench bootstrap', () => {
    const payload = buildNativeDetachedWorkbenchPayload({
      tabs: [queryTab],
      aiContexts: { 'connection-1:main': [{ dbName: 'main', tableName: 'users' }] },
      jvmDiagnosticDrafts: {
        [queryTab.id]: { command: 'thread' },
        'query-2': { command: 'heap' },
      },
      jvmDiagnosticOutputs: {
        [queryTab.id]: [{ type: 'stdout', content: 'ok' }],
        'query-2': [{ type: 'stdout', content: 'other' }],
      },
    }, queryTab);

    expect(payload.storeState.aiContexts).toEqual({
      'connection-1:main': [{ dbName: 'main', tableName: 'users' }],
    });
    expect(payload.storeState.jvmDiagnosticDrafts).toEqual({
      [queryTab.id]: { command: 'thread' },
    });
    expect(payload.storeState.jvmDiagnosticOutputs).toEqual({
      [queryTab.id]: [{ type: 'stdout', content: 'ok' }],
    });
  });

  it('builds AI chat bootstrap and sync snapshots without unrelated detached state', () => {
    const state = {
      tabs: [queryTab],
      activeTabId: queryTab.id,
      aiPanelVisible: true,
      aiChatHistory: {
        'session-1': [{ id: 'message-1', role: 'user', content: 'hello', timestamp: 1 }],
      },
      aiChatSessions: [{ id: 'session-1', title: 'Session 1', updatedAt: 1 }],
      aiActiveSessionId: 'session-1',
      aiContexts: { 'connection-1:main': [{ dbName: 'main', tableName: 'users', ddl: 'create table users(id int)' }] },
      detachedWorkbenchWindows: [{ tabId: queryTab.id }],
      detachedQueryResultWindows: [{ id: 'result-1' }],
      detachedAIChatWindow: { x: -1200, y: 20, width: 500, height: 720, zIndex: 1201 },
      addAIChatMessage: () => undefined,
    };

    const payload = buildNativeDetachedAIChatPayload(state);

    expect(payload.storeState).toEqual(expect.objectContaining({
      tabs: [queryTab],
      activeTabId: queryTab.id,
      aiPanelVisible: true,
      aiChatHistory: state.aiChatHistory,
      aiChatSessions: state.aiChatSessions,
      aiActiveSessionId: 'session-1',
      aiContexts: state.aiContexts,
      detachedWorkbenchWindows: [],
      detachedQueryResultWindows: [],
      detachedAIChatWindow: null,
    }));
    expect(JSON.stringify(payload)).not.toContain('addAIChatMessage');
    expect(buildNativeDetachedAIChatSyncStoreSnapshot(state)).toEqual({
      aiChatHistory: state.aiChatHistory,
      aiChatSessions: state.aiChatSessions,
      aiActiveSessionId: 'session-1',
      aiContexts: state.aiContexts,
    });
  });

  it('keeps main-window AI context sync separate from child-owned conversation state', () => {
    const appearance = {
      uiVersion: 'v2',
      toolbarButtonColorOverrides: {
        query: {
          'button-bg': '#13579b',
          'primary-hover-border': 'rgba(18, 52, 86, 0.5)',
        },
      },
    };
    const state = {
      theme: 'light',
      themePreference: 'light',
      appearance,
      fontSize: 16,
      uiScale: 1.15,
      activeContext: { connectionId: 'connection-2', dbName: 'analytics' },
      activeTabId: 'query-2',
      tabs: [queryTab, { ...queryTab, id: 'query-2', connectionId: 'connection-2' }],
      connections: [{ id: 'connection-2', name: 'Analytics' }],
      sqlLogs: [{ id: 'log-2', sql: 'select * from events' }],
      aiChatHistory: { 'session-1': [{ content: 'must stay child-owned' }] },
    };

    const snapshot = buildNativeDetachedAIHostStoreSnapshot(state);
    expect(snapshot).toEqual({
      theme: 'light',
      themePreference: 'light',
      appearance,
      fontSize: 16,
      uiScale: 1.15,
      activeContext: state.activeContext,
      activeTabId: 'query-2',
      activeTab: state.tabs[1],
      activeConnection: state.connections[0],
    });
    expect(snapshot).not.toHaveProperty('aiChatHistory');

    const current = {
      ...state,
      theme: 'dark',
      themePreference: 'dark',
      appearance: { uiVersion: 'legacy' },
      fontSize: 12,
      uiScale: 0.9,
      activeTabId: queryTab.id,
      aiChatHistory: { 'session-1': [{ content: 'current child history' }] },
      closeTab: vi.fn(),
    };
    const next = applyNativeDetachedHostStateSync(current, snapshot);
    expect(next.activeTabId).toBe('query-2');
    expect(next.tabs.find((tab) => tab.id === 'query-2')).toEqual(state.tabs[1]);
    expect(next.connections).toEqual(state.connections);
    expect(next.aiChatHistory).toEqual(current.aiChatHistory);
    expect(next.closeTab).toBe(current.closeTab);
    expect(next.theme).toBe('light');
    expect(next.themePreference).toBe('light');
    expect(next.appearance).toEqual(appearance);
    expect(next.fontSize).toBe(16);
    expect(next.uiScale).toBe(1.15);

    let childState = current;
    const childStore = {
      getState: () => childState,
      setState: (nextState: typeof childState) => {
        childState = nextState;
      },
    };
    const revision = applyNativeDetachedHostStateCommand(childStore, 'ai-chat', 4, {
      id: 'ai-chat',
      action: 'sync-host-state',
      payload: { revision: 5, storeState: snapshot },
    });
    expect(revision).toBe(5);
    expect(childState.activeTabId).toBe('query-2');
    expect(childState.appearance).toEqual(appearance);
    expect(getQueryTabDraft('query-2')).toBe('select 1');
    expect(applyNativeDetachedHostStateCommand(childStore, 'ai-chat', revision, {
      id: 'ai-chat',
      action: 'sync-host-state',
      payload: { revision: 3, storeState: { activeTabId: queryTab.id } },
    })).toBe(5);
    expect(childState.activeTabId).toBe('query-2');
  });

  it('applies shortcut options from a newer host-state revision', () => {
    let childState = {
      shortcutOptions: {
        toggleAIPanel: {
          mac: { combo: 'Meta+J', enabled: true },
          windows: { combo: 'Ctrl+J', enabled: true },
        },
      },
      closeTab: vi.fn(),
    };
    const childStore = {
      getState: () => childState,
      setState: (nextState: typeof childState) => {
        childState = nextState;
      },
    };

    const revision = applyNativeDetachedHostStateCommand(childStore, 'workbench:query-1', 2, {
      id: 'workbench:query-1',
      action: 'sync-host-state',
      payload: {
        revision: 3,
        storeState: {
          shortcutOptions: {
            toggleAIPanel: {
              mac: { combo: 'Meta+K', enabled: false },
              windows: { combo: 'Ctrl+K', enabled: false },
            },
          },
        },
      },
    });

    expect(revision).toBe(3);
    expect(childState.shortcutOptions.toggleAIPanel.mac).toEqual({
      combo: 'Meta+K',
      enabled: false,
    });
    expect(childState.closeTab).toBeTypeOf('function');
  });

  it('bounds oversized active SQL before sending it over the native event stream', () => {
    const snapshot = buildNativeDetachedAIHostStoreSnapshot({
      activeTabId: queryTab.id,
      tabs: [{ ...queryTab, query: 'x'.repeat(700_000) }],
      connections: [],
      activeContext: null,
    });

    expect(String((snapshot.activeTab as TabData).query)).toContain('SQL truncated');
    expect(JSON.stringify(snapshot).length).toBeLessThan(600_000);
  });

  it('merges AI context changes from one process without deleting concurrent peer additions', () => {
    const users = { dbName: 'main', tableName: 'users', ddl: 'create table users(id int)' };
    const orders = { dbName: 'main', tableName: 'orders', ddl: 'create table orders(id int)' };
    expect(mergeNativeDetachedAIContextsDelta(
      { 'connection-1:main': [users, orders] },
      { 'connection-1:main': [users] },
      {},
    )).toEqual({ 'connection-1:main': [orders] });
  });

  it('replays retained host events once while accepting newer host state revisions', () => {
    let childState = {
      activeTabId: queryTab.id,
      aiContexts: {},
    };
    const childStore = {
      getState: () => childState,
      setState: (nextState: typeof childState) => {
        childState = nextState;
      },
    };
    const processedEventIds = new Set<string>();
    const dispatchHostEvent = vi.fn();
    const command = {
      id: 'ai-chat',
      action: 'sync-host-state' as const,
      payload: {
        revision: 10,
        storeState: {
          __gonaviNativeHostEvents: [{
            id: 'main:1',
            name: 'gonavi:ai:inject-prompt',
            detail: { prompt: 'explain this query' },
          }],
        },
      },
    };

    const revision = applyNativeDetachedHostStateCommand(
      childStore,
      'ai-chat',
      0,
      command,
      { processedEventIds, dispatchHostEvent },
    );
    expect(revision).toBe(10);
    expect(dispatchHostEvent).toHaveBeenCalledOnce();

    expect(applyNativeDetachedHostStateCommand(
      childStore,
      'ai-chat',
      revision,
      { ...command, payload: { ...command.payload, revision: 11 } },
      { processedEventIds, dispatchHostEvent },
    )).toBe(11);
    expect(dispatchHostEvent).toHaveBeenCalledOnce();
  });

  it('builds an isolated JSON-safe query result snapshot', () => {
    const resultWindow: DetachedQueryResultWindow = {
      id: 'result-1',
      sourceQueryTabId: queryTab.id,
      connectionId: queryTab.connectionId,
      dbName: queryTab.dbName,
      title: 'Result 1',
      x: -1200,
      y: 100,
      width: 900,
      height: 620,
      zIndex: 1201,
      result: {
        key: 'result-set-1',
        sql: 'select 1 as value',
        rows: [{ value: 1, ignored: () => undefined }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    };

    const payload = buildNativeDetachedQueryResultPayload(
      { tabs: [queryTab], closeTab: () => undefined },
      resultWindow,
    );

    expect(payload.resultWindow?.x).toBe(-1200);
    expect(payload.resultWindow?.result.rows).toEqual([{ value: 1 }]);
    expect(payload.resultWindow?.result).not.toBe(resultWindow.result);
    expect(payload.storeState).toEqual({
      tabs: [],
      activeTabId: null,
      detachedWorkbenchWindows: [],
      detachedQueryResultWindows: [],
      detachedAIChatWindow: null,
      sqlLogs: [],
      sqlEditorPendingTransactions: {},
    });
  });

  it('posts attach actions with the detached window identity', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 204 })
    ));

    await attachNativeDetachedWindow(
      { id: 'window-1', kind: 'workbench', tab: queryTab },
      fetchMock as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/__gonavi/detached/action');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      action: 'attach',
      payload: { id: 'window-1', kind: 'workbench', tab: queryTab },
    });
  });

  it('uses the child Go bridge for terminal actions so attach is not followed by close', async () => {
    const action = vi.fn(async () => ({ success: true }));
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __GONAVI_DETACHED__: { action } },
    });
    try {
      await attachNativeDetachedWindow({ id: 'window-1', kind: 'workbench', tab: queryTab });
      expect(action).toHaveBeenCalledWith('attach', {
        id: 'window-1',
        kind: 'workbench',
        tab: queryTab,
      });
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('rejects a terminal action that the parent ignored as stale', async () => {
    const action = vi.fn(async () => ({
      success: true,
      applied: false,
      message: 'stale detached action ignored',
    }));
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __GONAVI_DETACHED__: { action } },
    });
    try {
      await expect(attachNativeDetachedWindow({
        id: 'window-1',
        kind: 'workbench',
        tab: queryTab,
      })).rejects.toThrow('stale detached action ignored');
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('reuses the child runtime bootstrap cache instead of fetching the payload twice', async () => {
    const bootstrap = {
      id: 'workbench:query-1',
      kind: 'workbench' as const,
      title: queryTab.title,
      payload: { storeState: { tabs: [queryTab] }, tab: queryTab },
    };
    const loadBootstrap = vi.fn(async () => bootstrap);
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __GONAVI_DETACHED__: { loadBootstrap } },
    });
    try {
      await expect(fetchNativeDetachedWindowBootstrap()).resolves.toEqual(bootstrap);
      expect(loadBootstrap).toHaveBeenCalledOnce();
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('presents the child through the local runtime without acknowledging parent ready', async () => {
    const present = vi.fn(async () => ({ success: true }));
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __GONAVI_DETACHED__: { present } },
    });
    try {
      await presentCurrentNativeDetachedWindow();
      expect(present).toHaveBeenCalledOnce();
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('routes the non-terminal AI settings command through the child bridge', async () => {
    const action = vi.fn(async () => ({ success: true }));
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __GONAVI_DETACHED__: { action } },
    });
    try {
      await openNativeDetachedAISettings({ id: 'ai-chat', kind: 'ai-chat' });
      expect(action).toHaveBeenCalledWith('open-ai-settings', {
        id: 'ai-chat',
        kind: 'ai-chat',
      });
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('returns the parent visibility revision when an AI child is hidden', async () => {
    const action = vi.fn(async () => ({
      success: true,
      id: 'ai-chat',
      visibilityRevision: 7,
    }));
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __GONAVI_DETACHED__: { action } },
    });
    try {
      await expect(hideNativeDetachedWindow({ id: 'ai-chat', kind: 'ai-chat' }))
        .resolves.toBe(7);
      expect(action).toHaveBeenCalledWith('hide', { id: 'ai-chat', kind: 'ai-chat' });
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('passes the visibility revision to the native hide control', async () => {
    const hide = vi.fn(async () => ({ success: true }));
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { go: { nativewindow: { Control: { Hide: hide } } } },
    });
    try {
      await hideCurrentNativeDetachedWindow(11);
      expect(hide).toHaveBeenCalledWith(11);
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('uses the atomic native hide-and-open control for AI settings', async () => {
    const hideForAISettings = vi.fn(async () => ({ success: true }));
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { go: { nativewindow: { Control: { HideForAISettings: hideForAISettings } } } },
    });
    try {
      await hideCurrentNativeDetachedWindowForAISettings(13);
      expect(hideForAISettings).toHaveBeenCalledWith(13);
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('rejects when the native close control reports a failure', async () => {
    const close = vi.fn(async () => ({
      success: false,
      message: 'native window is not ready',
    }));
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { go: { nativewindow: { Control: { Close: close } } } },
    });
    try {
      await expect(closeCurrentNativeDetachedWindow())
        .rejects.toThrow('native window is not ready');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('detects injected flags and the detached query parameter', () => {
    expect(isNativeDetachedWindow({ pathname: '/', search: '?__gonavi_detached=window-1' })).toBe(true);
    expect(isNativeDetachedWindow({ pathname: '/', search: '' })).toBe(false);

    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __GONAVI_NATIVE_DETACHED__: true },
    });
    try {
      expect(isNativeDetachedWindow({ pathname: '/', search: '' })).toBe(true);
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('omits circular values instead of breaking bootstrap serialization', () => {
    const state: Record<string, unknown> = { theme: 'dark' };
    state.self = state;
    expect(buildNativeDetachedStoreSnapshot(state)).toEqual({ theme: 'dark' });
  });
});
