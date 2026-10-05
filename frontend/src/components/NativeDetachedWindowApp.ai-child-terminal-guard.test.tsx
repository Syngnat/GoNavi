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
      payload: { storeState: { appearance: {  }, theme: 'light' } },
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
      payload: { storeState: { appearance: {  }, theme: 'light' } },
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
      payload: { storeState: { appearance: {  }, theme: 'light' } },
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
      payload: { storeState: { appearance: {  }, theme: 'light' } },
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
          appearance: {  },
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

  it('recovers the AI child when the local close fails and allows a second attach', async () => {
    const bootstrap: NativeDetachedWindowBootstrap = {
      id: 'ai-chat',
      kind: 'ai-chat',
      title: 'GoNavi AI',
      actionRevision: 40,
      payload: { storeState: { appearance: {  }, theme: 'light' } },
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
          payload: { storeState: { appearance: {  }, theme: 'light' } },
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
      payload: { storeState: { appearance: {  }, theme: 'light' } },
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
