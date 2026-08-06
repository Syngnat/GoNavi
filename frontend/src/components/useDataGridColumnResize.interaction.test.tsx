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

class FakeStyle {
  private properties = new Map<string, string>();
  private priorities = new Map<string, string>();

  constructor(
    public width = '',
    public flex = '',
    public left = '',
    public transform = '',
    public willChange = '',
  ) {}

  minWidth = '';
  position = '';
  overflow = '';
  zIndex = '';

  setProperty(name: string, value: string, priority = '') {
    this.properties.set(name, value);
    this.priorities.set(name, priority);
    if (name === 'width') this.width = value;
    if (name === 'min-width') this.minWidth = value;
    if (name === 'flex') this.flex = value;
    if (name === 'left') this.left = value;
  }

  removeProperty(name: string) {
    this.properties.delete(name);
    this.priorities.delete(name);
    if (name === 'width') this.width = '';
    if (name === 'min-width') this.minWidth = '';
    if (name === 'flex') this.flex = '';
    if (name === 'left') this.left = '';
  }

  getPropertyValue(name: string) {
    if (name === 'width') return this.width;
    if (name === 'min-width') return this.minWidth;
    if (name === 'flex') return this.flex;
    if (name === 'left') return this.left;
    return this.properties.get(name) ?? '';
  }

  getPropertyPriority(name: string) {
    return this.priorities.get(name) ?? '';
  }
}

const fakeClassList = (...classNames: string[]) => ({
  contains: (className: string) => classNames.includes(className),
});

describe('useDataGridColumnResize interaction cleanup', () => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousRequestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const previousCancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');

  let renderer: ReactTestRenderer | null = null;
  let resize: ReturnType<typeof useDataGridColumnResize> | null = null;
  let fakeWindow: FakeEventTarget;
  let fakeDocument: FakeEventTarget & {
    body: { style: { cursor: string; userSelect: string } };
  };
  let scheduledFrames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let setColumnWidths: ReturnType<typeof vi.fn>;
  let previewCol: { style: FakeStyle };
  let previewTable: { style: FakeStyle };
  let externalScrollInner: { style: FakeStyle };
  let previewCell: { style: FakeStyle };
  let previewRow: { style: FakeStyle };
  let nextFixedHeaderCell: { style: FakeStyle };
  let nextFixedBodyCell: { style: FakeStyle };
  let nextStandardFixedBodyCell: { style: FakeStyle };
  let resizeHandle: { closest: (selector: string) => unknown; style: FakeStyle };
  let renderedHeaderWidth: number;
  let renderedTableWidth: number;
  let tableViewportWidth: number;
  let headerIsFixedLeft: boolean;
  let hasLaterResizableHeader: boolean;

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
        currentTarget: resizeHandle,
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

  const flushAnimationFrames = () => {
    const callbacks = [...scheduledFrames.values()];
    scheduledFrames.clear();
    callbacks.forEach((callback) => callback(0));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    scheduledFrames = new Map();
    nextFrameId = 1;
    setColumnWidths = vi.fn();
    renderedHeaderWidth = 120;
    renderedTableWidth = 1000;
    tableViewportWidth = 800;
    headerIsFixedLeft = true;
    hasLaterResizableHeader = false;
    previewCol = { style: new FakeStyle('120px') };
    externalScrollInner = {
      style: new FakeStyle('980px'),
      getBoundingClientRect: () => ({ width: 980 }),
    } as any;
    previewCell = {
      style: new FakeStyle('120px', '0 0 120px', '0px'),
      classList: fakeClassList('ant-table-cell', 'ant-table-cell-fix-left'),
      getAttribute: (name: string) => name === 'data-col-name' ? 'name' : null,
    } as any;
    nextFixedBodyCell = {
      style: new FakeStyle('120px', '0 0 120px', '120px'),
      classList: fakeClassList('ant-table-cell', 'ant-table-cell-fix-left'),
      getAttribute: () => 'next',
    } as any;
    previewRow = {
      style: new FakeStyle('1000px'),
      children: [previewCell, nextFixedBodyCell],
      getBoundingClientRect: () => ({ width: renderedTableWidth }),
    } as any;
    const standardTargetCell = {
      style: new FakeStyle('120px', '', '0px'),
      classList: fakeClassList('ant-table-cell', 'ant-table-cell-fix-left'),
      getAttribute: (name: string) => name === 'data-col-name' ? 'name' : null,
    } as any;
    nextStandardFixedBodyCell = {
      style: new FakeStyle('120px', '', '120px'),
      classList: fakeClassList('ant-table-cell', 'ant-table-cell-fix-left'),
      getAttribute: () => 'next',
    } as any;
    const standardRow = {
      style: new FakeStyle('1000px'),
      children: [standardTargetCell, nextStandardFixedBodyCell],
    } as any;
    const tableSurface = {
      querySelector: (selector: string) => selector === '.data-grid-external-horizontal-scroll-inner'
        ? externalScrollInner
        : null,
    };
    const tableRoot = {
      closest: (selector: string) => selector === '.data-grid-table-wrap' ? tableSurface : null,
      querySelectorAll: (selector: string) => {
        if (selector === 'table') return [table];
        if (selector === '.ant-table-tbody-virtual .ant-table-row') return [previewRow];
        if (selector === '.ant-table-tbody > .ant-table-row') return [standardRow];
        return [];
      },
    };
    previewTable = {
      style: new FakeStyle(),
      closest: (selector: string) => selector === '.ant-table-wrapper' ? tableRoot : null,
      querySelectorAll: (selector: string) => selector === 'colgroup > col' ? [previewCol] : [],
      getBoundingClientRect: () => ({ width: renderedTableWidth }),
      parentElement: { getBoundingClientRect: () => ({ width: tableViewportWidth }) },
    } as any;
    previewTable.style.setProperty('width', '1000px', 'important');
    previewTable.style.setProperty('min-width', '1000px', 'important');
    const table = previewTable;
    nextFixedHeaderCell = {
      style: new FakeStyle('120px', '', '120px'),
      classList: fakeClassList('ant-table-cell', 'ant-table-cell-fix-left'),
      querySelector: (selector: string) => selector === '.react-resizable-handle' && hasLaterResizableHeader
        ? {}
        : null,
    } as any;
    const headerCell = {
      cellIndex: 0,
      style: new FakeStyle('120px'),
      classList: {
        contains: (className: string) => className === 'ant-table-cell'
          || (className === 'ant-table-cell-fix-left' && headerIsFixedLeft),
      },
      getBoundingClientRect: () => ({ width: renderedHeaderWidth }),
      closest: (selector: string) => selector === 'table' ? table : null,
    } as any;
    headerCell.parentElement = {
      children: [headerCell, nextFixedHeaderCell],
    };
    resizeHandle = {
      closest: (selector: string) => selector === 'th' ? headerCell : null,
      style: new FakeStyle(),
    };
    fakeWindow = new FakeEventTarget();
    fakeDocument = Object.assign(new FakeEventTarget(), {
      body: { style: { cursor: 'crosshair', userSelect: 'text' } },
    });
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

  it('restores body styles and commits on window blur', () => {
    beginResize();
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 230 }));

    expect(fakeDocument.body.style).toEqual({ cursor: 'col-resize', userSelect: 'none' });
    expect(fakeWindow.listenerCount('blur')).toBe(1);

    act(() => fakeWindow.dispatch('blur'));

    expectLastWidthUpdate(150);
    expect(scheduledFrames.size).toBe(0);
    expect(fakeDocument.body.style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(resize?.isResizingRef.current).toBe(false);
  });

  it('previews the real header and virtual body widths without a React state update and commits once on release', () => {
    beginResize();
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 230 }));

    expect(setColumnWidths).not.toHaveBeenCalled();
    act(() => flushAnimationFrames());

    expect(previewCol.style.width).toBe('150px');
    expect(previewTable.style.width).toBe('1030px');
    expect(previewTable.style.minWidth).toBe('1030px');
    expect(externalScrollInner.style.width).toBe('1010px');
    expect(previewCell.style.width).toBe('150px');
    expect(previewCell.style.flex).toBe('0 0 150px');
    expect(previewRow.style.width).toBe('1030px');
    expect(nextFixedHeaderCell.style.left).toBe('150px');
    expect(nextFixedBodyCell.style.left).toBe('150px');
    expect(nextStandardFixedBodyCell.style.left).toBe('150px');
    expect(setColumnWidths).not.toHaveBeenCalled();

    act(() => fakeDocument.dispatch('mouseup', { clientX: 250 }));

    expect(previewCol.style.width).toBe('120px');
    expect(previewTable.style.width).toBe('1000px');
    expect(previewTable.style.minWidth).toBe('1000px');
    expect(previewTable.style.getPropertyPriority('width')).toBe('important');
    expect(previewTable.style.getPropertyPriority('min-width')).toBe('important');
    expect(externalScrollInner.style.width).toBe('980px');
    expect(previewCell.style.width).toBe('120px');
    expect(previewCell.style.flex).toBe('0 0 120px');
    expect(previewRow.style.width).toBe('1000px');
    expect(nextFixedHeaderCell.style.left).toBe('120px');
    expect(nextFixedBodyCell.style.left).toBe('120px');
    expect(nextStandardFixedBodyCell.style.left).toBe('120px');
    expect(setColumnWidths).toHaveBeenCalledTimes(1);
    expectLastWidthUpdate(170);
  });

  it('self-heals when movement reports no pressed button', () => {
    beginResize();

    act(() => fakeDocument.dispatch('mousemove', { buttons: 0, clientX: 260 }));

    expectLastWidthUpdate(180);
    expect(fakeDocument.body.style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
  });

  it('does not commit when an already-minimum column is dragged below its minimum', () => {
    beginResize();

    act(() => fakeDocument.dispatch('mouseup', { clientX: 0 }));

    expect(setColumnWidths).not.toHaveBeenCalled();
  });

  it('does not rewrite the DOM or state when resize ends without movement', () => {
    beginResize();

    act(() => fakeDocument.dispatch('mouseup', { clientX: 200 }));

    expect(setColumnWidths).not.toHaveBeenCalled();
    expect(previewCol.style.width).toBe('120px');
    expect(previewCell.style.width).toBe('120px');
  });

  it('keeps a viewport-filling column at its real shrink floor without release-time rebound', () => {
    headerIsFixedLeft = false;
    renderedHeaderWidth = 1646;
    renderedTableWidth = 2988;
    tableViewportWidth = 2937.333;
    previewCol.style.width = '1646px';
    previewCell.style.width = '1646px';
    previewCell.style.flex = '0 0 1646px';
    previewRow.style.width = '2988px';
    previewTable.style.setProperty('width', '2988px', 'important');
    previewTable.style.setProperty('min-width', '2988px', 'important');

    beginResize();
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 100 }));
    act(() => flushAnimationFrames());

    expect(previewCol.style.width).toBe('1596px');
    expect(previewCell.style.width).toBe('1596px');
    expect(previewCell.style.flex).toBe('0 0 1596px');
    expect(previewRow.style.width).toBe('2938px');
    expect(previewTable.style.width).toBe('2938px');

    act(() => fakeDocument.dispatch('mouseup', { clientX: 100 }));

    expect(previewCol.style.width).toBe('1646px');
    expect(previewCell.style.width).toBe('1646px');
    expect(previewTable.style.width).toBe('2988px');
    expect(setColumnWidths).toHaveBeenCalledTimes(1);
    expectLastWidthUpdate(1596);
  });

  it('allows a regular column before the viewport-filling column to shrink normally', () => {
    headerIsFixedLeft = false;
    hasLaterResizableHeader = true;
    renderedHeaderWidth = 180;
    renderedTableWidth = 2938;
    tableViewportWidth = 2937.333;
    previewCol.style.width = '180px';
    previewCell.style.width = '180px';
    previewCell.style.flex = '0 0 180px';
    previewRow.style.width = '2938px';
    previewTable.style.setProperty('width', '2938px', 'important');
    previewTable.style.setProperty('min-width', '2938px', 'important');

    beginResize();
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 100 }));
    act(() => flushAnimationFrames());

    expect(previewCol.style.width).toBe('120px');
    expect(previewCell.style.width).toBe('120px');
    expect(previewCell.style.flex).toBe('0 0 120px');
    expect(previewRow.style.width).toBe('2878px');
    expect(previewTable.style.width).toBe('2878px');

    act(() => fakeDocument.dispatch('mouseup', { clientX: 100 }));

    expect(previewCol.style.width).toBe('180px');
    expect(previewCell.style.width).toBe('180px');
    expect(previewTable.style.width).toBe('2938px');
    expect(setColumnWidths).toHaveBeenCalledTimes(1);
    expectLastWidthUpdate(120);
  });

  it('cancels pending RAF and gate work without committing when unmounted mid-resize', () => {
    beginResize();
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 230 }));
    expect(scheduledFrames.size).toBe(1);
    act(() => flushAnimationFrames());
    expect(previewCol.style.width).toBe('150px');
    expect(previewTable.style.width).toBe('1030px');
    expect(externalScrollInner.style.width).toBe('1010px');
    expect(previewCell.style.width).toBe('150px');
    expect(previewRow.style.width).toBe('1030px');
    act(() => fakeDocument.dispatch('mousemove', { buttons: 1, clientX: 240 }));
    expect(scheduledFrames.size).toBe(1);

    act(() => renderer?.unmount());
    renderer = null;

    expect(scheduledFrames.size).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(resize?.isResizingRef.current).toBe(false);
    expect(fakeDocument.body.style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
    expect(fakeDocument.listenerCount('mousemove')).toBe(0);
    expect(fakeDocument.listenerCount('mouseup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
    expect(setColumnWidths).not.toHaveBeenCalled();
    expect(previewCol.style.width).toBe('120px');
    expect(previewTable.style.width).toBe('1000px');
    expect(previewTable.style.minWidth).toBe('1000px');
    expect(externalScrollInner.style.width).toBe('980px');
    expect(previewCell.style.width).toBe('120px');
    expect(previewCell.style.flex).toBe('0 0 120px');
    expect(previewRow.style.width).toBe('1000px');
    expect(nextFixedHeaderCell.style.left).toBe('120px');
    expect(nextFixedBodyCell.style.left).toBe('120px');
    expect(nextStandardFixedBodyCell.style.left).toBe('120px');
  });
});
