import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '../store';
import type { TabData } from '../types';
import {
  clearNativeDetachedHostEvents,
  openNativeAIChatWindow,
  openNativeQueryResultWindow,
  openNativeWorkbenchTabWindow,
  forwardNativeDetachedHostEvent,
  shouldApplyNativeDetachedHideRevision,
  syncNativeAIChatHostState,
  syncNativeDetachedShortcutOptions,
  syncNativeDetachedThemeContext,
  toggleOrFocusNativeAIChatFromMainWindow,
  type NativeDetachedWindowManager,
} from './nativeDetachedWindowHost';
import { clearQueryTabDraft, setQueryTabDraft } from './sqlFileTabDrafts';
import { NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY } from './nativeDetachedWindowClient';

const buildTab = (id: string) => ({
  id,
  title: `Query ${id}`,
  type: 'query' as const,
  connectionId: 'conn-1',
  dbName: 'main',
  query: 'select 1',
});

describe('nativeDetachedWindowHost', () => {
  let manager: NativeDetachedWindowManager;

  beforeEach(() => {
    clearNativeDetachedHostEvents('ai-chat');
    manager = {
      Open: vi.fn().mockResolvedValue({ success: true }),
      Focus: vi.fn().mockResolvedValue({ success: true }),
      Hide: vi.fn().mockResolvedValue({ success: true, visibilityRevision: 1 }),
      Close: vi.fn().mockResolvedValue({ success: true }),
      CloseAll: vi.fn().mockResolvedValue({ success: true }),
      SyncHostState: vi.fn().mockResolvedValue({ success: true }),
    };
    useStore.setState({
      tabs: [buildTab('query-1')],
      activeTabId: 'query-1',
      detachedWorkbenchWindows: [],
      detachedQueryResultWindows: [],
      detachedAIChatWindow: null,
      aiPanelVisible: false,
      aiChatHistory: {},
      aiChatSessions: [],
      aiActiveSessionId: null,
      aiContexts: {},
    });
  });

  afterEach(() => {
    clearQueryTabDraft('query-1');
    vi.restoreAllMocks();
  });

  it('hides the docked tab only after the native window opens', async () => {
    let resolveOpen: ((value: { success: boolean }) => void) | undefined;
    const pending = new Promise<{ success: boolean }>((resolve) => {
      resolveOpen = resolve;
    });
    vi.mocked(manager.Open).mockReturnValueOnce(pending);

    const opening = openNativeWorkbenchTabWindow('query-1', { x: -1600, y: 120 }, manager);
    expect(useStore.getState().isWorkbenchTabDetached('query-1')).toBe(false);

    resolveOpen?.({ success: true });
    await expect(opening).resolves.toBe(true);
    expect(useStore.getState().isWorkbenchTabDetached('query-1')).toBe(true);
    expect(manager.Open).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workbench:query-1',
      kind: 'workbench',
      x: -1600,
      y: 120,
    }));
  });

  it('keeps the tab docked when native window creation fails', async () => {
    vi.mocked(manager.Open).mockResolvedValueOnce({ success: false, message: 'open failed' });

    await expect(
      openNativeWorkbenchTabWindow('query-1', { x: 2000, y: -300 }, manager),
    ).rejects.toThrow('open failed');
    expect(useStore.getState().isWorkbenchTabDetached('query-1')).toBe(false);
  });

  it('focuses an existing window instead of opening a duplicate', async () => {
    await openNativeWorkbenchTabWindow('query-1', undefined, manager);
    await openNativeWorkbenchTabWindow('query-1', undefined, manager);

    expect(manager.Open).toHaveBeenCalledTimes(1);
    expect(manager.Focus).toHaveBeenCalledTimes(2);
    expect(manager.Focus).toHaveBeenCalledWith('workbench:query-1');
  });

  it('restores the source tab when a just-ready child exits before detach commits', async () => {
    vi.mocked(manager.Focus).mockResolvedValueOnce({
      success: false,
      message: 'native window was not found',
    });

    await expect(openNativeWorkbenchTabWindow('query-1', undefined, manager))
      .rejects.toThrow('native window was not found');

    expect(useStore.getState().isWorkbenchTabDetached('query-1')).toBe(false);
    expect(useStore.getState().tabs.map((tab) => tab.id)).toContain('query-1');
  });

  it('opens many tabs with unique native window ids without a hard cap', async () => {
    const tabs = Array.from({ length: 32 }, (_, index) => buildTab(`query-${index + 1}`));
    useStore.setState({ tabs, detachedWorkbenchWindows: [] });

    await Promise.all(tabs.map((tab) => openNativeWorkbenchTabWindow(tab.id, undefined, manager)));

    const ids = vi.mocked(manager.Open).mock.calls.map(([request]) => request.id);
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(32);
    expect(useStore.getState().detachedWorkbenchWindows).toHaveLength(32);
  });

  it('routes every detachable workbench tab type through the native window manager', async () => {
    const types: TabData['type'][] = [
      'query',
      'table',
      'design',
      'sql-file-execution',
      'sql-analysis',
      'sql-audit',
      'redis-keys',
      'redis-command',
      'redis-monitor',
      'trigger',
      'view-def',
      'event-def',
      'routine-def',
      'sequence-def',
      'package-def',
      'table-overview',
      'table-export',
      'jvm-overview',
      'jvm-resource',
      'jvm-audit',
      'jvm-diagnostic',
      'jvm-monitoring',
    ];
    const tabs = types.map((type, index): TabData => ({
      id: `matrix-${index}`,
      title: type,
      type,
      connectionId: 'conn-1',
    }));
    useStore.setState({ tabs, detachedWorkbenchWindows: [] });

    await Promise.all(tabs.map((tab) => openNativeWorkbenchTabWindow(tab.id, undefined, manager)));

    expect(manager.Open).toHaveBeenCalledTimes(types.length);
    expect(vi.mocked(manager.Open).mock.calls.map(([request]) => ({
      kind: request.kind,
      type: request.payload.tab?.type,
    }))).toEqual(types.map((type) => ({ kind: 'workbench', type })));
  });

  it('opens AI chat as a native window and preserves its live conversation state', async () => {
    setQueryTabDraft('query-1', 'select live AI context');
    useStore.setState({
      aiPanelVisible: true,
      aiChatHistory: {
        'session-1': [{ id: 'message-1', role: 'user', content: 'hello', timestamp: 1 }],
      },
      aiChatSessions: [{ id: 'session-1', title: 'Session 1', updatedAt: 1 }],
      aiActiveSessionId: 'session-1',
      aiContexts: { 'conn-1:main': [{ dbName: 'main', tableName: 'users', ddl: 'CREATE TABLE users(id int)' }] },
      detachedAIChatWindow: null,
    });

    await expect(openNativeAIChatWindow({
      x: -1680,
      y: 90,
      width: 520,
      height: 760,
    }, manager)).resolves.toBe(true);

    expect(manager.Open).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      x: -1680,
      y: 90,
      width: 520,
      height: 760,
      payload: expect.objectContaining({
        storeState: expect.objectContaining({
          aiActiveSessionId: 'session-1',
          aiChatSessions: [expect.objectContaining({ id: 'session-1' })],
          aiChatHistory: expect.objectContaining({
            'session-1': [expect.objectContaining({ content: 'hello' })],
          }),
          tabs: [expect.objectContaining({
            id: 'query-1',
            query: 'select live AI context',
          })],
        }),
      }),
    }));
    expect(useStore.getState().detachedAIChatWindow).toBeTruthy();
    expect(manager.SyncHostState).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ai-chat',
      revision: expect.any(Number),
      storeState: expect.objectContaining({
        activeTabId: 'query-1',
        activeTab: expect.objectContaining({
          id: 'query-1',
          query: 'select live AI context',
        }),
      }),
    }));
  });

  it('builds the AI bootstrap from an explicit feature whitelist', async () => {
    const originalTableColumnOrders = useStore.getState().tableColumnOrders;
    useStore.setState({
      aiPanelVisible: true,
      tableColumnOrders: {
        'unrelated-large-table-state': ['x'.repeat(256 * 1024)],
      },
    });

    try {
      await expect(openNativeAIChatWindow(undefined, manager)).resolves.toBe(true);

      const request = vi.mocked(manager.Open).mock.calls[0]?.[0];
      expect(request?.payload.storeState).toEqual(expect.objectContaining({
        languagePreference: useStore.getState().languagePreference,
        theme: useStore.getState().theme,
        appearance: useStore.getState().appearance,
        fontSize: useStore.getState().fontSize,
        uiScale: useStore.getState().uiScale,
        shortcutOptions: useStore.getState().shortcutOptions,
        tabs: useStore.getState().tabs,
        connections: useStore.getState().connections,
        aiChatHistory: useStore.getState().aiChatHistory,
        aiChatSessions: useStore.getState().aiChatSessions,
        aiContexts: useStore.getState().aiContexts,
        savedQueries: useStore.getState().savedQueries,
        sqlSnippets: useStore.getState().sqlSnippets,
        externalSQLDirectories: useStore.getState().externalSQLDirectories,
        sqlEditorTransactionOptions: useStore.getState().sqlEditorTransactionOptions,
      }));
      expect(request?.payload.storeState).not.toHaveProperty('tableColumnOrders');
      expect(request?.payload.storeState).not.toHaveProperty('tableExportHistories');
      expect(request?.payload.storeState).not.toHaveProperty('recentSQLFiles');
      expect(request?.payload.storeState).not.toHaveProperty('windowBounds');
    } finally {
      useStore.setState({ tableColumnOrders: originalTableColumnOrders });
    }
  });

  it('reuses a parked AI child without building another native window', async () => {
    const parkedBounds = { x: -1180, y: 70, width: 480, height: 700 };
    useStore.setState({
      aiPanelVisible: true,
      detachedAIChatWindow: { ...parkedBounds, zIndex: 1201, coordinateSpace: 'screen' },
      aiChatHistory: {
        'session-warm': [{ id: 'message-warm', role: 'assistant', content: 'kept', timestamp: 1 }],
      },
      aiChatSessions: [{ id: 'session-warm', title: 'Warm', updatedAt: 1 }],
      aiActiveSessionId: 'session-warm',
    });
    vi.mocked(manager.Focus).mockResolvedValueOnce({
      success: true,
      bounds: parkedBounds,
      visibilityRevision: 4,
    });

    await expect(openNativeAIChatWindow(undefined, manager)).resolves.toBe(true);

    expect(manager.Focus).toHaveBeenCalledOnce();
    expect(manager.Focus).toHaveBeenCalledWith('ai-chat');
    expect(manager.Open).not.toHaveBeenCalled();
    expect(manager.SyncHostState).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ai-chat',
      storeState: expect.objectContaining({
        shortcutOptions: useStore.getState().shortcutOptions,
      }),
    }));
    expect(useStore.getState().aiChatHistory['session-warm'][0]?.content).toBe('kept');
    expect(shouldApplyNativeDetachedHideRevision('ai-chat', 3)).toBe(false);
  });

  it('focuses an already-visible native AI child from the main shortcut without closing it first', async () => {
    useStore.setState({
      aiPanelVisible: true,
      detachedAIChatWindow: {
        x: 20,
        y: 30,
        width: 440,
        height: 720,
        zIndex: 1201,
        coordinateSpace: 'screen',
      },
    });

    await expect(toggleOrFocusNativeAIChatFromMainWindow(manager)).resolves.toBe(true);

    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(manager.Focus).toHaveBeenCalledOnce();
    expect(manager.Focus).toHaveBeenCalledWith('ai-chat');
    expect(manager.Hide).not.toHaveBeenCalled();
    expect(manager.Open).not.toHaveBeenCalled();
  });

  it('resends the latest AI shortcut after native open completes', async () => {
    const initialShortcutOptions = useStore.getState().shortcutOptions;
    const latestShortcutOptions = {
      ...initialShortcutOptions,
      toggleAIPanel: {
        ...initialShortcutOptions.toggleAIPanel,
        mac: { combo: 'Meta+K', enabled: false },
      },
    };
    useStore.setState({
      aiPanelVisible: true,
      detachedAIChatWindow: null,
    });
    vi.mocked(manager.Open).mockImplementationOnce(async () => {
      useStore.setState({ shortcutOptions: latestShortcutOptions });
      return { success: true };
    });

    await expect(openNativeAIChatWindow(undefined, manager)).resolves.toBe(true);

    const shortcutSync = vi.mocked(manager.SyncHostState!).mock.calls
      .map(([request]) => request)
      .find((request) => Object.prototype.hasOwnProperty.call(
        request.storeState,
        'shortcutOptions',
      ));
    expect(shortcutSync).toEqual(expect.objectContaining({
      id: 'ai-chat',
      storeState: expect.objectContaining({ shortcutOptions: latestShortcutOptions }),
    }));
  });

  it('stores the native bounds returned for every detached window kind', async () => {
    const workbenchBounds = { x: 48, y: 44, width: 840, height: 520 };
    const queryResultBounds = { x: 72, y: 64, width: 800, height: 500 };
    const aiChatBounds = { x: 96, y: 80, width: 420, height: 620 };
    useStore.setState({
      aiPanelVisible: true,
      detachedAIChatWindow: null,
      aiChatDetachedBoundsMemory: {
        x: 0,
        y: 1152,
        width: 921,
        height: 812,
        coordinateSpace: 'screen',
      },
    });
    vi.mocked(manager.Open)
      .mockResolvedValueOnce({ success: true, bounds: workbenchBounds })
      .mockResolvedValueOnce({ success: true, bounds: queryResultBounds })
      .mockResolvedValueOnce({ success: true, bounds: aiChatBounds });

    await expect(openNativeWorkbenchTabWindow('query-1', {
      x: -1600,
      y: 120,
      width: 960,
      height: 640,
    }, manager)).resolves.toBe(true);
    await expect(openNativeQueryResultWindow({
      id: 'query-result:query-1:returned-bounds',
      sourceQueryTabId: 'query-1',
      connectionId: 'conn-1',
      dbName: 'main',
      title: 'Returned bounds',
      x: 2100,
      y: -240,
      width: 960,
      height: 640,
      result: {
        key: 'returned-bounds',
        sql: 'select 42',
        rows: [{ value: 42 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    }, manager)).resolves.toBe(true);
    await expect(openNativeAIChatWindow(undefined, manager)).resolves.toBe(true);

    expect(useStore.getState().detachedWorkbenchWindows).toEqual([
      expect.objectContaining({ tabId: 'query-1', ...workbenchBounds }),
    ]);
    expect(useStore.getState().detachedQueryResultWindows).toEqual([
      expect.objectContaining({
        id: 'query-result:query-1:returned-bounds',
        ...queryResultBounds,
      }),
    ]);
    expect(useStore.getState().detachedAIChatWindow).toEqual(expect.objectContaining(aiChatBounds));
    expect(useStore.getState().aiChatDetachedBoundsMemory).toEqual({
      ...aiChatBounds,
      coordinateSpace: 'screen',
    });
  });

  it('falls back to the requested bounds when native open returns no bounds', async () => {
    const workbenchBounds = { x: 40, y: 36, width: 820, height: 510 };
    const queryResultBounds = { x: 64, y: 52, width: 780, height: 480 };
    const aiChatBounds = { x: 88, y: 72, width: 410, height: 600 };
    useStore.setState({
      aiPanelVisible: true,
      detachedAIChatWindow: null,
    });

    await expect(openNativeWorkbenchTabWindow('query-1', workbenchBounds, manager)).resolves.toBe(true);
    await expect(openNativeQueryResultWindow({
      id: 'query-result:query-1:fallback-bounds',
      sourceQueryTabId: 'query-1',
      connectionId: 'conn-1',
      dbName: 'main',
      title: 'Fallback bounds',
      ...queryResultBounds,
      result: {
        key: 'fallback-bounds',
        sql: 'select 42',
        rows: [{ value: 42 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    }, manager)).resolves.toBe(true);
    await expect(openNativeAIChatWindow(aiChatBounds, manager)).resolves.toBe(true);

    expect(useStore.getState().detachedWorkbenchWindows).toEqual([
      expect.objectContaining({ tabId: 'query-1', ...workbenchBounds }),
    ]);
    expect(useStore.getState().detachedQueryResultWindows).toEqual([
      expect.objectContaining({
        id: 'query-result:query-1:fallback-bounds',
        ...queryResultBounds,
      }),
    ]);
    expect(useStore.getState().detachedAIChatWindow).toEqual(expect.objectContaining(aiChatBounds));
    expect(useStore.getState().aiChatDetachedBoundsMemory).toEqual({
      ...aiChatBounds,
      coordinateSpace: 'screen',
    });
  });

  it('does not reopen AI chat when the user attaches it while native open is pending', async () => {
    let resolveOpen: ((value: { success: boolean }) => void) | undefined;
    vi.mocked(manager.Open).mockReturnValueOnce(new Promise((resolve) => {
      resolveOpen = resolve;
    }));
    vi.mocked(manager.Focus).mockResolvedValueOnce({
      success: false,
      message: 'native window was not found',
    });
    useStore.getState().detachAIChatPanel({ x: 120, y: 80, width: 440, height: 720 });

    const opening = openNativeAIChatWindow(undefined, manager);
    useStore.getState().attachAIChatPanel();
    resolveOpen?.({ success: true });

    await expect(opening).resolves.toBe(false);
    expect(useStore.getState().aiPanelVisible).toBe(true);
    expect(useStore.getState().detachedAIChatWindow).toBeNull();
    expect(manager.Close).toHaveBeenCalledOnce();
    expect(manager.Close).toHaveBeenCalledWith('ai-chat');
    expect(manager.Focus).toHaveBeenCalledOnce();
    expect(manager.Focus).toHaveBeenCalledWith('ai-chat');
    expect(manager.SyncHostState).not.toHaveBeenCalled();
  });

  it('does not reopen AI chat when the user closes it while native open is pending', async () => {
    let resolveOpen: ((value: { success: boolean }) => void) | undefined;
    vi.mocked(manager.Open).mockReturnValueOnce(new Promise((resolve) => {
      resolveOpen = resolve;
    }));
    vi.mocked(manager.Focus).mockResolvedValueOnce({
      success: false,
      message: 'native window was not found',
    });
    useStore.getState().detachAIChatPanel({ x: 120, y: 80, width: 440, height: 720 });

    const opening = openNativeAIChatWindow(undefined, manager);
    useStore.getState().setAIPanelVisible(false);
    resolveOpen?.({ success: true });

    await expect(opening).resolves.toBe(false);
    expect(useStore.getState().aiPanelVisible).toBe(false);
    expect(useStore.getState().detachedAIChatWindow).not.toBeNull();
    expect(manager.Close).toHaveBeenCalledOnce();
    expect(manager.Close).toHaveBeenCalledWith('ai-chat');
    expect(manager.Focus).toHaveBeenCalledOnce();
    expect(manager.Focus).toHaveBeenCalledWith('ai-chat');
    expect(manager.SyncHostState).not.toHaveBeenCalled();
  });

  it('pushes only the active host context to an existing native AI child', async () => {
    useStore.setState({
      activeContext: { connectionId: 'conn-1', dbName: 'main' },
      connections: [{ id: 'conn-1', name: 'Local', config: { type: 'sqlite' } } as any],
    });

    await expect(syncNativeAIChatHostState(manager)).resolves.toBe(true);

    expect(manager.SyncHostState).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ai-chat',
      storeState: expect.objectContaining({
        activeContext: { connectionId: 'conn-1', dbName: 'main' },
        activeTabId: 'query-1',
        activeTab: expect.objectContaining({ id: 'query-1' }),
        activeConnection: expect.objectContaining({ id: 'conn-1' }),
        aiContexts: {},
      }),
    }));
  });

  it('pushes changed shortcut options to every detached window kind', async () => {
    const shortcutOptions = {
      toggleAIPanel: {
        mac: { combo: 'Meta+K', enabled: false },
        windows: { combo: 'Ctrl+K', enabled: false },
      },
    };

    await expect(syncNativeDetachedShortcutOptions([
      'workbench:query-1',
      'query-result:query-1:r1',
      'ai-chat',
    ], shortcutOptions, manager)).resolves.toBe(true);

    expect(manager.SyncHostState).toHaveBeenCalledTimes(3);
    expect(vi.mocked(manager.SyncHostState!).mock.calls.map(([request]) => request.id))
      .toEqual([
        'workbench:query-1',
        'query-result:query-1:r1',
        'ai-chat',
      ]);
    for (const [request] of vi.mocked(manager.SyncHostState!).mock.calls) {
      expect(request).toEqual(expect.objectContaining({ revision: expect.any(Number) }));
      expect(request.storeState).toEqual(request.id === 'ai-chat'
        ? expect.objectContaining({ shortcutOptions })
        : { shortcutOptions });
    }
  });

  it('pushes the active custom theme context to every detached window kind', async () => {
    const theme = {
      schemaVersion: 1 as const,
      id: 'theme-host-sync',
      name: 'Host sync',
      sourceFileName: 'host-sync.css',
      baseMode: 'light' as const,
      css: 'body[data-custom-theme] { --gn-bg-panel: #e8f5ee; --gn-monaco-bg: #e8f5ee; }',
      createdAt: 1,
      updatedAt: 2,
    };

    await expect(syncNativeDetachedThemeContext([
      'workbench:query-1',
      'query-result:query-1:r1',
      'ai-chat',
    ], theme, manager)).resolves.toBe(true);

    expect(manager.SyncHostState).toHaveBeenCalledTimes(3);
    for (const [request] of vi.mocked(manager.SyncHostState!).mock.calls) {
      expect(request.storeState[NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY]).toEqual(theme);
    }
  });

  it('retains and serializes host events for a detached AI child', async () => {
    let releaseFirst: (() => void) | undefined;
    const syncHostState = vi.mocked(manager.SyncHostState!);
    syncHostState
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ success: true });
      }))
      .mockResolvedValue({ success: true });

    const first = forwardNativeDetachedHostEvent(
      'ai-chat',
      'gonavi:ai:inject-prompt',
      { prompt: 'first' },
      manager,
    );
    const second = forwardNativeDetachedHostEvent(
      'ai-chat',
      'gonavi:ai:config-changed',
      undefined,
      manager,
    );

    await vi.waitFor(() => expect(syncHostState).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(syncHostState).toHaveBeenCalledTimes(2);

    const firstRequest = syncHostState.mock.calls[0]![0];
    const secondRequest = syncHostState.mock.calls[1]![0];
    expect(secondRequest.revision).toBeGreaterThan(firstRequest.revision);
    expect((secondRequest.storeState.__gonaviNativeHostEvents as any[]).map((item) => item.name))
      .toEqual(['gonavi:ai:inject-prompt', 'gonavi:ai:config-changed']);
  });

  it('opens a query result snapshot as a native window on another display', async () => {
    await expect(openNativeQueryResultWindow({
      id: 'query-result:query-1:r1',
      sourceQueryTabId: 'query-1',
      connectionId: 'conn-1',
      dbName: 'main',
      title: 'Result 1',
      x: 2100,
      y: -240,
      result: {
        key: 'r1',
        sql: 'select 42',
        rows: [{ value: 42 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    }, manager)).resolves.toBe(true);

    expect(manager.Open).toHaveBeenCalledWith(expect.objectContaining({
      id: 'query-result:query-1:r1',
      kind: 'query-result',
      x: 2100,
      y: -240,
    }));
    expect(useStore.getState().detachedQueryResultWindows).toHaveLength(1);
  });

  it('closes a just-opened result child when its source tab closed while native open was pending', async () => {
    let resolveOpen: ((value: { success: boolean }) => void) | undefined;
    vi.mocked(manager.Open).mockReturnValueOnce(new Promise((resolve) => {
      resolveOpen = resolve;
    }));

    const opening = openNativeQueryResultWindow({
      id: 'query-result:query-1:r-pending',
      sourceQueryTabId: 'query-1',
      connectionId: 'conn-1',
      dbName: 'main',
      title: 'Pending result',
      result: {
        key: 'r-pending',
        sql: 'select 42',
        rows: [{ value: 42 }],
        columns: ['value'],
        pkColumns: [],
        readOnly: true,
      },
    }, manager);

    useStore.getState().closeTab('query-1');
    resolveOpen?.({ success: true });

    await expect(opening).resolves.toBe(false);
    expect(manager.Close).toHaveBeenCalledOnce();
    expect(manager.Close).toHaveBeenCalledWith('query-result:query-1:r-pending');
    expect(manager.Focus).not.toHaveBeenCalled();
    expect(useStore.getState().detachedQueryResultWindows).toEqual([]);
  });
});
