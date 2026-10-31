// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tree } from 'antd';
import type { TreeDataNode } from 'antd';

// 侧栏树开多选的前提：rc-tree 在 multiple=false 时会把 selectedKeys 截成首个 key
// （rc-tree/es/util.js calcSelectedKeys），拖选写进去的其余 key 不会渲染高亮。
const treeData: TreeDataNode[] = [
  { key: 't1', title: 't1' },
  { key: 't2', title: 't2' },
  { key: 't3', title: 't3' },
];

let container: HTMLDivElement;
let root: Root;

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
  vi.unstubAllGlobals();
});

const countSelectedRows = (multiple: boolean): number => {
  act(() => root.render(
    <Tree treeData={treeData} selectedKeys={['t1', 't2']} multiple={multiple} motion={false} />,
  ));
  return container.querySelectorAll('.ant-tree-treenode-selected').length;
};

describe('sidebar tree multi-select rendering', () => {
  it('multiple 关闭时只渲染首个选中 key（即开多选前的行为）', () => {
    expect(countSelectedRows(false)).toBe(1);
  });

  it('multiple 开启后选中的多张表全部高亮', () => {
    expect(countSelectedRows(true)).toBe(2);
  });
});
