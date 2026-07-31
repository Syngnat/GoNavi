import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDataGridColumnResize } from './useDataGridColumnResize';

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

describe('useDataGridColumnResize interaction cleanup', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousRequestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const previousCancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');

  let renderer: ReactTestRenderer | null = null;
  let resize: ReturnType<typeof useDataGridColumnResize> | null = null;
  let fakeWindow: FakeEventTarget;
  let fakeDocument: FakeEventTarget & { body: { style: { cursor: string; userSelect: string } } };
  let ghost: { style: { display: string; transform: string } };
  let scheduledFrames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let setColumnWidths: ReturnType<typeof vi.fn>;

  const containerRef = {
    current: {
      clientWidth: 1000,
      getBoundingClientRect: () => ({ left: 40 }),
      querySelectorAll: () => [],
    },
  };

  const Harness = () => {
    resize = useDataGridColumnResize({
      columnMetaMap: {},
      columnMetaMapByLowerName: {},
      columnWidths: { name: 120 },
      containerRef,
      dataTableDensity: 'comfortable',
      densityParams: { dataFontSize: 13, defaultColumnWidth: 160 },
      displayColumnNames: [],
      displayData: [],
      displayDataRef: { current: [] },
      setColumnWidths,
      showColumnComment: false,
      showColumnType: false,
    });
    return null;
  };

  const beginResize = () => {
    act(() => {
      resize?.handleResizeStart('name')({
        button: 0,
        clientX: 200,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.MouseEvent);
    });
  };

  const expectLastWidthUpdate = (width: number) => {
    const lastCall = setColumnWidths.mock.calls[setColumnWidths.mock.calls.length - 1];
    const update = lastCall?.[0] as ((previous: Record<string, number>) => Record<string, number>);
    expect(update({ name: 120 })).toEqual({ name: width });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    scheduledFrames = new Map();
    nextFrameId = 1;
    setColumnWidths = vi.fn();
    fakeWindow = new FakeEventTarget();
    fakeDocument = Object.assign(new FakeEventTarget(), {
      body: { style: { cursor: 'crosshair', userSelect: 'text' } },
    });
    ghost = { style: { display: 'none', transform: '' } };

    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
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
    (resize!.ghostRef as React.MutableRefObject<any>).current = ghost;
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    resize = null;
    vi.useRealTimers();

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

  it('restores body styles, hides the ghost, and commits on window blur', () => {
    beginResize();
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 230 }));

    expect(fakeDocument.body.style).toEqual({ cursor: 'col-resize', userSelect: 'none' });
    expect(ghost.style.display).toBe('block');
    expect(fakeWindow.listenerCount('blur')).toBe(1);

    act(() => fakeWindow.dispatch('blur'));

    expectLastWidthUpdate(150);
    expect(scheduledFrames.size).toBe(0);
    expect(ghost.style.display).toBe('none');
    expect(fakeDocument.body.style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(resize?.isResizingRef.current).toBe(false);
  });

  it('self-heals when movement reports no pressed button', () => {
    beginResize();

    act(() => fakeDocument.dispatch('mousemove', { buttons: 0, clientX: 260 }));

    expectLastWidthUpdate(180);
    expect(ghost.style.display).toBe('none');
    expect(fakeDocument.body.style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });

  it('clamps manual data column resizing to the shared 120px minimum', () => {
    beginResize();

    act(() => fakeDocument.dispatch('mouseup', { clientX: 0 }));

    expectLastWidthUpdate(120);
  });

  it('cancels pending RAF and gate work without committing when unmounted mid-resize', () => {
    beginResize();
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 230 }));
    expect(scheduledFrames.size).toBe(1);

    act(() => renderer?.unmount());
    renderer = null;

    expect(scheduledFrames.size).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(resize?.isResizingRef.current).toBe(false);
    expect(ghost.style.display).toBe('none');
    expect(fakeDocument.body.style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
    expect(setColumnWidths).not.toHaveBeenCalled();
  });
});
