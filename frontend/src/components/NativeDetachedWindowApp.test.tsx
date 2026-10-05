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
import NativeDetachedWindowApp, {
  NATIVE_DETACHED_PAINT_FALLBACK_MS,
  applyNativeDetachedDocumentAppearance,
  waitForNativeDetachedContentPaint,
} from './NativeDetachedWindowApp';

const {
  aiTerminalGuard,
  aiChatRenderProps,
  customThemeStyleHostProps,
  detachedResultAutoReport,
  detachedResultDataChangeHandlers,
  detachedResultGridProps,
  detachedResultRows,
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
  'driver-manager',
  'settings-center',
  'redis-keys',
  'redis-command',
  'redis-monitor',
  'trigger',
  'view-def',
  'event-def',
  'routine-def',
  'sequence-def',
  'package-def',
  'database-link-def',
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
    (
      selector: (state: Record<string, any>) => unknown,
      equalityFn: (left: unknown, right: unknown) => boolean = Object.is,
    ) => {
      // Keep the external-store snapshot itself stable. Zustand applies selectors
      // after subscribing and reuses an equal selection, rather than returning a
      // newly allocated selector result from getSnapshot on every read.
      const state = useSyncExternalStore(
        (listener) => {
          storeListeners.add(listener);
          return () => storeListeners.delete(listener);
        },
        () => storeState,
        () => storeState,
      );
      const selected = selector(state);
      const selectedRef = React.useRef<{ value: unknown } | null>(null);
      if (!selectedRef.current || !equalityFn(selectedRef.current.value, selected)) {
        selectedRef.current = { value: selected };
      }
      return selectedRef.current.value;
    },
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
  return { useStore };
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
    onRequestClose,
  }: {
    tab: TabData;
    onContentReady?: () => void;
    onRequestClose?: () => void;
  }) => {
    React.useEffect(() => {
      onContentReady?.();
    }, [onContentReady]);
    return (
      <div data-workbench-tab={tab.id}>
        <button data-workbench-request-close type="button" onClick={onRequestClose} />
      </div>
    );
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
    onOpenSettings?: (providerId?: string) => void;
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
        <button data-ai-chat-settings type="button" onClick={() => onOpenSettings?.()} />
        <button data-ai-chat-provider-settings type="button" onClick={() => onOpenSettings?.('provider-grok')} />
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

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('NativeDetachedWindowApp', () => {
  beforeEach(() => {
    clearQueryTabDraft(queryTab.id);
    storeListeners.clear();
    runtimeEventListeners.clear();
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
      appearance: {  },
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

    applyNativeDetachedDocumentAppearance('dark', 24, 0.5, documentRef);

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
          appearance: {  },
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
          appearance: {  },
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
          appearance: {  },
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
          appearance: {  },
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

  it('routes the driver manager body close action through the native window lifecycle', async () => {
    const tab: TabData = {
      id: 'driver-manager',
      title: 'Driver Manager',
      type: 'driver-manager',
      connectionId: '',
    };
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'workbench:driver-manager',
      kind: 'workbench',
      title: tab.title,
      payload: {
        storeState: {
          tabs: [tab],
          activeTabId: tab.id,
          theme: 'light',
          appearance: {  },
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
      cancelCloseRequest: vi.fn(async () => undefined),
      openAISettings: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
      await flushEffects();
    });

    await act(async () => {
      renderer!.root.findByProps({ 'data-workbench-request-close': true }).props.onClick();
      await flushEffects();
      await flushEffects();
    });

    expect(client.close).toHaveBeenCalledWith(expect.objectContaining({
      id: bootstrap.id,
      kind: 'workbench',
    }));
    expect(client.closeCurrentWindow).toHaveBeenCalledOnce();
    await act(async () => renderer!.unmount());
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
          appearance: {  },
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
            appearance: {  },
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
    expect(storeState.appearance).toEqual({  });
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
        storeState: { appearance: {  }, theme: 'light', sqlLogs: [] },
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
            executionConnectionId: 'connection-snapshot',
            executionDbName: 'snapshot_db',
            executionConnectionParams: 'application_name=gonavi&options=-c%20search_path%3DAPP%2Cpublic',
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
        connectionId: 'connection-snapshot',
        connectionParamsOverride: 'application_name=gonavi&options=-c%20search_path%3DAPP%2Cpublic',
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
        storeState: { appearance: {  }, theme: 'light', sqlLogs: [] },
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
        storeState: { appearance: {  }, theme: 'light', sqlLogs: [] },
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
        storeState: { appearance: {  }, theme: 'light', sqlLogs: [] },
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
});
