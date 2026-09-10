import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDataGridCellSelectionRectangle } from './DataGridCore';
import { useDataGridBatchActions } from './useDataGridBatchActions';

const messageApi = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
}));

vi.mock('antd', () => ({ message: messageApi }));

const CELL_KEY_SEP = '\u0001';
const makeCellKey = (rowKey: string, colName: string) => `${rowKey}${CELL_KEY_SEP}${colName}`;
const splitCellKey = (cellKey: string) => {
  const index = cellKey.indexOf(CELL_KEY_SEP);
  return index === -1 ? null : { rowKey: cellKey.slice(0, index), colName: cellKey.slice(index + 1) };
};

class MockHTMLElement {
  attributes: Record<string, string>;
  parent: MockHTMLElement | null;
  selectorMatches: Set<string>;

  constructor(attributes: Record<string, string> = {}, parent: MockHTMLElement | null = null, selectorMatches: string[] = []) {
    this.attributes = attributes;
    this.parent = parent;
    this.selectorMatches = new Set(selectorMatches);
  }

  closest(selector: string): MockHTMLElement | null {
    if (selector === '[data-row-key][data-col-name]' && this.attributes['data-row-key'] && this.attributes['data-col-name']) {
      return this;
    }
    if (this.selectorMatches.has(selector)) return this;
    return this.parent?.closest(selector) || null;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
}

const createEventTarget = () => {
  const listeners = new Map<string, EventListener>();
  return {
    listeners,
    addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
  };
};

describe('useDataGridBatchActions clipboard paste', () => {
  let renderer: ReactTestRenderer | null = null;
  let windowTarget: ReturnType<typeof createEventTarget>;
  let documentTarget: ReturnType<typeof createEventTarget> & { activeElement: MockHTMLElement | null; elementFromPoint: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    messageApi.info.mockReset();
    messageApi.success.mockReset();
    windowTarget = createEventTarget();
    documentTarget = {
      ...createEventTarget(),
      activeElement: null,
      elementFromPoint: vi.fn(() => null),
    };
    vi.stubGlobal('HTMLElement', MockHTMLElement);
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('document', documentTarget);
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  const renderHook = ({
    canModifyData = true,
    addedRows = [] as any[],
    deletedRowKeys = new Set<string>(),
    modifiedRows = {} as Record<string, any>,
    selectedCells = new Set<string>(),
    selectedRowKeys = [] as React.Key[],
    copiedCellPatch = null as { sourceRowKey: string; values: Record<string, any> } | null,
    canUseCellSelectionAsFillTemplateTargets = true,
    selectionScrollController = null as any,
  } = {}) => {
    const containerTarget = createEventTarget();
    const container = {
      ...containerTarget,
      contains: vi.fn(() => true),
      querySelector: vi.fn<(selector: string) => HTMLElement | null>(() => null),
      querySelectorAll: vi.fn(() => []),
    };
    const rows = [
      { key: 'row-1', id: '1', generated: 'A', name: 'alpha' },
      { key: 'row-2', id: '2', generated: 'B', name: 'beta' },
      { key: 'row-3', id: '3', generated: 'C', name: 'gamma' },
      ...addedRows,
    ];
    const currentSelectionRef = { current: selectedCells };
    const selectionStartRef = { current: null as null | { rowKey: string; colName: string; rowIndex: number; colIndex: number } };
    const cellSelectionAnchorSourceRef = { current: null as 'user' | 'page-find' | null };
    const setAddedRows = vi.fn();
    const setModifiedRows = vi.fn();
    const setModifiedColumns = vi.fn();
    const setSelectedCells = vi.fn();
    const updateCellSelection = vi.fn();
    const resetCellSelection = vi.fn();
    const animationFrameCallbacks = new Map<number, FrameRequestCallback>();
    let nextAnimationFrameId = 1;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const frameId = nextAnimationFrameId++;
      animationFrameCallbacks.set(frameId, callback);
      return frameId;
    });
    const cancelAnimationFrame = vi.fn((frameId: number) => {
      animationFrameCallbacks.delete(frameId);
    });
    const runNextAnimationFrame = () => {
      const next = animationFrameCallbacks.entries().next().value;
      if (!next) return false;
      const [frameId, callback] = next;
      animationFrameCallbacks.delete(frameId);
      act(() => callback(0));
      return true;
    };

    const ctx = {
      CELL_SELECTION_DRAG_THRESHOLD_PX: 4,
      GONAVI_ROW_KEY: 'key',
      addedRows,
      batchEditSetNull: false,
      batchEditValue: '',
      canModifyData,
      cancelAnimationFrame,
      cellEditModeRef: { current: false },
      cellSelectionAutoScrollRafRef: { current: null },
      cellSelectionPointerRef: { current: null },
      cellSelectionRafRef: { current: null },
      cellSelectionScrollRafRef: { current: null },
      cellSelectionAutoScrollControllerRef: { current: selectionScrollController },
      closeBatchEditModal: vi.fn(),
      columnIndexMap: new Map([['id', 0], ['generated', 1], ['name', 2]]),
      containerRef: { current: container },
      copiedCellPatch,
      canUseCellSelectionAsFillTemplateTargets,
      currentSelectionRef,
      deletedRowKeys,
      displayColumnNames: ['id', 'generated', 'name'],
      displayDataRef: { current: rows },
      effectiveEditLocator: {},
      isActive: true,
      isCellValueEqualForDiff: (left: unknown, right: unknown) => left === right,
      isDraggingRef: { current: false },
      isTableSurfaceActive: true,
      isWritableResultColumn: (columnName: string) => columnName !== 'generated',
      makeCellKey,
      markCellSelectionDeleteEligible: vi.fn(),
      markCellSelectionUserSelection: vi.fn(),
      modifiedRows,
      pendingCellSelectionStartRef: { current: null },
      requestAnimationFrame,
      resetCellSelection,
      rowIndexMapRef: { current: new Map<string, number>() },
      rowKeyStr: String,
      selectedCells,
      selectedRowKeysRef: { current: selectedRowKeys },
      selectionStartRef,
      cellSelectionAnchorSourceRef,
      setAddedRows,
      setCellContextMenu: vi.fn(),
      setCellEditMode: vi.fn(),
      setCopiedCellPatch: vi.fn(),
      setModifiedColumns,
      setModifiedRows,
      setSelectedCells,
      splitCellKey,
      suppressCellSelectionClickRef: { current: false },
      translateDataGrid: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params || {})}`,
      updateCellSelection,
    };

    let actions: ReturnType<typeof useDataGridBatchActions> | null = null;
    const Harness = () => {
      actions = useDataGridBatchActions(ctx as any);
      return null;
    };
    act(() => { renderer = create(<Harness />); });

    return {
      container,
      ctx,
      currentSelectionRef,
      selectionStartRef,
      cellSelectionAnchorSourceRef,
      setAddedRows,
      setModifiedRows,
      setModifiedColumns,
      setSelectedCells,
      updateCellSelection,
      resetCellSelection,
      runNextAnimationFrame,
      getActions: () => actions!,
      rerender: () => act(() => { renderer?.update(<Harness />); }),
    };
  };

  const selectCell = (container: ReturnType<typeof renderHook>['container'], rowKey: string, colName: string) => {
    const cell = new MockHTMLElement({ 'data-row-key': rowKey, 'data-col-name': colName });
    act(() => {
      (container.listeners.get('mousedown') as any)?.({ button: 0, target: cell, clientX: 10, clientY: 10 });
      (documentTarget.listeners.get('mouseup') as any)?.({ target: cell, clientX: 10, clientY: 10 });
    });
    return cell;
  };

  const shiftSelectCell = (container: ReturnType<typeof renderHook>['container'], rowKey: string, colName: string) => {
    const cell = new MockHTMLElement({ 'data-row-key': rowKey, 'data-col-name': colName });
    const preventDefault = vi.fn();
    const clickPreventDefault = vi.fn();
    const stopPropagation = vi.fn();
    act(() => {
      (container.listeners.get('mousedown') as any)?.({
        button: 0,
        target: cell,
        clientX: 10,
        clientY: 10,
        shiftKey: true,
        preventDefault,
      });
      (documentTarget.listeners.get('mouseup') as any)?.({ target: cell, clientX: 10, clientY: 10 });
      (container.listeners.get('click') as any)?.({ preventDefault: clickPreventDefault, stopPropagation });
    });
    return { cell, preventDefault, clickPreventDefault, stopPropagation };
  };

  it('accelerates lower-right drag auto-scroll and clamps it at grid bounds', () => {
    const hook = renderHook();
    const tableBody = {
      clientHeight: 200,
      clientWidth: 200,
      scrollHeight: 400,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 400,
      getBoundingClientRect: () => ({ top: 0, right: 200, bottom: 200, left: 0 }),
    };
    hook.container.querySelector.mockReturnValue(tableBody as unknown as HTMLElement);
    hook.ctx.cellEditModeRef.current = true;
    const startCell = new MockHTMLElement({ 'data-row-key': 'row-1', 'data-col-name': 'id' });

    const dragTo = (x: number, y: number) => {
      act(() => {
        (hook.container.listeners.get('mousedown') as any)?.({
          button: 0,
          target: startCell,
          clientX: 10,
          clientY: 10,
          preventDefault: vi.fn(),
        });
        (hook.container.listeners.get('mousemove') as any)?.({
          target: {},
          clientX: x,
          clientY: y,
          preventDefault: vi.fn(),
        });
      });
      expect(hook.runNextAnimationFrame()).toBe(true);
      act(() => {
        (documentTarget.listeners.get('mouseup') as any)?.({ target: {}, clientX: x, clientY: y });
      });
    };

    dragTo(137, 137);
    expect({ top: tableBody.scrollTop, left: tableBody.scrollLeft }).toEqual({ top: 4, left: 4 });

    tableBody.scrollTop = 0;
    tableBody.scrollLeft = 0;
    dragTo(168, 168);
    expect({ top: tableBody.scrollTop, left: tableBody.scrollLeft }).toEqual({ top: 15, left: 15 });

    tableBody.scrollTop = 200;
    tableBody.scrollLeft = 200;
    dragTo(200, 200);
    expect({ top: tableBody.scrollTop, left: tableBody.scrollLeft }).toEqual({ top: 200, left: 200 });
  });

  it('uses the injected virtual scroll controller when no ant table body exists', () => {
    const virtualViewport = {
      rect: { top: 0, right: 200, bottom: 200, left: 0 },
      scrollTop: 0,
      scrollLeft: 0,
      maxScrollTop: 200,
      maxScrollLeft: 200,
    };
    const scrollBy = vi.fn((deltaX: number, deltaY: number) => {
      virtualViewport.scrollLeft += deltaX;
      virtualViewport.scrollTop += deltaY;
      return deltaX !== 0 || deltaY !== 0;
    });
    const hook = renderHook({
      selectionScrollController: {
        getViewport: () => virtualViewport,
        scrollBy,
      },
    });
    hook.ctx.cellEditModeRef.current = true;
    const startCell = new MockHTMLElement({ 'data-row-key': 'row-1', 'data-col-name': 'id' });

    act(() => {
      (hook.container.listeners.get('mousedown') as any)?.({
        button: 0,
        target: startCell,
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
      });
      (hook.container.listeners.get('mousemove') as any)?.({
        target: {},
        clientX: 168,
        clientY: 168,
        preventDefault: vi.fn(),
      });
    });

    expect(hook.runNextAnimationFrame()).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith(15, 15);
    expect(virtualViewport).toMatchObject({ scrollTop: 15, scrollLeft: 15 });

    act(() => {
      (documentTarget.listeners.get('mouseup') as any)?.({ target: {}, clientX: 168, clientY: 168 });
    });
  });

  it('extends the selection from the visible edge cell when the pointer leaves the table body', () => {
    const hook = renderHook();
    const tableBody = {
      clientHeight: 200,
      clientWidth: 200,
      scrollHeight: 400,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 400,
      getBoundingClientRect: () => ({ top: 0, right: 200, bottom: 200, left: 0 }),
    };
    const edgeCell = new MockHTMLElement({ 'data-row-key': 'row-2', 'data-col-name': 'name' });
    documentTarget.elementFromPoint.mockImplementation((x: number, y: number) => (
      x === 199 && y === 199 ? edgeCell : null
    ));
    hook.container.querySelector.mockReturnValue(tableBody as unknown as HTMLElement);
    hook.ctx.cellEditModeRef.current = true;
    const startCell = new MockHTMLElement({ 'data-row-key': 'row-1', 'data-col-name': 'id' });

    act(() => {
      (hook.container.listeners.get('mousedown') as any)?.({
        button: 0,
        target: startCell,
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
      });
      (hook.container.listeners.get('mousemove') as any)?.({
        target: {},
        clientX: 220,
        clientY: 220,
        preventDefault: vi.fn(),
      });
    });

    expect(hook.runNextAnimationFrame()).toBe(true);
    expect(hook.runNextAnimationFrame()).toBe(true);
    expect(hook.currentSelectionRef.current).toEqual(new Set([
      makeCellKey('row-1', 'id'),
      makeCellKey('row-1', 'name'),
      makeCellKey('row-2', 'id'),
      makeCellKey('row-2', 'name'),
    ]));

    act(() => {
      (documentTarget.listeners.get('mouseup') as any)?.({ target: {}, clientX: 220, clientY: 220 });
    });
  });

  it('uses the visible edge cell when releasing the drag outside the table body', () => {
    const hook = renderHook();
    const tableBody = {
      clientHeight: 200,
      clientWidth: 200,
      scrollHeight: 400,
      scrollLeft: 200,
      scrollTop: 200,
      scrollWidth: 400,
      getBoundingClientRect: () => ({ top: 0, right: 200, bottom: 200, left: 0 }),
    };
    const edgeCell = new MockHTMLElement({ 'data-row-key': 'row-3', 'data-col-name': 'name' });
    documentTarget.elementFromPoint.mockImplementation((x: number, y: number) => (
      x === 199 && y === 199 ? edgeCell : null
    ));
    hook.container.querySelector.mockReturnValue(tableBody as unknown as HTMLElement);
    hook.ctx.cellEditModeRef.current = true;
    const startCell = new MockHTMLElement({ 'data-row-key': 'row-1', 'data-col-name': 'id' });

    act(() => {
      (hook.container.listeners.get('mousedown') as any)?.({
        button: 0,
        target: startCell,
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
      });
      (hook.container.listeners.get('mousemove') as any)?.({
        target: {},
        clientX: 220,
        clientY: 220,
        preventDefault: vi.fn(),
      });
    });

    expect(hook.runNextAnimationFrame()).toBe(true);
    expect(hook.currentSelectionRef.current).toEqual(new Set([makeCellKey('row-1', 'id')]));

    act(() => {
      (documentTarget.listeners.get('mouseup') as any)?.({ target: {}, clientX: 220, clientY: 220 });
    });
    expect(hook.currentSelectionRef.current).toEqual(new Set([
      makeCellKey('row-1', 'id'),
      makeCellKey('row-1', 'name'),
      makeCellKey('row-2', 'id'),
      makeCellKey('row-2', 'name'),
      makeCellKey('row-3', 'id'),
      makeCellKey('row-3', 'name'),
    ]));
  });

  it('does not treat the center of a compact table body as an edge', () => {
    const hook = renderHook();
    const tableBody = {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 200,
      scrollLeft: 50,
      scrollTop: 50,
      scrollWidth: 200,
      getBoundingClientRect: () => ({ top: 0, right: 100, bottom: 100, left: 0 }),
    };
    hook.container.querySelector.mockReturnValue(tableBody as unknown as HTMLElement);
    hook.ctx.cellEditModeRef.current = true;
    const startCell = new MockHTMLElement({ 'data-row-key': 'row-1', 'data-col-name': 'id' });

    act(() => {
      (hook.container.listeners.get('mousedown') as any)?.({
        button: 0,
        target: startCell,
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
      });
      (hook.container.listeners.get('mousemove') as any)?.({
        target: {},
        clientX: 50,
        clientY: 50,
        preventDefault: vi.fn(),
      });
    });

    expect(hook.runNextAnimationFrame()).toBe(true);
    expect({ top: tableBody.scrollTop, left: tableBody.scrollLeft }).toEqual({ top: 50, left: 50 });

    act(() => {
      (documentTarget.listeners.get('mouseup') as any)?.({ target: {}, clientX: 50, clientY: 50 });
    });
  });

  it('recovers an out-of-range scroll position while the pointer is away from the edges', () => {
    const hook = renderHook();
    const tableBody = {
      clientHeight: 200,
      clientWidth: 200,
      scrollHeight: 400,
      scrollLeft: 250,
      scrollTop: -12,
      scrollWidth: 400,
      getBoundingClientRect: () => ({ top: 0, right: 200, bottom: 200, left: 0 }),
    };
    hook.container.querySelector.mockReturnValue(tableBody as unknown as HTMLElement);
    hook.ctx.cellEditModeRef.current = true;
    const startCell = new MockHTMLElement({ 'data-row-key': 'row-1', 'data-col-name': 'id' });

    act(() => {
      (hook.container.listeners.get('mousedown') as any)?.({
        button: 0,
        target: startCell,
        clientX: 10,
        clientY: 10,
        preventDefault: vi.fn(),
      });
      (hook.container.listeners.get('mousemove') as any)?.({
        target: {},
        clientX: 100,
        clientY: 100,
        preventDefault: vi.fn(),
      });
    });

    expect(hook.runNextAnimationFrame()).toBe(true);
    expect({ top: tableBody.scrollTop, left: tableBody.scrollLeft }).toEqual({ top: 0, left: 200 });

    act(() => {
      (documentTarget.listeners.get('mouseup') as any)?.({ target: {}, clientX: 100, clientY: 100 });
    });
  });

  it('builds a closed rectangle from the current rows and skips unavailable columns', () => {
    expect(buildDataGridCellSelectionRectangle({
      startRowIndex: 2,
      startColIndex: 2,
      endRowIndex: 0,
      endColIndex: 0,
      rows: [
        { key: 'row-1' },
        { key: 'row-2' },
        { key: 'row-3' },
      ],
      columnNames: ['id', 'generated', 'name'],
      rowKeyField: 'key',
      canSelectColumn: (columnName) => columnName !== 'generated',
    })).toEqual(new Set([
      makeCellKey('row-1', 'id'),
      makeCellKey('row-1', 'name'),
      makeCellKey('row-2', 'id'),
      makeCellKey('row-2', 'name'),
      makeCellKey('row-3', 'id'),
      makeCellKey('row-3', 'name'),
    ]));
  });

  it('pastes a two-dimensional matrix from the selected anchor cell', () => {
    const hook = renderHook({ modifiedRows: { 'row-1': { name: 'draft' } } });
    const cell = selectCell(hook.container, 'row-1', 'id');

    expect(hook.selectionStartRef.current).toEqual({ rowKey: 'row-1', colName: 'id', rowIndex: 0, colIndex: 0 });
    expect(hook.setSelectedCells).toHaveBeenCalledWith(new Set([makeCellKey('row-1', 'id')]));

    const preventDefault = vi.fn();
    act(() => {
      (windowTarget.listeners.get('paste') as any)?.({
        target: cell,
        clipboardData: {
          types: ['text/plain'],
          getData: vi.fn(() => '11\tignored\tAda\r\n12\tignored\tNULL\r\n'),
        },
        preventDefault,
      });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(hook.setModifiedRows).toHaveBeenCalledOnce();
    const nextRows = hook.setModifiedRows.mock.calls[0][0]({ 'row-1': { name: 'draft' } });
    expect(nextRows).toEqual({
      'row-1': { id: '11', name: 'Ada' },
      'row-2': { id: '12', name: null },
    });
    const nextColumns = hook.setModifiedColumns.mock.calls[0][0]({});
    expect(nextColumns['row-1']).toEqual(new Set(['id', 'name']));
    expect(nextColumns['row-2']).toEqual(new Set(['id', 'name']));
    expect(messageApi.success).toHaveBeenCalledWith('data_grid.message.pasted_columns_to_rows:{"rows":2,"cells":4}');
  });

  it('fills the selected cells when pasting a single value', () => {
    const hook = renderHook();
    const cell = selectCell(hook.container, 'row-1', 'id');
    hook.currentSelectionRef.current = new Set([
      makeCellKey('row-1', 'id'),
      makeCellKey('row-1', 'name'),
      makeCellKey('row-2', 'id'),
      makeCellKey('row-2', 'name'),
    ]);

    const preventDefault = vi.fn();
    act(() => {
      (windowTarget.listeners.get('paste') as any)?.({
        target: cell,
        clipboardData: { types: ['text/plain'], getData: vi.fn(() => 'filled') },
        preventDefault,
      });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({
      'row-1': { id: 'filled', name: 'filled' },
      'row-2': { id: 'filled', name: 'filled' },
    });
    const nextColumns = hook.setModifiedColumns.mock.calls[0][0]({});
    expect(nextColumns['row-1']).toEqual(new Set(['id', 'name']));
    expect(nextColumns['row-2']).toEqual(new Set(['id', 'name']));
    expect(messageApi.success).toHaveBeenCalledWith('data_grid.message.pasted_columns_to_rows:{"rows":2,"cells":4}');
  });

  it('anchors a header-selected column at its first cell so paste fills the column', () => {
    const hook = renderHook();
    hook.ctx.cellEditModeRef.current = true;

    act(() => {
      hook.getActions().selectEditableColumnCells('name');
    });

    expect(hook.selectionStartRef.current).toEqual({ rowKey: 'row-1', colName: 'name', rowIndex: 0, colIndex: 2 });
    expect(hook.setSelectedCells).toHaveBeenCalledWith(new Set([
      makeCellKey('row-1', 'name'),
      makeCellKey('row-2', 'name'),
      makeCellKey('row-3', 'name'),
    ]));
    expect(hook.ctx.markCellSelectionDeleteEligible).toHaveBeenCalledWith(true);
    expect(hook.ctx.markCellSelectionUserSelection).toHaveBeenCalledWith(true);

    const preventDefault = vi.fn();
    act(() => {
      (windowTarget.listeners.get('paste') as any)?.({
        target: new MockHTMLElement({ 'data-row-key': 'row-1', 'data-col-name': 'name' }),
        clipboardData: { types: ['text/plain'], getData: vi.fn(() => 'x\ny\n') },
        preventDefault,
      });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({
      'row-1': { name: 'x' },
      'row-2': { name: 'y' },
    });
  });

  it('fills the whole selected column when a single value is pasted after a header selection', () => {
    const hook = renderHook();
    hook.ctx.cellEditModeRef.current = true;

    act(() => {
      hook.getActions().selectEditableColumnCells('name');
    });

    const preventDefault = vi.fn();
    act(() => {
      (windowTarget.listeners.get('paste') as any)?.({
        target: new MockHTMLElement({ 'data-row-key': 'row-1', 'data-col-name': 'name' }),
        clipboardData: { types: ['text/plain'], getData: vi.fn(() => 'fixed') },
        preventDefault,
      });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({
      'row-1': { name: 'fixed' },
      'row-2': { name: 'fixed' },
      'row-3': { name: 'fixed' },
    });
  });

  it('sets every selected cell to NULL from the context-menu action', () => {
    const hook = renderHook({
      selectedCells: new Set([
        makeCellKey('row-1', 'name'),
        makeCellKey('row-2', 'id'),
        makeCellKey('row-2', 'name'),
      ]),
    });

    act(() => {
      hook.getActions().handleSetNullForSelectedCells({ rowKey: 'row-2', colName: 'name' });
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({
      'row-1': { name: null },
      'row-2': { id: null, name: null },
    });
    const nextColumns = hook.setModifiedColumns.mock.calls[0][0]({});
    expect(nextColumns['row-1']).toEqual(new Set(['name']));
    expect(nextColumns['row-2']).toEqual(new Set(['id', 'name']));
    expect(hook.ctx.setCellContextMenu).toHaveBeenCalledWith(expect.any(Function));
  });

  it('keeps the explicit selected-cell action scoped to the selection', () => {
    const hook = renderHook({
      selectedCells: new Set([
        makeCellKey('row-1', 'name'),
        makeCellKey('row-2', 'name'),
      ]),
    });

    act(() => {
      // The explicit menu action deliberately has no right-click fallback.
      hook.getActions().handleSetNullForSelectedCells();
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({
      'row-1': { name: null },
      'row-2': { name: null },
    });
  });

  it('merges a concurrent field patch when the NULL updater runs', () => {
    const hook = renderHook({
      selectedCells: new Set([makeCellKey('row-1', 'name')]),
    });

    act(() => {
      hook.getActions().handleSetNullForSelectedCells();
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({
      'row-1': { id: 'concurrent-id' },
    });
    expect(nextRows).toEqual({
      'row-1': { id: 'concurrent-id', name: null },
    });

    const nextColumns = hook.setModifiedColumns.mock.calls[0][0]({
      'row-1': new Set(['id']),
    });
    expect(nextColumns['row-1']).toEqual(new Set(['id', 'name']));
  });

  it('ignores selected cells from rows hidden by the active client filter', () => {
    const hook = renderHook({
      selectedCells: new Set([
        makeCellKey('row-1', 'name'),
        makeCellKey('row-2', 'name'),
      ]),
    });
    hook.ctx.displayDataRef.current = hook.ctx.displayDataRef.current.filter((row: any) => row.key !== 'row-2');

    act(() => {
      hook.getActions().handleSetNullForSelectedCells({ rowKey: 'row-1', colName: 'name' });
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({ 'row-1': { name: null } });
  });

  it('falls back to the clicked cell when the context menu is outside the selection', () => {
    const hook = renderHook({
      selectedCells: new Set([makeCellKey('row-1', 'name')]),
    });

    act(() => {
      hook.getActions().handleSetNullForSelectedCells({ rowKey: 'row-2', colName: 'name' });
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({ 'row-2': { name: null } });
  });

  it('does not treat an ineligible focused-cell state as a batch selection', () => {
    const hook = renderHook({
      canUseCellSelectionAsFillTemplateTargets: false,
      selectedCells: new Set([
        makeCellKey('row-1', 'name'),
        makeCellKey('row-2', 'name'),
      ]),
    });

    act(() => {
      hook.getActions().handleSetNullForSelectedCells({ rowKey: 'row-2', colName: 'name' });
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({ 'row-2': { name: null } });
  });

  it('keeps the non-editable-field message for a single read-only fallback cell', () => {
    const hook = renderHook({
      canUseCellSelectionAsFillTemplateTargets: false,
    });

    act(() => {
      hook.getActions().handleSetNullForSelectedCells({ rowKey: 'row-1', colName: 'generated' });
    });

    expect(messageApi.info).toHaveBeenCalledWith(expect.stringContaining('data_grid.message.current_field_not_editable'));
    expect(hook.setModifiedRows).not.toHaveBeenCalled();
  });

  it('skips rows that are already marked for deletion', () => {
    const hook = renderHook({
      deletedRowKeys: new Set(['row-1']),
      selectedCells: new Set([
        makeCellKey('row-1', 'name'),
        makeCellKey('row-2', 'name'),
      ]),
    });

    act(() => {
      hook.getActions().handleSetNullForSelectedCells({ rowKey: 'row-2', colName: 'name' });
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({ 'row-2': { name: null } });
  });

  it('preserves an existing partial patch while setting another selected field to NULL', () => {
    const hook = renderHook({
      modifiedRows: { 'row-1': { id: 'draft-id' } },
      selectedCells: new Set([
        makeCellKey('row-1', 'name'),
      ]),
    });

    act(() => {
      hook.getActions().handleSetNullForSelectedCells({ rowKey: 'row-1', colName: 'name' });
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({ 'row-1': { id: 'draft-id' } });
    expect(nextRows).toEqual({ 'row-1': { id: 'draft-id', name: null } });
    const nextColumns = hook.setModifiedColumns.mock.calls[0][0]({ 'row-1': new Set(['id']) });
    expect(nextColumns['row-1']).toEqual(new Set(['id', 'name']));
  });

  it('removes a row patch when NULL restores the original NULL value', () => {
    const hook = renderHook({
      modifiedRows: { 'row-1': { name: 'draft' } },
      selectedCells: new Set([makeCellKey('row-1', 'name')]),
    });
    hook.ctx.displayDataRef.current[0].name = null;

    act(() => {
      hook.getActions().handleSetNullForSelectedCells({ rowKey: 'row-1', colName: 'name' });
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({ 'row-1': { name: 'draft' } });
    expect(nextRows).toEqual({});
    const nextColumns = hook.setModifiedColumns.mock.calls[0][0]({ 'row-1': new Set(['name']) });
    expect(nextColumns).toEqual({});
  });

  it('ignores column header selection when the column is not writable', () => {
    const hook = renderHook();
    hook.ctx.cellEditModeRef.current = true;

    act(() => {
      hook.getActions().selectEditableColumnCells('generated');
    });

    expect(hook.selectionStartRef.current).toBeNull();
    expect(hook.setSelectedCells).not.toHaveBeenCalled();
  });

  it('clears the source selection after creating a fill template', () => {
    const hook = renderHook({
      selectedCells: new Set([makeCellKey('row-1', 'name')]),
    });

    act(() => {
      hook.getActions().handleCopySelectedColumnsFromRow();
    });

    expect(hook.ctx.setCopiedCellPatch).toHaveBeenCalledWith({
      sourceRowKey: 'row-1',
      values: { name: 'alpha' },
    });
    expect(hook.resetCellSelection).toHaveBeenCalledOnce();
  });

  it('applies a fill template to rows represented by selected cells', () => {
    const hook = renderHook({
      copiedCellPatch: { sourceRowKey: 'row-1', values: { name: 'template' } },
      selectedCells: new Set([
        makeCellKey('row-1', 'name'),
        makeCellKey('row-2', 'id'),
        makeCellKey('row-2', 'name'),
      ]),
    });

    act(() => {
      hook.getActions().handlePasteCopiedColumnsToSelectedRows();
    });

    expect(messageApi.info).not.toHaveBeenCalledWith('data_grid.message.select_target_rows:{}');
    expect(hook.setModifiedRows).toHaveBeenCalledOnce();
    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({ 'row-2': { name: 'template' } });
    expect(messageApi.success).toHaveBeenCalledWith(
      'data_grid.message.pasted_columns_to_rows:{"rows":1,"cells":1}',
    );
  });

  it('merges checked rows and selected-cell rows without updating the template source row', () => {
    const hook = renderHook({
      copiedCellPatch: { sourceRowKey: 'row-1', values: { name: 'template' } },
      selectedRowKeys: ['row-1', 'row-2'],
      selectedCells: new Set([
        makeCellKey('row-1', 'name'),
        makeCellKey('row-3', 'id'),
      ]),
    });

    act(() => {
      hook.getActions().handlePasteCopiedColumnsToSelectedRows();
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({
      'row-2': { name: 'template' },
      'row-3': { name: 'template' },
    });
    expect(nextRows).not.toHaveProperty('row-1');
    expect(messageApi.success).toHaveBeenCalledWith(
      'data_grid.message.pasted_columns_to_rows:{"rows":2,"cells":2}',
    );
  });

  it('does not treat page-find highlighting as fill-template targets', () => {
    const hook = renderHook({
      copiedCellPatch: { sourceRowKey: 'row-1', values: { name: 'template' } },
      selectedCells: new Set([makeCellKey('row-2', 'name')]),
      canUseCellSelectionAsFillTemplateTargets: false,
    });

    act(() => {
      hook.getActions().handlePasteCopiedColumnsToSelectedRows();
    });

    expect(hook.setModifiedRows).not.toHaveBeenCalled();
    expect(messageApi.info).toHaveBeenCalledWith('data_grid.message.select_target_rows:{}');
  });

  it('applies a context-menu template action only to the clicked row', () => {
    const hook = renderHook({
      copiedCellPatch: { sourceRowKey: 'row-1', values: { name: 'template' } },
      selectedRowKeys: ['row-2'],
      selectedCells: new Set([makeCellKey('row-2', 'name')]),
    });

    act(() => {
      hook.getActions().handlePasteCopiedColumnsToSelectedRows('row-3');
    });

    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({ 'row-3': { name: 'template' } });
  });

  it('resolves the selected row and column again before pasting', () => {
    const hook = renderHook();
    const cell = selectCell(hook.container, 'row-2', 'name');
    hook.ctx.displayDataRef.current = [
      { key: 'row-2', id: '2', generated: 'B', name: 'beta' },
      { key: 'row-1', id: '1', generated: 'A', name: 'alpha' },
    ];
    hook.ctx.displayColumnNames = ['name', 'id', 'generated'];
    hook.ctx.columnIndexMap = new Map([['name', 0], ['id', 1], ['generated', 2]]);
    hook.rerender();

    const preventDefault = vi.fn();
    act(() => {
      (windowTarget.listeners.get('paste') as any)?.({
        target: cell,
        clipboardData: { types: ['text/plain'], getData: vi.fn(() => '') },
        preventDefault,
      });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    const nextRows = hook.setModifiedRows.mock.calls[0][0]({});
    expect(nextRows).toEqual({ 'row-2': { name: '' } });
  });

  it('allows grid paste inside a shortcut-guarded floating window', () => {
    const hook = renderHook();
    const floatingWindow = new MockHTMLElement({}, null, ['[data-gonavi-close-shortcut-guard]']);
    const cell = new MockHTMLElement({ 'data-row-key': 'row-1', 'data-col-name': 'name' }, floatingWindow);
    selectCell(hook.container, 'row-1', 'name');
    documentTarget.activeElement = floatingWindow;

    const preventDefault = vi.fn();
    act(() => {
      (windowTarget.listeners.get('paste') as any)?.({
        target: cell,
        clipboardData: { types: ['text/plain'], getData: vi.fn(() => 'updated') },
        preventDefault,
      });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(hook.setModifiedRows).toHaveBeenCalledOnce();
  });

  it('does not intercept paste for read-only grids or editable targets', () => {
    const readOnlyHook = renderHook({ canModifyData: false });
    selectCell(readOnlyHook.container, 'row-1', 'id');
    expect(windowTarget.listeners.has('paste')).toBe(true);
    const readOnlyPreventDefault = vi.fn();
    act(() => {
      (windowTarget.listeners.get('paste') as any)?.({
        target: new MockHTMLElement(),
        clipboardData: { types: ['text/plain'], getData: vi.fn(() => '11') },
        preventDefault: readOnlyPreventDefault,
      });
    });
    expect(readOnlyPreventDefault).not.toHaveBeenCalled();

    act(() => renderer?.unmount());
    renderer = null;
    const editableHook = renderHook();
    selectCell(editableHook.container, 'row-1', 'id');
    const input = new MockHTMLElement({}, null, ['input, textarea, select, [contenteditable="true"], .ant-modal, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-popover']);
    documentTarget.activeElement = input;
    const editablePreventDefault = vi.fn();
    act(() => {
      (windowTarget.listeners.get('paste') as any)?.({
        target: input,
        clipboardData: { types: ['text/plain'], getData: vi.fn(() => '11') },
        preventDefault: editablePreventDefault,
      });
    });
    expect(editablePreventDefault).not.toHaveBeenCalled();
    expect(editableHook.setModifiedRows).not.toHaveBeenCalled();
  });

  it('selects a single cell in read-only results without enabling mutation actions', () => {
    const hook = renderHook({ canModifyData: false });

    selectCell(hook.container, 'row-1', 'id');

    expect(hook.selectionStartRef.current).toEqual({ rowKey: 'row-1', colName: 'id', rowIndex: 0, colIndex: 0 });
    expect(hook.setSelectedCells).toHaveBeenCalledWith(new Set([makeCellKey('row-1', 'id')]));
    expect(hook.ctx.markCellSelectionDeleteEligible).toHaveBeenCalledWith(false);
    expect(hook.ctx.markCellSelectionUserSelection).toHaveBeenCalledWith(false);
    expect(hook.updateCellSelection).toHaveBeenCalledWith(new Set([makeCellKey('row-1', 'id')]));
  });

  it('extends from the original anchor across a Shift-clicked rectangle', () => {
    const hook = renderHook();
    selectCell(hook.container, 'row-1', 'id');

    const { preventDefault, clickPreventDefault, stopPropagation } = shiftSelectCell(hook.container, 'row-3', 'name');

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(clickPreventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(hook.selectionStartRef.current).toEqual({ rowKey: 'row-1', colName: 'id', rowIndex: 0, colIndex: 0 });
    expect(hook.currentSelectionRef.current).toEqual(new Set([
      makeCellKey('row-1', 'id'), makeCellKey('row-1', 'name'),
      makeCellKey('row-2', 'id'), makeCellKey('row-2', 'name'),
      makeCellKey('row-3', 'id'), makeCellKey('row-3', 'name'),
    ]));
  });

  it('enters cell edit mode when an editable result uses Shift to extend a range', () => {
    const hook = renderHook();
    selectCell(hook.container, 'row-1', 'id');

    shiftSelectCell(hook.container, 'row-2', 'name');

    expect(hook.ctx.cellEditModeRef.current).toBe(true);
    expect(hook.ctx.setCellEditMode).toHaveBeenCalledWith(true);
  });

  it('keeps the original anchor for consecutive Shift-clicks', () => {
    const hook = renderHook();
    selectCell(hook.container, 'row-1', 'id');
    shiftSelectCell(hook.container, 'row-3', 'name');
    shiftSelectCell(hook.container, 'row-2', 'name');

    expect(hook.selectionStartRef.current).toEqual({ rowKey: 'row-1', colName: 'id', rowIndex: 0, colIndex: 0 });
    expect(hook.currentSelectionRef.current).toEqual(new Set([
      makeCellKey('row-1', 'id'), makeCellKey('row-1', 'name'),
      makeCellKey('row-2', 'id'), makeCellKey('row-2', 'name'),
    ]));
  });

  it('limits a Shift range to rows in the current filtered result', () => {
    const hook = renderHook();
    selectCell(hook.container, 'row-1', 'id');
    hook.ctx.displayDataRef.current = [
      { key: 'row-1', id: '1', generated: 'A', name: 'alpha' },
      { key: 'row-3', id: '3', generated: 'C', name: 'gamma' },
    ];

    shiftSelectCell(hook.container, 'row-3', 'name');

    expect(hook.currentSelectionRef.current).toEqual(new Set([
      makeCellKey('row-1', 'id'), makeCellKey('row-1', 'name'),
      makeCellKey('row-3', 'id'), makeCellKey('row-3', 'name'),
    ]));
  });

  it('falls back to a normal single-cell selection when the anchor is no longer visible', () => {
    const hook = renderHook();
    selectCell(hook.container, 'row-1', 'id');
    hook.ctx.displayDataRef.current = [
      { key: 'row-4', id: '4', generated: 'D', name: 'delta' },
    ];

    shiftSelectCell(hook.container, 'row-4', 'name');

    expect(hook.selectionStartRef.current).toEqual({
      rowKey: 'row-4',
      colName: 'name',
      rowIndex: 0,
      colIndex: 2,
    });
    expect(hook.currentSelectionRef.current).toEqual(new Set([makeCellKey('row-4', 'name')]));
  });

  it('does not use a page-find focus as a Shift-selection anchor', () => {
    const hook = renderHook();
    hook.selectionStartRef.current = { rowKey: 'row-1', colName: 'id', rowIndex: 0, colIndex: 0 };
    hook.cellSelectionAnchorSourceRef.current = 'page-find';
    hook.currentSelectionRef.current = new Set([makeCellKey('row-1', 'id')]);

    shiftSelectCell(hook.container, 'row-3', 'name');

    expect(hook.selectionStartRef.current).toEqual({ rowKey: 'row-3', colName: 'name', rowIndex: 2, colIndex: 2 });
    expect(hook.cellSelectionAnchorSourceRef.current).toBe('user');
    expect(hook.currentSelectionRef.current).toEqual(new Set([makeCellKey('row-3', 'name')]));
  });

  it('keeps all displayed columns selectable in read-only results', () => {
    const hook = renderHook({ canModifyData: false });
    selectCell(hook.container, 'row-1', 'id');

    shiftSelectCell(hook.container, 'row-2', 'generated');

    expect(hook.currentSelectionRef.current).toEqual(new Set([
      makeCellKey('row-1', 'id'), makeCellKey('row-1', 'generated'),
      makeCellKey('row-2', 'id'), makeCellKey('row-2', 'generated'),
    ]));
    expect(hook.ctx.markCellSelectionDeleteEligible).toHaveBeenCalledWith(false);
    expect(hook.ctx.markCellSelectionUserSelection).toHaveBeenCalledWith(true);
  });

  it('moves a single active cell with arrow keys without changing row-selection semantics', () => {
    const selectedCells = new Set([makeCellKey('row-1', 'id')]);
    const hook = renderHook({ selectedCells });
    hook.selectionStartRef.current = { rowKey: 'row-1', colName: 'id', rowIndex: 0, colIndex: 0 };
    const preventDefault = vi.fn();

    act(() => {
      (windowTarget.listeners.get('keydown') as any)?.({
        key: 'ArrowRight',
        defaultPrevented: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        target: null,
        preventDefault,
      });
    });

    const expectedSelection = new Set([makeCellKey('row-1', 'name')]);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(hook.selectionStartRef.current).toEqual({
      rowKey: 'row-1',
      colName: 'name',
      rowIndex: 0,
      colIndex: 2,
    });
    expect(hook.setSelectedCells).toHaveBeenCalledWith(expectedSelection);
    expect(hook.ctx.markCellSelectionDeleteEligible).toHaveBeenCalledWith(false);
    expect(hook.updateCellSelection).toHaveBeenCalledWith(expectedSelection);
  });
});
