/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectOverviewRangeNames,
  collectOverviewRowNames,
  resolveOverviewClickSelection,
  resolveOverviewRowNameFromElement,
} from './tableOverviewSelection';

const buildContent = (names: string[]) => {
  const container = document.createElement('div');
  names.forEach((name) => {
    const row = document.createElement('div');
    row.dataset.tableOverviewSelect = name;
    const label = document.createElement('span');
    label.textContent = name;
    row.appendChild(label);
    container.appendChild(row);
  });
  document.body.appendChild(container);
  return container;
};

afterEach(() => { document.body.innerHTML = ''; });

describe('tableOverviewSelection > 行解析', () => {
  it('从行本身与行内子元素都能解出表名', () => {
    const container = buildContent(['t1', 't2']);
    const row = container.querySelector('[data-table-overview-select="t2"]') as HTMLElement;
    expect(resolveOverviewRowNameFromElement(row)).toBe('t2');
    expect(resolveOverviewRowNameFromElement(row.firstElementChild)).toBe('t2');
  });

  it('非可选元素返回空串', () => {
    const container = buildContent(['t1']);
    expect(resolveOverviewRowNameFromElement(container)).toBe('');
    expect(resolveOverviewRowNameFromElement(null)).toBe('');
  });
});

describe('tableOverviewSelection > 渲染顺序与区间', () => {
  it('按渲染顺序收集表名', () => {
    const container = buildContent(['t3', 't1', 't2']);
    expect(collectOverviewRowNames(container)).toEqual(['t3', 't1', 't2']);
  });

  it('返回含两端的区间，反向拖动自动倒转', () => {
    const container = buildContent(['t1', 't2', 't3', 't4']);
    expect(collectOverviewRangeNames(container, 't2', 't4')).toEqual(['t2', 't3', 't4']);
    expect(collectOverviewRangeNames(container, 't4', 't2')).toEqual(['t2', 't3', 't4']);
  });

  it('端点缺失时返回空数组', () => {
    const container = buildContent(['t1']);
    expect(collectOverviewRangeNames(container, 't1', 'missing')).toEqual([]);
    expect(collectOverviewRangeNames(null, 't1', 't2')).toEqual([]);
  });
});

describe('tableOverviewSelection > 点击选中集', () => {
  it('普通点击只保留该行', () => {
    const container = buildContent(['t1', 't2']);
    expect(resolveOverviewClickSelection(container, ['t1', 't2'], 't2', { shift: false, toggle: false }, 't1'))
      .toEqual(['t2']);
  });

  it('Shift 点击按锚点区间选中', () => {
    const container = buildContent(['t1', 't2', 't3']);
    expect(resolveOverviewClickSelection(container, [], 't3', { shift: true, toggle: false }, 't1'))
      .toEqual(['t1', 't2', 't3']);
  });

  it('Ctrl / Cmd 点击切换该行', () => {
    const container = buildContent(['t1', 't2']);
    expect(resolveOverviewClickSelection(container, ['t1'], 't2', { shift: false, toggle: true }, 't1'))
      .toEqual(['t1', 't2']);
    expect(resolveOverviewClickSelection(container, ['t1', 't2'], 't2', { shift: false, toggle: true }, 't1'))
      .toEqual(['t1']);
  });

  it('无锚点时 Shift 点击回落为单选', () => {
    const container = buildContent(['t1', 't2']);
    expect(resolveOverviewClickSelection(container, [], 't2', { shift: true, toggle: false }, null))
      .toEqual(['t2']);
  });
});
