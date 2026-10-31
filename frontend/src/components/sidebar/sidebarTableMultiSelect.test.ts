/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectVisibleTableRangeKeys,
  resolveMultiTableSelection,
  resolvePlainClickSelectedKeys,
  resolveTableRowKeyFromElement,
} from './sidebarTableMultiSelect';

const buildTree = (keys: string[], types: Record<string, string> = {}) => {
  const container = document.createElement('div');
  keys.forEach((key) => {
    const row = document.createElement('div');
    row.dataset.sidebarNodeKey = key;
    row.dataset.sidebarNodeType = types[key] || 'table';
    container.appendChild(row);
  });
  return container;
};

describe('collectVisibleTableRangeKeys', () => {
  it('返回可视顺序中两端（含）之间的表 key', () => {
    const container = buildTree(['t1', 't2', 't3', 't4']);
    expect(collectVisibleTableRangeKeys(container, 't2', 't4')).toEqual(['t2', 't3', 't4']);
  });

  it('反向拖动时自动倒转区间', () => {
    const container = buildTree(['t1', 't2', 't3']);
    expect(collectVisibleTableRangeKeys(container, 't3', 't1')).toEqual(['t1', 't2', 't3']);
  });

  it('非表行不进入范围（其他类型节点被跳过）', () => {
    const container = buildTree(['t1', 'conn1', 'db1', 't2'], { conn1: 'connection', db1: 'database' });
    expect(collectVisibleTableRangeKeys(container, 't1', 't2')).toEqual(['t1', 't2']);
  });

  it('任一端不在可视表行中时返回空数组（调用方回落单选）', () => {
    const container = buildTree(['t1', 't2']);
    expect(collectVisibleTableRangeKeys(container, 't1', 'missing')).toEqual([]);
    expect(collectVisibleTableRangeKeys(null, 't1', 't2')).toEqual([]);
  });
});

describe('resolveMultiTableSelection', () => {
  const table = (key: string) => ({ key, type: 'table', dataRef: { tableName: key } });

  it('多张表且包含右键目标时返回全部节点', () => {
    const nodes = [table('a'), table('b')];
    expect(resolveMultiTableSelection(table('b'), nodes)).toEqual(nodes);
  });

  it('单选 / 目标不在选中集中 / 混入非表节点时回落单表菜单', () => {
    expect(resolveMultiTableSelection(table('a'), [table('a')])).toBeNull();
    expect(resolveMultiTableSelection(table('c'), [table('a'), table('b')])).toBeNull();
    expect(resolveMultiTableSelection(table('a'), [table('a'), { key: 'db', type: 'database' }])).toBeNull();
  });

  it('右键目标不是表时一律单表菜单', () => {
    expect(resolveMultiTableSelection({ key: 'db', type: 'database' }, [table('a'), table('b')])).toBeNull();
    expect(resolveMultiTableSelection(null, [table('a'), table('b')])).toBeNull();
  });
});

describe('resolveTableRowKeyFromElement', () => {
  const buildRow = (key: string, type = 'table') => {
    const row = document.createElement('div');
    row.className = 'ant-tree-treenode';
    const icon = document.createElement('span');
    icon.className = 'ant-tree-iconEle';
    const title = document.createElement('span');
    title.dataset.sidebarNodeKey = key;
    title.dataset.sidebarNodeType = type;
    const label = document.createElement('span');
    title.appendChild(label);
    row.append(icon, title);
    document.body.appendChild(row);
    return { row, icon, title, label };
  };

  afterEach(() => { document.body.innerHTML = ''; });

  it('标题文字上与标题内的子元素都能解出表 key', () => {
    const { title, label } = buildRow('db1-t1');
    expect(resolveTableRowKeyFromElement(title)).toBe('db1-t1');
    expect(resolveTableRowKeyFromElement(label)).toBe('db1-t1');
  });

  it('按在行内图标上时回落到所属树行的表 key', () => {
    const { icon } = buildRow('db1-t2');
    expect(resolveTableRowKeyFromElement(icon)).toBe('db1-t2');
  });

  it('非表行与空元素返回空串', () => {
    const { row } = buildRow('conn-1', 'connection');
    expect(resolveTableRowKeyFromElement(row)).toBe('');
    expect(resolveTableRowKeyFromElement(null)).toBe('');
  });
});

describe('resolvePlainClickSelectedKeys', () => {
  it('普通单击未选中行时只保留它（清掉此前累计的多选）', () => {
    // rc-tree 多选时把被点节点并进集合，这里模拟 ['a','b'] 之上再点 'c'。
    expect(resolvePlainClickSelectedKeys(['a', 'b', 'c'], 'c', false)).toEqual(['c']);
    expect(resolvePlainClickSelectedKeys(['c'], 'c', false)).toEqual(['c']);
  });

  it('点击已选中行时清空（rc-tree 已把它从集合移除，保持二次点击取消）', () => {
    expect(resolvePlainClickSelectedKeys(['a'], 'b', false)).toEqual([]);
    expect(resolvePlainClickSelectedKeys([], 'b', false)).toEqual([]);
  });

  it('带修饰键时返回 null，交由调用方保留树给出的多选集', () => {
    expect(resolvePlainClickSelectedKeys(['a', 'b'], 'c', true)).toBeNull();
  });

  it('没有节点 key 时不改写选中集', () => {
    expect(resolvePlainClickSelectedKeys(['a'], undefined, false)).toBeNull();
  });
});
