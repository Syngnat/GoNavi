// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSidebarTableDragSelect } from './useSidebarTableDragSelect';

// 行的几何在 jsdom 里不存在，按下 / 移动的落点解析靠 elementFromPoint，
// 这里按行序号给假的命中结果。
const ROW_TOP = 300;
const ROW_HEIGHT = 30;

let container: HTMLDivElement;
let root: Root;

const buildTreeData = (keys: string[]) => {
  const nodes: Record<string, { key: string; type: string }> = {};
  keys.forEach((key) => { nodes[key] = { key, type: 'table' }; });
  return nodes;
};

type HarnessProps = {
  keys: string[];
  onSelected: (keys: React.Key[]) => void;
  onNodes: (nodes: unknown[]) => void;
};

const Harness = ({ keys, onSelected, onNodes }: HarnessProps) => {
  const treeContainerRef = React.useRef<HTMLDivElement | null>(null);
  const selectedNodesRef = React.useRef<unknown[]>([]);
  const findTreeNodeByKeyRef = React.useRef<((treeData: any, key: any) => any) | null>(null);
  const treeDataRef = React.useRef<unknown>(null);
  const treeData = React.useMemo(() => buildTreeData(keys), [keys]);

  treeDataRef.current = treeData;
  findTreeNodeByKeyRef.current = (nodes: Record<string, unknown>, key: unknown) => nodes[String(key)] || null;

  const setSidebarSelectedKeys = React.useCallback((next: React.Key[]) => {
    onSelected(next);
    onNodes(selectedNodesRef.current);
  }, [onNodes, onSelected]);

  useSidebarTableDragSelect({
    treeContainerRef,
    setSidebarSelectedKeys,
    selectedNodesRef,
    findTreeNodeByKeyRef,
    treeDataRef,
  });

  return (
    <div ref={treeContainerRef} data-testid="shell">
      {keys.map((key) => (
        <div key={key} className="ant-tree-treenode" data-row={key}>
          <span data-sidebar-node-key={key} data-sidebar-node-type="table">{key}</span>
        </div>
      ))}
    </div>
  );
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

// jsdom 没有实现 elementFromPoint，按给定规则补一个。
const stubElementFromPoint = (resolve: (x: number, y: number) => Element | null) => {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    writable: true,
    value: (x: number, y: number) => resolve(x, y),
  });
};

const renderHarness = (keys: string[], onSelected: (k: React.Key[]) => void, onNodes: (n: unknown[]) => void) => {
  act(() => root.render(<Harness keys={keys} onSelected={onSelected} onNodes={onNodes} />));
};

const rowElement = (key: string) => container.querySelector(`[data-row="${key}"]`) as HTMLElement;

const yForRow = (index: number) => ROW_TOP + index * ROW_HEIGHT + ROW_HEIGHT / 2;

describe('useSidebarTableDragSelect', () => {
  it('在表行上纵向拖过若干行时，把区间内的表全部选中', async () => {
    const keys = ['t1', 't2', 't3', 't4'];
    const onSelected = vi.fn();
    const onNodes = vi.fn();
    renderHarness(keys, onSelected, onNodes);

    // 按下落在 t1 的标题上；移动落点按行序号返回对应行。
    stubElementFromPoint((_x, y) => {
      const index = Math.floor((Number(y) - ROW_TOP) / ROW_HEIGHT);
      return (rowElement(keys[index] || 't4') as Element) ?? null;
    });

    act(() => {
      rowElement('t1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: yForRow(0) }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: yForRow(2) }));
    });
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });

    expect(onSelected).toHaveBeenCalled();
    expect(onSelected.mock.calls.at(-1)?.[0]).toEqual(['t1', 't2', 't3']);
    expect((onNodes.mock.calls.at(-1)?.[0] as Array<{ key: string }>).map((n) => n.key)).toEqual(['t1', 't2', 't3']);

    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  });

  it('按下后位移不足阈值时保持普通点击（不改写选中集）', async () => {
    const keys = ['t1', 't2', 't3'];
    const onSelected = vi.fn();
    renderHarness(keys, onSelected, vi.fn());

    stubElementFromPoint((_x, y) => {
      const index = Math.floor((Number(y) - ROW_TOP) / ROW_HEIGHT);
      return (rowElement(keys[index] || 't1') as Element) ?? null;
    });

    act(() => {
      rowElement('t1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: yForRow(0) }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 101, clientY: yForRow(0) + 1 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });

    expect(onSelected).not.toHaveBeenCalled();
  });
});
