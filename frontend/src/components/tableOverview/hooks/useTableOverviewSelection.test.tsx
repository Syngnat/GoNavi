// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTableOverviewSelection } from './useTableOverviewSelection';

const ROW_TOP = 200;
const ROW_HEIGHT = 30;

let container: HTMLDivElement;
let root: Root;

const Harness = ({ names, onSelection }: {
  names: string[];
  onSelection: (n: string[]) => void;
}) => {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const { selectedNames, isSelected } = useTableOverviewSelection({ contentRef });
  onSelection(selectedNames);
  return (
    <div>
      <div ref={contentRef} data-testid="content">
        {names.map((name) => (
          <div
            key={name}
            data-row={name}
            data-table-overview-select={name}
            tabIndex={-1}
            className={isSelected(name) ? 'is-selected' : ''}
          >
            <span data-name={name}>{name}</span>
          </div>
        ))}
      </div>
      <div data-testid="outside">其他区域</div>
    </div>
  );
};

const latestSelection = () => {
  const selected = [...container.querySelectorAll('.is-selected')].map((el) => (el as HTMLElement).dataset.row);
  return selected;
};

const row = (name: string) => container.querySelector(`[data-row="${name}"]`) as HTMLElement;

const yForRow = (index: number) => ROW_TOP + index * ROW_HEIGHT + ROW_HEIGHT / 2;

const stubElementFromPoint = (names: string[]) => {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    writable: true,
    value: (_x: number, y: number) => {
      const index = Math.floor((Number(y) - ROW_TOP) / ROW_HEIGHT);
      return row(names[index] ?? names[names.length - 1]) as Element;
    },
  });
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (document as unknown as Record<string, unknown>).elementFromPoint;
  vi.unstubAllGlobals();
});

const renderHarness = (names: string[]) => {
  act(() => root.render(<Harness names={names} onSelection={() => {}} />));
};

const clickRow = (target: HTMLElement, options: MouseEventInit = {}) => {
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ...options }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...options }));
  });
};

describe('useTableOverviewSelection', () => {
  it('单击一行高亮该行', () => {
    const names = ['t1', 't2', 't3'];
    renderHarness(names);
    act(() => {
      row('t2').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      row('t2').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(latestSelection()).toEqual(['t2']);
  });

  it('Shift 点击选中两行之间的区间', () => {
    const names = ['t1', 't2', 't3', 't4'];
    renderHarness(names);
    act(() => {
      row('t1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      row('t1').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    act(() => {
      row('t3').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, shiftKey: true }));
      row('t3').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, shiftKey: true }));
    });
    expect(latestSelection()).toEqual(['t1', 't2', 't3']);
  });

  it('按住拖动跨过若干行时按区间选中', async () => {
    const names = ['t1', 't2', 't3', 't4'];
    renderHarness(names);
    stubElementFromPoint(names);

    act(() => {
      row('t1').dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: 100, clientY: yForRow(0),
      }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: yForRow(2) }));
    });
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });

    expect(latestSelection()).toEqual(['t1', 't2', 't3']);

    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  });

  it('点击列表以外的区域取消选中', () => {
    renderHarness(['t1', 't2']);
    clickRow(row('t1'));
    expect(latestSelection()).toEqual(['t1']);

    const outside = container.querySelector('[data-testid="outside"]') as HTMLElement;
    act(() => { outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
    expect(latestSelection()).toEqual([]);
  });

});
