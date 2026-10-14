// @vitest-environment jsdom
//
// gridGesturesInteraction 纯逻辑单测：
//   - Ctrl/Cmd+A 的组合键与目标判定（输入控件内不劫持）；
//   - 全选单元格 key 的生成（锚点 = 首格、跳过无 key 行）。

import { describe, expect, it } from 'vitest';

import {
  buildAllDataCellKeys,
  isGridSelectAllEventTarget,
  isSelectAllKeyCombo,
} from './gridGesturesInteraction';

const makeCellKey = (rowKey: string, colName: string) => `${rowKey}\u0001${colName}`;
const rowKeyStr = (key: unknown) => String(key);

const ROW_KEY_FIELD = '__gonavi_row_key__';

const buildRows = (keys: (number | string)[]) => keys.map((key) => ({ [ROW_KEY_FIELD]: key }));

describe('isSelectAllKeyCombo', () => {
  it('recognises meta/ctrl + a', () => {
    expect(isSelectAllKeyCombo({ key: 'a', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSelectAllKeyCombo({ key: 'A', ctrlKey: true, metaKey: false })).toBe(true);
  });

  it('rejects plain keys and other modifiers', () => {
    expect(isSelectAllKeyCombo({ key: 'a', ctrlKey: false, metaKey: false })).toBe(false);
    expect(isSelectAllKeyCombo({ key: 'b', ctrlKey: true, metaKey: true })).toBe(false);
  });
});

describe('isGridSelectAllEventTarget', () => {
  const container = document.createElement('div');
  const cell = document.createElement('span');
  container.appendChild(cell);
  document.body.appendChild(container);

  it('accepts plain targets inside the grid container', () => {
    expect(isGridSelectAllEventTarget(cell, container)).toBe(true);
  });

  it('rejects targets outside the container and non-element targets', () => {
    const outside = document.createElement('span');
    document.body.appendChild(outside);
    expect(isGridSelectAllEventTarget(outside, container)).toBe(false);
    expect(isGridSelectAllEventTarget(null, container)).toBe(false);
    expect(isGridSelectAllEventTarget(cell, null)).toBe(false);
  });

  it('rejects editable targets so native text select-all still works', () => {
    const input = document.createElement('input');
    container.appendChild(input);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    container.appendChild(editable);

    expect(isGridSelectAllEventTarget(input, container)).toBe(false);
    expect(isGridSelectAllEventTarget(editable, container)).toBe(false);
  });
});

describe('buildAllDataCellKeys', () => {
  it('covers every data cell and anchors on the first cell', () => {
    const { cellKeys, anchor } = buildAllDataCellKeys({
      rows: buildRows([0, 1, 2]),
      rowKeyField: ROW_KEY_FIELD,
      rowKeyStr,
      columnNames: ['id', 'region'],
      makeCellKey,
    });

    expect(cellKeys.size).toBe(6);
    expect(anchor).toEqual({ rowKey: '0', colName: 'id' });
    expect(cellKeys.has(makeCellKey('2', 'region'))).toBe(true);
  });

  it('skips rows without a row key', () => {
    const rows = [...buildRows([0]), { [ROW_KEY_FIELD]: null }, { other: 1 }];
    const { cellKeys, anchor } = buildAllDataCellKeys({
      rows,
      rowKeyField: ROW_KEY_FIELD,
      rowKeyStr,
      columnNames: ['id'],
      makeCellKey,
    });

    expect(cellKeys.size).toBe(1);
    expect(anchor).toEqual({ rowKey: '0', colName: 'id' });
  });

  it('returns no anchor for empty rows', () => {
    const { cellKeys, anchor } = buildAllDataCellKeys({
      rows: [],
      rowKeyField: ROW_KEY_FIELD,
      rowKeyStr,
      columnNames: ['id'],
      makeCellKey,
    });

    expect(cellKeys.size).toBe(0);
    expect(anchor).toBeNull();
  });
});
