import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SIDEBAR_RESIZE_SETTLED_EVENT,
  createSidebarResizeAwareFrameScheduler,
} from './sidebarResizeLifecycle';

type Listener = (event: { type: string }) => void;

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

  dispatchEvent(event: { type: string }) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener(event);
    }
    return true;
  }
}

class FakeBody {
  private attributes = new Map<string, string>();

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
}

describe('sidebarResizeLifecycle', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousRequestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const previousCancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');

  let fakeWindow: FakeEventTarget;
  let fakeBody: FakeBody;
  let scheduledFrames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  const flushAnimationFrames = () => {
    const frames = [...scheduledFrames.values()];
    scheduledFrames.clear();
    frames.forEach((frame) => frame(0));
  };

  beforeEach(() => {
    fakeWindow = new FakeEventTarget();
    fakeBody = new FakeBody();
    scheduledFrames = new Map();
    nextFrameId = 1;

    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: fakeBody } });
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
  });

  afterEach(() => {
    for (const [name, descriptor] of [
      ['window', previousWindowDescriptor],
      ['document', previousDocumentDescriptor],
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

  it('defers all resize work during sidebar drag and flushes the latest state once', () => {
    const callback = vi.fn();
    const scheduler = createSidebarResizeAwareFrameScheduler(callback);
    fakeBody.setAttribute('data-sidebar-resizing', 'true');

    for (let index = 0; index < 100; index += 1) {
      scheduler.schedule();
    }

    expect(scheduledFrames.size).toBe(0);
    expect(callback).not.toHaveBeenCalled();

    fakeBody.removeAttribute('data-sidebar-resizing');
    fakeWindow.dispatchEvent({ type: SIDEBAR_RESIZE_SETTLED_EVENT });

    expect(scheduledFrames.size).toBe(1);
    flushAnimationFrames();
    expect(callback).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('coalesces normal resize notifications into one animation frame', () => {
    const callback = vi.fn();
    const scheduler = createSidebarResizeAwareFrameScheduler(callback);

    for (let index = 0; index < 100; index += 1) {
      scheduler.schedule();
    }

    expect(scheduledFrames.size).toBe(1);
    flushAnimationFrames();
    expect(callback).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('defers resize work throughout a sidebar collapse transition', () => {
    const callback = vi.fn();
    const scheduler = createSidebarResizeAwareFrameScheduler(callback);
    fakeBody.setAttribute('data-sidebar-transitioning', 'true');

    scheduler.schedule();

    expect(scheduledFrames.size).toBe(0);
    expect(callback).not.toHaveBeenCalled();

    fakeBody.removeAttribute('data-sidebar-transitioning');
    fakeWindow.dispatchEvent({ type: SIDEBAR_RESIZE_SETTLED_EVENT });
    flushAnimationFrames();

    expect(callback).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('cancels pending work when disposed', () => {
    const callback = vi.fn();
    const scheduler = createSidebarResizeAwareFrameScheduler(callback);

    scheduler.schedule();
    scheduler.dispose();
    flushAnimationFrames();

    expect(callback).not.toHaveBeenCalled();
  });
});
