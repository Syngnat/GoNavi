/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import VirtualList from 'rc-virtual-list';
import { afterEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it('pre-renders one viewport around fixed-height rows to cover a large native jump', () => {
    const rows: Row[] = Array.from({ length: 200 }, (_, index) => ({
      id: `fixed-${index}`,
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

    expect(container.querySelector('[data-row-id="fixed-45"]')).not.toBeNull();
    expect(container.querySelector('[data-row-id="fixed-60"]')).not.toBeNull();
    expect(container.querySelector('[data-row-id="fixed-61"]')).toBeNull();
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
    expect(compositedInner?.style.translate).toBe('-120px 0');
  });
});
