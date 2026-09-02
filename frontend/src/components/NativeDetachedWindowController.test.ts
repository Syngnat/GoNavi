import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '../store';
import {
  clearNativeDetachedHostEvents,
  recordNativeDetachedVisibilityRevision,
} from '../utils/nativeDetachedWindowHost';
import { peekQueryEditorResultSession } from '../utils/queryEditorResultSessionCache';
import { clearQueryTabDraft, getQueryTabDraft } from '../utils/sqlFileTabDrafts';
import {
  applyNativeDetachedWindowEvent,
  readAIHostStateRefs,
  type NativeDetachedWindowEvent,
} from './NativeDetachedWindowController';
import NativeDetachedWindowController from './NativeDetachedWindowController';

const buildQueryTab = (id: string, query: string) => ({
  id,
  title: id,
  type: 'query' as const,
  connectionId: 'conn-1',
  query,
});

describe('NativeDetachedWindowController', () => {
  beforeEach(() => {
    clearQueryTabDraft('query-a');
    clearQueryTabDraft('query-b');
    clearNativeDetachedHostEvents('ai-chat');
    useStore.setState({
      tabs: [buildQueryTab('query-a', 'select 1'), buildQueryTab('query-b', 'select 2')],
      activeTabId: 'query-a',
      detachedWorkbenchWindows: [
        { tabId: 'query-a', x: 10, y: 10, width: 800, height: 600, zIndex: 1201 },
        { tabId: 'query-b', x: 30, y: 30, width: 800, height: 600, zIndex: 1202 },
      ],
      detachedQueryResultWindows: [],
      detachedAIChatWindow: null,
      aiPanelVisible: false,
      aiChatHistory: {},
      aiChatSessions: [],
      aiActiveSessionId: null,
      aiContexts: {},
      sqlLogs: [],
    });
  });

  it('syncs only the detached tab and its live result session', () => {
    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'sync',
      payload: {
        storeState: { sqlEditorPendingTransactions: { 'query-a': { transactionId: 'tx-1' } } },
        tab: buildQueryTab('query-a', 'select 42'),
        resultSession: {
          activeResultKey: 'result-1',
          resultSets: [{
            key: 'result-1',
            sql: 'select 42',
            rows: [{ value: 42 }],
            columns: ['value'],
            pkColumns: [],
            readOnly: true,
          }],
        },
      },
    });

    expect(useStore.getState().tabs.find((tab) => tab.id === 'query-a')?.query).toBe('select 42');
    expect(getQueryTabDraft('query-a')).toBe('select 42');
    expect(useStore.getState().tabs.find((tab) => tab.id === 'query-b')?.query).toBe('select 2');
    expect((useStore.getState().sqlEditorPendingTransactions['query-a'] as any)?.transactionId).toBe('tx-1');
    expect(peekQueryEditorResultSession('query-a')?.resultSets[0]?.rows).toEqual([{ value: 42 }]);
  });

  it('ignores sync events echoed back to the child that originated them', () => {
    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'sync',
      payload: { tab: buildQueryTab('query-a', 'select echoed') },
    }, 'workbench:query-a');

    expect(useStore.getState().tabs.find((tab) => tab.id === 'query-a')?.query).toBe('select 1');
  });

  it('merges new child SQL logs by id without duplicating existing entries', () => {
    useStore.getState().addSqlLog({
      id: 'log-existing',
      timestamp: 1,
      sql: 'select 1',
      status: 'success',
      duration: 1,
    });

    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'sync',
      payload: {
        storeState: {
          sqlLogs: [
            {
              id: 'log-new',
              timestamp: 2,
              sql: 'select 2',
              status: 'success',
              duration: 2,
            },
            {
              id: 'log-existing',
              timestamp: 1,
              sql: 'select 1',
              status: 'success',
              duration: 1,
            },
          ],
        },
      },
    });

    expect(useStore.getState().sqlLogs.map((log) => log.id)).toEqual([
      'log-new',
      'log-existing',
    ]);
  });

  it('applies a query-result DataGrid setting delta even when no SQL log was added', () => {
    const workbenchStateSources = new Map<string, Record<string, unknown>>([
      ['query-result:query-a:r1', { queryOptions: { maxRows: 500 } }],
    ]);
    useStore.setState({ queryOptions: { ...useStore.getState().queryOptions, maxRows: 500 } });

    applyNativeDetachedWindowEvent({
      id: 'query-result:query-a:r1',
      kind: 'query-result',
      action: 'sync',
      payload: {
        workbenchState: { queryOptions: { ...useStore.getState().queryOptions, maxRows: 2000 } },
      },
    }, undefined, { workbenchStateSources });

    expect(useStore.getState().queryOptions.maxRows).toBe(2000);
  });

  it('preserves peer window record changes while advancing the child source snapshot', () => {
    const workbenchStateSources = new Map<string, Record<string, unknown>>([
      ['workbench:query-a', { tableHiddenColumns: { users: ['password'] } }],
    ]);
    useStore.setState({
      tableHiddenColumns: {
        users: ['password'],
        orders: ['internal_note'],
      },
    });

    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'sync',
      payload: {
        workbenchState: {
          tableHiddenColumns: { users: ['password', 'email'] },
        },
      },
    }, undefined, { workbenchStateSources });

    expect(useStore.getState().tableHiddenColumns).toEqual({
      users: ['password', 'email'],
      orders: ['internal_note'],
    });
    expect(workbenchStateSources.get('workbench:query-a')).toEqual({
      tableHiddenColumns: { users: ['password', 'email'] },
    });
  });

  it('opens a tab created inside a detached workbench only once', () => {
    const openedTab = buildQueryTab('query-child', 'select 3');
    const event: NativeDetachedWindowEvent = {
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'sync',
      payload: { openedTabs: [openedTab] },
    };

    applyNativeDetachedWindowEvent(event);
    applyNativeDetachedWindowEvent(event);

    expect(useStore.getState().tabs.filter((tab) => tab.id === openedTab.id)).toHaveLength(1);
    expect(useStore.getState().activeTabId).toBe(openedTab.id);
  });

  it('uses the child bootstrap baseline when host state changes while the window opens', () => {
    useStore.setState({
      savedQueries: [
        { id: 'saved-base', name: 'Base', sql: 'select 1', connectionId: 'connection-1', dbName: 'main', createdAt: 1 },
        { id: 'saved-host', name: 'Host', sql: 'select 2', connectionId: 'connection-1', dbName: 'main', createdAt: 2 },
      ],
    });

    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'sync',
      payload: {
        workbenchStateBase: {
          savedQueries: [
            { id: 'saved-base', name: 'Base', sql: 'select 1', connectionId: 'connection-1', dbName: 'main', createdAt: 1 },
          ],
        },
        workbenchState: {
          savedQueries: [
            { id: 'saved-base', name: 'Base', sql: 'select 1', connectionId: 'connection-1', dbName: 'main', createdAt: 1 },
            { id: 'saved-child', name: 'Child', sql: 'select 3', connectionId: 'connection-1', dbName: 'main', createdAt: 3 },
          ],
        },
      },
    });

    expect(useStore.getState().savedQueries.map((query) => query.id)).toEqual([
      'saved-base',
      'saved-child',
      'saved-host',
    ]);
  });

  it('clears main-window SQL logs when a detached child clears its log panel', () => {
    useStore.getState().addSqlLog({
      id: 'log-to-clear',
      timestamp: 1,
      sql: 'select 1',
      status: 'success',
      duration: 1,
    });

    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'sync',
      payload: { clearSqlLogs: true },
    });

    expect(useStore.getState().sqlLogs).toEqual([]);
  });

  it('syncs AI conversation state from the native AI window', () => {
    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'sync',
      payload: {
        storeState: {
          aiChatHistory: {
            'session-1': [{ id: 'message-1', role: 'assistant', content: 'done', timestamp: 1 }],
          },
          aiChatSessions: [{ id: 'session-1', title: 'Session 1', updatedAt: 1 }],
          aiActiveSessionId: 'session-1',
          aiContexts: { 'conn-1:main': [{ dbName: 'main', tableName: 'users', ddl: 'create table users(id int)' }] },
        },
      },
    });

    expect(useStore.getState().aiChatHistory['session-1']?.[0]?.content).toBe('done');
    expect(useStore.getState().aiChatSessions).toEqual([expect.objectContaining({ id: 'session-1' })]);
    expect(useStore.getState().aiActiveSessionId).toBe('session-1');
    expect(useStore.getState().aiContexts['conn-1:main']).toHaveLength(1);
  });

  it('applies only the AI context delta from the child and preserves host additions', () => {
    const users = { dbName: 'main', tableName: 'users', ddl: 'create table users(id int)' };
    const orders = { dbName: 'main', tableName: 'orders', ddl: 'create table orders(id int)' };
    useStore.setState({ aiContexts: { 'conn-1:main': [users, orders] } });
    const aiContextSourceRef = { current: { 'conn-1:main': [users] } };

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'sync',
      payload: { storeState: { aiContexts: {} } },
    }, undefined, { aiContextSourceRef });

    expect(useStore.getState().aiContexts).toEqual({ 'conn-1:main': [orders] });
    expect(aiContextSourceRef.current).toEqual({});
  });

  it('routes child host events only through the main-window callback', () => {
    const onHostEvent = vi.fn();
    const event: NativeDetachedWindowEvent = {
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'host-event',
      payload: {
        hostEvent: {
          id: 'ai-chat:1',
          name: 'gonavi:insert-sql',
          detail: { sql: 'select 1' },
        },
      },
    };

    applyNativeDetachedWindowEvent(event, undefined, { onHostEvent });
    applyNativeDetachedWindowEvent(event, 'ai-chat', { onHostEvent });
    expect(onHostEvent).toHaveBeenCalledOnce();
    expect(onHostEvent).toHaveBeenCalledWith(event.payload?.hostEvent);
  });

  it('accepts sidebar locate host events from a detached workbench', () => {
    const onHostEvent = vi.fn();
    const event: NativeDetachedWindowEvent = {
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'host-event',
      payload: {
        hostEvent: {
          id: 'workbench:query-a:locate-1',
          name: 'gonavi:locate-sidebar-object',
          detail: {
            connectionId: 'conn-1',
            dbName: 'main',
            tableName: 'users',
            objectGroup: 'tables',
          },
        },
      },
    };

    applyNativeDetachedWindowEvent(event, undefined, { onHostEvent });

    expect(onHostEvent).toHaveBeenCalledOnce();
    expect(onHostEvent).toHaveBeenCalledWith(event.payload?.hostEvent);
  });

  it('toggles only the main-window AI panel for a shortcut forwarded by a result child', () => {
    expect(useStore.getState().aiPanelVisible).toBe(false);

    const event: NativeDetachedWindowEvent = {
      id: 'query-result:query-a:r1',
      kind: 'query-result',
      action: 'host-event',
      payload: {
        ownerWindowId: 'workbench:query-a',
        hostEvent: {
          id: 'query-result:query-a:r1:shortcut-1',
          name: 'gonavi:shortcut:toggle-ai-panel',
        },
      },
    };

    applyNativeDetachedWindowEvent(event, 'workbench:query-a');
    expect(useStore.getState().aiPanelVisible).toBe(false);

    applyNativeDetachedWindowEvent(event);
    expect(useStore.getState().aiPanelVisible).toBe(true);
  });

  it('delegates a forwarded AI shortcut to the guarded main-window toggle when provided', () => {
    const onToggleAI = vi.fn();
    const event: NativeDetachedWindowEvent = {
      id: 'query-result:query-a:r1',
      kind: 'query-result',
      action: 'host-event',
      payload: {
        hostEvent: {
          id: 'query-result:query-a:r1:shortcut-guarded',
          name: 'gonavi:shortcut:toggle-ai-panel',
        },
      },
    };

    applyNativeDetachedWindowEvent(event, undefined, { onToggleAI });

    expect(onToggleAI).toHaveBeenCalledOnce();
    expect(useStore.getState().aiPanelVisible).toBe(false);
  });

  it('shows the main window only when the shortcut opens docked AI', () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const windowShow = vi.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        innerHeight: 900,
        innerWidth: 1200,
        runtime: { WindowShow: windowShow },
      },
    });
    const event: NativeDetachedWindowEvent = {
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'host-event',
      payload: {
        hostEvent: {
          id: 'workbench:query-a:shortcut-focus',
          name: 'gonavi:shortcut:toggle-ai-panel',
        },
      },
    };

    try {
      useStore.setState({
        aiChatOpenMode: 'dock',
        aiPanelVisible: false,
        detachedAIChatWindow: null,
      });
      applyNativeDetachedWindowEvent(event);
      expect(useStore.getState().aiPanelVisible).toBe(true);
      expect(windowShow).toHaveBeenCalledOnce();

      applyNativeDetachedWindowEvent(event);
      expect(useStore.getState().aiPanelVisible).toBe(false);
      expect(windowShow).toHaveBeenCalledOnce();

      useStore.setState({ aiChatOpenMode: 'detached' });
      applyNativeDetachedWindowEvent(event);
      expect(useStore.getState().detachedAIChatWindow).not.toBeNull();
      expect(windowShow).toHaveBeenCalledOnce();
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('syncs changed appearance and shortcut options, including newly opened windows', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    const manager = {
      Open: vi.fn(async () => ({ success: true })),
      Focus: vi.fn(async () => ({ success: true })),
      Close: vi.fn(async () => ({ success: true })),
      CloseAll: vi.fn(async () => ({ success: true })),
      SyncHostState: vi.fn(async (_request: {
        id: string;
        revision: number;
        storeState: Record<string, unknown>;
      }) => ({ success: true })),
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        go: { nativewindow: { Manager: manager } },
        runtime: {
          EventsOnMultiple: vi.fn(() => vi.fn()),
          WindowShow: vi.fn(),
        },
      }),
    });
    const resultWindow = {
      id: 'query-result:query-a:r1',
      sourceQueryTabId: 'query-a',
      connectionId: 'conn-1',
      title: 'Result 1',
      x: 10,
      y: 10,
      width: 800,
      height: 600,
      zIndex: 1203,
      result: {
        key: 'r1',
        sql: 'select 1',
        rows: [],
        columns: [],
        pkColumns: [],
        readOnly: true,
      },
    };
    useStore.setState({
      detachedWorkbenchWindows: [
        { tabId: 'query-a', x: 10, y: 10, width: 800, height: 600, zIndex: 1201 },
      ],
      detachedQueryResultWindows: [resultWindow],
      detachedAIChatWindow: { x: 20, y: 20, width: 440, height: 720, zIndex: 1202 },
      appearance: {
        ...useStore.getState().appearance,
        toolbarButtonColorOverrides: {},
      },
    });

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(NativeDetachedWindowController));
        await Promise.resolve();
      });

      await act(async () => {
        useStore.getState().setAppearance({
          toolbarButtonColorOverrides: {
            query: { 'button-bg': '#13579b' },
          },
        });
        useStore.getState().setAppearance({
          toolbarButtonColorOverrides: {
            query: { 'button-bg': '#2468ac' },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      const appearanceOnlyRequests = () => manager.SyncHostState.mock.calls
        .map(([request]) => request)
        .filter((request) => (
          Object.keys(request.storeState).length === 1
          && Object.prototype.hasOwnProperty.call(request.storeState, 'appearance')
        ));
      await vi.waitFor(() => expect(appearanceOnlyRequests()).toHaveLength(3));
      const appearance = useStore.getState().appearance;
      const appearanceSyncRequests = appearanceOnlyRequests();
      expect(appearanceSyncRequests.map((request) => request.id)).toEqual([
        'workbench:query-a',
        'query-result:query-a:r1',
        'ai-chat',
      ]);
      expect(appearance.toolbarButtonColorOverrides).toEqual({
        query: { 'button-bg': '#2468ac' },
      });
      for (const request of appearanceSyncRequests) {
        expect(request.storeState).toEqual({ appearance });
      }

      manager.SyncHostState.mockClear();
      const previousShortcutOptions = useStore.getState().shortcutOptions;
      const shortcutOptions = {
        ...previousShortcutOptions,
        toggleAIPanel: {
          ...previousShortcutOptions.toggleAIPanel,
          mac: { combo: 'Meta+K', enabled: false },
        },
      };

      await act(async () => {
        useStore.setState({ shortcutOptions });
        await Promise.resolve();
        await Promise.resolve();
      });

      const shortcutSyncRequests = manager.SyncHostState.mock.calls
        .map(([request]) => request)
        .filter((request) => Object.prototype.hasOwnProperty.call(
          request.storeState,
          'shortcutOptions',
        ));
      expect(shortcutSyncRequests.map((request) => request.id)).toEqual([
        'workbench:query-a',
        'query-result:query-a:r1',
        'ai-chat',
      ]);
      for (const request of shortcutSyncRequests) {
        expect(request.storeState.shortcutOptions).toEqual(shortcutOptions);
      }

      manager.SyncHostState.mockClear();
      await act(async () => {
        useStore.setState({
          detachedWorkbenchWindows: [
            ...useStore.getState().detachedWorkbenchWindows,
            { tabId: 'query-b', x: 30, y: 30, width: 800, height: 600, zIndex: 1204 },
          ],
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      const newlyOpenedWindowRequests = () => manager.SyncHostState.mock.calls
        .map(([request]) => request)
        .filter((request) => Object.keys(request.storeState).length === 1);
      await vi.waitFor(() => expect(newlyOpenedWindowRequests()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'workbench:query-b',
          storeState: { appearance },
        }),
        expect.objectContaining({
          id: 'workbench:query-b',
          storeState: { shortcutOptions },
        }),
      ])));
      expect(newlyOpenedWindowRequests()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'workbench:query-b',
          storeState: { appearance },
        }),
        expect.objectContaining({
          id: 'workbench:query-b',
          storeState: { shortcutOptions },
        }),
      ]));

      await act(async () => {
        useStore.setState({ detachedAIChatWindow: null });
        await Promise.resolve();
      });
      manager.SyncHostState.mockClear();
      await act(async () => {
        useStore.setState({
          detachedAIChatWindow: { x: 40, y: 40, width: 440, height: 720, zIndex: 1205 },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(manager.SyncHostState).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('parks the native AI child before routing settings to the main window', () => {
    const onOpenAISettings = vi.fn();
    useStore.setState({
      aiPanelVisible: true,
      detachedAIChatWindow: { x: 10, y: 10, width: 500, height: 720, zIndex: 1201 },
    });

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'open-ai-settings',
      payload: { visibilityRevision: 7 },
    }, undefined, { onOpenAISettings });

    expect(onOpenAISettings).toHaveBeenCalledOnce();
    expect(useStore.getState().aiPanelVisible).toBe(false);
    expect(useStore.getState().detachedAIChatWindow).not.toBeNull();

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'open-ai-settings',
    }, 'ai-chat', { onOpenAISettings });
    expect(onOpenAISettings).toHaveBeenCalledOnce();
  });

  it('tracks AI context changes by immutable reference without serializing the context tree', () => {
    const aiContexts = {
      'conn-1:main': [{ dbName: 'main', tableName: 'users', ddl: 'create table users(id int)' }],
    };
    useStore.setState({ aiContexts });

    const refs = readAIHostStateRefs();

    expect(refs.aiContexts).toBe(aiContexts);
    expect(refs).not.toHaveProperty('aiContextsFingerprint');
  });

  it('raises the main window without restoring a maximized window before opening settings', () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const calls: string[] = [];
    const windowUnminimise = vi.fn(() => calls.push('unminimise-window'));
    const show = vi.fn(() => calls.push('show-app'));
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        runtime: {
          WindowUnminimise: windowUnminimise,
          Show: show,
          WindowShow: vi.fn(() => calls.push('show-window')),
        },
      },
    });

    try {
      applyNativeDetachedWindowEvent({
        id: 'ai-chat',
        kind: 'ai-chat',
        action: 'open-ai-settings',
      }, undefined, {
        onOpenAISettings: () => calls.push('open-settings'),
      });

      expect(windowUnminimise).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledOnce();
      expect(calls).toEqual(['show-app', 'show-window', 'open-settings']);
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('reattaches, closes, and crash-recovers the native AI window', () => {
    useStore.setState({
      aiPanelVisible: true,
      detachedAIChatWindow: { x: 10, y: 10, width: 500, height: 720, zIndex: 1201 },
    });
    applyNativeDetachedWindowEvent({ id: 'ai-chat', kind: 'ai-chat', action: 'attach' });
    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).toBeNull();

    useStore.getState().detachAIChatPanel();
    applyNativeDetachedWindowEvent({ id: 'ai-chat', kind: 'ai-chat', action: 'close' });
    expect(useStore.getState().aiPanelVisible).toBe(false);
    expect(useStore.getState().detachedAIChatWindow).toBeNull();

    useStore.getState().detachAIChatPanel();
    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'close',
      payload: { reason: 'process-error', exited: true },
    });
    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).toBeNull();
  });

  it('keeps the docked AI panel visible when a child closes before detach state commits', () => {
    useStore.setState({ aiPanelVisible: true, detachedAIChatWindow: null });

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'close',
    });

    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).toBeNull();
  });

  it('restores detached state when the child cancels a failed close', () => {
    useStore.setState({ aiPanelVisible: false, detachedAIChatWindow: null });

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'cancel-close',
      payload: {
        storeState: {
          aiChatHistory: {
            'session-1': [{ id: 'message-1', role: 'user', content: 'keep me', timestamp: 1 }],
          },
        },
      },
    });

    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).not.toBeNull();
    expect(useStore.getState().aiChatHistory['session-1']?.[0]?.content).toBe('keep me');
  });

  it('restores a workbench tab removed by close-other when the child cancels close', () => {
    const detachedTab = buildQueryTab('query-a', 'select unsaved_work');
    const dockedTab = buildQueryTab('query-b', 'select 2');
    useStore.setState({
      tabs: [detachedTab, dockedTab],
      activeTabId: dockedTab.id,
      detachedWorkbenchWindows: [
        { tabId: detachedTab.id, x: 10, y: 10, width: 800, height: 600, zIndex: 1201 },
      ],
    });

    useStore.getState().closeOtherTabs(dockedTab.id);
    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual([dockedTab.id]);
    expect(useStore.getState().detachedWorkbenchWindows).toEqual([]);

    applyNativeDetachedWindowEvent({
      id: `workbench:${detachedTab.id}`,
      kind: 'workbench',
      action: 'cancel-close',
      payload: { tab: detachedTab },
    });

    expect(useStore.getState().tabs.find((tab) => tab.id === detachedTab.id)).toEqual(
      expect.objectContaining({ query: 'select unsaved_work' }),
    );
    expect(useStore.getState().detachedWorkbenchWindows).toEqual([
      expect.objectContaining({ tabId: detachedTab.id }),
    ]);
  });

  it('merges audit logs produced by an editable detached result window', () => {
    applyNativeDetachedWindowEvent({
      id: 'query-result:query-a:r-edit',
      kind: 'query-result',
      action: 'sync',
      payload: {
        storeState: {
          sqlLogs: [{
            id: 'log-result-edit',
            timestamp: 3,
            sql: 'update users set name = ?',
            status: 'success',
            duration: 4,
            affectedRows: 1,
          }],
        },
      },
    });

    expect(useStore.getState().sqlLogs.map((log) => log.id)).toEqual(['log-result-edit']);
  });

  it('retains the latest edited rows sent by a detached result window', () => {
    const resultWindow = {
      id: 'query-result:query-a:r-edited',
      sourceQueryTabId: 'query-a',
      connectionId: 'conn-1',
      title: 'Edited result',
      x: 10,
      y: 10,
      width: 800,
      height: 600,
      zIndex: 1201,
      result: {
        key: 'r-edited',
        sql: 'select * from users',
        rows: [{ id: 1, name: 'before' }],
        columns: ['id', 'name'],
        pkColumns: ['id'],
        readOnly: false,
      },
    };
    useStore.setState({ detachedQueryResultWindows: [resultWindow] });

    applyNativeDetachedWindowEvent({
      id: resultWindow.id,
      kind: 'query-result',
      action: 'sync',
      payload: {
        resultWindow: {
          ...resultWindow,
          result: {
            ...resultWindow.result,
            rows: [{ id: 1, name: 'edited' }],
          },
        },
      },
    });

    expect(useStore.getState().detachedQueryResultWindows[0].result.rows).toEqual([
      { id: 1, name: 'edited' },
    ]);
  });

  it('tracks a result window opened by its owning detached SQL window', () => {
    const resultWindow = {
      id: 'query-result:query-a:r-nested',
      sourceQueryTabId: 'query-a',
      connectionId: 'conn-1',
      title: 'Nested result',
      x: 2100,
      y: -120,
      width: 900,
      height: 620,
      zIndex: 1201,
      result: {
        key: 'r-nested',
        sql: 'select 7',
        rows: [{ value: 7 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    };
    const event: NativeDetachedWindowEvent = {
      id: resultWindow.id,
      kind: 'query-result',
      action: 'opened',
      payload: {
        ownerWindowId: 'workbench:query-a',
        resultWindow,
      },
    };

    applyNativeDetachedWindowEvent(event);
    expect(useStore.getState().detachedQueryResultWindows).toEqual([
      expect.objectContaining({ id: resultWindow.id }),
    ]);
    useStore.setState({ detachedQueryResultWindows: [] });

    applyNativeDetachedWindowEvent(event, resultWindow.id);
    applyNativeDetachedWindowEvent(event, 'workbench:query-b');
    expect(useStore.getState().detachedQueryResultWindows).toEqual([]);

    applyNativeDetachedWindowEvent(event, 'workbench:query-a');
    expect(useStore.getState().detachedQueryResultWindows).toEqual([
      expect.objectContaining({ id: resultWindow.id }),
    ]);
  });

  it('reattaches one tab without closing it or disturbing peer windows', () => {
    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'attach',
      payload: { tab: buildQueryTab('query-a', 'select 9') },
    });

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-a', 'query-b']);
    expect(useStore.getState().detachedWorkbenchWindows.map((item) => item.tabId)).toEqual(['query-b']);
    expect(useStore.getState().activeTabId).toBe('query-a');
  });

  it('parks a native AI child without discarding its detached identity', () => {
    useStore.setState({
      aiPanelVisible: true,
      detachedAIChatWindow: { x: 20, y: 30, width: 440, height: 720, zIndex: 1203 },
      aiChatHistory: {
        'session-1': [{ id: 'message-1', role: 'assistant', content: 'kept', timestamp: 1 }],
      },
    });

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'hide',
      payload: { visibilityRevision: 3 },
    });

    expect(useStore.getState().aiPanelVisible).toBe(false);
    expect(useStore.getState().detachedAIChatWindow).toEqual(expect.objectContaining({
      width: 440,
      height: 720,
    }));
    expect(useStore.getState().aiChatHistory['session-1'][0]?.content).toBe('kept');
  });

  it('restores main-store visibility when the native AI child is focused again', () => {
    const detachedAIChatWindow = {
      x: 20,
      y: 30,
      width: 440,
      height: 720,
      zIndex: 1203,
    };
    useStore.setState({
      aiPanelVisible: false,
      detachedAIChatWindow,
    });

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'focus',
      payload: { visibilityRevision: 8 },
    });

    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).toBe(detachedAIChatWindow);

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'hide',
      payload: { visibilityRevision: 7 },
    });
    expect(useStore.getState().aiPanelVisible).toBe(true);
  });

  it('ignores delayed AI settings events older than the latest native focus', () => {
    const onOpenAISettings = vi.fn();
    useStore.setState({
      aiPanelVisible: false,
      detachedAIChatWindow: { x: 20, y: 30, width: 440, height: 720, zIndex: 1203 },
    });

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'focus',
      payload: { visibilityRevision: 8 },
    });
    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'open-ai-settings',
      payload: { visibilityRevision: 7 },
    }, undefined, { onOpenAISettings });

    expect(onOpenAISettings).not.toHaveBeenCalled();
    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).not.toBeNull();
  });

  it('ignores a delayed hide event older than the latest native focus', () => {
    useStore.setState({
      aiPanelVisible: true,
      detachedAIChatWindow: { x: 20, y: 30, width: 440, height: 720, zIndex: 1203 },
    });
    recordNativeDetachedVisibilityRevision('ai-chat', 7);

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'hide',
      payload: { visibilityRevision: 6 },
    });

    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).not.toBeNull();

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'hide',
      payload: { visibilityRevision: 8 },
    });
    expect(useStore.getState().aiPanelVisible).toBe(false);
  });

  it('drops a parked AI identity when its child process exits', () => {
    useStore.setState({
      aiPanelVisible: false,
      detachedAIChatWindow: { x: 20, y: 30, width: 440, height: 720, zIndex: 1203 },
    });

    applyNativeDetachedWindowEvent({
      id: 'ai-chat',
      kind: 'ai-chat',
      action: 'close',
      payload: { reason: 'process-error', exited: true },
    });

    expect(useStore.getState().aiPanelVisible).toBe(false);
    expect(useStore.getState().detachedAIChatWindow).toBeNull();
  });

  it('closes only the tab whose native window sent an explicit close action', () => {
    const event: NativeDetachedWindowEvent = {
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'close',
    };
    applyNativeDetachedWindowEvent(event);

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-b']);
    expect(useStore.getState().detachedWorkbenchWindows.map((item) => item.tabId)).toEqual(['query-b']);
  });

  it('reattaches a workbench tab when its child process exits unexpectedly', () => {
    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'close',
      payload: { reason: 'process-error', exited: true, error: 'exit status 9' },
    });

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-a', 'query-b']);
    expect(useStore.getState().detachedWorkbenchWindows.map((item) => item.tabId)).toEqual(['query-b']);
    expect(useStore.getState().activeTabId).toBe('query-a');
  });

  it('restores instead of deleting when the process exit races a window-close action', () => {
    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'close',
      payload: { reason: 'window-closed', exited: true },
    });

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-a', 'query-b']);
    expect(useStore.getState().detachedWorkbenchWindows.map((item) => item.tabId)).toEqual(['query-b']);
  });

  it('ignores the child process exit that follows a successful reattach', () => {
    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'attach',
      payload: { tab: buildQueryTab('query-a', 'select 9') },
    });
    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'close',
      payload: { reason: 'attached', exited: true },
    });

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-a', 'query-b']);
    expect(useStore.getState().detachedWorkbenchWindows.map((item) => item.tabId)).toEqual(['query-b']);
  });

  it('keeps a docked tab when a just-ready child exits before detach state commits', () => {
    useStore.setState({
      detachedWorkbenchWindows: useStore.getState().detachedWorkbenchWindows.filter(
        (item) => item.tabId !== 'query-a',
      ),
    });
    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'close',
      payload: { reason: 'process-error', exited: true },
    });

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-a', 'query-b']);
  });

  it('keeps a docked tab when a child closes before detach state commits', () => {
    useStore.setState({
      detachedWorkbenchWindows: useStore.getState().detachedWorkbenchWindows.filter(
        (item) => item.tabId !== 'query-a',
      ),
    });

    applyNativeDetachedWindowEvent({
      id: 'workbench:query-a',
      kind: 'workbench',
      action: 'close',
    });

    expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-a', 'query-b']);
    expect(useStore.getState().detachedWorkbenchWindows.map((item) => item.tabId)).toEqual(['query-b']);
  });

  it('restores a result snapshot without closing its source query tab', () => {
    useStore.setState({
      detachedQueryResultWindows: [{
        id: 'query-result:query-a:r1',
        sourceQueryTabId: 'query-a',
        connectionId: 'conn-1',
        title: 'Result 1',
        x: 10,
        y: 10,
        width: 800,
        height: 600,
        zIndex: 1201,
        result: {
          key: 'r1',
          sql: 'select 42',
          rows: [{ value: 42 }],
          columns: ['value'],
          pkColumns: [],
          readOnly: true,
        },
      }],
    });
    const dispatchEvent = vi.fn();
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent },
    });
    try {
      applyNativeDetachedWindowEvent({
        id: 'query-result:query-a:r1',
        kind: 'query-result',
        action: 'attach',
      });
      expect(useStore.getState().detachedQueryResultWindows).toEqual([]);
      expect(useStore.getState().tabs.map((tab) => tab.id)).toEqual(['query-a', 'query-b']);
      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(dispatchEvent.mock.calls[0][0].detail.result.rows).toEqual([{ value: 42 }]);
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('re-detaches an inline result when a failed native close cancels attach', () => {
    const resultWindow = {
      id: 'query-result:query-a:r1',
      sourceQueryTabId: 'query-a',
      connectionId: 'conn-1',
      title: 'Result 1',
      x: 10,
      y: 10,
      width: 800,
      height: 600,
      zIndex: 1201,
      result: {
        key: 'r1',
        sql: 'select 42',
        rows: [{ value: 42 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    };
    const dispatchEvent = vi.fn();
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent },
    });
    try {
      useStore.setState({ detachedQueryResultWindows: [resultWindow] });
      applyNativeDetachedWindowEvent({
        id: resultWindow.id,
        kind: 'query-result',
        action: 'attach',
      });
      expect(useStore.getState().detachedQueryResultWindows).toEqual([]);

      applyNativeDetachedWindowEvent({
        id: resultWindow.id,
        kind: 'query-result',
        action: 'cancel-close',
        payload: { resultWindow, rollbackAction: 'attach' },
      });

      expect(useStore.getState().detachedQueryResultWindows).toEqual([
        expect.objectContaining({ id: resultWindow.id, result: resultWindow.result }),
      ]);
      expect(dispatchEvent).toHaveBeenCalledTimes(2);
      expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
        type: 'gonavi:restore-query-result',
        detail: {
          sourceQueryTabId: 'query-a',
          result: resultWindow.result,
        },
      });
      expect(dispatchEvent.mock.calls[1][0]).toMatchObject({
        type: 'gonavi:redetach-query-result',
        detail: {
          windowId: resultWindow.id,
          sourceQueryTabId: 'query-a',
          resultKey: 'r1',
        },
      });
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('restores a detached result when its child process crashes', () => {
    useStore.setState({
      detachedQueryResultWindows: [{
        id: 'query-result:query-a:r1',
        sourceQueryTabId: 'query-a',
        connectionId: 'conn-1',
        title: 'Result 1',
        x: 10,
        y: 10,
        width: 800,
        height: 600,
        zIndex: 1201,
        result: {
          key: 'r1',
          sql: 'select 42',
          rows: [{ value: 42 }],
          columns: ['value'],
          pkColumns: [],
          readOnly: true,
        },
      }],
    });
    const dispatchEvent = vi.fn();
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent },
    });
    try {
      applyNativeDetachedWindowEvent({
        id: 'query-result:query-a:r1',
        kind: 'query-result',
        action: 'close',
        payload: { reason: 'process-error', exited: true },
      });

      expect(useStore.getState().detachedQueryResultWindows).toEqual([]);
      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(dispatchEvent.mock.calls[0][0].detail.result.rows).toEqual([{ value: 42 }]);
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('routes result restoration to the detached SQL window that owns it', () => {
    const resultWindow = {
      id: 'query-result:query-a:r-owned',
      sourceQueryTabId: 'query-a',
      connectionId: 'conn-1',
      title: 'Owned result',
      x: 10,
      y: 10,
      width: 800,
      height: 600,
      zIndex: 1201,
      result: {
        key: 'r-owned',
        sql: 'select 8',
        rows: [{ value: 8 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    };
    useStore.setState({ detachedQueryResultWindows: [resultWindow] });
    const dispatchEvent = vi.fn();
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent },
    });
    try {
      const event: NativeDetachedWindowEvent = {
        id: resultWindow.id,
        kind: 'query-result',
        action: 'attach',
        payload: { ownerWindowId: 'workbench:query-a' },
      };
      applyNativeDetachedWindowEvent(event, 'workbench:query-b');
      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(useStore.getState().detachedQueryResultWindows).toHaveLength(1);

      applyNativeDetachedWindowEvent(event, 'workbench:query-a');
      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(dispatchEvent.mock.calls[0][0].detail.result.rows).toEqual([{ value: 8 }]);
      expect(useStore.getState().detachedQueryResultWindows).toEqual([]);
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
