import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAIChatPanelResize } from './useAIChatPanelResize';

type Listener = (event: unknown) => void;

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

  dispatch(type: string, event: unknown = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe('useAIChatPanelResize interaction cleanup', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let renderer: ReactTestRenderer | null = null;
  let resize: ReturnType<typeof useAIChatPanelResize> | null = null;
  let fakeWindow: FakeEventTarget;
  let fakeDocument: FakeEventTarget & {
    body: {
      style: {
        cursor: string;
        pointerEvents: string;
        userSelect: string;
      };
    };
  };

  const Harness = ({ attachPanel = true }: { attachPanel?: boolean }) => {
    resize = useAIChatPanelResize({ width: 420 });
    return attachPanel ? <div ref={resize.panelRef} /> : null;
  };

  const mountHarness = (attachPanel = true) => {
    renderer = create(<Harness attachPanel={attachPanel} />, {
      createNodeMock: () => ({
        getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 480 }),
      }),
    });
  };

  beforeEach(() => {
    fakeWindow = new FakeEventTarget();
    fakeDocument = Object.assign(new FakeEventTarget(), {
      body: {
        style: {
          cursor: 'wait',
          pointerEvents: 'auto',
          userSelect: 'text',
        },
      },
    });

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(fakeWindow, { innerHeight: 900 }),
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: fakeDocument,
    });

    act(() => {
      mountHarness();
    });
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    resize = null;

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

  const beginResize = () => {
    act(() => {
      resize?.handleResizeStart({
        clientX: 600,
        preventDefault: vi.fn(),
      } as unknown as React.MouseEvent);
    });
  };

  it('ends resizing and restores global interaction styles when the window loses focus', () => {
    beginResize();

    expect(fakeDocument.body.style).toEqual({
      cursor: 'col-resize',
      pointerEvents: 'none',
      userSelect: 'none',
    });
    expect(fakeDocument.listenerCount('mousemove')).toBe(1);
    expect(fakeDocument.listenerCount('mouseup')).toBe(1);
    expect(fakeWindow.listenerCount('blur')).toBe(1);

    act(() => {
      fakeWindow.dispatch('blur');
    });

    expect(resize?.isResizing).toBe(false);
    expect(fakeDocument.body.style).toEqual({
      cursor: 'wait',
      pointerEvents: 'auto',
      userSelect: 'text',
    });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });

  it('ends resizing when a move reports that the mouse button was released outside the window', () => {
    beginResize();

    act(() => {
      fakeDocument.dispatch('mousemove', { buttons: 0, clientX: 560 });
    });

    expect(resize?.isResizing).toBe(false);
    expect(fakeDocument.body.style).toEqual({
      cursor: 'wait',
      pointerEvents: 'auto',
      userSelect: 'text',
    });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });

  it('does not lock global interaction when the panel ref is unavailable', () => {
    act(() => {
      renderer?.unmount();
      mountHarness(false);
    });

    beginResize();

    expect(resize?.isResizing).toBe(false);
    expect(fakeDocument.body.style).toEqual({
      cursor: 'wait',
      pointerEvents: 'auto',
      userSelect: 'text',
    });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });

  it('restores global interaction styles when an active resize unmounts without a terminal event', () => {
    beginResize();

    act(() => {
      renderer?.unmount();
    });
    renderer = null;

    expect(fakeDocument.body.style).toEqual({
      cursor: 'wait',
      pointerEvents: 'auto',
      userSelect: 'text',
    });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });
});
