import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabData } from '../types';
import type {
  NativeDetachedWindowActionPayload,
  NativeDetachedWindowBootstrap,
} from '../utils/nativeDetachedWindowClient';
import { NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY } from '../utils/nativeDetachedWindowClient';
import { clearQueryTabDraft, setQueryTabDraft } from '../utils/sqlFileTabDrafts';

const {
  aiTerminalGuard,
  aiChatRenderProps,
  customThemeStyleHostProps,
  detachedResultAutoReport,
  detachedResultDataChangeHandlers,
  detachedResultGridProps,
  detachedResultRows,
  flushAIChatSessionPersistence,
} = vi.hoisted(() => ({
  aiTerminalGuard: vi.fn(async (): Promise<boolean> => true),
  aiChatRenderProps: {
    current: null as { darkMode?: boolean; bgColor?: string; presentation?: string } | null,
  },
  customThemeStyleHostProps: {
    current: null as {
      contextKey?: string;
      onAntTokensChange?: (snapshot: unknown) => void;
      themeOverride?: unknown;
    } | null,
  },
  detachedResultAutoReport: { current: false },
  detachedResultDataChangeHandlers: {
    current: [] as Array<((rows: Array<Record<string, unknown>>) => void) | undefined>,
  },
  detachedResultGridProps: { current: null as Record<string, any> | null },
  detachedResultRows: {
    current: [{ id: 1, name: 'edited in detached result' }] as Array<Record<string, unknown>>,
  },
  flushAIChatSessionPersistence: vi.fn(async () => undefined),
}));
const runtimeEventListeners = new Map<string, (payload: any) => void>();

vi.mock('../../wailsjs/runtime', () => ({
  EventsOn: (name: string, callback: (payload: any) => void) => {
    runtimeEventListeners.set(name, callback);
    return () => runtimeEventListeners.delete(name);
  },
  WindowShow: vi.fn(),
}));

const queryTab: TabData = {
  id: 'query-native-1',
  title: 'Detached query',
  type: 'query',
  connectionId: 'connection-1',
  dbName: 'main',
  query: 'select 1',
};

const workbenchTabTypes: TabData['type'][] = [
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

let storeState: Record<string, any>;
const storeListeners = new Set<() => void>();

vi.mock('../store', async () => {
  const { useSyncExternalStore } = await import('react');
  const useStore = Object.assign(
    (selector: (state: Record<string, any>) => unknown) => useSyncExternalStore(
      (listener) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
      () => selector(storeState),
      () => selector(storeState),
    ),
    {
      getState: () => storeState,
      setState: (nextState: Record<string, any> | ((state: Record<string, any>) => Record<string, any>)) => {
        storeState = typeof nextState === 'function' ? nextState(storeState) : nextState;
        storeListeners.forEach((listener) => listener());
      },
      subscribe: (listener: () => void) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
    },
  );
  return { flushAIChatSessionPersistence, useStore };
});

vi.mock('../i18n/provider', () => ({
  useOptionalI18n: () => null,
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../utils/appearance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/appearance')>();
  return {
    ...actual,
    isMacLikePlatform: () => true,
  };
});

vi.mock('antd', () => ({
  Button: ({ icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) => (
    <button {...props}>{icon}</button>
  ),
  ConfigProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Segmented: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <button data-component="segmented" type="button" onClick={() => onChange?.(value === 'table' ? 'raw' : 'table')}>
      {value}
    </button>
  ),
  Spin: () => <span data-component="spin" />,
  Tag: ({ children }: { children: React.ReactNode }) => <span data-component="tag">{children}</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  theme: {
    darkAlgorithm: 'dark',
    defaultAlgorithm: 'light',
  },
}));

vi.mock('@ant-design/icons', () => ({
  CloseOutlined: () => <span data-icon="close" />,
  CompressOutlined: () => <span data-icon="attach" />,
}));

vi.mock('./WorkbenchTabContent', () => ({
  default: ({
    tab,
    onContentReady,
  }: {
    tab: TabData;
    onContentReady?: () => void;
  }) => {
    React.useEffect(() => {
      onContentReady?.();
    }, [onContentReady]);
    return <div data-workbench-tab={tab.id} />;
  },
}));

vi.mock('./DataGrid', () => ({
  default: (props: { onDataChange?: (rows: Array<Record<string, unknown>>) => void }) => {
    const { onDataChange } = props;
    detachedResultGridProps.current = props;
    detachedResultDataChangeHandlers.current.push(onDataChange);
    React.useEffect(() => {
      if (detachedResultAutoReport.current) {
        onDataChange?.(detachedResultRows.current);
      }
    }, [onDataChange]);
    return (
      <button
        data-component="data-grid"
        type="button"
        onClick={() => onDataChange?.(detachedResultRows.current)}
      />
    );
  },
}));

vi.mock('./AIChatPanel', () => ({
  default: ({
    darkMode,
    bgColor,
    presentation,
    onAttach,
    onClose,
    onOpenSettings,
    onRegisterTerminalGuard,
    interactionDisabled,
  }: {
    darkMode?: boolean;
    bgColor?: string;
    presentation?: string;
    onAttach?: () => void;
    onClose?: () => void;
    onOpenSettings?: () => void;
    onRegisterTerminalGuard?: (guard: (() => Promise<boolean>) | null) => void;
    interactionDisabled?: boolean;
  }) => {
    aiChatRenderProps.current = { darkMode, bgColor, presentation };
    return (
      <div
        data-ai-chat-presentation={presentation}
        data-ai-chat-interaction-disabled={interactionDisabled ? 'true' : 'false'}
        ref={() => onRegisterTerminalGuard?.(aiTerminalGuard)}
      >
        <button data-ai-chat-attach type="button" onClick={onAttach} />
        <button data-ai-chat-close type="button" onClick={onClose} />
        <button data-ai-chat-settings type="button" onClick={onOpenSettings} />
      </div>
    );
  },
}));

vi.mock('./NativeDetachedWindowController', () => ({
  default: () => null,
}));

vi.mock('./theme/CustomThemeStyleHost', () => ({
  default: ({
    contextKey,
    onAntTokensChange,
    themeOverride,
  }: {
    contextKey?: string;
    onAntTokensChange?: (snapshot: unknown) => void;
    themeOverride?: unknown;
  }) => {
    customThemeStyleHostProps.current = { contextKey, onAntTokensChange, themeOverride };
    return null;
  },
}));

import NativeDetachedWindowApp, {
  NATIVE_DETACHED_PAINT_FALLBACK_MS,
  applyNativeDetachedDocumentAppearance,
  waitForNativeDetachedContentPaint,
} from './NativeDetachedWindowApp';

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('NativeDetachedWindowApp', () => {
  beforeEach(() => {
    clearQueryTabDraft(queryTab.id);
    storeListeners.clear();
    runtimeEventListeners.clear();
    flushAIChatSessionPersistence.mockReset();
    flushAIChatSessionPersistence.mockResolvedValue(undefined);
    aiTerminalGuard.mockReset();
    aiTerminalGuard.mockResolvedValue(true);
    aiChatRenderProps.current = null;
    customThemeStyleHostProps.current = null;
    detachedResultAutoReport.current = false;
    detachedResultDataChangeHandlers.current = [];
    detachedResultGridProps.current = null;
    detachedResultRows.current = [{ id: 1, name: 'edited in detached result' }];
    storeState = {
      tabs: [],
      activeTabId: null,
      activeContext: null,
      connections: [],
      theme: 'light',
      themePreference: 'light',
      appearance: { uiVersion: 'v2' },
      fontSize: 14,
      uiScale: 1,
      aiPanelVisible: false,
      aiChatHistory: {},
      aiChatSessions: [],
      aiActiveSessionId: null,
      aiContexts: {},
      shortcutOptions: {
        toggleAIPanel: {
          mac: { combo: 'Meta+J', enabled: true },
          windows: { combo: 'Ctrl+J', enabled: true },
        },
      },
      updateQueryTabDraft: vi.fn(),
    };
  });

  it('applies the host theme context to the detached document before paint', () => {
    const setAttribute = vi.fn();
    const setProperty = vi.fn();
    const documentRef = {
      body: {
        style: { backgroundColor: '', color: '', fontSize: '' },
        setAttribute,
      },
      documentElement: {
        style: { colorScheme: '', setProperty },
      },
    } as any;

    applyNativeDetachedDocumentAppearance('dark', 'v2', 24, 0.5, documentRef);

    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
    expect(setAttribute).toHaveBeenCalledWith('data-ui-version', 'v2');
    expect(documentRef.body.style).toEqual({
      backgroundColor: 'transparent',
      color: '#ffffff',
      fontSize: '20px',
    });
    expect(documentRef.documentElement.style.colorScheme).toBe('dark');
    expect(setProperty).toHaveBeenCalledWith('--gn-ui-scale', '0.8');
    expect(setProperty).toHaveBeenCalledWith('--gn-font-size', '20px');
  });

  it('falls back when a visible WebView temporarily throttles animation frames', async () => {
    vi.useFakeTimers();
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { requestAnimationFrame: vi.fn(() => 1) },
    });
    try {
      const painted = waitForNativeDetachedContentPaint();
      await vi.advanceTimersByTimeAsync(NATIVE_DETACHED_PAINT_FALLBACK_MS);
      await expect(painted).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('hydrates and attaches a workbench tab through the native action client', async () => {
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'native-window-1',
      kind: 'workbench',
      title: queryTab.title,
      payload: {
        storeState: {
          tabs: [queryTab],
          theme: 'dark',
          appearance: { uiVersion: 'v2' },
          fontSize: 15,
        },
        tab: queryTab,
        resultSession: {
          resultSets: [],
          activeResultKey: '',
          isResultPanelVisible: true,
        },
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      present: vi.fn(async () => undefined),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      cancelCloseRequest: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
      await flushEffects();
    });

    expect(storeState.tabs).toEqual([queryTab]);
    expect(storeState.theme).toBe('dark');
    expect(typeof storeState.updateQueryTabDraft).toBe('function');
    expect(client.ready).toHaveBeenCalledWith(expect.objectContaining({
      id: bootstrap.id,
      kind: 'workbench',
    }));
    expect(renderer!.root.findByProps({ 'data-workbench-tab': queryTab.id })).toBeTruthy();

    const attachButton = renderer!.root.findByProps({
      'aria-label': 'tab_manager.detached.restore',
    });
    setQueryTabDraft(queryTab.id, 'select live before attach');
    await act(async () => {
      attachButton.props.onClick();
      await flushEffects();
    });

    expect(client.sync).toHaveBeenCalledWith(expect.objectContaining({
      id: bootstrap.id,
      kind: 'workbench',
      tab: expect.objectContaining({
        id: queryTab.id,
        query: 'select live before attach',
      }),
    }));
    expect(client.attach).toHaveBeenCalledWith(expect.objectContaining({
      id: bootstrap.id,
      kind: 'workbench',
      tab: expect.objectContaining({
        id: queryTab.id,
        query: 'select live before attach',
      }),
    }));
    const syncCalls = client.sync.mock.calls as unknown as Array<[NativeDetachedWindowActionPayload]>;
    const attachCalls = client.attach.mock.calls as unknown as Array<[NativeDetachedWindowActionPayload]>;
    const finalSyncPayload = syncCalls[syncCalls.length - 1]?.[0];
    const attachPayload = attachCalls[attachCalls.length - 1]?.[0];
    expect(finalSyncPayload?.revision).toEqual(expect.any(Number));
    expect(attachPayload?.revision).toEqual(expect.any(Number));
    expect(attachPayload!.revision!).toBeGreaterThan(finalSyncPayload!.revision!);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.closeCurrentWindow).toHaveBeenCalledOnce();
    await act(async () => renderer!.unmount());
    clearQueryTabDraft(queryTab.id);
  });

  it('uses the host custom theme definition in the detached style host', async () => {
    const theme = {
      schemaVersion: 1 as const,
      id: 'theme-detached-app',
      name: 'Detached app',
      sourceFileName: 'detached-app.css',
      baseMode: 'light' as const,
      css: 'body[data-custom-theme] { --gn-bg-panel: #e8f5ee; --gn-monaco-bg: #e8f5ee; }',
      createdAt: 1,
      updatedAt: 2,
    };
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'native-themed-window',
      kind: 'workbench',
      title: queryTab.title,
      payload: {
        storeState: {
          tabs: [queryTab],
          theme: 'light',
          appearance: { uiVersion: 'v2' },
          [NATIVE_DETACHED_CUSTOM_THEME_CONTEXT_KEY]: theme,
        },
        tab: queryTab,
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      present: vi.fn(async () => undefined),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
      await flushEffects();
    });

    expect(customThemeStyleHostProps.current?.themeOverride).toEqual(theme);
    await act(async () => renderer!.unmount());
  });

  it('signals ready only after committed native content crosses a paint frame', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const animationFrames: FrameRequestCallback[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
          animationFrames.push(callback);
          return animationFrames.length;
        }),
      },
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'native-paint-ready',
      kind: 'workbench',
      title: queryTab.title,
      payload: {
        storeState: {
          tabs: [queryTab],
          theme: 'light',
          appearance: { uiVersion: 'v2' },
        },
        tab: queryTab,
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      present: vi.fn(async () => undefined),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      expect(renderer!.root.findByProps({ 'data-workbench-tab': queryTab.id })).toBeTruthy();
      expect(client.present).toHaveBeenCalledOnce();
      expect(client.ready).not.toHaveBeenCalled();
      expect(animationFrames).toHaveLength(1);

      await act(async () => {
        animationFrames.shift()?.(16);
        await flushEffects();
      });
      expect(client.ready).not.toHaveBeenCalled();
      expect(animationFrames).toHaveLength(1);

      await act(async () => {
        animationFrames.shift()?.(32);
        await flushEffects();
      });
      expect(client.ready).toHaveBeenCalledWith({
        id: bootstrap.id,
        kind: bootstrap.kind,
      });
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

  it.each(workbenchTabTypes)('renders %s through the native workbench bootstrap', async (type) => {
    const tab: TabData = {
      id: `native-${type}`,
      title: type,
      type,
      connectionId: 'connection-1',
    };
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: `workbench:${tab.id}`,
      kind: 'workbench',
      title: tab.title,
      payload: {
        storeState: {
          tabs: [tab],
          activeTabId: tab.id,
          theme: 'light',
          appearance: { uiVersion: 'v2' },
        },
        tab,
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
      await flushEffects();
    });

    expect(renderer!.root.findByProps({ 'data-workbench-tab': tab.id })).toBeTruthy();
    expect(client.ready).toHaveBeenCalledWith({ id: bootstrap.id, kind: 'workbench' });
    await act(async () => {
      renderer!.unmount();
    });
  });

  it('hydrates and renders AI chat in a native detached window', async () => {
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: {
        storeState: {
          tabs: [queryTab],
          activeTabId: queryTab.id,
          theme: 'dark',
          appearance: { uiVersion: 'v2' },
          fontSize: 15,
          aiPanelVisible: true,
          aiChatHistory: {
            'session-1': [{ id: 'message-1', role: 'user', content: 'hello', timestamp: 1 }],
          },
          aiChatSessions: [{ id: 'session-1', title: 'Session 1', updatedAt: 1 }],
          aiActiveSessionId: 'session-1',
          aiContexts: {},
        },
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
      await flushEffects();
    });

    expect(renderer!.root.findByProps({ 'data-ai-chat-presentation': 'detached' })).toBeTruthy();
    expect(client.ready).toHaveBeenCalledWith({ id: 'ai-chat', kind: 'ai-chat' });
    expect(customThemeStyleHostProps.current?.contextKey).toBe('dark:v2');

    await act(async () => {
      runtimeEventListeners.get('gonavi:native-detached-command')?.({
        id: 'ai-chat',
        action: 'sync-host-state',
        payload: {
          revision: 2,
          storeState: {
            theme: 'light',
            themePreference: 'light',
            appearance: { uiVersion: 'v2' },
            fontSize: 16,
            uiScale: 1.1,
            activeContext: { connectionId: 'connection-2', dbName: 'analytics' },
            activeTabId: 'query-native-2',
            activeTab: { ...queryTab, id: 'query-native-2', connectionId: 'connection-2' },
            activeConnection: { id: 'connection-2', name: 'Analytics' },
          },
        },
      });
      await flushEffects();
    });
    expect(storeState.activeContext).toEqual({ connectionId: 'connection-2', dbName: 'analytics' });
    expect(storeState.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'query-native-2', connectionId: 'connection-2' }),
    ]));
    expect(storeState.theme).toBe('light');
    expect(storeState.themePreference).toBe('light');
    expect(storeState.appearance).toEqual({ uiVersion: 'v2' });
    expect(storeState.fontSize).toBe(16);
    expect(storeState.uiScale).toBe(1.1);
    expect(aiChatRenderProps.current).toEqual(expect.objectContaining({
      presentation: 'detached',
      darkMode: false,
      bgColor: 'var(--gn-bg-panel, #ffffff)',
    }));
    expect(customThemeStyleHostProps.current?.contextKey).toBe('light:v2');

    await act(async () => {
      renderer!.root.findByProps({ 'data-ai-chat-attach': true }).props.onClick();
      await flushEffects();
    });

    expect(client.attach).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ai-chat',
      kind: 'ai-chat',
      storeState: expect.objectContaining({
        aiActiveSessionId: 'session-1',
        aiChatHistory: expect.objectContaining({
          'session-1': [expect.objectContaining({ content: 'hello' })],
        }),
      }),
    }));
    expect(flushAIChatSessionPersistence).toHaveBeenCalledOnce();
    expect(client.closeCurrentWindow).toHaveBeenCalledOnce();

    expect(client.openAISettings).not.toHaveBeenCalled();
  });

  it('syncs edited query-result rows before the result window is restored', async () => {
    vi.useFakeTimers();
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'query-result:query-native-1:r1',
      kind: 'query-result',
      title: 'Result 1',
      payload: {
        storeState: { appearance: { uiVersion: 'v2' }, theme: 'light', sqlLogs: [] },
        resultWindow: {
          id: 'query-result:query-native-1:r1',
          sourceQueryTabId: queryTab.id,
          connectionId: queryTab.connectionId,
          dbName: queryTab.dbName,
          title: 'Result 1',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1201,
          result: {
            key: 'r1',
            sql: 'select * from APP.USERS',
            rows: [{ id: 1, name: 'before' }],
            columns: ['id', 'name'],
            tableName: 'APP.USERS',
            metadataTableName: 'USERS',
            metadataDbName: 'APP',
            pkColumns: ['id'],
            readOnly: false,
          },
        },
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      await act(async () => {
        renderer!.root.findByProps({ 'data-component': 'data-grid' }).props.onClick();
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(detachedResultGridProps.current).toMatchObject({
        tableName: 'APP.USERS',
        dbName: 'APP',
      });
      expect(client.sync).toHaveBeenCalledWith(expect.objectContaining({
        resultWindow: expect.objectContaining({
          result: expect.objectContaining({
            rows: [{ id: 1, name: 'edited in detached result' }],
          }),
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders detached Elasticsearch raw responses with status metadata', async () => {
    const rawResponse = '{"errors":true,"items":[]}';
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'query-result:query-native-1:es-r1',
      kind: 'query-result',
      title: 'POST /_bulk',
      payload: {
        storeState: { appearance: { uiVersion: 'v2' }, theme: 'light', sqlLogs: [] },
        resultWindow: {
          id: 'query-result:query-native-1:es-r1',
          sourceQueryTabId: queryTab.id,
          connectionId: queryTab.connectionId,
          dbName: 'events',
          title: 'POST /_bulk',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1201,
          result: {
            key: 'es-r1',
            sql: 'POST /_bulk',
            rows: [],
            columns: [],
            resultType: 'elasticsearch',
            requestLabel: 'POST /_bulk',
            httpStatus: 200,
            rawResponse,
            partialFailure: true,
            outcomeUnknown: true,
            pkColumns: [],
            readOnly: true,
          },
        },
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
      await flushEffects();
    });

    const raw = renderer!.root.findByProps({
      'aria-label': 'query_editor.elasticsearch.raw_response',
    });
    expect(raw.props.value).toBe(rawResponse);
    expect(renderer!.root.findAllByProps({ 'data-component': 'data-grid' })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ 'data-component': 'tag' }).map((tag) => tag.children.join('')))
      .toEqual(expect.arrayContaining([
        'HTTP 200',
        'query_editor.elasticsearch.partial',
        'query_editor.elasticsearch.outcome_unknown',
      ]));
  });

  it('keeps query-result data reporting stable across unrelated parent renders', async () => {
    vi.useFakeTimers();
    const initialRows = [{ id: 1, name: 'before' }];
    detachedResultRows.current = initialRows;
    detachedResultAutoReport.current = true;
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'query-result:query-native-1:stable-callback',
      kind: 'query-result',
      title: 'Stable result callback',
      payload: {
        storeState: { appearance: { uiVersion: 'v2' }, theme: 'light', sqlLogs: [] },
        resultWindow: {
          id: 'query-result:query-native-1:stable-callback',
          sourceQueryTabId: queryTab.id,
          connectionId: queryTab.connectionId,
          dbName: queryTab.dbName,
          title: 'Stable result callback',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1201,
          result: {
            key: 'stable-callback',
            sql: 'select * from users',
            rows: initialRows,
            columns: ['id', 'name'],
            pkColumns: ['id'],
            readOnly: false,
          },
        },
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(client.sync).toHaveBeenCalledOnce();

      await act(async () => {
        storeState = { ...storeState, theme: 'dark' };
        storeListeners.forEach((listener) => listener());
        await flushEffects();
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(new Set(detachedResultDataChangeHandlers.current)).toHaveLength(1);
      expect(client.sync).toHaveBeenCalledOnce();

      detachedResultRows.current = [{ id: 1, name: 'edited after rerender' }];
      await act(async () => {
        renderer!.root.findByProps({ 'data-component': 'data-grid' }).props.onClick();
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(client.sync).toHaveBeenCalledTimes(2);
      expect(client.sync).toHaveBeenLastCalledWith(expect.objectContaining({
        resultWindow: expect.objectContaining({
          result: expect.objectContaining({
            rows: [{ id: 1, name: 'edited after rerender' }],
          }),
        }),
      }));
    } finally {
      await act(async () => renderer?.unmount());
      vi.useRealTimers();
    }
  });

  it('syncs a newer query-result edit after an older sync completes', async () => {
    vi.useFakeTimers();
    let resolveFirstSync: (() => void) | undefined;
    const firstSyncPending = new Promise<void>((resolve) => {
      resolveFirstSync = resolve;
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'query-result:query-native-1:r1',
      kind: 'query-result',
      title: 'Result 1',
      payload: {
        storeState: { appearance: { uiVersion: 'v2' }, theme: 'light', sqlLogs: [] },
        resultWindow: {
          id: 'query-result:query-native-1:r1',
          sourceQueryTabId: queryTab.id,
          connectionId: queryTab.connectionId,
          dbName: queryTab.dbName,
          title: 'Result 1',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          zIndex: 1201,
          result: {
            key: 'r1',
            sql: 'select * from users',
            rows: [{ id: 1, name: 'before' }],
            columns: ['id', 'name'],
            pkColumns: ['id'],
            readOnly: false,
          },
        },
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn()
        .mockImplementationOnce(() => firstSyncPending)
        .mockResolvedValue(undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      const dataGrid = renderer!.root.findByProps({ 'data-component': 'data-grid' });

      detachedResultRows.current = [{ id: 1, name: 'edit-v1' }];
      await act(async () => {
        dataGrid.props.onClick();
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(client.sync).toHaveBeenCalledOnce();

      detachedResultRows.current = [{ id: 1, name: 'edit-v2' }];
      await act(async () => {
        dataGrid.props.onClick();
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(client.sync).toHaveBeenCalledOnce();

      await act(async () => {
        resolveFirstSync?.();
        await firstSyncPending;
        await flushEffects();
        await flushEffects();
      });

      expect(client.sync).toHaveBeenCalledTimes(2);
      const syncCalls = client.sync.mock.calls as unknown as Array<[NativeDetachedWindowActionPayload]>;
      expect(syncCalls[0]?.[0].resultWindow?.result.rows).toEqual([{ id: 1, name: 'edit-v1' }]);
      expect(syncCalls[1]?.[0].resultWindow?.result.rows).toEqual([{ id: 1, name: 'edit-v2' }]);
      expect(syncCalls[1]?.[0].revision).toBeGreaterThan(syncCalls[0]?.[0].revision || 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parks the native AI window before opening settings in the main window', async () => {
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      hide: vi.fn(async () => 9),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
      hideCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
      await flushEffects();
    });

    await act(async () => {
      renderer!.root.findByProps({ 'data-ai-chat-settings': true }).props.onClick();
      await flushEffects();
      await flushEffects();
    });

    expect(client.hide).toHaveBeenCalledOnce();
    expect(client.openAISettings).toHaveBeenCalledWith(9);
    expect(client.hide.mock.invocationCallOrder[0]).toBeLessThan(
      client.openAISettings.mock.invocationCallOrder[0],
    );
    expect(client.hideCurrentWindow).not.toHaveBeenCalled();
    expect(client.attach).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(client.closeCurrentWindow).not.toHaveBeenCalled();
  });

  it('unlocks the AI window and allows retry when opening settings fails', async () => {
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const settingsError = new Error('parent settings unavailable');
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      hide: vi.fn()
        .mockResolvedValueOnce(9)
        .mockResolvedValueOnce(11),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn()
        .mockRejectedValueOnce(settingsError)
        .mockResolvedValueOnce(undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
      hideCurrentWindow: vi.fn(async () => undefined),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-settings': true }).props.onClick();
        await flushEffects();
        await flushEffects();
      });

      expect(client.openAISettings).toHaveBeenNthCalledWith(1, 9);
      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('false');

      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-settings': true }).props.onClick();
        await flushEffects();
        await flushEffects();
      });

      expect(client.openAISettings).toHaveBeenNthCalledWith(2, 11);
      expect(client.hideCurrentWindow).not.toHaveBeenCalled();
      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('false');
    } finally {
      await act(async () => renderer?.unmount());
      consoleError.mockRestore();
    }
  });

  it('forwards AI child SQL actions to the main process', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        outerHeight: 720,
        outerWidth: 440,
        screenX: -1200,
        screenY: 80,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      hostEvent: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      const event = new Event('gonavi:insert-sql');
      Object.defineProperty(event, 'detail', { value: { sql: 'select 42' } });
      await act(async () => {
        eventTarget.dispatchEvent(event);
        await flushEffects();
      });

      expect(client.hostEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: 'ai-chat',
        kind: 'ai-chat',
        hostEvent: expect.objectContaining({
          name: 'gonavi:insert-sql',
          detail: { sql: 'select 42' },
        }),
      }));
      await act(async () => {
        renderer!.unmount();
      });
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it.each([
    ['workbench', 'workbench:query-native-1', 'Meta+K', 'k', 'KeyK', true, false, false, false],
    ['query-result', 'query-result:query-native-1:r1', 'Meta+J', 'j', 'KeyJ', true, false, false, false],
    ['ai-chat', 'ai-chat', 'Meta+J', 'j', 'KeyJ', true, false, false, false],
    ['ai-chat', 'ai-chat-repeat', 'Meta+J', 'j', 'KeyJ', true, false, false, true],
    ['workbench', 'workbench:query-native-disabled', 'Meta+J', 'j', 'KeyJ', false, false, false, false],
    ['workbench', 'workbench:query-native-ime', 'Meta+J', 'j', 'KeyJ', true, true, false, false],
    ['workbench', 'workbench:query-native-composition', 'Meta+J', 'j', 'KeyJ', true, false, true, false],
  ] as const)(
    'handles the configured AI shortcut in a detached %s window (%s)',
    async (kind, id, combo, key, code, enabled, isComposing, compositionActive, repeat) => {
      const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
      const eventTarget = new EventTarget();
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: Object.assign(eventTarget, {
          clearTimeout: globalThis.clearTimeout,
          innerWidth: 800,
          outerHeight: 720,
          outerWidth: 800,
          screenX: 40,
          screenY: 40,
          setTimeout: globalThis.setTimeout,
        }),
      });
      const shortcutOptions = {
        toggleAIPanel: {
          mac: { combo, enabled },
          windows: { combo: 'Ctrl+J', enabled: true },
        },
      };
      const bootstrap: NativeDetachedWindowBootstrap = {
        id,
        kind,
        title: 'Detached window',
        payload: {
          storeState: {
            appearance: { uiVersion: 'v2' },
            theme: 'light',
            shortcutOptions,
            ...(kind === 'workbench' ? { tabs: [queryTab], activeTabId: queryTab.id } : {}),
          },
          ...(kind === 'workbench' ? { tab: queryTab } : {}),
          ...(kind === 'query-result'
            ? {
                resultWindow: {
                  id,
                  sourceQueryTabId: queryTab.id,
                  connectionId: queryTab.connectionId || '',
                  dbName: queryTab.dbName,
                  title: 'Result',
                  x: 40,
                  y: 40,
                  width: 800,
                  height: 720,
                  zIndex: 1201,
                  result: {
                    key: 'result-1',
                    sql: 'select 1',
                    rows: [],
                    columns: [],
                    pkColumns: [],
                    readOnly: true,
                  },
                },
              }
            : {}),
        },
      };
      const client = {
        load: vi.fn(async () => bootstrap),
        present: vi.fn(async () => undefined),
        ready: vi.fn(async () => undefined),
        sync: vi.fn(async () => undefined),
        attach: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        cancelCloseRequest: vi.fn(async () => undefined),
        openAISettings: vi.fn(async () => undefined),
        hostEvent: vi.fn(async () => undefined),
        closeCurrentWindow: vi.fn(async () => undefined),
      };

      try {
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
          renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
          await flushEffects();
        });

        const event = new Event('keydown', { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          key: { value: key },
          code: { value: code },
          metaKey: { value: true },
          ctrlKey: { value: false },
          altKey: { value: false },
          shiftKey: { value: false },
          isComposing: { value: isComposing },
          repeat: { value: repeat },
        });
        await act(async () => {
          if (compositionActive) {
            eventTarget.dispatchEvent(new Event('compositionstart'));
          }
          eventTarget.dispatchEvent(event);
          await flushEffects();
        });

        const shouldConsume = enabled && !isComposing && !compositionActive;
        const shouldForward = shouldConsume && !repeat;
        expect(event.defaultPrevented).toBe(shouldConsume);
        if (shouldForward) {
          expect(client.hostEvent).toHaveBeenCalledWith(expect.objectContaining({
            id,
            kind,
            hostEvent: expect.objectContaining({
              name: 'gonavi:shortcut:toggle-ai-panel',
            }),
          }));
        } else {
          expect(client.hostEvent).not.toHaveBeenCalled();
        }
        await act(async () => {
          renderer!.unmount();
        });
      } finally {
        if (previousWindowDescriptor) {
          Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, 'window');
        }
      }
    },
  );

  it('rebinds and disables the AI shortcut after a host-state sync', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    const addEventListener = vi.spyOn(eventTarget, 'addEventListener');
    const removeEventListener = vi.spyOn(eventTarget, 'removeEventListener');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 800,
        outerHeight: 720,
        outerWidth: 800,
        screenX: 40,
        screenY: 40,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'workbench:query-native-1',
      kind: 'workbench',
      title: queryTab.title,
      payload: {
        storeState: {
          appearance: { uiVersion: 'v2' },
          theme: 'light',
          tabs: [queryTab],
          activeTabId: queryTab.id,
          shortcutOptions: {
            toggleAIPanel: {
              mac: { combo: 'Meta+J', enabled: true },
              windows: { combo: 'Ctrl+J', enabled: true },
            },
          },
        },
        tab: queryTab,
      },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      present: vi.fn(async () => undefined),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      cancelCloseRequest: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      hostEvent: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };
    const shortcutEvent = (key: string, code: string) => {
      const event = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        key: { value: key },
        code: { value: code },
        metaKey: { value: true },
        ctrlKey: { value: false },
        altKey: { value: false },
        shiftKey: { value: false },
        isComposing: { value: false },
      });
      return event;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      await act(async () => {
        runtimeEventListeners.get('gonavi:native-detached-command')?.({
          id: bootstrap.id,
          action: 'sync-host-state',
          payload: {
            revision: 1,
            storeState: {
              shortcutOptions: {
                toggleAIPanel: {
                  mac: { combo: 'Meta+K', enabled: true },
                  windows: { combo: 'Ctrl+K', enabled: true },
                },
              },
            },
          },
        });
        renderer?.update(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      expect(storeState.shortcutOptions.toggleAIPanel.mac).toEqual({
        combo: 'Meta+K',
        enabled: true,
      });
      expect(addEventListener.mock.calls.filter(([name]) => name === 'keydown')).toHaveLength(2);
      expect(removeEventListener.mock.calls.filter(([name]) => name === 'keydown')).toHaveLength(1);

      const oldShortcut = shortcutEvent('j', 'KeyJ');
      const reboundShortcut = shortcutEvent('k', 'KeyK');
      await act(async () => {
        eventTarget.dispatchEvent(oldShortcut);
        eventTarget.dispatchEvent(reboundShortcut);
        await flushEffects();
      });
      expect(oldShortcut.defaultPrevented).toBe(false);
      expect(reboundShortcut.defaultPrevented).toBe(true);
      expect(client.hostEvent).toHaveBeenCalledOnce();

      await act(async () => {
        runtimeEventListeners.get('gonavi:native-detached-command')?.({
          id: bootstrap.id,
          action: 'sync-host-state',
          payload: {
            revision: 2,
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
        renderer?.update(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      const disabledShortcut = shortcutEvent('k', 'KeyK');
      await act(async () => {
        eventTarget.dispatchEvent(disabledShortcut);
        await flushEffects();
      });
      expect(disabledShortcut.defaultPrevented).toBe(false);
      expect(client.hostEvent).toHaveBeenCalledOnce();
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

  it('flushes the latest AI session before a graceful native close request', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        outerHeight: 720,
        outerWidth: 440,
        screenX: -1200,
        screenY: 80,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const callOrder: string[] = [];
    aiTerminalGuard.mockImplementationOnce(async () => {
      callOrder.push('guard');
      return true;
    });
    flushAIChatSessionPersistence.mockImplementationOnce(async () => {
      callOrder.push('flush');
    });
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        callOrder.push('close');
      }),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => {
        callOrder.push('close-window');
      }),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      await act(async () => {
        eventTarget.dispatchEvent(new Event('gonavi:native-detached-request-close'));
        await flushEffects();
      });

      expect(callOrder).toEqual(['guard', 'flush', 'close', 'close-window']);
      expect(client.close).toHaveBeenCalledWith(expect.objectContaining({
        id: 'ai-chat',
        kind: 'ai-chat',
        bounds: { x: -1200, y: 80, width: 440, height: 720 },
      }));
      await act(async () => {
        renderer!.unmount();
      });
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('parks the AI child instead of terminating it when its close button is clicked', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        outerHeight: 720,
        outerWidth: 440,
        screenX: -1200,
        screenY: 80,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const callOrder: string[] = [];
    aiTerminalGuard.mockImplementationOnce(async () => {
      callOrder.push('guard');
      return true;
    });
    flushAIChatSessionPersistence.mockImplementationOnce(async () => {
      callOrder.push('flush');
    });
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      hide: vi.fn(async () => {
        callOrder.push('hide');
        return 9;
      }),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
      hideCurrentWindow: vi.fn(async (revision: number) => {
        callOrder.push(`hide-window:${revision}`);
      }),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-close': true }).props.onClick();
        await flushEffects();
        await flushEffects();
      });

      expect(callOrder).toEqual(['guard', 'flush', 'hide', 'hide-window:9']);
      expect(client.close).not.toHaveBeenCalled();
      expect(client.closeCurrentWindow).not.toHaveBeenCalled();
      expect(renderer!.root.findByProps({ 'data-ai-chat-presentation': 'detached' })).toBeTruthy();
      await act(async () => renderer!.unmount());
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('unlocks a parked AI child when a newer focus arrives before native hide returns', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        outerHeight: 720,
        outerWidth: 440,
        screenX: 80,
        screenY: 60,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    let markNativeHideStarted: (() => void) | undefined;
    const nativeHideStarted = new Promise<void>((resolve) => {
      markNativeHideStarted = resolve;
    });
    let releaseFirstNativeHide: (() => void) | undefined;
    let markSecondNativeHideStarted: (() => void) | undefined;
    const secondNativeHideStarted = new Promise<void>((resolve) => {
      markSecondNativeHideStarted = resolve;
    });
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      hide: vi.fn()
        .mockResolvedValueOnce(9)
        .mockResolvedValueOnce(11),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
      hideCurrentWindow: vi.fn((visibilityRevision: number) => {
        if (visibilityRevision === 9) {
          markNativeHideStarted?.();
          return new Promise<void>((resolve) => {
            releaseFirstNativeHide = resolve;
          });
        }
        markSecondNativeHideStarted?.();
        return new Promise<void>(() => undefined);
      }),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-close': true }).props.onClick();
        await flushEffects();
      });
      await nativeHideStarted;
      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('true');

      await act(async () => {
        runtimeEventListeners.get('gonavi:native-detached-command')?.({
          id: 'ai-chat',
          action: 'focus',
          payload: { visibilityRevision: 10 },
        });
        await flushEffects();
      });

      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('false');

      await act(async () => {
        runtimeEventListeners.get('gonavi:native-detached-command')?.({
          id: 'ai-chat',
          action: 'hide',
          payload: { visibilityRevision: 9 },
        });
        const staleHideEvent = new Event('gonavi:native-detached-request-hide');
        Object.defineProperty(staleHideEvent, 'detail', {
          value: { visibilityRevision: 9 },
        });
        eventTarget.dispatchEvent(staleHideEvent);
        await flushEffects();
      });
      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('false');

      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-close': true }).props.onClick();
        await flushEffects();
      });
      await secondNativeHideStarted;
      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('true');

      await act(async () => {
        releaseFirstNativeHide?.();
        await flushEffects();
      });
      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('true');

      await act(async () => {
        runtimeEventListeners.get('gonavi:native-detached-command')?.({
          id: 'ai-chat',
          action: 'focus',
          payload: { visibilityRevision: 12 },
        });
        await flushEffects();
      });
      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('false');
      await act(async () => renderer!.unmount());
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('does not start a cancelled AI hide when focus arrives before its effect starts', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        outerHeight: 720,
        outerWidth: 440,
        screenX: 80,
        screenY: 60,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      hide: vi.fn(async () => 9),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
      hideCurrentWindow: vi.fn(async () => undefined),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      const flushableRenderer = renderer! as TestRenderer.ReactTestRenderer & {
        unstable_flushSync: (callback: () => void) => void;
      };
      flushableRenderer.unstable_flushSync(() => {
        renderer!.root.findByProps({ 'data-ai-chat-close': true }).props.onClick();
      });
      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('true');

      runtimeEventListeners.get('gonavi:native-detached-command')?.({
        id: 'ai-chat',
        action: 'focus',
        payload: { visibilityRevision: 10 },
      });
      await act(async () => {
        await flushEffects();
      });

      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('false');
      expect(client.hide).not.toHaveBeenCalled();
      expect(client.sync).not.toHaveBeenCalled();
      expect(client.hideCurrentWindow).not.toHaveBeenCalled();
      await act(async () => renderer!.unmount());
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('lets a graceful close preempt an in-flight AI hide', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        outerHeight: 720,
        outerWidth: 440,
        screenX: 120,
        screenY: 80,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const callOrder: string[] = [];
    let releaseHide: (() => void) | undefined;
    let markHideStarted: (() => void) | undefined;
    const hideStarted = new Promise<void>((resolve) => {
      markHideStarted = resolve;
    });
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      hide: vi.fn(async () => {
        callOrder.push('hide-started');
        markHideStarted?.();
        return new Promise<number>((resolve) => {
          releaseHide = () => resolve(15);
        });
      }),
      close: vi.fn(async () => {
        callOrder.push('close');
      }),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => {
        callOrder.push('close-window');
      }),
      hideCurrentWindow: vi.fn(async () => {
        callOrder.push('hide-window');
      }),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-close': true }).props.onClick();
        await flushEffects();
      });
      await hideStarted;

      await act(async () => {
        eventTarget.dispatchEvent(new Event('gonavi:native-detached-request-close'));
        runtimeEventListeners.get('gonavi:native-detached-command')?.({
          id: 'ai-chat',
          action: 'focus',
          payload: { visibilityRevision: 16 },
        });
        releaseHide?.();
        await flushEffects();
        await flushEffects();
      });

      expect(client.close).toHaveBeenCalledWith(expect.objectContaining({
        id: 'ai-chat',
        kind: 'ai-chat',
      }));
      expect(client.hideCurrentWindow).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['hide-started', 'close', 'close-window']);
      await act(async () => renderer!.unmount());
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('uses the host visibility revision when the main window requests an AI hide', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        outerHeight: 720,
        outerWidth: 440,
        screenX: 80,
        screenY: 60,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      hide: vi.fn(async () => 99),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
      hideCurrentWindow: vi.fn(async () => undefined),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      const hideEvent = new Event('gonavi:native-detached-request-hide');
      Object.defineProperty(hideEvent, 'detail', { value: { visibilityRevision: 12 } });
      await act(async () => {
        eventTarget.dispatchEvent(hideEvent);
        await flushEffects();
        await flushEffects();
      });

      expect(client.sync).toHaveBeenCalledWith(expect.objectContaining({
        id: 'ai-chat',
        kind: 'ai-chat',
      }));
      expect(client.hide).not.toHaveBeenCalled();
      expect(client.hideCurrentWindow).toHaveBeenCalledWith(12);
      await act(async () => renderer!.unmount());
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('locks AI interactions while a native terminal handoff is waiting', async () => {
    let releaseGuard: (() => void) | undefined;
    aiTerminalGuard.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      releaseGuard = () => resolve(true);
    }));
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
      await flushEffects();
    });
    await act(async () => {
      renderer!.root.findByProps({ 'data-ai-chat-attach': true }).props.onClick();
      await flushEffects();
    });

    expect(renderer!.root.findByProps({
      'data-ai-chat-presentation': 'detached',
    }).props['data-ai-chat-interaction-disabled']).toBe('true');
    expect(client.attach).not.toHaveBeenCalled();

    await act(async () => {
      releaseGuard?.();
      await flushEffects();
      await flushEffects();
    });
    expect(client.attach).toHaveBeenCalledOnce();
  });

  it('gates simultaneous attach and OS-close requests and hands off the final guarded token', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        outerHeight: 720,
        outerWidth: 440,
        screenX: 10,
        screenY: 20,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: {
        storeState: {
          appearance: { uiVersion: 'v2' },
          theme: 'light',
          aiActiveSessionId: 'session-handoff',
          aiChatHistory: {
            'session-handoff': [{ id: 'assistant-1', role: 'assistant', content: 'partial' }],
          },
          aiChatSessions: [],
          aiContexts: {},
        },
      },
    };
    aiTerminalGuard.mockImplementationOnce(async () => {
      storeState.aiChatHistory['session-handoff'][0].content = 'partial final-token';
      return true;
    });
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-attach': true }).props.onClick();
        eventTarget.dispatchEvent(new Event('gonavi:native-detached-request-close'));
        await flushEffects();
      });

      expect(client.attach).toHaveBeenCalledOnce();
      expect(client.close).not.toHaveBeenCalled();
      expect(client.attach).toHaveBeenCalledWith(expect.objectContaining({
        storeState: expect.objectContaining({
          aiChatHistory: expect.objectContaining({
            'session-handoff': [expect.objectContaining({ content: 'partial final-token' })],
          }),
        }),
      }));
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('cancels the native close fallback when AI session persistence fails', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    flushAIChatSessionPersistence.mockRejectedValueOnce(new Error('disk full'));
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      cancelCloseRequest: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
      cancelClose: vi.fn(async () => undefined),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      await act(async () => {
        eventTarget.dispatchEvent(new Event('gonavi:native-detached-request-close'));
        await flushEffects();
        await flushEffects();
      });

      expect(client.cancelCloseRequest).toHaveBeenCalledWith(expect.objectContaining({
        id: 'ai-chat',
        kind: 'ai-chat',
        revision: expect.any(Number),
        rollbackAction: 'close',
      }));
      expect(client.cancelClose).toHaveBeenCalledOnce();
      expect(client.close).not.toHaveBeenCalled();
      expect(client.closeCurrentWindow).not.toHaveBeenCalled();
      expect(renderer!.root.findByProps({ 'data-ai-chat-presentation': 'detached' })).toBeTruthy();
      await act(async () => {
        renderer!.unmount();
      });
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  it('recovers the AI child when the local close fails and allows a second attach', async () => {
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      actionRevision: 40,
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    const closeError = new Error('native close failed');
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      cancelCloseRequest: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn()
        .mockRejectedValueOnce(closeError)
        .mockResolvedValueOnce(undefined),
      cancelClose: vi.fn(async () => undefined),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-attach': true }).props.onClick();
        await flushEffects();
        await flushEffects();
      });

      expect(client.attach).toHaveBeenCalledWith(expect.objectContaining({ revision: 41 }));
      expect(client.closeCurrentWindow).toHaveBeenCalledOnce();
      expect(client.cancelCloseRequest).toHaveBeenCalledWith(expect.objectContaining({
        id: 'ai-chat',
        kind: 'ai-chat',
        revision: expect.any(Number),
        rollbackAction: 'attach',
      }));
      expect(client.cancelClose).toHaveBeenCalledOnce();
      expect(renderer!.root.findByProps({
        'data-ai-chat-presentation': 'detached',
      }).props['data-ai-chat-interaction-disabled']).toBe('false');

      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-attach': true }).props.onClick();
        await flushEffects();
        await flushEffects();
      });

      expect(client.attach).toHaveBeenNthCalledWith(2, expect.objectContaining({ revision: 43 }));
      expect(client.closeCurrentWindow).toHaveBeenCalledTimes(2);
      expect(client.cancelCloseRequest).toHaveBeenCalledOnce();
      expect(client.cancelClose).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        '[Native Detached Window] Failed to close native window',
        closeError,
      );
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      consoleError.mockRestore();
    }
  });

  it('offers an explicit close retry when either side of close rollback cannot be confirmed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const failureTarget of ['parent', 'local'] as const) {
        const bootstrap: NativeDetachedWindowBootstrap = {
          id: 'ai-chat',
          kind: 'ai-chat',
          title: 'GoNavi AI',
          payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
        };
        const closeError = new Error(`${failureTarget} convergence failed`);
        const cancelError = new Error(`${failureTarget} cancel failed`);
        const client = {
          load: vi.fn(async () => bootstrap),
          ready: vi.fn(async () => undefined),
          sync: vi.fn(async () => undefined),
          attach: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
          cancelCloseRequest: failureTarget === 'parent'
            ? vi.fn(async () => { throw cancelError; })
            : vi.fn(async () => undefined),
          openAISettings: vi.fn(async () => undefined),
          closeCurrentWindow: vi.fn()
            .mockRejectedValueOnce(closeError)
            .mockRejectedValueOnce(closeError)
            .mockResolvedValueOnce(undefined),
          cancelClose: failureTarget === 'local'
            ? vi.fn(async () => { throw cancelError; })
            : vi.fn(async () => undefined),
        };
        let renderer: TestRenderer.ReactTestRenderer | undefined;

        await act(async () => {
          renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
          await flushEffects();
        });
        await act(async () => {
          renderer!.root.findByProps({ 'data-ai-chat-attach': true }).props.onClick();
          await flushEffects();
          await flushEffects();
        });

        expect(client.attach).toHaveBeenCalledOnce();
        expect(client.cancelCloseRequest).toHaveBeenCalledTimes(failureTarget === 'parent' ? 2 : 1);
        expect(client.cancelClose).toHaveBeenCalledOnce();
        expect(client.closeCurrentWindow).toHaveBeenCalledTimes(2);
        expect(renderer!.root.findByProps({
          'data-ai-chat-presentation': 'detached',
        }).props['data-ai-chat-interaction-disabled']).toBe('true');

        await act(async () => {
          renderer!.root.findByProps({ 'data-native-close-recovery': true }).props.onClick();
          await flushEffects();
        });
        expect(client.attach).toHaveBeenCalledOnce();
        expect(client.closeCurrentWindow).toHaveBeenCalledTimes(3);

        await act(async () => renderer?.unmount());
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps the AI child open when its terminal guard rejects attach and close', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 440,
        outerHeight: 720,
        outerWidth: 440,
        screenX: 10,
        screenY: 20,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: { uiVersion: 'v2' }, theme: 'light' } },
    };
    aiTerminalGuard.mockResolvedValue(false);
    const client = {
      load: vi.fn(async () => bootstrap),
      ready: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      attach: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      cancelCloseRequest: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
      cancelClose: vi.fn(async () => undefined),
    };

    try {
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });

      await act(async () => {
        renderer!.root.findByProps({ 'data-ai-chat-attach': true }).props.onClick();
        await flushEffects();
        await flushEffects();
      });
      expect(client.attach).not.toHaveBeenCalled();
      expect(client.closeCurrentWindow).not.toHaveBeenCalled();

      await act(async () => {
        eventTarget.dispatchEvent(new Event('gonavi:native-detached-request-close'));
        await flushEffects();
        await flushEffects();
      });

      expect(aiTerminalGuard).toHaveBeenCalledTimes(2);
      expect(client.close).not.toHaveBeenCalled();
      expect(client.closeCurrentWindow).not.toHaveBeenCalled();
      expect(client.cancelCloseRequest).toHaveBeenCalledTimes(2);
      expect(client.cancelClose).toHaveBeenCalledTimes(2);
      expect(renderer!.root.findByProps({ 'data-ai-chat-presentation': 'detached' })).toBeTruthy();
      await act(async () => {
        renderer!.unmount();
      });
    } finally {
      if (previousWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
