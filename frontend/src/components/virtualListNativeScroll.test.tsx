/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import VirtualList from 'rc-virtual-list';
import VirtualTable from 'rc-table/lib/VirtualTable';
import VirtualTableESM from 'rc-table/es/VirtualTable';
import { Table } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_GRID_FILL_BODY_CSS } from './dataGridLayout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

type Row = {
  id: string;
  height: number;
};

describe('resolver-based native virtual scrolling', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  it.each([['CommonJS', VirtualTable], ['ESM', VirtualTableESM]] as const)(
    'retains unchanged virtual cells when the horizontal column window moves (%s)', (_, Table) => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onCell = vi.fn(() => ({}));
    const onUncontrolledCell = vi.fn(() => ({}));
    const data = [{ id: 'row', value: 'before' }];
    const columns = Array.from({ length: 30 }, (_, index) => ({
      key: `col-${index}`, dataIndex: 'value', width: 200,
      shouldCellUpdate: index === 3 ? undefined : (next: typeof data[0], previous: typeof data[0]) => next !== previous,
      onCell: index === 2 ? onCell : index === 3 ? onUncontrolledCell : undefined,
    }));
    const render = (rows = data, nextColumns = columns) => root?.render(
      <Table data={rows} columns={nextColumns} rowKey="id" scroll={{ x: 6000, y: 200 }}
        {...{ listItemHeightFixed: true, listItemHorizontalOffsetComposited: true, listItemColumnVirtual: true }} />,
    );
    act(() => render());
    const holder = container.querySelector<HTMLElement>('.rc-table-tbody-virtual-holder')!;
    expect(holder).not.toBeNull();
    expect(onCell).toHaveBeenCalled();
    onCell.mockClear();
    onUncontrolledCell.mockClear();
    act(() => {
      holder.scrollLeft = 500;
      holder.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(onCell).not.toHaveBeenCalled();
    expect(onUncontrolledCell).toHaveBeenCalled();
    act(() => render([{ id: 'row', value: 'after' }]));
    expect(onCell).toHaveBeenCalled();
    expect(container.textContent).toContain('after');
    const onClick = vi.fn();
    const onChangedCell = vi.fn(() => ({ className: 'updated-cell', style: { color: 'red' }, onClick }));
    act(() => render(data, columns.map((column, index) => index === 2
      ? { ...column, width: 240, onCell: onChangedCell } : column)));
    expect(onChangedCell).toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>('.updated-cell')?.style.width).toBe('240px');
    act(() => container?.querySelector<HTMLElement>('.updated-cell')?.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not mount another full viewport before the first paint or during horizontal scroll', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const rows = Array.from({ length: 500 }, (_, id) => ({ id }));
    act(() => root?.render(
      <VirtualList data={rows} height={600} itemHeight={30} itemHeightFixed
        itemHorizontalOffsetComposited itemKey="id" scrollWidth={12000}>
        {(row) => <div data-budget-row={row.id}>{row.id}</div>}
      </VirtualList>,
    ));
    expect(container.querySelectorAll('[data-budget-row]').length).toBeLessThanOrEqual(25);
    const holder = container.querySelector<HTMLElement>('.rc-virtual-list-holder')!;
    act(() => {
      holder.scrollLeft = 6000;
      holder.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-budget-row]').length).toBeLessThanOrEqual(25);
  });

  it('does not reread layout to reinitialize an existing scroll notification ref', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const rows = [{ id: 'same' }];
    const render = (className: string) => root?.render(
      <VirtualList data={rows} height={300} itemHeight={30} itemHeightFixed
        itemHorizontalOffsetComposited itemKey="id" className={className}>
        {(row) => <div>{row.id}</div>}
      </VirtualList>,
    );
    act(() => render('before'));
    const holder = container.querySelector<HTMLElement>('.rc-virtual-list-holder')!;
    const notificationReads: string[] = [];
    Object.defineProperty(holder, 'scrollLeft', {
      configurable: true,
      get: () => {
        const stack = new Error().stack || '';
        if (stack.includes('getVirtualScrollInfo')) notificationReads.push(stack);
        return 0;
      },
    });
    act(() => render('after'));
    expect(notificationReads).toHaveLength(0);
  });

  it('uses the known resize offset without reading the dirty native layout', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const rows = [{ id: 1 }];
    const onScroll = vi.fn();
    const render = (width: number) => root?.render(
      <VirtualList data={rows} height={300} itemHeight={30} itemHeightFixed
        itemHorizontalOffsetComposited itemKey="id" scrollWidth={width} onVirtualScroll={onScroll}>
        {(row) => <div>{row.id}</div>}
      </VirtualList>,
    );
    act(() => render(1000));
    const holder = container.querySelector<HTMLElement>('.rc-virtual-list-holder')!;
    const notificationReads: string[] = [];
    Object.defineProperty(holder, 'scrollLeft', { configurable: true, get: () => {
      const stack = new Error().stack || '';
      if (stack.includes('getVirtualScrollInfo')) notificationReads.push(stack);
      return 0;
    } });
    act(() => render(1500));
    expect(notificationReads).toHaveLength(0);
    expect(onScroll).not.toHaveBeenCalled();
  });

  it('covers the actual flex viewport after it grows beyond the requested height', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const rows = Array.from({ length: 300 }, (_, id) => ({ id }));
    act(() => root?.render(
      <VirtualList data={rows} height={100} itemHeight={10} itemHeightFixed itemKey="id">
        {(row) => <div data-visible-row={row.id}>{row.id}</div>}
      </VirtualList>,
    ));
    const holder = container.querySelector<HTMLElement>('.rc-virtual-list-holder')!;
    Object.defineProperty(holder, 'clientHeight', { configurable: true, value: 600 });
    act(() => {
      holder.scrollTop = 1000;
      holder.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(container.querySelector('[data-visible-row="100"]')).not.toBeNull();
    expect(container.querySelector('[data-visible-row="159"]')).not.toBeNull();
    act(() => {
      holder.scrollTop = 2400;
      holder.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(container.querySelector('[data-visible-row="299"]')).not.toBeNull();
    expect(container.querySelector('.rc-virtual-list-scrollbar-vertical')).toBeNull();
  });

  it('adopts a larger height prop before the first scroll event', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const rows = Array.from({ length: 300 }, (_, id) => ({ id }));
    const render = (height: number) => root?.render(
      <VirtualList data={rows} height={height} itemHeight={10} itemHeightFixed itemKey="id">
        {(row) => <div data-visible-row={row.id}>{row.id}</div>}
      </VirtualList>,
    );

    act(() => render(100));
    const holder = container.querySelector<HTMLElement>('.rc-virtual-list-holder')!;
    expect(container.querySelector('[data-visible-row="59"]')).toBeNull();

    Object.defineProperty(holder, 'clientHeight', { configurable: true, value: 600 });
    act(() => render(600));

    expect(container.querySelector('[data-visible-row="0"]')).not.toBeNull();
    expect(container.querySelector('[data-visible-row="59"]')).not.toBeNull();
  });

  it('keeps exact variable row offsets while leaving vertical wheel input native', () => {
    const rows: Row[] = Array.from({ length: 40 }, (_, index) => ({
      id: `row-${index}`,
      height: index % 5 === 0 ? 36 : 30,
    }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <VirtualList
          data={rows}
          height={90}
          itemHeight={30}
          itemHeightResolver={(row) => row.height}
          itemKey="id"
        >
          {(row) => <div data-row-id={row.id}>{row.id}</div>}
        </VirtualList>,
      );
    });

    const holder = container.querySelector<HTMLElement>('.rc-virtual-list-holder');
    expect(holder).not.toBeNull();
    expect(holder?.style.overflowY).toBe('auto');
    expect(container.querySelector('.rc-virtual-list-scrollbar-vertical')).toBeNull();

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 48 });
    holder?.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it('commits a native scroll window without writing scrollTop back to WebKit', () => {
    const rows: Row[] = Array.from({ length: 200 }, (_, index) => ({
      id: `native-${index}`,
      height: 10,
    }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <VirtualList
          data={rows}
          height={300}
          itemHeight={10}
          itemHeightFixed
          itemKey="id"
        >
          {(row) => <div data-row-id={row.id}>{row.id}</div>}
        </VirtualList>,
      );
    });

    const holder = container.querySelector<HTMLElement>('.rc-virtual-list-holder');
    expect(holder).not.toBeNull();

    let nativeScrollTop = 1200;
    const scrollTopWrites: number[] = [];
    Object.defineProperty(holder, 'scrollTop', {
      configurable: true,
      get: () => nativeScrollTop,
      set: (value: number) => {
        scrollTopWrites.push(value);
        nativeScrollTop = value;
      },
    });

    let targetRowWasMountedBeforeScrollReturned = false;
    holder?.addEventListener('scroll', () => {
      targetRowWasMountedBeforeScrollReturned = !!container?.querySelector('[data-row-id="native-120"]');
    });

    const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    holder?.dispatchEvent(new Event('scroll', { bubbles: true }));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;

    expect(targetRowWasMountedBeforeScrollReturned).toBe(true);
    expect(scrollTopWrites).toEqual([]);

    // Direction changes and jumps to the end must not reuse the old row window.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      for (const top of [0, 1600, 300, 1700, 0]) {
        nativeScrollTop = top;
        holder?.dispatchEvent(new Event('scroll', { bubbles: true }));
        expect(container.querySelector(`[data-row-id="native-${top / 10}"]`)).not.toBeNull();
        expect(container.querySelector(`[data-row-id="native-${Math.min(199, top / 10 + 29)}"]`)).not.toBeNull();
      }
      expect(scrollTopWrites).toEqual([]);
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it('mounts a distant target before a controlled scrollbar moves the native holder', async () => {
    const rows: Row[] = Array.from({ length: 200 }, (_, index) => ({
      id: `controlled-${index}`,
      height: 10,
    }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <VirtualList
          data={rows}
          height={300}
          itemHeight={10}
          itemHeightFixed
          itemNativeScrollbarControlled
          itemKey="id"
        >
          {(row) => <div data-row-id={row.id}>{row.id}</div>}
        </VirtualList>,
      );
    });

    const holder = container.querySelector<HTMLElement>('.rc-virtual-list-holder');
    const scrollbar = container.querySelector<HTMLElement>('.rc-virtual-list-scrollbar-vertical');
    const thumb = scrollbar?.querySelector<HTMLElement>('.rc-virtual-list-scrollbar-thumb');
    expect(holder?.dataset.virtualScrollbarControlled).toBe('true');
    expect(scrollbar).not.toBeNull();
    expect(thumb).not.toBeNull();

    Object.defineProperty(scrollbar, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: 300,
        height: 300,
        left: 0,
        right: 8,
        top: 0,
        width: 8,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    let nativeScrollTop = 0;
    const writes: Array<{ value: number; targetMounted: boolean }> = [];
    Object.defineProperty(holder, 'scrollTop', {
      configurable: true,
      get: () => nativeScrollTop,
      set: (value: number) => {
        writes.push({
          value,
          targetMounted: !!container?.querySelector('[data-row-id="controlled-100"]'),
        });
        nativeScrollTop = value;
      },
    });

    act(() => {
      thumb?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientY: 0,
      }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientY: 150,
      }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1]?.value).toBeGreaterThan(900);
    expect(writes[writes.length - 1]?.targetMounted).toBe(true);
  });

  it('mounts a distant horizontal window before the native scroll event returns', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <VirtualList data={[{ id: 'row', height: 28 }]} height={300} itemHeight={28}
          itemHeightFixed itemHorizontalOffsetComposited itemKey="id" scrollWidth={12000}>
          {(_row, _index, props) => <div data-offset={props.offsetX} />}
        </VirtualList>,
      );
    });
    const holder = container.querySelector<HTMLElement>('.rc-virtual-list-holder')!;
    const previous = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      for (const offset of [6000, 1200, 11000, 0]) {
        holder.scrollLeft = offset;
        holder.dispatchEvent(new Event('scroll', { bubbles: true }));
        expect(container.querySelector('[data-offset]')?.getAttribute('data-offset')).toBe(String(offset));
      }
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });

  it('uses compositor horizontal offset only when the caller opts in', () => {
    const rows: Row[] = Array.from({ length: 20 }, (_, index) => ({
      id: `horizontal-${index}`,
      height: 10,
    }));
    const renderList = (composited: boolean) => {
      const ref = React.createRef<any>();
      act(() => {
        root?.render(
          <VirtualList
            ref={ref}
            data={rows}
            height={100}
            itemHeight={10}
            itemHeightFixed
            itemHorizontalOffsetComposited={composited}
            itemKey="id"
            scrollWidth={600}
          >
            {(row) => <div data-row-id={row.id}>{row.id}</div>}
          </VirtualList>,
        );
      });
      act(() => ref.current?.scrollTo({ left: 120 }));
      return container?.querySelector<HTMLElement>('.rc-virtual-list-holder-inner');
    };

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    const legacyInner = renderList(false);
    expect(legacyInner?.style.marginLeft).toBe('-120px');
    expect(legacyInner?.style.translate).toBe('');

    const compositedInner = renderList(true);
    expect(compositedInner?.style.marginLeft).toBe('');
    expect(compositedInner?.style.translate).toBe('');
    expect(compositedInner?.style.width).toBe('600px');
  });

  it('keeps horizontal scrolling available for empty results with wide columns', () => {
    container = document.createElement('div');
    container.className = 'data-grid-root';
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<>
      <style>{DATA_GRID_FILL_BODY_CSS}</style>
      <div className="data-grid-table-wrap">
        <VirtualList data={[{ id: 'one', height: 28 }]} height={500} fullHeight={false}
          prefixCls="ant-table-tbody-virtual" itemHeight={28} itemKey="id">
          {(row) => <div>{row.id}</div>}
        </VirtualList>
        <Table dataSource={[]} columns={Array.from({ length: 20 }, (_, index) => ({
          key: `column-${index}`, title: `column-${index}`, width: 180,
        }))} virtual scroll={{ x: 3600, y: 500 }} pagination={false} />
      </div>
    </>));
    const holder = container.querySelector('.ant-table-tbody-virtual-holder')!;
    expect(getComputedStyle(holder).flexGrow).toBe('1');
    const emptyBody = container.querySelector('.ant-table-body')!;
    expect(getComputedStyle(emptyBody).flexGrow).toBe('1');
    expect(getComputedStyle(emptyBody).overflowX).not.toBe('hidden');
    expect(getComputedStyle(container.querySelector('.ant-table-body > table')!).height).toBe('100%');
    expect(getComputedStyle(container.querySelector('.ant-table-placeholder')!).height).toBe('100%');
    // jsdom does not apply stylesheet !important over inline styles. Check the
    // override priority here; the real browser probe verifies its final height.
    const bodyRule = Array.from(container.querySelector('style')!.sheet!.cssRules)
      .find((rule) => rule instanceof CSSStyleRule && emptyBody.matches(rule.selectorText)
        && rule.style.getPropertyValue('max-height') === 'none') as CSSStyleRule;
    expect(bodyRule.style.getPropertyPriority('max-height')).toBe('important');
    container.classList.add('data-grid-empty');
    const external = document.createElement('div');
    external.className = 'data-grid-external-horizontal-scroll';
    container.append(external);
    expect(getComputedStyle(external).display).not.toBe('none');
    container.classList.remove('data-grid-empty');
    expect(getComputedStyle(external).display).not.toBe('none');
  });
});
