import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RedisResizableDivider from './RedisResizableDivider';

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

class FakeOverlay {
  isConnected = false;
  style = { cssText: '' };
  onRemove: (() => void) | null = null;

  remove() {
    this.isConnected = false;
    this.onRemove?.();
  }
}

describe('RedisResizableDivider interaction cleanup', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let fakeWindow: FakeEventTarget & { innerWidth: number };
  let fakeDocument: FakeEventTarget & {
    body: { appendChild: (overlay: FakeOverlay) => void };
    createElement: () => FakeOverlay;
  };
  let overlays: FakeOverlay[];
  let renderer: ReactTestRenderer | null = null;
  let onResizeEnd: ReturnType<typeof vi.fn>;
  const target = {
    offsetWidth: 420,
    parentElement: { offsetWidth: 1200 },
    style: { width: '', flexBasis: '' },
  };

  const startResize = () => {
    act(() => {
      renderer?.root.findByType('div').props.onMouseDown({
        clientX: 400,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
  };

  beforeEach(() => {
    overlays = [];
    fakeWindow = Object.assign(new FakeEventTarget(), { innerWidth: 1200 });
    fakeDocument = Object.assign(new FakeEventTarget(), {
      body: {
        appendChild: (overlay: FakeOverlay) => {
          overlay.isConnected = true;
          overlay.onRemove = () => {
            overlays = overlays.filter((candidate) => candidate !== overlay);
          };
          overlays.push(overlay);
        },
      },
      createElement: () => new FakeOverlay(),
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    onResizeEnd = vi.fn();
    act(() => {
      renderer = create(
        <RedisResizableDivider
          targetRef={{ current: target } as React.RefObject<HTMLDivElement>}
          onResizeEnd={onResizeEnd}
          title="resize"
        />,
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

  it('removes the full-screen overlay and commits the width when the window blurs', () => {
    expect(renderer?.root.findByType('div').props.className).toBe('redis-resizable-divider');

    startResize();
    expect(overlays).toHaveLength(1);

    act(() => fakeWindow.dispatch('blur'));

    expect(overlays).toHaveLength(0);
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
    expect(onResizeEnd).toHaveBeenCalledWith(420);

    startResize();
    expect(overlays).toHaveLength(1);
  });

  it('self-heals when mouse movement reports that the button was released', () => {
    startResize();

    act(() => fakeDocument.dispatch('mousemove', {
      buttons: 0,
      clientX: 520,
      preventDefault: vi.fn(),
    }));

    expect(overlays).toHaveLength(0);
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(onResizeEnd).toHaveBeenCalledWith(420);
  });

  it('updates a container grid width variable while dragging', () => {
    const setProperty = vi.fn();
    target.parentElement = { offsetWidth: 1200, style: { setProperty } } as any;
    act(() => {
      renderer?.unmount();
      renderer = create(
        <RedisResizableDivider
          targetRef={{ current: target } as React.RefObject<HTMLDivElement>}
          onResizeEnd={onResizeEnd}
          maxReservedWidth={361}
          containerWidthCssVariable="--redis-sidebar-width"
          title="resize"
        />,
      );
    });

    startResize();
    act(() => fakeDocument.dispatch('mousemove', {
      buttons: 1,
      clientX: 520,
      preventDefault: vi.fn(),
    }));

    expect(setProperty).toHaveBeenCalledWith('--redis-sidebar-width', '540px');
    expect(target.style.width).toBe('');
  });

  it('removes the overlay without updating state when unmounted mid-resize', () => {
    startResize();

    act(() => renderer?.unmount());
    renderer = null;

    expect(overlays).toHaveLength(0);
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
    expect(onResizeEnd).not.toHaveBeenCalled();
  });
});
