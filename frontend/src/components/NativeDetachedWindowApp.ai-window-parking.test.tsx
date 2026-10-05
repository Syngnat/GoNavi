import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabData } from '../types';
import type { NativeDetachedWindowBootstrap } from '../utils/nativeDetachedWindowClient';
import { clearQueryTabDraft } from '../utils/sqlFileTabDrafts';
import NativeDetachedWindowApp from './NativeDetachedWindowApp';

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

  it('parks the native AI window before opening the focused provider in main settings', async () => {
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      payload: { storeState: { appearance: {  }, theme: 'light' } },
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
      renderer!.root.findByProps({ 'data-ai-chat-provider-settings': true }).props.onClick();
      await flushEffects();
      await flushEffects();
    });

    expect(client.hide).toHaveBeenCalledOnce();
    expect(client.openAISettings).toHaveBeenCalledWith(9, 'provider-grok');
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
      payload: { storeState: { appearance: {  }, theme: 'light' } },
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
      payload: { storeState: { appearance: {  }, theme: 'light' } },
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
    'gonavi:open-global-proxy-settings',
    'gonavi:open-download-source-settings',
  ] as const)('forwards driver manager %s requests to the main window', async (eventName) => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 960,
        outerHeight: 720,
        outerWidth: 960,
        screenX: 40,
        screenY: 40,
        setTimeout: globalThis.setTimeout,
      }),
    });
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
          appearance: {  },
          theme: 'light',
          tabs: [tab],
          activeTabId: tab.id,
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
      hostEvent: vi.fn(async () => undefined),
      closeCurrentWindow: vi.fn(async () => undefined),
    };
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      await act(async () => {
        eventTarget.dispatchEvent(new Event(eventName));
        await flushEffects();
      });

      expect(client.hostEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: bootstrap.id,
        kind: 'workbench',
        hostEvent: expect.objectContaining({
          name: eventName,
        }),
      }));
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

  it('forwards sidebar locate actions from a detached workbench to the main process', async () => {
    const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(eventTarget, {
        clearTimeout: globalThis.clearTimeout,
        innerWidth: 1200,
        outerHeight: 800,
        outerWidth: 1200,
        screenX: 80,
        screenY: 80,
        setTimeout: globalThis.setTimeout,
      }),
    });
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'workbench:query-native-1',
      kind: 'workbench',
      title: queryTab.title,
      payload: {
        storeState: { appearance: {  }, theme: 'light' },
        tab: queryTab,
      },
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
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = TestRenderer.create(<NativeDetachedWindowApp client={client} />);
        await flushEffects();
      });
      const event = new Event('gonavi:locate-sidebar-object');
      Object.defineProperty(event, 'detail', {
        value: {
          connectionId: 'connection-1',
          dbName: 'main',
          tableName: 'users',
          objectGroup: 'tables',
        },
      });
      await act(async () => {
        eventTarget.dispatchEvent(event);
        await flushEffects();
      });

      expect(client.hostEvent).toHaveBeenCalledWith(expect.objectContaining({
        id: bootstrap.id,
        kind: 'workbench',
        hostEvent: expect.objectContaining({
          name: 'gonavi:locate-sidebar-object',
          detail: {
            connectionId: 'connection-1',
            dbName: 'main',
            tableName: 'users',
            objectGroup: 'tables',
          },
        }),
      }));
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
            appearance: {  },
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
          appearance: {  },
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

  it('waits for the Harness terminal guard before a graceful native close request', async () => {
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
      payload: { storeState: { appearance: {  }, theme: 'light' } },
    };
    const callOrder: string[] = [];
    aiTerminalGuard.mockImplementationOnce(async () => {
      callOrder.push('guard');
      return true;
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

      expect(callOrder).toEqual(['guard', 'close', 'close-window']);
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
      payload: { storeState: { appearance: {  }, theme: 'light' } },
    };
    const callOrder: string[] = [];
    aiTerminalGuard.mockImplementationOnce(async () => {
      callOrder.push('guard');
      return true;
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

      expect(callOrder).toEqual(['guard', 'hide', 'hide-window:9']);
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
});
