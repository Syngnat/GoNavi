import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RedisCommandEditor from './RedisCommandEditor';

const storeState = vi.hoisted((): any => ({
  connections: [{
    id: 'redis-1',
    name: 'redis',
    config: { type: 'redis', host: '127.0.0.1', port: 6379 },
  }],
  theme: 'dark',
  appearance: { enabled: true, opacity: 1, blur: 0 },
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => any) => selector(storeState),
}));

vi.mock('./MonacoEditor', async () => {
  const ReactModule = await import('react');
  return {
    default: () => ReactModule.createElement('div', { 'data-monaco-editor': 'true' }),
  };
});

vi.mock('@ant-design/icons', async () => {
  const ReactModule = await import('react');
  const Icon = () => ReactModule.createElement('span');
  return { ClearOutlined: Icon, PlayCircleOutlined: Icon };
});

vi.mock('antd', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, ...props }: any) => ReactModule.createElement('button', props, children),
    Space: ({ children }: any) => ReactModule.createElement('div', null, children),
    message: { warning: vi.fn() },
  };
});

type Listener = (event: any) => void;

class FakeEventTarget {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: any = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe('RedisCommandEditor resize interaction cleanup', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let renderer: ReactTestRenderer | null = null;
  let fakeWindow: FakeEventTarget;
  let fakeDocument: FakeEventTarget & {
    body: {
      getAttribute: (name: string) => string | null;
      style: { cursor: string; userSelect: string };
    };
  };

  const beginResize = () => {
    act(() => {
      renderer?.root.findByProps({ 'data-redis-command-resizer': 'true' }).props.onMouseDown({
        button: 0,
        clientY: 300,
        preventDefault: vi.fn(),
      });
    });
  };

  beforeEach(() => {
    fakeWindow = new FakeEventTarget();
    fakeDocument = Object.assign(new FakeEventTarget(), {
      body: {
        getAttribute: (name: string) => (name === 'data-ui-version' ? 'v2' : null),
        style: { cursor: 'wait', userSelect: 'text' },
      },
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });

    act(() => {
      renderer = create(
        <RedisCommandEditor connectionId="redis-1" redisDB={0} />,
        {
          createNodeMock: (element) => (
            element.props['data-redis-command-editor'] === 'true'
              ? { clientHeight: 900, scrollIntoView: vi.fn() }
              : { scrollIntoView: vi.fn() }
          ),
        },
      );
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    if (previousDocumentDescriptor) {
      Object.defineProperty(globalThis, 'document', previousDocumentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('restores exact body styles and removes listeners on window blur', () => {
    beginResize();

    expect(fakeDocument.body.style).toEqual({ cursor: 'row-resize', userSelect: 'none' });
    expect(fakeWindow.listenerCount('blur')).toBe(1);

    act(() => fakeWindow.dispatch('blur'));

    expect(fakeDocument.body.style).toEqual({ cursor: 'wait', userSelect: 'text' });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });

  it('self-heals when movement reports no pressed button', () => {
    beginResize();

    act(() => fakeDocument.dispatch('mousemove', { buttons: 0, clientY: 340 }));

    expect(fakeDocument.body.style).toEqual({ cursor: 'wait', userSelect: 'text' });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });

  it('restores interaction state when unmounted mid-resize', () => {
    beginResize();

    act(() => renderer?.unmount());
    renderer = null;

    expect(fakeDocument.body.style).toEqual({ cursor: 'wait', userSelect: 'text' });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });
});
