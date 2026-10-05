// QueryEditor.results-and-drop.test.tsx 拆分前的共享测试辅助函数；只由测试文件导入。
import { create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';
import { vi } from 'vitest';
import type { TabData } from '../types';
import { storeSubscribers, editorState } from './queryEditorResultsAndDropTestState';

export const mountedRenderers = new Set<ReactTestRenderer>();

export const create = (...args: Parameters<typeof createRenderer>): ReactTestRenderer => {
  const renderer = createRenderer(...args);
  mountedRenderers.add(renderer);
  const unmount = renderer.unmount.bind(renderer);
  renderer.unmount = () => {
    mountedRenderers.delete(renderer);
    unmount();
  };
  return renderer;
};

export const notifyStoreSubscribers = () => {
  storeSubscribers.forEach((subscriber) => subscriber());
};

export const textContent = (node: any): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((item) => textContent(item)).join('');
  return (node.children || [])
    .map((item: any) => (typeof item === 'string' ? item : textContent(item)))
    .join('');
};

export const findButtons = (renderer: ReactTestRenderer, text: string) => {
  const visibleTextMatches = renderer.root.findAll(
    (node) => node.type === 'button' && textContent(node).includes(text),
  );
  return visibleTextMatches.length > 0
    ? visibleTextMatches
    : renderer.root.findAll((node) => (
      node.type === 'button' && String(node.props?.['aria-label'] || '').includes(text)
    ));
};

export const findButton = (renderer: ReactTestRenderer, text: string) => findButtons(renderer, text)[0];

export const findResultMessageTextarea = (renderer: ReactTestRenderer, mode: 'compact' | 'full' = 'full') =>
  renderer.root.find((node) =>
    node.type === 'textarea' && node.props['data-query-result-message-textarea'] === mode,
  );

export const findByClassName = (renderer: ReactTestRenderer, className: string) =>
  renderer.root.find((node) =>
    typeof node.props?.className === 'string' && node.props.className.includes(className),
  );

export const findEditorAction = (id: string) =>
  editorState.editor.addAction.mock.calls
    .map((call: any[]) => call[0])
    .reverse()
    .find((action: any) => action?.id === id);

export const createRunShortcutEvent = () => {
  const isMacRuntime = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
  return {
    ctrlKey: !isMacRuntime,
    metaKey: isMacRuntime,
    altKey: false,
    shiftKey: false,
    key: 'Enter',
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
};

export const createTab = (overrides: Partial<TabData> = {}): TabData => ({
  id: 'tab-1',
  title: 'query.sql',
  type: 'query',
  connectionId: 'conn-1',
  dbName: 'main',
  query: 'select 1;',
  ...overrides,
});

export const createDefaultConnections = () => ([
  {
    id: 'conn-1',
    name: 'local',
    config: {
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database: 'main',
    },
  },
]);

export type ResultTabTestListener = (event: Record<string, unknown>) => void;

export const createResultTabTestEventTarget = () => {
  const listeners = new Map<string, Set<ResultTabTestListener>>();
  return {
    addEventListener: vi.fn((type: string, listener: ResultTabTestListener) => {
      const registered = listeners.get(type) ?? new Set<ResultTabTestListener>();
      registered.add(listener);
      listeners.set(type, registered);
    }),
    removeEventListener: vi.fn((type: string, listener: ResultTabTestListener) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(type: string, event: Record<string, unknown> = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener({ type, ...event });
      }
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
};

export const createResultTabPointerCaptureTarget = (throwOnRelease = false) => {
  const eventTarget = createResultTabTestEventTarget();
  const capturedPointers = new Set<number>();
  return Object.assign(eventTarget, {
    setPointerCapture: vi.fn((pointerId: number) => {
      capturedPointers.add(pointerId);
    }),
    hasPointerCapture: vi.fn((pointerId: number) => capturedPointers.has(pointerId)),
    releasePointerCapture: vi.fn((pointerId: number) => {
      if (throwOnRelease) throw new Error('capture already released');
      capturedPointers.delete(pointerId);
    }),
  });
};
