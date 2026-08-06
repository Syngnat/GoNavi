import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import FloatingAIChatWindow from './FloatingAIChatWindow';

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

  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type, ...event });
    }
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakePointerCaptureTarget extends FakeEventTarget {
  private capturedPointers = new Set<number>();

  setPointerCapture = vi.fn((pointerId: number) => {
    this.capturedPointers.add(pointerId);
  });

  hasPointerCapture = vi.fn((pointerId: number) => this.capturedPointers.has(pointerId));

  releasePointerCapture = vi.fn((pointerId: number) => {
    this.capturedPointers.delete(pointerId);
  });
}

const storeState = vi.hoisted(() => ({
  theme: 'light',
  detachedAIChatWindow: {
    x: 120,
    y: 90,
    width: 520,
    height: 560,
    zIndex: 100,
  } as null | { x: number; y: number; width: number; height: number; zIndex: number },
  attachAIChatPanel: vi.fn(),
  setAIPanelVisible: vi.fn(),
  updateDetachedAIChatBounds: vi.fn(),
  focusDetachedAIChatPanel: vi.fn(),
}));

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../utils/nativeDetachedWindowHost', () => ({
  hasNativeDetachedWindowManager: () => false,
}));

vi.mock('antd', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  ConfigProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Spin: () => <span data-spin="true" />,
}));

vi.mock('./AIChatPanel', () => ({
  default: ({ onWindowDragStart }: { onWindowDragStart?: (event: React.PointerEvent) => void }) => (
    <div className="ai-chat-panel">
      <div className="ai-chat-header" onPointerDown={onWindowDragStart} />
    </div>
  ),
}));

describe('FloatingAIChatWindow pointer interaction lifecycle', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let fakeWindow: FakeEventTarget & { innerHeight: number; innerWidth: number };
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    storeState.theme = 'light';
    storeState.detachedAIChatWindow = {
      x: 120,
      y: 90,
      width: 520,
      height: 560,
      zIndex: 100,
    };
    fakeWindow = Object.assign(new FakeEventTarget(), {
      innerHeight: 900,
      innerWidth: 1440,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: fakeWindow,
    });
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  const renderWindow = async () => {
    await act(async () => {
      renderer = create(
        <FloatingAIChatWindow
          darkMode={false}
          overlayTheme={{} as OverlayWorkbenchTheme}
          onOpenSettings={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
  };

  const beginEastResize = () => {
    const handle = renderer?.root.findByProps({ className: 'gn-detached-ai-chat-resize-e' });
    const captureTarget = new FakePointerCaptureTarget();
    act(() => {
      handle?.props.onPointerDown({
        button: 0,
        buttons: 1,
        clientX: 640,
        clientY: 300,
        currentTarget: captureTarget,
        pointerId: 7,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    return captureTarget;
  };

  it('uses the host-resolved theme instead of a stale store theme', async () => {
    storeState.theme = 'dark';

    await act(async () => {
      renderer = create(
        <FloatingAIChatWindow
          darkMode={false}
          bgColor="#ffffff"
          overlayTheme={{} as OverlayWorkbenchTheme}
          onOpenSettings={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    const style = renderer?.root.findByType('style');
    expect(style?.props.children).toContain('background: #ffffff;');
    expect(style?.props.children).toContain('border: 1px solid rgba(0,0,0,0.12);');
  });

  it('removes an active instance global pointer listeners before unmounting', async () => {
    await renderWindow();
    beginEastResize();

    expect(fakeWindow.listenerCount('pointermove')).toBe(1);
    expect(fakeWindow.listenerCount('pointerup')).toBe(1);
    expect(fakeWindow.listenerCount('pointercancel')).toBe(1);

    act(() => {
      renderer?.unmount();
    });
    renderer = null;

    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('pointerup')).toBe(0);
    expect(fakeWindow.listenerCount('pointercancel')).toBe(0);

    fakeWindow.dispatch('pointermove', {
      buttons: 1,
      clientX: 720,
      clientY: 300,
      pointerId: 7,
    });
    expect(storeState.updateDetachedAIChatBounds).not.toHaveBeenCalled();
  });

  it('captures and updates only the pointer that started the interaction', async () => {
    await renderWindow();
    const captureTarget = beginEastResize();

    expect(captureTarget.setPointerCapture).toHaveBeenCalledWith(7);

    fakeWindow.dispatch('pointermove', {
      buttons: 1,
      clientX: 900,
      clientY: 300,
      pointerId: 9,
    });
    fakeWindow.dispatch('pointerup', { pointerId: 9 });

    expect(storeState.updateDetachedAIChatBounds).not.toHaveBeenCalled();
    expect(fakeWindow.listenerCount('pointermove')).toBe(1);

    fakeWindow.dispatch('pointermove', {
      buttons: 1,
      clientX: 720,
      clientY: 300,
      pointerId: 7,
    });
    expect(storeState.updateDetachedAIChatBounds).toHaveBeenLastCalledWith({
      height: 560,
      width: 600,
    });

    fakeWindow.dispatch('pointerup', { pointerId: 7 });

    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('pointerup')).toBe(0);
    expect(fakeWindow.listenerCount('pointercancel')).toBe(0);
  });

  it('ends the interaction when the browser loses pointer capture', async () => {
    await renderWindow();
    const captureTarget = beginEastResize();

    expect(captureTarget.listenerCount('lostpointercapture')).toBe(1);

    captureTarget.dispatch('lostpointercapture', { pointerId: 7 });

    expect(captureTarget.listenerCount('lostpointercapture')).toBe(0);
    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('pointerup')).toBe(0);
    expect(fakeWindow.listenerCount('pointercancel')).toBe(0);
  });

  it('ends the interaction when the window loses focus', async () => {
    await renderWindow();
    const captureTarget = beginEastResize();

    expect(fakeWindow.listenerCount('blur')).toBe(1);

    fakeWindow.dispatch('blur');

    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('pointerup')).toBe(0);
    expect(fakeWindow.listenerCount('pointercancel')).toBe(0);
  });

  it('self-heals when a move reports that the primary button is already released', async () => {
    await renderWindow();
    const captureTarget = beginEastResize();

    fakeWindow.dispatch('pointermove', {
      buttons: 0,
      clientX: 720,
      clientY: 300,
      pointerId: 7,
    });

    expect(storeState.updateDetachedAIChatBounds).not.toHaveBeenCalled();
    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('pointerup')).toBe(0);
    expect(fakeWindow.listenerCount('pointercancel')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });

  it('ends the interaction on pointer cancellation', async () => {
    await renderWindow();
    const captureTarget = beginEastResize();

    fakeWindow.dispatch('pointercancel', { pointerId: 7 });

    expect(captureTarget.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(fakeWindow.listenerCount('pointermove')).toBe(0);
    expect(fakeWindow.listenerCount('pointerup')).toBe(0);
    expect(fakeWindow.listenerCount('pointercancel')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });
});
