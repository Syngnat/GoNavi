// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTableOverviewSelection } from './useTableOverviewSelection';

const ROW_TOP = 200;
const ROW_HEIGHT = 30;

let container: HTMLDivElement;
let root: Root;

const Harness = ({ names, onSelection, onActivateName }: {
  names: string[];
  onSelection: (n: string[]) => void;
  onActivateName?: (name: string) => void;
}) => {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const { selectedNames, isSelected } = useTableOverviewSelection({ contentRef, onActivateName });
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
            <span data-name={name} data-table-overview-rename={name}>{name}</span>
          </div>
        ))}
        <span data-table-overview-name-editor="true"><input data-testid="editor-input" /></span>
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

const renderHarness = (names: string[], onActivateName?: (name: string) => void) => {
  act(() => root.render(<Harness names={names} onSelection={() => {}} onActivateName={onActivateName} />));
};

const nameElement = (name: string) => container.querySelector(`[data-name="${name}"]`) as HTMLElement;

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

  it('已单选该表时再次点击表名触发就地改名', () => {
    const onActivateName = vi.fn();
    renderHarness(['t1', 't2'], onActivateName);

    // 第一次点在表名上只是选中，不触发改名。
    clickRow(nameElement('t1'));
    expect(onActivateName).not.toHaveBeenCalled();

    // 选中后再点同名表名 → 触发改名，且选中集不变。
    clickRow(nameElement('t1'));
    expect(onActivateName).toHaveBeenCalledWith('t1');
    expect(latestSelection()).toEqual(['t1']);
  });

  it('多选状态下点击表名不改名，只收窄为单选', () => {
    const onActivateName = vi.fn();
    renderHarness(['t1', 't2'], onActivateName);

    clickRow(row('t1'));
    clickRow(row('t2'), { shiftKey: true });
    expect(latestSelection()).toEqual(['t1', 't2']);

    clickRow(nameElement('t2'));
    expect(onActivateName).not.toHaveBeenCalled();
    expect(latestSelection()).toEqual(['t2']);
  });

  it('点在行内非表名位置不触发改名', () => {
    const onActivateName = vi.fn();
    renderHarness(['t1'], onActivateName);

    clickRow(row('t1'));
    clickRow(row('t1'));
    expect(onActivateName).not.toHaveBeenCalled();
  });

  it('单选后按回车进入改名', () => {
    const onActivateName = vi.fn();
    renderHarness(['t1', 't2'], onActivateName);

    clickRow(row('t1'));
    expect(document.activeElement).toBe(row('t1'));

    act(() => {
      row('t1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onActivateName).toHaveBeenCalledWith('t1');
  });

  it('多选或未选中时回车不进入改名', () => {
    const onActivateName = vi.fn();
    renderHarness(['t1', 't2'], onActivateName);

    act(() => {
      row('t1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onActivateName).not.toHaveBeenCalled();

    clickRow(row('t1'));
    clickRow(row('t2'), { shiftKey: true });
    act(() => {
      row('t2').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onActivateName).not.toHaveBeenCalled();
  });

  it('焦点在表名输入框里时回车不重复触发改名', () => {
    const onActivateName = vi.fn();
    renderHarness(['t1'], onActivateName);

    clickRow(row('t1'));
    const input = container.querySelector('[data-testid="editor-input"]') as HTMLInputElement;
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onActivateName).not.toHaveBeenCalled();
  });
});
