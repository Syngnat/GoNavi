import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppSidebarResize } from './useAppSidebarResize';
import { createSidebarResizeAwareFrameScheduler } from '../utils/sidebarResizeLifecycle';

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

  dispatchEvent(event: { type: string }) {
    this.dispatch(event.type, event);
    return true;
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeAttributeHost {
  private attributes = new Map<string, string>();

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  getAttribute(name: string) {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }
}

class FakeStyle {
  private properties = new Map<string, string>();

  setProperty(name: string, value: string) {
    this.properties.set(name, value);
  }

  removeProperty(name: string) {
    const previous = this.properties.get(name) || '';
    this.properties.delete(name);
    return previous;
  }

  getPropertyValue(name: string) {
    return this.properties.get(name) || '';
  }
}

class FakeHTMLElement extends FakeAttributeHost {
  style = new FakeStyle();
  nextElementSibling: FakeHTMLElement | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(private readonly width = 240) {
    super();
  }

  getBoundingClientRect() {
    return { right: this.width, width: this.width };
  }

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
}

class FakeBody extends FakeAttributeHost {
  style = {
    cursor: 'wait',
    userSelect: 'text',
    webkitUserSelect: 'auto',
  };
}

const flushAnimationFrames = (frames: Map<number, FrameRequestCallback>, passes = 2) => {
  for (let pass = 0; pass < passes; pass += 1) {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) {
      callback(0);
    }
  }
};

describe('useAppSidebarResize interaction cleanup', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousHTMLElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const previousRequestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const previousCancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');

  let renderer: ReactTestRenderer | null = null;
  let resize: ReturnType<typeof useAppSidebarResize> | null = null;
  let fakeWindow: FakeEventTarget & { getComputedStyle: () => { minWidth: string; maxWidth: string }; innerWidth: number };
  let fakeDocument: FakeEventTarget & { body: FakeBody };
  let scheduledFrames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let setSidebarWidth: ReturnType<typeof vi.fn>;
  let fakeSider: FakeHTMLElement;
  let fakeContent: FakeHTMLElement;

  const Harness = ({ sidebarCollapsed = false }: { sidebarCollapsed?: boolean }) => {
    const options = {
      effectiveUiScale: 1,
      setSidebarWidth,
      sidebarWidth: 240,
      sidebarCollapsed,
    };
    resize = useAppSidebarResize(options);
    return null;
  };

  const beginResize = () => {
    act(() => {
      resize?.handleSidebarMouseDown({
        button: 0,
        clientX: 200,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.MouseEvent);
    });
  };

  beforeEach(() => {
    scheduledFrames = new Map();
    nextFrameId = 1;
    setSidebarWidth = vi.fn();
    fakeWindow = Object.assign(new FakeEventTarget(), {
      getComputedStyle: () => ({ minWidth: '180px', maxWidth: '600px' }),
      innerWidth: 1200,
    });
    fakeDocument = Object.assign(new FakeEventTarget(), {
      body: new FakeBody(),
    });
    fakeSider = new FakeHTMLElement(240);
    fakeContent = new FakeHTMLElement(960);
    fakeContent.setAttribute('data-sidebar-resize-content', 'true');
    fakeSider.nextElementSibling = fakeContent;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeHTMLElement });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        const frameId = nextFrameId++;
        scheduledFrames.set(frameId, callback);
        return frameId;
      }),
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn((frameId: number) => scheduledFrames.delete(frameId)),
    });

    act(() => {
      renderer = create(<Harness />);
    });
    (resize!.siderRef as React.MutableRefObject<any>).current = fakeSider;
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    resize = null;

    for (const [name, descriptor] of [
      ['window', previousWindowDescriptor],
      ['document', previousDocumentDescriptor],
      ['HTMLElement', previousHTMLElementDescriptor],
      ['requestAnimationFrame', previousRequestAnimationFrameDescriptor],
      ['cancelAnimationFrame', previousCancelAnimationFrameDescriptor],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it('restores the exact body styles and removes listeners when the window blurs', () => {
    beginResize();

    expect(fakeDocument.body.style).toEqual({
      cursor: 'col-resize',
      userSelect: 'none',
      webkitUserSelect: 'none',
    });
    expect(fakeWindow.listenerCount('blur')).toBe(1);

    act(() => fakeWindow.dispatch('blur'));

    expect(fakeDocument.body.style).toEqual({
      cursor: 'wait',
      userSelect: 'text',
      webkitUserSelect: 'auto',
    });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
    expect(setSidebarWidth).toHaveBeenCalledWith(240);
  });

  it('self-heals and commits the last width when movement reports no pressed button', () => {
    beginResize();

    act(() => fakeDocument.dispatch('mousemove', { buttons: 0, clientX: 260 }));

    expect(setSidebarWidth).toHaveBeenCalledWith(300);
    expect((resize?.siderRef.current as unknown as FakeHTMLElement).style.getPropertyValue('--gonavi-sidebar-resize-width')).toBe('300px');
    expect(fakeDocument.body.style.cursor).toBe('wait');
    expect(fakeDocument.body.style.userSelect).toBe('text');
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });

  it('previews the sidebar width while dragging and persists it only after release', () => {
    const sider = resize!.siderRef.current as unknown as FakeHTMLElement;

    beginResize();
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 260 }));

    expect(setSidebarWidth).not.toHaveBeenCalled();
    expect(sider.style.getPropertyValue('--gonavi-sidebar-resize-width')).toBe('240px');

    act(() => flushAnimationFrames(scheduledFrames, 1));

    expect(sider.style.getPropertyValue('--gonavi-sidebar-resize-width')).toBe('300px');
    expect(setSidebarWidth).not.toHaveBeenCalled();

    act(() => fakeDocument.dispatch('mouseup', { clientX: 260 }));

    expect(setSidebarWidth).toHaveBeenCalledTimes(1);
    expect(setSidebarWidth).toHaveBeenCalledWith(300);
  });

  it('cancels pending work and restores interaction state when unmounted mid-resize', () => {
    const sider = resize!.siderRef.current as unknown as FakeHTMLElement;

    beginResize();
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 250 }));
    expect(scheduledFrames.size).toBe(1);

    act(() => renderer?.unmount());
    renderer = null;

    expect(scheduledFrames.size).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(sider.style.getPropertyValue('--gonavi-sidebar-resize-width')).toBe('');
    expect(fakeDocument.body.style).toEqual({
      cursor: 'wait',
      userSelect: 'text',
      webkitUserSelect: 'auto',
    });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
    expect(setSidebarWidth).not.toHaveBeenCalled();
  });

  it('keeps the workbench fluid while marking the resize lifecycle', () => {
    const sider = resize!.siderRef.current as unknown as FakeHTMLElement;
    const settledListener = vi.fn();
    fakeWindow.addEventListener('gonavi:sidebar-resize-settled', settledListener);

    beginResize();
    expect(sider.getAttribute('data-sidebar-resizing')).toBe('true');
    expect(fakeDocument.body.getAttribute('data-sidebar-resizing')).toBe('true');
    expect(fakeContent.getAttribute('data-sidebar-resize-content-locked')).toBe(null);
    expect(fakeContent.style.getPropertyValue('--gonavi-sidebar-resize-content-width')).toBe('');

    act(() => fakeDocument.dispatch('mouseup', { clientX: 280 }));
    expect(setSidebarWidth).toHaveBeenCalledWith(320);
    // Still marked while the commit paints, so Ant Design width transition stays off.
    expect(sider.getAttribute('data-sidebar-resizing')).toBe('true');
    expect(fakeDocument.body.getAttribute('data-sidebar-resizing')).toBe('true');
    expect(fakeContent.getAttribute('data-sidebar-resize-content-locked')).toBe(null);
    expect(settledListener).not.toHaveBeenCalled();

    act(() => flushAnimationFrames(scheduledFrames, 2));

    expect(sider.getAttribute('data-sidebar-resizing')).toBe(null);
    expect(fakeDocument.body.getAttribute('data-sidebar-resizing')).toBe(null);
    expect(sider.style.getPropertyValue('--gonavi-sidebar-resize-width')).toBe('');
    expect(fakeContent.getAttribute('data-sidebar-resize-content-locked')).toBe(null);
    expect(fakeContent.style.getPropertyValue('--gonavi-sidebar-resize-content-width')).toBe('');
    expect(settledListener).toHaveBeenCalledTimes(1);
  });

  it('suspends observer work and settles once across collapse and expand commits', () => {
    const callback = vi.fn();
    const settledListener = vi.fn();
    const scheduler = createSidebarResizeAwareFrameScheduler(callback);
    fakeWindow.addEventListener('gonavi:sidebar-resize-settled', settledListener);

    act(() => renderer?.update(<Harness sidebarCollapsed />));

    expect(fakeDocument.body.getAttribute('data-sidebar-transitioning')).toBe('true');
    for (let index = 0; index < 100; index += 1) scheduler.schedule();
    expect(scheduledFrames.size).toBe(0);
    expect(callback).not.toHaveBeenCalled();

    act(() => fakeSider.dispatch('transitionend', {
      target: fakeSider,
      propertyName: 'width',
    }));

    expect(fakeDocument.body.getAttribute('data-sidebar-transitioning')).toBe(null);
    expect(settledListener).toHaveBeenCalledTimes(1);
    expect(scheduledFrames.size).toBe(1);
    act(() => flushAnimationFrames(scheduledFrames, 1));
    expect(callback).toHaveBeenCalledTimes(1);

    act(() => renderer?.update(<Harness sidebarCollapsed={false} />));
    expect(fakeDocument.body.getAttribute('data-sidebar-transitioning')).toBe('true');
    for (let index = 0; index < 100; index += 1) scheduler.schedule();
    expect(callback).toHaveBeenCalledTimes(1);

    act(() => fakeSider.dispatch('transitionend', {
      target: fakeSider,
      propertyName: 'flex-basis',
    }));
    act(() => flushAnimationFrames(scheduledFrames, 1));

    expect(fakeDocument.body.getAttribute('data-sidebar-transitioning')).toBe(null);
    expect(settledListener).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(setSidebarWidth).not.toHaveBeenCalled();
    scheduler.dispose();
  });
});
