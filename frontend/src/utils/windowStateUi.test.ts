import { describe, expect, it, vi } from 'vitest';

import {
  installNativeWindowActivityScheduler,
  resolveTitleBarToggleIconKey,
  resolveWindowsScaleCheckDelayMs,
  shouldApplyWindowsScaleFix,
  shouldResetWebViewZoomForScaleFix,
  WINDOW_STATE_FALLBACK_INTERVAL_MS,
  WINDOWS_SCALE_FALLBACK_INTERVAL_MS,
} from './windowStateUi';

class FakeWindowActivityTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly intervals = new Map<number, TimerHandler>();
  private nextTimerId = 1;

  readonly listenerCapture = new Map<string, boolean>();
  readonly intervalDelays: number[] = [];

  addEventListener(type: string, listener: EventListener, capture = false) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    this.listenerCapture.set(type, capture);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  setInterval(handler: TimerHandler, delayMs?: number) {
    const timerId = this.nextTimerId++;
    this.intervals.set(timerId, handler);
    this.intervalDelays.push(Number(delayMs));
    return timerId;
  }

  clearInterval(timerId: number) {
    this.intervals.delete(timerId);
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  tickFallbacks() {
    for (const handler of this.intervals.values()) {
      if (typeof handler === 'function') handler();
    }
  }

  get activeIntervalCount() {
    return this.intervals.size;
  }
}

class FakeDocumentActivityTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }
}

describe('windowStateUi', () => {
  it('keeps 10-30 seconds of visible idle native-window fallback IPC within budget', () => {
    const normalWindowStateCallsPerTick = 4;
    const windowsScaleCallsPerTick = 1;
    const countNativeIpcCalls = (idleDurationMs: number) => (
      Math.floor(idleDurationMs / WINDOW_STATE_FALLBACK_INTERVAL_MS) * normalWindowStateCallsPerTick
      + Math.floor(idleDurationMs / WINDOWS_SCALE_FALLBACK_INTERVAL_MS) * windowsScaleCallsPerTick
    );

    expect(countNativeIpcCalls(10_000)).toBe(1);
    expect(countNativeIpcCalls(30_000)).toBe(11);
  });

  it('uses activity events while suppressing native fallback work on hidden pages', () => {
    const windowTarget = new FakeWindowActivityTarget();
    const documentTarget = new FakeDocumentActivityTarget();
    const onResize = vi.fn();
    const onFocus = vi.fn();
    const onPageShow = vi.fn();
    const onVisibilityChange = vi.fn();
    const onPageHide = vi.fn();
    const onBeforeUnload = vi.fn();
    const onFallback = vi.fn();

    const cleanup = installNativeWindowActivityScheduler({
      windowTarget: windowTarget as unknown as Window,
      documentTarget: documentTarget as unknown as Document,
      fallbackIntervalMs: WINDOW_STATE_FALLBACK_INTERVAL_MS,
      onFallback,
      handlers: {
        resize: onResize,
        focus: onFocus,
        pageshow: onPageShow,
        pagehide: onPageHide,
        beforeunload: onBeforeUnload,
        visibilitychange: onVisibilityChange,
      },
    });
    expect(windowTarget.intervalDelays).toEqual([WINDOW_STATE_FALLBACK_INTERVAL_MS]);

    windowTarget.dispatch('resize');
    windowTarget.dispatch('focus');
    windowTarget.dispatch('pageshow');
    documentTarget.dispatch('visibilitychange');
    windowTarget.dispatch('pagehide');
    windowTarget.dispatch('beforeunload');
    expect([onResize, onFocus, onPageShow, onVisibilityChange, onPageHide, onBeforeUnload]
      .map((handler) => handler.mock.calls.length))
      .toEqual([1, 1, 1, 1, 1, 1]);
    expect(windowTarget.listenerCapture.get('pagehide')).toBe(true);
    expect(windowTarget.listenerCapture.get('beforeunload')).toBe(true);

    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatch('visibilitychange');
    expect(windowTarget.activeIntervalCount).toBe(0);
    windowTarget.tickFallbacks();
    expect(onFallback).not.toHaveBeenCalled();

    documentTarget.visibilityState = 'visible';
    documentTarget.dispatch('visibilitychange');
    expect(windowTarget.activeIntervalCount).toBe(1);
    windowTarget.tickFallbacks();
    expect(onFallback).toHaveBeenCalledTimes(1);

    cleanup();
    windowTarget.dispatch('focus');
    documentTarget.dispatch('visibilitychange');
    windowTarget.tickFallbacks();
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onVisibilityChange).toHaveBeenCalledTimes(3);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('keeps Windows scale fallback dormant while the document is hidden', () => {
    const windowTarget = new FakeWindowActivityTarget();
    const documentTarget = new FakeDocumentActivityTarget();
    const onFallback = vi.fn();
    documentTarget.visibilityState = 'hidden';

    const cleanup = installNativeWindowActivityScheduler({
      windowTarget: windowTarget as unknown as Window,
      documentTarget: documentTarget as unknown as Document,
      fallbackIntervalMs: WINDOWS_SCALE_FALLBACK_INTERVAL_MS,
      onFallback,
      handlers: {},
    });
    expect(windowTarget.intervalDelays).toEqual([]);

    windowTarget.tickFallbacks();
    expect(onFallback).not.toHaveBeenCalled();
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatch('visibilitychange');
    expect(windowTarget.intervalDelays).toEqual([WINDOWS_SCALE_FALLBACK_INTERVAL_MS]);
    windowTarget.tickFallbacks();
    expect(onFallback).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('only applies the Windows scale fix on real ratio drift', () => {
    expect(shouldApplyWindowsScaleFix('activation', true)).toBe(false);
    expect(shouldApplyWindowsScaleFix('ratio-change', true)).toBe(true);
  });

  it('applies the Windows scale fix whenever a minimized taskbar window is restored', () => {
    expect(shouldApplyWindowsScaleFix('restore', true)).toBe(true);
    // 外接显示器恢复后的 WebView2/DWM backing surface 可能被旧 DPI 缩放，
    // 但不一定表现为 viewport ratio drift；restore 仍要刷新 WebView2 controller。
    expect(shouldApplyWindowsScaleFix('restore', false)).toBe(true);
  });

  it('applies the Windows scale fix on cold startup the same way as taskbar restore', () => {
    expect(shouldApplyWindowsScaleFix('startup', true)).toBe(true);
    expect(shouldApplyWindowsScaleFix('startup', false)).toBe(true);
    expect(shouldResetWebViewZoomForScaleFix('startup', false)).toBe(true);
  });

  it('calls the backend WebView2 zoom reset whenever a minimized window is restored', () => {
    expect(shouldResetWebViewZoomForScaleFix('restore', true)).toBe(true);
    // 字体模糊/DirectWrite 度量缓存异常不一定表现为 viewport ratio drift，
    // 因此任务栏恢复场景必须直接走零动画 WebView2 zoom reset。
    expect(shouldResetWebViewZoomForScaleFix('restore', false)).toBe(true);
    expect(shouldResetWebViewZoomForScaleFix('activation', true)).toBe(false);
    expect(shouldResetWebViewZoomForScaleFix('ratio-change', true)).toBe(true);
  });

  it('debounces resize-triggered Windows scale checks until window transitions settle', () => {
    expect(resolveWindowsScaleCheckDelayMs('resize')).toBeGreaterThan(0);
    expect(resolveWindowsScaleCheckDelayMs('focus')).toBe(0);
    expect(resolveWindowsScaleCheckDelayMs('poll')).toBe(0);
  });

  it('switches the titlebar toggle icon to restore when the window is maximized', () => {
    expect(resolveTitleBarToggleIconKey('maximized')).toBe('restore');
  });
});
